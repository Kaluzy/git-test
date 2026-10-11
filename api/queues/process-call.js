import { getRuntime } from '../../lib/runtime.mjs';
import { createConsumer, getQueueClient } from '../../lib/queue.mjs';

let consumer;

// vercel.json registers this as a private queue consumer. Do not expose it via
// an ordinary public webhook route or call it directly during operator replay.
export default async function processCall(req, res) {
  if (!consumer) consumer = createConsumer({ client: await getQueueClient(), getRuntime });
  return await consumer(req, res);
}
