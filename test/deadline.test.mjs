import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { withDeadline, deadlineSignal, remainingMs, throwIfExpired, awaitWithSignal } from '../lib/deadline.mjs';
import { BlobLedger } from '../lib/ledger.mjs';
import { TelnyxClient } from '../lib/telnyx.mjs';
import { NotionClient } from '../lib/notion.mjs';

const isDeadline = error => error?.code === 'worker_deadline';
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const json = data => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });

test('concurrent request deadlines are isolated and cancel an uncooperative await', async () => {
  assert.equal(remainingMs(100), 100);
  assert.equal(deadlineSignal(), undefined);
  let shortSignal;
  const short = withDeadline(30, async () => {
    shortSignal = deadlineSignal();
    assert.ok(remainingMs(100) <= 30);
    await new Promise(() => {});
  });
  const rejected = assert.rejects(short, isDeadline);
  const result = await withDeadline(1000, async () => {
    const signal = deadlineSignal();
    await rejected;
    assert.equal(shortSignal.aborted, true);
    assert.equal(signal.aborted, false);
    assert.ok(remainingMs() > 0);
    throwIfExpired();
    return 'other request completed';
  });
  assert.equal(result, 'other request completed');
  assert.equal(deadlineSignal(), undefined);
});

test('nested scopes cannot extend the parent and caller cancellation is preserved', async () => {
  await assert.rejects(withDeadline(25, () => withDeadline(1000, async () => {
    assert.ok(remainingMs() <= 25);
    await new Promise(() => {});
  })), isDeadline);
  const controller = new AbortController();
  const cancelled = withDeadline(1000, async () => {
    const signal = deadlineSignal(controller.signal);
    controller.abort(new Error('caller cancelled'));
    await awaitWithSignal(Promise.resolve('late response'), signal);
  });
  await assert.rejects(cancelled, /caller cancelled/);
});

test('a completed scope prevents escaped work from starting a later mutation', async () => {
  const gate = deferred(); let escaped; let writes = 0;
  await withDeadline(1000, async () => {
    escaped = gate.promise.then(() => { throwIfExpired(); writes++; });
  });
  const rejected = assert.rejects(escaped, isDeadline);
  gate.resolve();
  await rejected;
  assert.equal(writes, 0);
});

test('Blob cancellation blocks follow-on writes even when a late put returns success', async () => {
  const late = deferred(); let calls = 0; let signal;
  const ledger = new BlobLedger({ namespace: 'deadline-test', storage: {
    async get() { throw new Error('No reconciliation read is allowed after expiry'); },
    async put(_path, _body, options) { calls++; signal = options.abortSignal; return late.promise; },
  } });
  await assert.rejects(withDeadline(30, async () => {
    await ledger.create('first', { one: true });
    await ledger.create('second', { two: true });
  }), isDeadline);
  assert.equal(signal.aborted, true);
  late.resolve({ etag: 'late-commit' });
  await nextTurn();
  assert.equal(calls, 1);
});

function memoryStorage() {
  const rows = new Map(); let sequence = 0;
  return {
    async get(path) {
      const row = rows.get(path);
      return row ? { statusCode: 200, stream: new Response(row.body).body, blob: { etag: row.etag, size: Buffer.byteLength(row.body) } } : null;
    },
    async put(path, body, options) {
      const prior = rows.get(path);
      if ((!options.allowOverwrite && prior) || (options.ifMatch && prior?.etag !== options.ifMatch)) {
        const error = new Error('Conflict'); error.name = 'BlobPreconditionFailedError'; throw error;
      }
      const etag = String(++sequence); rows.set(path, { body, etag }); return { etag };
    },
  };
}

test('expiry during a provider write leaves durable dispatch intent that cannot be replayed', async () => {
  const ledger = new BlobLedger({ namespace: 'deadline-receipt', storage: memoryStorage() });
  let lease, providerSignal, attempts = 0;
  await assert.rejects(withDeadline(35, () => ledger.withLease('thread', async owned => {
    lease = owned;
    return ledger.runMutation({ conversationId: 'call', operationId: 'append', request: { transcript: 'fixture' }, lease,
      timeoutMs: 1000, perform: async ({ signal }) => { attempts++; providerSignal = signal; return new Promise(() => {}); } });
  })), isDeadline);
  assert.equal(providerSignal.aborted, true);
  assert.equal((await ledger.getReceipt('call', 'append')).value.state, 'dispatching');
  await assert.rejects(ledger.runMutation({ conversationId: 'call', operationId: 'append', request: { transcript: 'fixture' }, lease,
    perform: async () => { attempts++; return 'must not replay'; } }), { code: 'MUTATION_UNCERTAIN' });
  assert.equal(attempts, 1);
});

test('Telnyx client cancellation is scoped to the current worker', async () => {
  const started = deferred(); let slowSignal;
  const settings = { apiKey: 'synthetic-key', assistantId: 'assistant-test', agentNumber: '+13125550100', maxRetries: 0 };
  const client = new TelnyxClient({ ...settings, fetchImpl: async (url, { signal }) => {
    const id = url.split('/').at(-1);
    if (id === 'slow') { slowSignal = signal; started.resolve(); return new Promise(() => {}); }
    return json({ data: { id, metadata: { assistant_id: settings.assistantId, telnyx_agent_target: settings.agentNumber, telnyx_conversation_channel: 'phone_call' } } });
  } });
  const rejected = assert.rejects(withDeadline(30, () => client.getConversation('slow')), isDeadline);
  await started.promise;
  assert.equal((await withDeadline(1000, () => client.getConversation('fast'))).id, 'fast');
  await rejected;
  assert.equal(slowSignal.aborted, true);
});

const SOURCE = '10000000-0000-4000-8000-000000000001';
const PAGE = '10000000-0000-4000-8000-000000000004';
const BOT = '10000000-0000-4000-8000-000000000002';
const page = () => ({ object: 'page', id: PAGE, parent: { type: 'data_source_id', data_source_id: SOURCE }, properties: {
  Summary: { type: 'rich_text', rich_text: [{ type: 'text', text: { content: 'Before' } }] },
} });

test('Notion never performs readback or another write after a late accepted mutation', async () => {
  const late = deferred(); const methods = []; let writeSignal; let mutation;
  const client = new NotionClient({ token: 'synthetic-token', dataSourceId: SOURCE, maxRetries: 0, fetchImpl: async (_url, options) => {
    methods.push(options.method);
    if (options.method === 'PATCH') { writeSignal = options.signal; return late.promise; }
    return json(page());
  } });
  await assert.rejects(withDeadline(30, () => {
    mutation = client.updateThread(PAGE, { Summary: 'After' });
    return mutation;
  }), isDeadline);
  await assert.rejects(mutation, error => error.ambiguous === true);
  assert.equal(writeSignal.aborted, true);
  late.resolve(json(page()));
  await nextTurn();
  assert.deepEqual(methods, ['GET', 'PATCH']);
});

test('Notion bot identity cache does not share the first caller deadline with another worker', async () => {
  const started = deferred(); let identityReads = 0; let firstSignal;
  const client = new NotionClient({ token: 'synthetic-token', dataSourceId: SOURCE, maxRetries: 0, fetchImpl: async (url, { signal }) => {
    if (url.endsWith('/users/me')) {
      identityReads++;
      if (identityReads === 1) { firstSignal = signal; started.resolve(); return new Promise(() => {}); }
      return json({ object: 'user', type: 'bot', id: BOT });
    }
    if (url.includes('/blocks/')) return json({ object: 'list', results: [], has_more: false, next_cursor: null });
    return json(page());
  } });
  const rejected = assert.rejects(withDeadline(35, () => client.hasConversation(PAGE, 'slow')), isDeadline);
  await started.promise;
  assert.equal(await withDeadline(1000, () => client.hasConversation(PAGE, 'other')), false);
  await rejected;
  assert.equal(firstSignal.aborted, true);
  assert.equal(identityReads, 2);
});
