import test from 'node:test';
import assert from 'node:assert/strict';
import { signedBody, toolSession, route, json } from '../lib/http.mjs';
import { createSessionToken, SecurityError } from '../lib/security.mjs';
import { configuration } from '../lib/config.mjs';
import initializationRoute from '../api/assistant-initialization.js';
import { ASSISTANT, AGENT, CALLER, SECRET, config, publicBase64, signedRequest, responseRecorder } from './helpers.mjs';

function bodyFor(purpose = 'save_call_note') {
  const callControlId = 'v3:active-call';
  return {
    purpose, assistant_id: ASSISTANT, call_control_id: callControlId, agent_target: AGENT, caller_target: CALLER,
    channel: 'phone_call', session_token: createSessionToken({ secret: SECRET, assistantId: ASSISTANT, callControlId, caller: CALLER, agent: AGENT })
  };
}

test('HTTP authentication verifies original bytes before JSON parsing and accepts only POST objects', async () => {
  const body = bodyFor();
  assert.deepEqual(await signedBody(signedRequest(body), config), body);
  await assert.rejects(signedBody(signedRequest(body, { method: 'GET' }), config), { code: 'method_not_allowed', status: 405 });
  const changed = signedRequest(body); changed.rawBody = Buffer.concat([changed.rawBody, Buffer.from(' ')]);
  await assert.rejects(signedBody(changed, config), { code: 'invalid_signature', status: 401 });
  await assert.rejects(signedBody(signedRequest({}, { raw: Buffer.from('{') }), config), { code: 'invalid_json' });
  for (const value of [null, [], 'value', 3]) await assert.rejects(signedBody(signedRequest(value), config), { code: 'invalid_json' });
  await assert.rejects(signedBody(signedRequest(body, { now: Date.now() - 301_000 }), config), { code: 'invalid_signature' });
});

test('tool session requires exact purpose, configured owner, channel, and valid HMAC; unsigned headers cannot substitute', async () => {
  const body = bodyFor();
  const verified = await signedBody(signedRequest(body, { headers: { 'x-call-control-id': 'v3:untrusted-header' } }), config);
  assert.equal(toolSession(verified, config, 'save_call_note').callControlId, body.call_control_id);
  for (const patch of [
    { purpose: 'lookup_open_thread' }, { assistant_id: 'assistant-other' }, { channel: 'sms_chat' },
    { agent_target: '+13125550999' }, { caller_target: '+13125550456' }, { call_control_id: 'v3:other-call' },
    { call_control_id: undefined }, { session_token: '' }, { session_token: '{{nia_session_token}}' }
  ]) {
    const request = signedRequest({ ...body, ...patch });
    const signed = await signedBody(request, config);
    assert.throws(() => toolSession(signed, config, 'save_call_note'), SecurityError);
  }
});

test('a tool route performs no mutation for a signed body with invalid session and never acknowledges a failed write', async t => {
  const logs = [];
  t.mock.method(console, 'error', value => logs.push(value));
  let writes = 0;
  const handler = route(async (req, res) => {
    const body = await signedBody(req, config); toolSession(body, config, 'save_call_note');
    writes += 1;
    throw Object.assign(new Error('provider secret and caller@example.test must not escape'), { code: 'WRITE_FAILED' });
  });
  const unauthorized = responseRecorder();
  await handler(signedRequest({ ...bodyFor(), session_token: '' }), unauthorized);
  assert.equal(writes, 0); assert.equal(unauthorized.statusCode, 403); assert.equal(unauthorized.body.saved, false);
  const failed = responseRecorder(); await handler(signedRequest(bodyFor()), failed);
  assert.equal(writes, 1); assert.equal(failed.statusCode, 503); assert.equal(failed.body.saved, false);
  assert.match(failed.body.instruction, /did not confirm/);
  assert.equal(JSON.stringify([logs, failed]).includes('caller@example.test'), false);
  assert.equal(JSON.stringify([logs, failed]).includes('provider secret'), false);
  assert.equal(failed.headers['cache-control'], 'no-store');
  assert.equal(failed.headers['x-content-type-options'], 'nosniff');
});

test('configuration checks dedicated secrets and never requires provider write tokens for initialization', () => {
  const env = { NIA_ASSISTANT_ID: ASSISTANT, NIA_AGENT_NUMBER: AGENT, TELNYX_PUBLIC_KEY: publicBase64, NIA_SESSION_SECRET: SECRET };
  assert.equal(configuration(env, { full: false }).assistantId, ASSISTANT);
  assert.throws(() => configuration(env), { code: 'configuration_missing' });
  const full = { ...env, TELNYX_API_KEY: 'synthetic-key', NOTION_TOKEN: 'synthetic-token', NOTION_DATA_SOURCE_ID: config.dataSourceId, NIA_LEDGER_HASH_SECRET: SECRET };
  assert.throws(() => configuration(full), /separate/);
  assert.throws(() => configuration({ ...env, NIA_SESSION_SECRET: 'short' }, { full: false }), /32 bytes/);
  assert.throws(() => configuration({ ...env, TELNYX_PUBLIC_KEY: 'malformed' }, { full: false }), /public key/);
});

test('actual initialization endpoint returns scoped memory and a usable session with no false match', async t => {
  const env = { NIA_ASSISTANT_ID: ASSISTANT, NIA_AGENT_NUMBER: AGENT, TELNYX_PUBLIC_KEY: publicBase64, NIA_SESSION_SECRET: SECRET };
  const before = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => { for (const [key, value] of Object.entries(before)) value === undefined ? delete process.env[key] : process.env[key] = value; });
  const event = { data: { event_type: 'assistant.initialization', payload: {
    assistant_id: ASSISTANT, call_control_id: 'v3:active-call', telnyx_agent_target: AGENT,
    telnyx_end_user_target: CALLER, telnyx_conversation_channel: 'phone_call'
  } } };
  const res = responseRecorder(); await initializationRoute(signedRequest(event), res);
  assert.equal(res.statusCode, 200); assert.equal(res.body.dynamic_variables.callback_context_found, 'no');
  const query = new URLSearchParams(res.body.memory.conversation_query);
  assert.equal(query.get('metadata->assistant_id'), `eq.${ASSISTANT}`);
  assert.equal(query.get('metadata->telnyx_end_user_target'), `eq.${CALLER}`);
  const toolBody = { ...bodyFor(), session_token: res.body.dynamic_variables.nia_session_token };
  assert.equal(toolSession(toolBody, config, 'save_call_note').caller, CALLER);
});

test('JSON response has no cacheable action receipt', () => {
  const res = responseRecorder(); json(res, 202, { accepted: true, saved: false });
  assert.equal(res.statusCode, 202); assert.equal(res.headers['cache-control'], 'no-store');
  assert.deepEqual(res.body, { accepted: true, saved: false });
});
