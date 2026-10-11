import { createHash, createHmac, randomUUID } from 'node:crypto';
import { awaitWithSignal, deadlineSignal, remainingMs, throwIfExpired } from './deadline.mjs';

/**
 * Durable state for Nia. All keys (including namespace) are hashed; payloads
 * live in a PRIVATE Vercel Blob store. Supply hashSecret to make low-entropy
 * keys such as phone numbers resistant to dictionary guesses as well.
 *
 * SDK: @vercel/blob 2.8.1; get({ useCache: false }) and put({ ifMatch }) are
 * essential. The injected `storage` has the SDK's get/put interface, allowing
 * local tests without credentials or a network connection.
 *
 * read/create/compareAndSwap -> { value, etag, writeId }
 * update(key, pureUpdater) -> record; updater may run again after a conflict.
 * recordEvent/recordConversation -> { created, record }; redelivery does not
 * reset an existing record. updateEvent/updateConversation accept a pure
 * updater OR a patch object.
 *
 * withLease(key, fn, { ttlMs }) supplies an ownership-checking lease. Queue
 * retry should handle LeaseBusyError; this module never sleeps waiting for a
 * lock. Call withLease(`thread:${threadId}`, ...) around all thread mutations.
 * Defaults assume a function maxDuration <= 60 seconds and a 120 second lease.
 * A lease is coordination, NOT a fencing token accepted by Notion. A network
 * request already in flight cannot be revoked by losing this lease.
 *
 * runMutation({ conversationId, operationId, request, lease, perform,
 *               timeoutMs }) journals prepared -> dispatching -> completed.
 * perform({ signal, receiptId }) MUST honor signal for every network request.
 * Any ambiguous error leaves an uncertain receipt. It is never blindly
 * replayed; reconcile against the provider and call completeReceipt with the
 * verified result. An empty or delayed provider search is not proof of absence.
 */

export class LedgerConflictError extends Error {
  constructor(message = 'Ledger write conflicted') { super(message); this.name = 'LedgerConflictError'; this.code = 'LEDGER_CONFLICT'; }
}
export class LeaseBusyError extends Error {
  constructor(retryAfterMs = 1000) { super('Thread is being processed'); this.name = 'LeaseBusyError'; this.code = 'LEASE_BUSY'; this.retryAfterMs = retryAfterMs; }
}
export class LeaseLostError extends Error {
  constructor() { super('Lease is no longer owned or has insufficient time remaining'); this.name = 'LeaseLostError'; this.code = 'LEASE_LOST'; }
}
export class UncertainMutationError extends Error {
  constructor(message = 'Provider mutation needs reconciliation before retry', options) { super(message, options); this.name = 'UncertainMutationError'; this.code = 'MUTATION_UNCERTAIN'; }
}
export class ReceiptConflictError extends Error {
  constructor(message = 'Operation key was reused for a different request') { super(message); this.name = 'ReceiptConflictError'; this.code = 'RECEIPT_CONFLICT'; }
}

const clone = (value) => JSON.parse(JSON.stringify(value));
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function requireKey(key) {
  if (typeof key !== 'string' || !key.length || key.length > 8192) throw new TypeError('A nonempty bounded ledger key is required');
  return key;
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

export function requestDigest(value) {
  // JSON serialization rejects cycles and BigInt and normalizes undefined keys.
  const serialized = stableJson(clone(value));
  return createHash('sha256').update(serialized).digest('hex');
}

function isPreconditionError(error) {
  return error?.name === 'BlobPreconditionFailedError' ||
    error?.constructor?.name === 'BlobPreconditionFailedError' ||
    error?.status === 412 || error?.statusCode === 412;
}

export class BlobLedger {
  constructor({
    storage,
    namespace = process.env.NIA_LEDGER_NAMESPACE || process.env.VERCEL_ENV || 'development',
    hashSecret = process.env.NIA_LEDGER_HASH_SECRET,
    now = Date.now,
    leaseMs = 120_000,
    storageTimeoutMs = 5_000,
    maxRecordBytes = 2 * 1024 * 1024,
    maxCasAttempts = 6,
    token,
    storeId,
  } = {}) {
    requireKey(namespace);
    if (!Number.isInteger(leaseMs) || leaseMs < 1000) throw new TypeError('leaseMs must be at least 1000');
    if (!Number.isInteger(storageTimeoutMs) || storageTimeoutMs < 1) throw new TypeError('Invalid storageTimeoutMs');
    if (!Number.isInteger(maxCasAttempts) || maxCasAttempts < 1) throw new TypeError('Invalid maxCasAttempts');
    this.storage = storage;
    this.namespace = namespace;
    this.hashSecret = hashSecret;
    this.now = now;
    this.leaseMs = leaseMs;
    this.storageTimeoutMs = storageTimeoutMs;
    this.maxRecordBytes = maxRecordBytes;
    this.maxCasAttempts = maxCasAttempts;
    this.credentials = { ...(token ? { token } : {}), ...(storeId ? { storeId } : {}) };
  }

  async _client() {
    if (!this.storage) this.storage = await import('@vercel/blob');
    return this.storage;
  }

  _hash(value) {
    const hash = this.hashSecret ? createHmac('sha256', this.hashSecret) : createHash('sha256');
    return hash.update(value).digest('hex');
  }

  pathFor(key) {
    return `nia-ledger/v1/${this._hash(this.namespace)}/${this._hash(JSON.stringify([this.namespace, requireKey(key)]))}.json`;
  }

  async read(key) {
    throwIfExpired();
    const sdk = await this._client();
    throwIfExpired();
    const signal = deadlineSignal(AbortSignal.timeout(Math.max(1, Math.ceil(remainingMs(this.storageTimeoutMs)))));
    const result = await awaitWithSignal(sdk.get(this.pathFor(key), {
      ...this.credentials, access: 'private', useCache: false,
      abortSignal: signal,
    }), signal);
    if (result === null) return null;
    if (result.statusCode !== 200 || !result.stream || !result.blob?.etag) throw new Error('Invalid ledger storage response');
    if (result.blob.size > this.maxRecordBytes) throw new Error('Ledger record exceeds size limit');
    const text = await awaitWithSignal(new Response(result.stream).text(), signal);
    if (Buffer.byteLength(text) > this.maxRecordBytes) throw new Error('Ledger record exceeds size limit');
    const body = JSON.parse(text);
    if (body.schema !== 1 || typeof body.writeId !== 'string' || !hasOwn(body, 'value')) throw new Error('Invalid ledger envelope');
    return { value: body.value, etag: result.blob.etag, writeId: body.writeId };
  }

  async _write(key, value, expectedEtag) {
    throwIfExpired();
    const sdk = await this._client();
    const writeId = randomUUID();
    const body = JSON.stringify({ schema: 1, writeId, value });
    if (value === undefined || Buffer.byteLength(body) > this.maxRecordBytes) throw new TypeError('Invalid or oversized ledger value');
    throwIfExpired();
    const signal = deadlineSignal(AbortSignal.timeout(Math.max(1, Math.ceil(remainingMs(this.storageTimeoutMs)))));
    try {
      const result = await awaitWithSignal(sdk.put(this.pathFor(key), body, {
        ...this.credentials, access: 'private', addRandomSuffix: false,
        allowOverwrite: expectedEtag !== undefined,
        ...(expectedEtag !== undefined ? { ifMatch: expectedEtag } : {}),
        contentType: 'application/json', cacheControlMaxAge: 60,
        abortSignal: signal,
      }), signal);
      if (!result?.etag) throw new Error('Ledger write did not return an ETag');
      return { value: clone(value), etag: result.etag, writeId };
    } catch (error) {
      throwIfExpired();
      // A lost response can follow a successful commit. Recover only when this
      // exact write nonce is observed, never by comparing payloads alone.
      let current;
      try { current = await this.read(key); } catch { throw error; }
      if (current?.writeId === writeId) return current;
      if (isPreconditionError(error) || (current && (expectedEtag === undefined || current.etag !== expectedEtag))) {
        throw new LedgerConflictError();
      }
      throw error;
    }
  }

  async create(key, value) { return this._write(key, value, undefined); }

  async compareAndSwap(key, etag, value) {
    if (typeof etag !== 'string' || !etag) throw new TypeError('A current ETag is required');
    return this._write(key, value, etag);
  }

  async update(key, updater) {
    for (let attempt = 0; attempt < this.maxCasAttempts; attempt++) {
      const current = await this.read(key);
      if (!current) throw new Error('Ledger record is missing');
      const value = typeof updater === 'function' ? await updater(clone(current.value)) : { ...current.value, ...updater };
      if (value === undefined) return current;
      try { return await this.compareAndSwap(key, current.etag, value); }
      catch (error) { if (!(error instanceof LedgerConflictError)) throw error; }
    }
    throw new LedgerConflictError('Ledger contention exceeded retry limit');
  }

  async _record(key, value) {
    try { return { created: true, record: await this.create(key, value) }; }
    catch (error) {
      if (!(error instanceof LedgerConflictError)) throw error;
      const record = await this.read(key);
      if (!record) throw error;
      return { created: false, record };
    }
  }

  async recordEvent(eventId, metadata = {}) {
    const timestamp = new Date(this.now()).toISOString();
    return this._record(`event:${requireKey(eventId)}`, {
      ...metadata, kind: 'event', eventId, state: 'received', createdAt: timestamp, updatedAt: timestamp,
    });
  }
  async getEvent(eventId) { return this.read(`event:${requireKey(eventId)}`); }
  async updateEvent(eventId, updater) { return this._updateRecord(`event:${requireKey(eventId)}`, updater); }

  async recordConversation(conversationId, metadata = {}) {
    const timestamp = new Date(this.now()).toISOString();
    return this._record(`conversation:${requireKey(conversationId)}`, {
      ...metadata, kind: 'conversation', conversationId, state: 'pending', createdAt: timestamp, updatedAt: timestamp,
    });
  }
  async getConversation(conversationId) { return this.read(`conversation:${requireKey(conversationId)}`); }
  async updateConversation(conversationId, updater) { return this._updateRecord(`conversation:${requireKey(conversationId)}`, updater); }

  async _updateRecord(key, updater) {
    return this.update(key, async (value) => {
      const next = typeof updater === 'function' ? await updater(clone(value)) : { ...value, ...updater };
      if (next === undefined) return undefined;
      return { ...next, kind: value.kind, ...(value.eventId ? { eventId: value.eventId } : {}),
        ...(value.conversationId ? { conversationId: value.conversationId } : {}),
        createdAt: value.createdAt, updatedAt: new Date(this.now()).toISOString() };
    });
  }

  async acquireLease(key, { ttlMs = this.leaseMs } = {}) {
    requireKey(key);
    if (!Number.isInteger(ttlMs) || ttlMs < 1000) throw new TypeError('ttlMs must be at least 1000');
    const leaseKey = `lease:${key}`;
    const owner = randomUUID();
    for (let attempt = 0; attempt < this.maxCasAttempts; attempt++) {
      const current = await this.read(leaseKey);
      const now = this.now();
      if (current?.value.owner && current.value.expiresAt > now) throw new LeaseBusyError(current.value.expiresAt - now);
      const value = { kind: 'lease', owner, acquiredAt: now, expiresAt: now + ttlMs };
      try {
        if (current) await this.compareAndSwap(leaseKey, current.etag, value);
        else await this.create(leaseKey, value);
        return this._lease(leaseKey, owner, ttlMs);
      } catch (error) { if (!(error instanceof LedgerConflictError)) throw error; }
    }
    throw new LeaseBusyError();
  }

  _lease(key, owner, ttlMs) {
    const ledger = this;
    const owned = async (minRemainingMs = 0) => {
      const current = await ledger.read(key);
      if (!current || current.value.owner !== owner || current.value.expiresAt <= ledger.now() + minRemainingMs) throw new LeaseLostError();
      return current;
    };
    return {
      owner, ttlMs,
      async assertOwned({ minRemainingMs = 0 } = {}) {
        if (!Number.isFinite(minRemainingMs) || minRemainingMs < 0) throw new TypeError('Invalid lease time requirement');
        const current = await owned(minRemainingMs);
        return { owner, expiresAt: current.value.expiresAt };
      },
      async renew() {
        const current = await owned();
        try { return await ledger.compareAndSwap(key, current.etag, { ...current.value, expiresAt: ledger.now() + ttlMs }); }
        catch (error) { if (error instanceof LedgerConflictError) throw new LeaseLostError(); throw error; }
      },
      async release() {
        const current = await ledger.read(key);
        if (!current || current.value.owner !== owner) return false;
        try {
          await ledger.compareAndSwap(key, current.etag, { ...current.value, owner: null, expiresAt: 0, releasedAt: ledger.now() });
          return true;
        } catch (error) { if (error instanceof LedgerConflictError) return false; throw error; }
      },
    };
  }

  async withLease(key, fn, options) {
    const lease = await this.acquireLease(key, options);
    let callbackFailed = false;
    try { return await fn(lease); }
    catch (error) { callbackFailed = true; throw error; }
    finally {
      try { await lease.release(); }
      catch (error) { if (!callbackFailed) throw error; }
    }
  }

  _receiptKey(conversationId, operationId) { return `receipt:${JSON.stringify([requireKey(conversationId), requireKey(operationId)])}`; }

  async beginReceipt(conversationId, operationId, { requestDigest: digest, ...metadata } = {}) {
    if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) throw new TypeError('A SHA-256 requestDigest is required');
    const timestamp = new Date(this.now()).toISOString();
    const result = await this._record(this._receiptKey(conversationId, operationId), {
      ...metadata, kind: 'mutation', conversationId, operationId, requestDigest: digest,
      state: 'prepared', createdAt: timestamp, updatedAt: timestamp,
    });
    if (result.record.value.requestDigest !== digest) throw new ReceiptConflictError();
    return result;
  }

  async getReceipt(conversationId, operationId) { return this.read(this._receiptKey(conversationId, operationId)); }

  async markReceiptSent(conversationId, operationId, { leaseOwner } = {}) {
    return this.update(this._receiptKey(conversationId, operationId), (value) => {
      if (value.state !== 'prepared') throw new UncertainMutationError();
      return { ...value, state: 'dispatching', dispatchId: randomUUID(), leaseOwner: leaseOwner || null,
        updatedAt: new Date(this.now()).toISOString() };
    });
  }

  async completeReceipt(conversationId, operationId, result, { dispatchId, reconciled = false } = {}) {
    return this.update(this._receiptKey(conversationId, operationId), (value) => {
      if (value.state === 'completed') return undefined;
      if (!['dispatching', 'uncertain'].includes(value.state)) throw new ReceiptConflictError('Receipt was never dispatched');
      if (dispatchId && value.dispatchId !== dispatchId) throw new ReceiptConflictError('Receipt dispatch changed');
      return { ...value, state: 'completed', result: clone(result), reconciled, updatedAt: new Date(this.now()).toISOString() };
    });
  }

  async markReceiptUncertain(conversationId, operationId, reason = 'provider_result_unknown', { dispatchId } = {}) {
    return this.update(this._receiptKey(conversationId, operationId), (value) => {
      if (value.state === 'completed') return undefined;
      if (!['dispatching', 'uncertain'].includes(value.state)) throw new ReceiptConflictError('Receipt was never dispatched');
      if (dispatchId && value.dispatchId !== dispatchId) throw new ReceiptConflictError('Receipt dispatch changed');
      return { ...value, state: 'uncertain', reason: String(reason).slice(0, 120), updatedAt: new Date(this.now()).toISOString() };
    });
  }

  async runMutation({ conversationId, operationId, request, lease, perform, timeoutMs = 10_000 }) {
    throwIfExpired();
    if (!lease || typeof lease.assertOwned !== 'function' || typeof perform !== 'function') throw new TypeError('A lease and provider callback are required');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new TypeError('Provider timeout must be 1–30000 ms');
    const digest = requestDigest(request);
    const { record } = await this.beginReceipt(conversationId, operationId, { requestDigest: digest });
    if (record.value.state === 'completed') return { replayed: true, result: record.value.result };
    if (record.value.state !== 'prepared') throw new UncertainMutationError();
    await lease.assertOwned({ minRemainingMs: timeoutMs + 1000 });
    const sent = await this.markReceiptSent(conversationId, operationId, { leaseOwner: lease.owner });
    let timer;
    let dispatched = false;
    const controller = new AbortController();
    try {
      // This final origin read occurs after the durable intent, immediately
      // before dispatch. A lost lease never leads to a fresh provider request.
      await lease.assertOwned({ minRemainingMs: timeoutMs + 1000 });
      throwIfExpired();
      const signal = deadlineSignal(controller.signal);
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error('Provider request timed out');
          error.code = 'PROVIDER_TIMEOUT';
          controller.abort(error);
          reject(error);
        }, Math.max(1, Math.ceil(remainingMs(timeoutMs))));
      });
      dispatched = true;
      const result = await Promise.race([
        awaitWithSignal(Promise.resolve().then(() => {
          throwIfExpired();
          signal.throwIfAborted();
          return perform({ signal, receiptId: sent.value.dispatchId });
        }), signal),
        timeout,
      ]);
      throwIfExpired();
      const receipt = await this.completeReceipt(conversationId, operationId, result, { dispatchId: sent.value.dispatchId });
      return { replayed: false, result: receipt.value.result };
    } catch (cause) {
      // If this write also fails, the durable 'dispatching' record still blocks
      // blind replay. Persisting a successful Notion response may itself fail.
      try {
        await this.markReceiptUncertain(conversationId, operationId,
          dispatched ? 'provider_result_unknown' : 'lease_lost_before_dispatch', { dispatchId: sent.value.dispatchId });
      } catch { /* Existing dispatching intent remains the conservative truth. */ }
      throw new UncertainMutationError(undefined, { cause });
    } finally { if (timer) clearTimeout(timer); controller.abort(); }
  }
}
