import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BlobLedger, LedgerConflictError, LeaseBusyError, LeaseLostError,
  ReceiptConflictError, UncertainMutationError, requestDigest,
} from '../lib/ledger.mjs';

class MemoryBlobStorage {
  constructor() { this.rows = new Map(); this.calls = []; this.version = 0; this.failAfterNextCommit = false; }
  async get(path, options) {
    this.calls.push({ op: 'get', path, options });
    assert.equal(options.access, 'private');
    assert.equal(options.useCache, false);
    const row = this.rows.get(path);
    return row ? { statusCode: 200, stream: new Response(row.body).body, blob: { etag: row.etag, size: Buffer.byteLength(row.body) } } : null;
  }
  async put(path, body, options) {
    this.calls.push({ op: 'put', path, options });
    assert.equal(options.access, 'private');
    assert.equal(options.addRandomSuffix, false);
    const previous = this.rows.get(path);
    if ((!options.allowOverwrite && previous) || (options.ifMatch && previous?.etag !== options.ifMatch)) {
      const error = new Error('precondition failed');
      error.name = 'BlobPreconditionFailedError';
      throw error;
    }
    const etag = `"etag-${++this.version}"`;
    this.rows.set(path, { body, etag });
    if (this.failAfterNextCommit) { this.failAfterNextCommit = false; throw new Error('response lost after commit'); }
    return { etag, pathname: path };
  }
}

function fixture() {
  const storage = new MemoryBlobStorage();
  let clock = 10_000;
  const ledger = new BlobLedger({ storage, namespace: 'test', hashSecret: 'local-only-test-key', now: () => clock, leaseMs: 20_000 });
  return { storage, ledger, advance: (ms) => { clock += ms; } };
}

test('private storage uses opaque, deterministic, namespace-separated paths', async () => {
  const { ledger, storage } = fixture();
  const key = 'caller:+13017014932:person@example.test';
  await ledger.create(key, { note: 'private' });
  const path = storage.calls.find((call) => call.op === 'put').path;
  assert.match(path, /^nia-ledger\/v1\/[a-f0-9]{64}\/[a-f0-9]{64}\.json$/);
  assert.equal(path, ledger.pathFor(key));
  assert.equal(path.includes('3017014932'), false);
  const other = new BlobLedger({ storage, namespace: 'production', hashSecret: 'local-only-test-key' });
  assert.notEqual(path, other.pathFor(key));
});

test('concurrent create has one winner and stale CAS cannot overwrite it', async () => {
  const { ledger } = fixture();
  const attempts = await Promise.allSettled([ledger.create('record', { count: 1 }), ledger.create('record', { count: 2 })]);
  assert.equal(attempts.filter((item) => item.status === 'fulfilled').length, 1);
  assert.ok(attempts.find((item) => item.status === 'rejected').reason instanceof LedgerConflictError);
  const first = await ledger.read('record');
  await ledger.compareAndSwap('record', first.etag, { count: 3 });
  await assert.rejects(ledger.compareAndSwap('record', first.etag, { count: 999 }), LedgerConflictError);
  assert.equal((await ledger.read('record')).value.count, 3);
});

test('lost storage acknowledgment is recovered by exact write nonce', async () => {
  const { ledger, storage } = fixture();
  storage.failAfterNextCommit = true;
  const created = await ledger.create('record', { count: 1 });
  assert.equal(created.value.count, 1);
  storage.failAfterNextCommit = true;
  const updated = await ledger.update('record', (value) => ({ count: value.count + 1 }));
  assert.equal(updated.value.count, 2);
  assert.equal((await ledger.read('record')).value.count, 2);
});

test('CAS retries merge simultaneous changes without losing either update', async () => {
  const { ledger } = fixture();
  await ledger.create('counter', { count: 0 });
  await Promise.all([
    ledger.update('counter', (value) => ({ count: value.count + 1 })),
    ledger.update('counter', (value) => ({ count: value.count + 1 })),
  ]);
  assert.equal((await ledger.read('counter')).value.count, 2);
});

test('same thread is serialized while unrelated threads can proceed', async () => {
  const { ledger } = fixture();
  const first = await ledger.acquireLease('thread:one');
  await assert.rejects(ledger.acquireLease('thread:one'), LeaseBusyError);
  const second = await ledger.acquireLease('thread:two');
  assert.notEqual(first.owner, second.owner);
  await first.release();
  const next = await ledger.acquireLease('thread:one');
  await next.release();
  await second.release();
});

test('expired lease takeover cannot be released or renewed by the old owner', async () => {
  const { ledger, advance } = fixture();
  const stale = await ledger.acquireLease('thread:one', { ttlMs: 1000 });
  advance(1001);
  const fresh = await ledger.acquireLease('thread:one');
  await assert.rejects(stale.assertOwned(), LeaseLostError);
  await assert.rejects(stale.renew(), LeaseLostError);
  assert.equal(await stale.release(), false);
  assert.equal((await fresh.assertOwned()).owner, fresh.owner);
  assert.equal(await fresh.release(), true);
});

test('withLease releases after a failed callback and preserves the original error', async () => {
  const { ledger } = fixture();
  const failure = new Error('processor failed');
  await assert.rejects(ledger.withLease('thread:one', async () => { throw failure; }), (error) => error === failure);
  await ledger.withLease('thread:one', async (lease) => lease.assertOwned());
});

test('lease time checks reserve enough time for a bounded side effect', async () => {
  const { ledger, advance } = fixture();
  const lease = await ledger.acquireLease('thread:one', { ttlMs: 2000 });
  advance(1500);
  await assert.rejects(lease.assertOwned({ minRemainingMs: 600 }), LeaseLostError);
  await lease.renew();
  await lease.assertOwned({ minRemainingMs: 600 });
  await lease.release();
});

test('event redelivery and multiple event IDs do not reset a conversation', async () => {
  const { ledger } = fixture();
  const first = await ledger.recordEvent('event-1', { conversationId: 'conversation-1' });
  assert.equal(first.created, true);
  await ledger.updateEvent('event-1', { state: 'completed' });
  const duplicate = await ledger.recordEvent('event-1', { conversationId: 'other' });
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.record.value.state, 'completed');
  assert.equal(duplicate.record.value.conversationId, 'conversation-1');
  await ledger.recordConversation('conversation-1', { threadId: 'thread-1' });
  await ledger.updateConversation('conversation-1', { state: 'completed', notionPageId: 'page-1' });
  await ledger.recordEvent('event-2', { conversationId: 'conversation-1' });
  const sameCall = await ledger.recordConversation('conversation-1');
  assert.equal(sameCall.created, false);
  assert.equal(sameCall.record.value.notionPageId, 'page-1');
  assert.equal(sameCall.record.value.state, 'completed');
});

test('mutation request is journaled before dispatch and completed receipt is reused', async () => {
  const { ledger } = fixture();
  let providerCalls = 0;
  const request = { title: 'Call', databaseId: 'test' };
  await ledger.withLease('thread:one', async (lease) => {
    const invoke = () => ledger.runMutation({
      conversationId: 'call-1', operationId: 'create-page', request, lease,
      perform: async ({ signal, receiptId }) => {
        providerCalls++;
        assert.equal(signal.aborted, false);
        const current = await ledger.getReceipt('call-1', 'create-page');
        assert.equal(current.value.state, 'dispatching');
        assert.equal(current.value.dispatchId, receiptId);
        return { pageId: 'page-1' };
      },
    });
    assert.deepEqual(await invoke(), { replayed: false, result: { pageId: 'page-1' } });
    assert.deepEqual(await invoke(), { replayed: true, result: { pageId: 'page-1' } });
  });
  assert.equal(providerCalls, 1);
});

test('an ambiguous provider failure cannot be blindly replayed', async () => {
  const { ledger } = fixture();
  let providerCalls = 0;
  const args = {
    conversationId: 'call-1', operationId: 'append-transcript', request: { chunk: 1 },
    perform: async () => { providerCalls++; throw new Error('socket closed after write'); },
  };
  await ledger.withLease('thread:one', async (lease) => {
    await assert.rejects(ledger.runMutation({ ...args, lease }), UncertainMutationError);
    assert.equal((await ledger.getReceipt('call-1', 'append-transcript')).value.state, 'uncertain');
    await assert.rejects(ledger.runMutation({ ...args, lease }), UncertainMutationError);
  });
  assert.equal(providerCalls, 1);
  await ledger.completeReceipt('call-1', 'append-transcript', { blockId: 'verified-existing-block' }, { reconciled: true });
  assert.equal((await ledger.getReceipt('call-1', 'append-transcript')).value.reconciled, true);
});

test('crash after dispatch journal leaves a nonreplayable intent', async () => {
  const { ledger } = fixture();
  const request = { operation: 'create-page' };
  await ledger.beginReceipt('call-1', 'create', { requestDigest: requestDigest(request) });
  await ledger.markReceiptSent('call-1', 'create');
  await ledger.withLease('thread:one', async (lease) => {
    await assert.rejects(ledger.runMutation({ conversationId: 'call-1', operationId: 'create', request, lease,
      perform: async () => assert.fail('must not send again'),
    }), UncertainMutationError);
  });
});

test('a successful provider call followed by a ledger outage is not repeated', async () => {
  const { ledger, storage } = fixture();
  const put = storage.put.bind(storage);
  let unavailable = false;
  let providerCalls = 0;
  storage.put = async (...args) => { if (unavailable) throw new Error('temporary storage outage'); return put(...args); };
  const lease = await ledger.acquireLease('thread:one');
  const args = {
    conversationId: 'call-1', operationId: 'create', request: {}, lease,
    perform: async () => { providerCalls++; unavailable = true; return { pageId: 'already-created' }; },
  };
  await assert.rejects(ledger.runMutation(args), UncertainMutationError);
  assert.equal((await ledger.getReceipt('call-1', 'create')).value.state, 'dispatching');
  unavailable = false;
  await assert.rejects(ledger.runMutation(args), UncertainMutationError);
  assert.equal(providerCalls, 1);
  await lease.release();
});

test('receipt operation IDs cannot silently change their request', async () => {
  const { ledger } = fixture();
  await ledger.beginReceipt('call-1', 'create', { requestDigest: requestDigest({ a: 1, b: 2 }) });
  const same = await ledger.beginReceipt('call-1', 'create', { requestDigest: requestDigest({ b: 2, a: 1 }) });
  assert.equal(same.created, false);
  await assert.rejects(ledger.beginReceipt('call-1', 'create', { requestDigest: requestDigest({ a: 999 }) }), ReceiptConflictError);
});

test('lease lost after journaling prevents provider dispatch', async () => {
  const { ledger, advance } = fixture();
  const original = ledger.markReceiptSent.bind(ledger);
  ledger.markReceiptSent = async (...args) => { const value = await original(...args); advance(25_000); return value; };
  const lease = await ledger.acquireLease('thread:one');
  await assert.rejects(ledger.runMutation({
    conversationId: 'call-1', operationId: 'create', request: {}, lease,
    perform: async () => assert.fail('provider must not be called'),
  }), UncertainMutationError);
  const receipt = await ledger.getReceipt('call-1', 'create');
  assert.equal(receipt.value.reason, 'lease_lost_before_dispatch');
});

test('provider deadline aborts the request and leaves an uncertain receipt', async () => {
  const { ledger } = fixture();
  let observedSignal;
  await ledger.withLease('thread:one', async (lease) => {
    await assert.rejects(ledger.runMutation({
      conversationId: 'call-1', operationId: 'create', request: {}, lease, timeoutMs: 5,
      perform: ({ signal }) => { observedSignal = signal; return new Promise(() => {}); },
    }), UncertainMutationError);
  });
  assert.equal(observedSignal.aborted, true);
  assert.equal((await ledger.getReceipt('call-1', 'create')).value.state, 'uncertain');
});
