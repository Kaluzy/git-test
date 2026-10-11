import { configuration } from './config.mjs';
import { BlobLedger } from './ledger.mjs';
import { TelnyxClient } from './telnyx.mjs';
import { NotionClient } from './notion.mjs';
import { Relay } from './relay.mjs';

let runtime;
export async function getRuntime() {
  if (runtime) return runtime;
  const config = configuration();
  const ledger = new BlobLedger({ namespace: config.namespace, hashSecret: config.hashSecret, leaseMs: 120_000 });
  const telnyx = new TelnyxClient({ apiKey: config.telnyxApiKey, assistantId: config.assistantId, agentNumber: config.agentNumber, timeoutMs: 3500, maxRetries: 0, maxPages: 5 });
  const notion = new NotionClient({ token: config.notionToken, dataSourceId: config.dataSourceId, timeoutMs: 5000, maxRetries: 1, maxInlineRetryAfterMs: 1000 });
  const { sendEvent } = await import('./queue.mjs');
  runtime = new Relay({ config, ledger, telnyx, notion, enqueue: sendEvent });
  return runtime;
}
