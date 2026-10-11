import { getRuntime } from '../lib/runtime.mjs';
import { parsePostCallEvent } from '../lib/security.mjs';
import { json, route, signedBody } from '../lib/http.mjs';
export const config = { api: { bodyParser: false } };
export default route(async (req, res) => {
  const relay = await getRuntime();
  const body = await signedBody(req, relay.config);
  const event = parsePostCallEvent(body, relay.config);
  if (!event) return json(res, 200, { accepted: false, ignored: true });
  json(res, 200, await relay.acceptEvent(event));
});
