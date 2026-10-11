import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { BlobLedger } from '../lib/ledger.mjs';
import { pageToThread } from '../lib/notion.mjs';

export const clone = value => structuredClone(value);
export const ASSISTANT = 'assistant-relay-test';
export const AGENT = '+13125550100';
export const CALLER = '+13125550123';
export const SOURCE = '10000000-0000-4000-8000-000000000001';
export const ORIGINAL = '20000000-0000-4000-8000-000000000001';
export const CALLBACK = '20000000-0000-4000-8000-000000000002';
export const CALLBACK_TWO = '20000000-0000-4000-8000-000000000003';
export const PAGE = '30000000-0000-4000-8000-000000000001';
export const SECRET = 'synthetic-session-secret-at-least-32-bytes';
export const HASH_SECRET = 'separate-synthetic-ledger-secret-at-least-32-bytes';
export const { privateKey, publicKey } = generateKeyPairSync('ed25519');
export const publicBase64 = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
export const config = {
  assistantId: ASSISTANT, agentNumber: AGENT, publicKey: publicBase64, sessionSecret: SECRET,
  hashSecret: HASH_SECRET, namespace: 'integration-test', insightGroupId: 'group-test',
  telnyxApiKey: 'synthetic-telnyx-credential', notionToken: 'synthetic-notion-credential', dataSourceId: SOURCE
};

export function signedRequest(body, { now = Date.now(), method = 'POST', headers = {}, raw } = {}) {
  const rawBody = raw ?? Buffer.from(JSON.stringify(body));
  const timestamp = String(Math.floor(now / 1000));
  return { method, rawBody, headers: {
    'content-type': 'application/json', 'telnyx-timestamp': timestamp,
    'telnyx-signature-ed25519': sign(null, Buffer.concat([Buffer.from(`${timestamp}|`), rawBody]), privateKey).toString('base64'),
    ...headers
  } };
}

export function responseRecorder() {
  return {
    statusCode: null, headers: {}, ended: false, body: undefined,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    end(value) { assert.equal(this.ended, false, 'a response may be sent only once'); this.ended = true; this.body = JSON.parse(value); }
  };
}

export class MemoryBlobStorage {
  rows = new Map(); calls = []; version = 0; failAfterNextCommit = false;
  async get(path, options) {
    this.calls.push({ op: 'get', path });
    assert.equal(options.access, 'private'); assert.equal(options.useCache, false);
    options.abortSignal?.throwIfAborted();
    const row = this.rows.get(path);
    return row ? { statusCode: 200, stream: new Response(row.body).body, blob: { etag: row.etag, size: Buffer.byteLength(row.body) } } : null;
  }
  async put(path, body, options) {
    this.calls.push({ op: 'put', path });
    assert.equal(options.access, 'private'); assert.equal(options.addRandomSuffix, false);
    options.abortSignal?.throwIfAborted();
    const before = this.rows.get(path);
    if ((!options.allowOverwrite && before) || (options.ifMatch && before?.etag !== options.ifMatch)) {
      throw Object.assign(new Error('Storage precondition failed'), { name: 'BlobPreconditionFailedError' });
    }
    const etag = `"test-etag-${++this.version}"`;
    this.rows.set(path, { body, etag });
    if (this.failAfterNextCommit) { this.failAfterNextCommit = false; throw new Error('Acknowledgment lost after storage commit'); }
    return { etag, pathname: path };
  }
}

export function ledgerFixture() {
  const storage = new MemoryBlobStorage();
  let now = Date.parse('2026-10-11T20:00:00Z');
  const ledger = new BlobLedger({ storage, namespace: config.namespace, hashSecret: HASH_SECRET, now: () => now, leaseMs: 120_000 });
  return { storage, ledger, now: () => now, advance: ms => { now += ms; } };
}

const rich = value => [{ type: 'text', text: { content: String(value) }, plain_text: String(value) }];
const textProperty = value => ({ type: 'rich_text', rich_text: rich(value ?? '') });
const titleProperty = value => ({ type: 'title', title: rich(value ?? '') });
const selectProperty = value => ({ type: 'select', select: value == null ? null : { name: value } });
const dateProperty = value => ({ type: 'date', date: value ? { start: value, end: null } : null });

export function canonicalPage(values = {}) {
  const thread = {
    pageId: PAGE, threadId: 'example-store-thread', title: 'Example Store inquiry', business: 'Example Store',
    phone: CALLER, mission: 'Check widget availability and current store price.', type: 'Store Inquiry',
    direction: 'Outbound', originalConversationId: ORIGINAL, startedAt: '2026-10-10T10:00:00Z',
    lastContact: '2026-10-10T10:02:00Z', callbackCount: 0, status: 'Follow-up',
    summary: 'Original employee response', outcome: 'Price awaiting confirmation', nextAction: 'Review the callback', ...values
  };
  return {
    object: 'page', id: thread.pageId, parent: { type: 'data_source_id', data_source_id: SOURCE }, properties: {
      Call: titleProperty(thread.title), 'Thread ID': textProperty(thread.threadId),
      'Business / Person': textProperty(thread.business), Phone: { type: 'phone_number', phone_number: thread.phone },
      Mission: textProperty(thread.mission), Type: selectProperty(thread.type), Direction: selectProperty(thread.direction),
      'Conversation ID': textProperty(thread.originalConversationId), Timestamp: dateProperty(thread.startedAt),
      'Last Contact': dateProperty(thread.lastContact), 'Callback Count': { type: 'number', number: thread.callbackCount },
      Summary: textProperty(thread.summary), Outcome: textProperty(thread.outcome),
      'Next Action': textProperty(thread.nextAction), Status: selectProperty(thread.status)
    }
  };
}

/** Implements the adapter contract while always returning real-shaped Notion pages. */
export class FakeNotion {
  pages = new Map(); transcripts = new Map(); writes = []; reads = []; sequence = 10;
  constructor(pages = [canonicalPage()]) { for (const page of pages) this.pages.set(page.id, clone(page)); }
  async getPage(pageId, { signal } = {}) {
    signal?.throwIfAborted(); this.reads.push({ op: 'getPage', pageId });
    const page = this.pages.get(pageId); if (!page) throw Object.assign(new Error('Missing page'), { code: 'not_found' });
    return clone(page);
  }
  async findThread(threadId, options = {}) {
    options.signal?.throwIfAborted(); this.reads.push({ op: 'findThread', threadId });
    const found = [...this.pages.values()].filter(page => pageToThread(page).threadId === threadId);
    if (found.length > 1) throw Object.assign(new Error('Duplicate thread'), { code: 'duplicate_thread' });
    return clone(found[0] ?? null);
  }
  async listThreads({ status = 'Follow-up', limit = 50 } = {}) {
    const pages = [...this.pages.values()].filter(page => status == null || pageToThread(page).status === status);
    return { pages: clone(pages.slice(0, limit)), complete: pages.length <= limit };
  }
  async createThread(thread, call, { signal } = {}) {
    signal?.throwIfAborted();
    const found = await this.findThread(thread.threadId); if (found) return found.id;
    const pageId = `30000000-0000-4000-8000-${String(this.sequence++).padStart(12, '0')}`;
    this.pages.set(pageId, canonicalPage({ ...thread, pageId, callbackCount: 0 }));
    this.writes.push({ op: 'createThread', pageId, thread: clone(thread) });
    if (call) await this.appendConversation(pageId, call, { signal });
    return pageId;
  }
  async appendConversation(pageId, call, { signal } = {}) {
    signal?.throwIfAborted(); await this.getPage(pageId);
    const key = `${pageId}:${call.conversationId}`;
    if (!this.transcripts.has(key)) {
      this.writes.push({ op: 'appendConversation', pageId, call: clone(call) });
      this.transcripts.set(key, clone(call));
      return { pageId, conversationId: call.conversationId, verified: true, status: 'saved', contentHash: 'a'.repeat(64) };
    }
    assert.deepEqual(call, this.transcripts.get(key), 'The same conversation must have identical immutable content');
    return { pageId, conversationId: call.conversationId, verified: true, status: 'already_saved', contentHash: 'a'.repeat(64) };
  }
  async hasConversation(pageId, conversationId, { signal } = {}) {
    signal?.throwIfAborted(); return this.transcripts.has(`${pageId}:${conversationId}`);
  }
  async updateThread(pageId, values, { signal } = {}) {
    signal?.throwIfAborted(); const page = this.pages.get(pageId); if (!page) throw new Error('Missing page');
    this.writes.push({ op: 'updateThread', pageId, values: clone(values) });
    for (const [key, value] of Object.entries(values)) {
      if (key.startsWith('date:')) {
        const [, name, field] = key.split(':');
        if (field === 'start') page.properties[name] = dateProperty(value);
      } else if (key === 'Callback Count') page.properties[key] = { type: 'number', number: value };
      else if (['Status', 'Type', 'Direction'].includes(key)) page.properties[key] = selectProperty(value);
      else if (key === 'Call') page.properties[key] = titleProperty(value);
      else if (key === 'Phone') page.properties[key] = { type: 'phone_number', phone_number: value };
      else page.properties[key] = textProperty(value);
    }
    return { pageId, verified: true };
  }
  thread(pageId = PAGE) { return pageToThread(this.pages.get(pageId)); }
}
