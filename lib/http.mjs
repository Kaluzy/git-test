import { SecurityError, readRawBody, verifyTelnyxWebhook, verifySessionToken, validCallControlId, normalizePhone } from './security.mjs';

export function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify(body));
}

export async function signedBody(req, config) {
  if (req.method !== 'POST') throw new SecurityError('method_not_allowed', 'Use POST.', 405);
  const rawBody = await readRawBody(req);
  if (!verifyTelnyxWebhook({ rawBody, headers: req.headers, publicKey: config.publicKey })) throw new SecurityError('invalid_signature', 'Invalid webhook signature.', 401);
  let body;
  try { body = JSON.parse(rawBody.toString('utf8')); } catch { throw new SecurityError('invalid_json', 'Invalid JSON.'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new SecurityError('invalid_json', 'A JSON object is required.');
  return body;
}

export function toolSession(body, config, purpose) {
  if (body.purpose !== purpose || body.assistant_id !== config.assistantId || body.channel !== 'phone_call' || normalizePhone(body.agent_target) !== config.agentNumber || !validCallControlId(body.call_control_id)) throw new SecurityError('invalid_tool_binding', 'The tool session could not be verified.', 403);
  const claims = verifySessionToken({ token: body.session_token, secret: config.sessionSecret, assistantId: config.assistantId, callControlId: body.call_control_id, caller: body.caller_target, agent: body.agent_target });
  if (!claims) throw new SecurityError('invalid_session', 'The tool session is unavailable or expired.', 403);
  return claims;
}

export function route(handler) {
  return async (req, res) => {
    try { await handler(req, res); }
    catch (error) {
      // Do not put caller information, provider response bodies, or credentials in logs.
      const status = error instanceof SecurityError ? error.status : 503;
      const code = /^[a-zA-Z0-9_]{1,80}$/.test(error?.code || '') ? error.code : 'service_unavailable';
      console.error(JSON.stringify({ service: 'nia-relay', code, status }));
      json(res, status, { ok: false, error: code, saved: false, instruction: 'The service did not confirm this action. Explain that briefly; do not claim a save, booking, or follow-up.' });
    }
  };
}
