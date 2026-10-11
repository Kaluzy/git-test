import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  MAX_WEBHOOK_BYTES, normalizePhone, readRawBody, verifyTelnyxWebhook,
  createSessionToken, verifySessionToken, initialize, parsePostCallEvent
} from '../lib/security.mjs';

const now = Date.parse('2026-10-11T20:00:00Z');
const assistantId = 'assistant-test';
const agentNumber = '+13125550100';
const caller = '+13125550123';
const callControlId = 'v3:call-example';
const sessionSecret = 'synthetic-test-secret-at-least-32-bytes';
const options = { assistantId, agentNumber, sessionSecret, now };
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const publicBase64 = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
const initEvent = () => ({
  data: { record_type: 'event', id: 'event-init', event_type: 'assistant.initialization', payload: {
    assistant_id: assistantId, call_control_id: callControlId,
    telnyx_agent_target: agentNumber, telnyx_end_user_target: caller,
    telnyx_conversation_channel: 'phone_call'
  } }
});
const headersFor = (raw, sentAt = now) => {
  const timestamp = String(Math.floor(sentAt / 1000));
  return {
    'telnyx-timestamp': timestamp,
    'telnyx-signature-ed25519': sign(null, Buffer.concat([Buffer.from(`${timestamp}|`), Buffer.from(raw)]), privateKey).toString('base64')
  };
};
const verifyRaw = (raw, headers = headersFor(raw)) => verifyTelnyxWebhook({ rawBody: raw, headers, publicKey: publicBase64, now });

test('E.164 normalization never guesses a country or strips arbitrary characters', () => {
  for (const value of [agentNumber, '+442079460123', '+6831234', '+123456789012345']) assert.equal(normalizePhone(value), value);
  assert.equal(normalizePhone(` ${caller} `), caller);
  for (const value of ['3125550123', '(312) 555-0123', 'call +13125550123', '+1 3125550123', '+0123456789', '+1234567890123456', '＋13125550123', 13125550123, null, {}]) {
    assert.equal(normalizePhone(value), '');
  }
});

test('signatures cover exact raw bytes for wrapped events and flat tool/insight bodies', () => {
  const bodies = [initEvent(), { purpose: 'lookup_open_thread', business: 'Café' }, { record_type: 'event', event_type: 'conversation_insight_result', payload: {} }];
  for (const value of bodies) {
    const raw = Buffer.from(JSON.stringify(value));
    const headers = headersFor(raw);
    assert.equal(verifyRaw(raw, headers), true);
    assert.equal(verifyRaw(Buffer.concat([raw, Buffer.from(' ')]), headers), false);
    assert.equal(verifyRaw(raw, new Headers(headers)), true);
    assert.equal(verifyRaw(raw, {}), false);
  }
  assert.equal(verifyTelnyxWebhook({ rawBody: '{}', headers: headersFor('{}'), publicKey: 'invalid', now }), false);
  assert.equal(verifyTelnyxWebhook({ rawBody: {}, headers: headersFor('{}'), publicKey: publicBase64, now }), false);
});

test('correctly signed stale and future webhooks fail; timestamp rejection is independent of signature validity', () => {
  const raw = Buffer.from('{}');
  for (const delta of [-301_000, 301_000]) assert.equal(verifyRaw(raw, headersFor(raw, now + delta)), false);
  for (const delta of [-299_000, 299_000]) assert.equal(verifyRaw(raw, headersFor(raw, now + delta)), true);
  const headers = headersFor(raw);
  headers['telnyx-signature-ed25519'] += '!';
  assert.equal(verifyRaw(raw, headers), false);
});

test('unsigned call headers cannot establish a tool session; the signed body and HMAC must match every binding', () => {
  const token = initialize(initEvent(), options).dynamic_variables.nia_session_token;
  const body = {
    purpose: 'lookup_open_thread', assistant_id: assistantId, call_control_id: callControlId,
    agent_target: agentNumber, caller_target: caller, channel: 'phone_call', session_token: token
  };
  const raw = Buffer.from(JSON.stringify(body));
  const headers = headersFor(raw);
  // Both headers verify: they are outside timestamp|rawBody, so a route must ignore them.
  for (const headerId of [callControlId, 'v3:attacker-controlled']) {
    assert.equal(verifyRaw(raw, { ...headers, 'x-call-control-id': headerId }), true);
  }
  const sessionFor = (payload) => verifySessionToken({
    token: payload.session_token, secret: sessionSecret, assistantId: payload.assistant_id,
    callControlId: payload.call_control_id, caller: payload.caller_target, agent: payload.agent_target, now
  });
  assert.ok(sessionFor(body));
  for (const alteration of [
    { session_token: '' }, { session_token: '{{nia_session_token}}' }, { call_control_id: undefined },
    { call_control_id: 'v3:different-call' }, { caller_target: '+13125550456' },
    { agent_target: '+13125550457' }, { assistant_id: 'assistant-other' }
  ]) {
    const changed = { ...body, ...alteration };
    const signedChanged = Buffer.from(JSON.stringify(changed));
    // Even a valid provider signature is not a replacement for a valid relay session.
    assert.equal(verifyRaw(signedChanged), true);
    assert.equal(sessionFor(changed), null);
  }
  assert.equal(verifyRaw(raw, { ...headers, 'Telnyx-Timestamp': headers['telnyx-timestamp'] }), false);
});

test('raw readers preserve split UTF-8 and enforce 256 KB by bytes', async () => {
  const raw = Buffer.from('{"message":"café 🕊️"}');
  const split = Readable.from([...raw].map((byte) => Buffer.from([byte])));
  const read = await readRawBody(split);
  assert.deepEqual(read, raw);
  assert.equal(verifyRaw(read, headersFor(raw)), true);
  const nodeRequest = Readable.from([raw]);
  Object.defineProperty(nodeRequest, 'body', { get() { throw new Error('The lazy JSON parser must not be invoked'); } });
  assert.deepEqual(await readRawBody(nodeRequest), raw);
  const fetchRequest = new Request('https://example.test', { method: 'POST', body: raw });
  assert.deepEqual(await readRawBody(fetchRequest), raw);
  assert.equal((await readRawBody({ rawBody: Buffer.alloc(MAX_WEBHOOK_BYTES) })).byteLength, MAX_WEBHOOK_BYTES);
  await assert.rejects(readRawBody({ rawBody: Buffer.alloc(MAX_WEBHOOK_BYTES + 1) }), { code: 'body_too_large', status: 413 });
  await assert.rejects(readRawBody(Readable.from([Buffer.alloc(MAX_WEBHOOK_BYTES), Buffer.from('x')])), { code: 'body_too_large' });
  await assert.rejects(readRawBody({ headers: { 'content-length': String(MAX_WEBHOOK_BYTES + 1) } }), { code: 'body_too_large' });
  await assert.rejects(readRawBody({ body: { already: 'parsed' } }), { code: 'raw_body_required' });
  const tooLarge = Buffer.alloc(MAX_WEBHOOK_BYTES + 1);
  assert.equal(verifyRaw(tooLarge, headersFor(tooLarge)), false);
});

test('initialization scopes history but never claims that a matching conversation was found', () => {
  const result = initialize(initEvent(), options);
  const query = new URLSearchParams(result.memory.conversation_query);
  assert.equal(query.get('metadata->assistant_id'), `eq.${assistantId}`);
  assert.equal(query.get('metadata->telnyx_agent_target'), `eq.${agentNumber}`);
  assert.equal(query.get('metadata->telnyx_end_user_target'), `eq.${caller}`);
  assert.equal(query.get('metadata->telnyx_conversation_channel'), 'eq.phone_call');
  assert.equal(query.get('limit'), '5');
  assert.equal(result.dynamic_variables.callback_context_found, 'no');
  assert.equal(result.dynamic_variables.callback_summary, '');
  assert.equal(result.dynamic_variables.preferred_name, 'Kal');
  assert.equal(result.conversation.metadata.nia_caller_match, 'query_requested');
  assert.ok(result.dynamic_variables.nia_session_token);
  const claims = verifySessionToken({ token: result.dynamic_variables.nia_session_token, secret: sessionSecret, assistantId, callControlId, caller, agent: agentNumber, now });
  assert.equal(claims.exp - claims.iat, 7200);
});

test('missing or malformed caller/call linkage has neutral fallback; wrong assistant/channel/agent fails closed', () => {
  for (const value of ['', 'unknown', '3125550123', agentNumber]) {
    const event = initEvent(); event.data.payload.telnyx_end_user_target = value;
    const response = initialize(event, options);
    assert.equal(response.memory, undefined);
    assert.equal(response.dynamic_variables.nia_session_token, '');
    assert.equal(response.dynamic_variables.callback_context_found, 'no');
  }
  const missingCall = initEvent(); delete missingCall.data.payload.call_control_id;
  assert.equal(initialize(missingCall, options).dynamic_variables.nia_session_token, '');
  assert.equal(initialize(initEvent(), { assistantId, agentNumber, now }).dynamic_variables.nia_session_token, '');
  for (const [field, value, code] of [
    ['assistant_id', 'assistant-other', 'assistant_mismatch'],
    ['telnyx_agent_target', '+13125550999', 'agent_mismatch'],
    ['telnyx_conversation_channel', 'sms_chat', 'channel_mismatch']
  ]) {
    const event = initEvent(); event.data.payload[field] = value;
    assert.throws(() => initialize(event, options), { code, status: 403 });
  }
  assert.throws(() => initialize({ data: { event_type: 'other' } }, options), { code: 'unexpected_event' });
});

test('HMAC sessions bind assistant, active call, caller and number and expire after two hours', () => {
  const base = { secret: sessionSecret, assistantId, callControlId, caller, agent: agentNumber, now };
  const token = createSessionToken(base);
  assert.ok(verifySessionToken({ ...base, token }));
  for (const mismatch of [
    { assistantId: 'assistant-other' }, { callControlId: 'v3:different' }, { caller: '+13125550456' },
    { agent: '+13125550789' }, { secret: 'different-secret-with-more-than-32-bytes' },
    { now: now + 7_200_000 }, { now: now - 60_000 }, { token: `${token.slice(0, -3)}xxx` }
  ]) assert.equal(verifySessionToken({ ...base, token, ...mismatch }), null);
  assert.equal(verifySessionToken({ ...base, token, callControlId: undefined }), null);
  assert.throws(() => createSessionToken({ ...base, secret: 'short' }), { code: 'invalid_configuration' });
});

test('call-ended normalization keeps only stable identifiers; ownership mismatches reject', () => {
  const body = { data: { id: 'event-ended', event_type: 'call.conversation.ended', occurred_at: '2026-10-11T20:00:00Z', payload: {
    assistant_id: assistantId, conversation_id: 'conversation-one', call_control_id: callControlId, from: caller, to: agentNumber
  } } };
  assert.deepEqual(parsePostCallEvent(body, options), {
    eventId: 'event-ended', eventType: 'call.conversation.ended', conversationId: 'conversation-one',
    callControlId, occurredAt: '2026-10-11T20:00:00.000Z'
  });
  const other = structuredClone(body); other.data.payload.assistant_id = 'assistant-other';
  assert.throws(() => parsePostCallEvent(other, options), { code: 'assistant_mismatch' });
  const wrongLine = structuredClone(body); wrongLine.data.payload.to = '+13125550789';
  assert.throws(() => parsePostCallEvent(wrongLine, options), { code: 'agent_mismatch' });
  const wrongChannel = structuredClone(body); wrongChannel.data.payload.telnyx_conversation_channel = 'web_chat';
  assert.throws(() => parsePostCallEvent(wrongChannel, options), { code: 'channel_mismatch' });
});

test('flat conversation_insight_result uses request_id and does not invent an event timestamp', () => {
  const body = { record_type: 'event', event_type: 'conversation_insight_result', payload: {
    request_id: 'request-one', conversation_id: 'conversation-one', status: 'completed', insight_group_id: 'group-one',
    results: [{ insight_id: 'insight-one', result: '{"outcome":"known"}' }], metadata: {}
  } };
  assert.deepEqual(parsePostCallEvent(body, { ...options, insightGroupId: 'group-one' }), {
    eventId: 'request-one', eventType: 'conversation_insight_result', insightStatus: 'completed', conversationId: 'conversation-one', callControlId: null, occurredAt: null
  });
  assert.equal(parsePostCallEvent({ event_type: 'conversation.insights.completed' }, options), null);
  assert.equal(parsePostCallEvent({ data: { event_type: 'call.hangup' } }, options), null);
  const failed = structuredClone(body); failed.payload.status = 'failed';
  assert.deepEqual(parsePostCallEvent(failed, options), {
    eventId: 'request-one', eventType: 'conversation_insight_result', insightStatus: 'failed', conversationId: 'conversation-one', callControlId: null, occurredAt: null
  });
  for (const status of ['pending', 'in_progress', 'unknown']) {
    const nonterminal = structuredClone(body); nonterminal.payload.status = status;
    assert.equal(parsePostCallEvent(nonterminal, options), null);
  }
  assert.throws(() => parsePostCallEvent(body, { ...options, insightGroupId: 'group-other' }), { code: 'insight_group_mismatch' });
  const mismatched = structuredClone(body); mismatched.payload.metadata.assistant_id = 'assistant-other';
  assert.throws(() => parsePostCallEvent(mismatched, options), { code: 'assistant_mismatch' });
});
