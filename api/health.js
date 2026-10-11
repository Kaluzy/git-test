import { configuration } from '../lib/config.mjs';
import { json, route } from '../lib/http.mjs';
export default route(async (req, res) => {
  if (req.method !== 'GET') return json(res, 405, { ok: false });
  configuration();
  json(res, 200, { ok: true, service: 'nia-relay', version: 2, scope: 'configuration-only; provider connectivity and queue delivery require preflight' });
});
