import { getRuntime } from '../lib/runtime.mjs';
import { json, route, signedBody, toolSession } from '../lib/http.mjs';
import { withDeadline } from '../lib/deadline.mjs';
export const config = { api: { bodyParser: false } };
export default route(async (req, res) => {
  const relay = await getRuntime();
  const body = await signedBody(req, relay.config);
  const session = toolSession(body, relay.config, 'lookup_open_thread');
  json(res, 200, await withDeadline(6500, () => relay.lookup(session, body)));
});
