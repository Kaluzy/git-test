import { createHash } from 'node:crypto';

export const QUEUE_TOPIC = 'nia-call-events';
export const QUEUE_RETENTION_SECONDS = 7 * 24 * 60 * 60;
const EVENT_ID = /^[A-Za-z0-9_-]{1,160}$/;
const REDRIVE_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
let clientPromise;

export function validateEventId(eventId) {
  if (typeof eventId !== 'string' || !EVENT_ID.test(eventId)) {
    throw Object.assign(new TypeError('Invalid queue event ID'), { code: 'invalid_queue_event' });
  }
  return eventId;
}

export function queueIdempotencyKey(eventId, { redriveId } = {}) {
  validateEventId(eventId);
  if (redriveId === undefined) return eventId;
  if (typeof redriveId !== 'string' || !REDRIVE_ID.test(redriveId)) {
    throw Object.assign(new TypeError('A UUID v4 redrive ID is required'), { code: 'invalid_redrive_id' });
  }
  // Reusing the same operator attempt remains idempotent; a fresh operator
  // attempt bypasses the queue's 24-hour publish deduplication window. Durable
  // event/conversation/receipt records remain authoritative in either case.
  return `redrive-${createHash('sha256').update(JSON.stringify([eventId, redriveId.toLowerCase()])).digest('hex')}`;
}

export async function getQueueClient() {
  if (!clientPromise) {
    const region = process.env.NIA_REGION || 'iad1';
    if (!/^[a-z]{3}[1-9][0-9]?$/.test(region)) throw new TypeError('Invalid NIA_REGION');
    clientPromise = import('@vercel/queue').then(({ QueueClient }) => new QueueClient({ region }));
    clientPromise.catch(() => { clientPromise = undefined; });
  }
  return clientPromise;
}

/** Awaiting send is required before acknowledging an external webhook. */
export function createSender(client) {
  if (typeof client?.send !== 'function') throw new TypeError('Queue client is required');
  return async (eventId, options) => {
    const idempotencyKey = queueIdempotencyKey(eventId, options);
    return await client.send(QUEUE_TOPIC, { eventId }, {
      idempotencyKey,
      retentionSeconds: QUEUE_RETENTION_SECONDS,
    });
  };
}

export async function sendEvent(eventId, options) {
  // Validate before loading SDK credentials or contacting infrastructure.
  queueIdempotencyKey(eventId, options);
  return createSender(await getQueueClient())(eventId, options);
}

/**
 * Do not acknowledge exhausted/poison work here. maxDeliveries=20 bounds
 * infrastructure delivery attempts, while the relay's pending event index
 * retains the work for operator inspection/redrive after that point.
 */
export function retryQueueMessage(error, metadata = {}) {
  const count = Number.isSafeInteger(metadata.deliveryCount) && metadata.deliveryCount > 0
    ? Math.min(metadata.deliveryCount, 16) : 1;
  const backoffSeconds = Math.min(300, 5 * 2 ** count);
  const explicitMs = Number.isFinite(error?.retryAfterMs) && error.retryAfterMs > 0 ? error.retryAfterMs : 0;
  // Honor provider Retry-After and durable lease delays up to the platform's
  // documented one-day retry configuration bound. Expiry remains queue-owned.
  return { afterSeconds: Math.min(86_400, Math.max(backoffSeconds, Math.ceil(explicitMs / 1000))) };
}

export function createConsumer({ client, getRuntime }) {
  if (typeof client?.handleNodeCallback !== 'function' || typeof getRuntime !== 'function') {
    throw new TypeError('Queue client and runtime factory are required');
  }
  return client.handleNodeCallback(async message => {
    if (!message || typeof message !== 'object' || Array.isArray(message) ||
      Object.keys(message).length !== 1 || !Object.hasOwn(message, 'eventId')) {
      throw Object.assign(new TypeError('Invalid queue event payload'), { code: 'invalid_queue_event' });
    }
    const eventId = validateEventId(message.eventId);
    const runtime = await getRuntime();
    await runtime.processQueuedEvent(eventId);
  }, {
    visibilityTimeoutSeconds: 90,
    retry: retryQueueMessage,
  });
}
