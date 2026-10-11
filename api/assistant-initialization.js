import { configuration } from '../lib/config.mjs';
import { initialize } from '../lib/security.mjs';
import { json, route, signedBody } from '../lib/http.mjs';
export const config = { api: { bodyParser: false } };
export default route(async (req, res) => {
  const settings = configuration(process.env, { full: false });
  const body = await signedBody(req, settings);
  json(res, 200, initialize(body, settings));
});
