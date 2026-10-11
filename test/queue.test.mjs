import test from 'node:test';
import assert from 'node:assert/strict';
import { createSender, createConsumer, retryQueueMessage, queueIdempotencyKey } from '../lib/queue.mjs';

test('publisher awaits durable acceptance with a stable key and minimal payload', async () => {
  const calls = [];
  let resolveSend;
  const sender = createSender({ send: (...args) => { calls.push(args); return new Promise(resolve => { resolveSend = resolve; }); } });
  let settled = false;
  const pending = sender('event_123').then(result => { settled = true; return result; });
  await Promise.resolve();
  assert.equal(settled, false);
  assert.deepEqual(calls, [['nia-call-events', { eventId: 'event_123' }, { idempotencyKey: 'event_123', retentionSeconds: 604800 }]]);
  resolveSend({ messageId: 'queue_123' });
  assert.deepEqual(await pending, { messageId: 'queue_123' });
});

test('publish failure propagates so the webhook cannot falsely acknowledge work', async () => {
  const failure = new Error('queue unavailable');
  const sender = createSender({ send: async () => { throw failure; } });
  await assert.rejects(sender('event_123'), error => error === failure);
});

test('invalid event or redrive identifiers fail before any queue call', async () => {
  const sender = createSender({ send: async () => assert.fail('invalid input must not publish') });
  for (const id of ['', ' event', 'event/../x', 'a'.repeat(161), null, {}]) await assert.rejects(sender(id), { code: 'invalid_queue_event' });
  await assert.rejects(sender('event_123', { redriveId: 'arbitrary' }), { code: 'invalid_redrive_id' });
});

test('operator redrive changes only the idempotency key and is stable per attempt', async () => {
  const first = '00000000-0000-4000-8000-000000000001';
  const second = '00000000-0000-4000-8000-000000000002';
  const normal = queueIdempotencyKey('event_123');
  const redrive = queueIdempotencyKey('event_123', { redriveId: first });
  assert.equal(redrive, queueIdempotencyKey('event_123', { redriveId: first }));
  assert.notEqual(normal, redrive);
  assert.notEqual(redrive, queueIdempotencyKey('event_123', { redriveId: second }));
  const calls = [];
  await createSender({ send: async (...args) => { calls.push(args); return {}; } })('event_123', { redriveId: first });
  assert.deepEqual(calls[0][1], { eventId: 'event_123' });
  assert.equal(calls[0][2].idempotencyKey, redrive);
});

function fakeClient() {
  const client = {
    handler: null, options: null,
    handleNodeCallback(handler, options) { this.handler = handler; this.options = options; return handler; },
  };
  return client;
}

test('private consumer awaits processing and propagates final errors', async () => {
  const client = fakeClient();
  const failure = new Error('runtime failed');
  const calls = [];
  const consumer = createConsumer({ client, getRuntime: async () => ({ processQueuedEvent: async id => { calls.push(id); throw failure; } }) });
  await assert.rejects(consumer({ eventId: 'event_123' }), error => error === failure);
  assert.deepEqual(calls, ['event_123']);
  assert.equal(client.options.visibilityTimeoutSeconds, 90);
  assert.equal(client.options.retry, retryQueueMessage);
  assert.equal(Object.hasOwn(client.options.retry(failure, { deliveryCount: 20 }), 'acknowledge'), false);
});

test('consumer rejects malformed messages before initializing runtime', async () => {
  const consumer = createConsumer({ client: fakeClient(), getRuntime: async () => assert.fail('invalid input must not initialize runtime') });
  for (const value of [null, [], 'event_123', {}, { eventId: '../bad' }, { eventId: 'event_123', transcript: 'extra payload' }]) {
    await assert.rejects(consumer(value), { code: 'invalid_queue_event' });
  }
});

test('retry delay is bounded and respects provider and lease retry delays', () => {
  assert.deepEqual(retryQueueMessage({}, { deliveryCount: 1 }), { afterSeconds: 10 });
  assert.deepEqual(retryQueueMessage({}, { deliveryCount: 20 }), { afterSeconds: 300 });
  assert.deepEqual(retryQueueMessage({ retryAfterMs: 120_500 }, { deliveryCount: 1 }), { afterSeconds: 121 });
  assert.deepEqual(retryQueueMessage({ retryAfterMs: 900_000 }, { deliveryCount: 20 }), { afterSeconds: 900 });
  assert.deepEqual(retryQueueMessage({ retryAfterMs: Number.POSITIVE_INFINITY }, {}), { afterSeconds: 10 });
  assert.deepEqual(retryQueueMessage({ retryAfterMs: 1e12 }, {}), { afterSeconds: 86400 });
});
