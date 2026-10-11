import { createHmac, createPublicKey, timingSafeEqual, verify } from 'node:crypto';

export const MAX_WEBHOOK_BYTES = 256 * 1024;
const MAX_SESSION_SECONDS = 2 * 60 * 60;
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;
const CALL_ID_PATTERN = /^[A-Za-z0-9:._~+/-]+={0,2}$/;

export class SecurityError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'SecurityError';
    this.code = code;
    this.status = status;
    this.statusCode = status;
  }
}

// Validate canonical E.164 syntax only; do not guess countries or strip arbitrary text.
export function normalizePhone(value) {
  if (typeof value !== 'string') return '';
  const phone = value.trim();
  return /^\+[1-9]\d{1,14}$/.test(phone) ? phone : '';
}

export function validCallControlId(value) {
  return typeof value === 'string' && value.length <= 4096 && CALL_ID_PATTERN.test(value);
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function headerValue(headers, name) {
  if (typeof headers?.get === 'function') return headers.get(name) ?? '';
  if (!object(headers)) return '';
  const keys = Object.keys(headers).filter((item) => item.toLowerCase() === name);
  if (keys.length !== 1) return '';
  const value = headers[keys[0]];
  return typeof value === 'string' ? value : '';
}

function toRawBuffer(rawBody, maxBytes = MAX_WEBHOOK_BYTES) {
  let buffer;
  if (typeof rawBody === 'string') buffer = Buffer.from(rawBody, 'utf8');
  else if (Buffer.isBuffer(rawBody)) buffer = rawBody;
  else if (rawBody instanceof Uint8Array) buffer = Buffer.from(rawBody);
  else throw new SecurityError('raw_body_required', 'The original request bytes are required.');
  if (buffer.byteLength > maxBytes) {
    throw new SecurityError('body_too_large', 'Webhook body exceeds the size limit.', 413);
  }
  return buffer;
}

/** Read Node or Fetch request bytes without reserializing JSON or corrupting split UTF-8. */
export async function readRawBody(req, { maxBytes = MAX_WEBHOOK_BYTES } = {}) {
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_WEBHOOK_BYTES) {
    throw new SecurityError('invalid_configuration', 'Invalid webhook body limit.', 503);
  }
  const contentLength = headerValue(req?.headers, 'content-length');
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > maxBytes) {
    throw new SecurityError('body_too_large', 'Webhook body exceeds the size limit.', 413);
  }
  if (req?.rawBody !== undefined) return toRawBuffer(req.rawBody, maxBytes);
  const chunks = [];
  let length = 0;
  const append = (chunk) => {
    const bytes = toRawBuffer(chunk, maxBytes);
    length += bytes.byteLength;
    if (length > maxBytes) throw new SecurityError('body_too_large', 'Webhook body exceeds the size limit.', 413);
    chunks.push(bytes);
  };
  // Node adapters can install a lazy req.body parser. Read the original stream
  // first, without touching that property, so signature verification sees bytes.
  if (typeof req?.[Symbol.asyncIterator] === 'function') {
    for await (const chunk of req) append(chunk);
  } else if (typeof req?.body === 'string' || Buffer.isBuffer(req?.body) || req?.body instanceof Uint8Array) {
    return toRawBuffer(req.body, maxBytes);
  } else if (typeof req?.body?.getReader === 'function') {
    const reader = req.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        append(value);
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    } finally {
      reader.releaseLock();
    }
  } else if (req?.body === null && typeof req?.arrayBuffer === 'function') {
    return Buffer.alloc(0);
  } else {
    throw new SecurityError('raw_body_required', 'The original request bytes are unavailable.');
  }
  return Buffer.concat(chunks, length);
}

function decodeBase64(value, byteLength) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length !== byteLength || bytes.toString('base64').replace(/=+$/, '') !== value.replace(/=+$/, '')) return null;
  return bytes;
}

/** Telnyx signs timestamp|rawBody only. Other headers cannot authenticate call identity. */
export function verifyTelnyxWebhook({ rawBody, headers, publicKey, now = Date.now() } = {}) {
  try {
    const body = toRawBuffer(rawBody);
    const keyBytes = decodeBase64(publicKey, 32);
    const signature = decodeBase64(headerValue(headers, 'telnyx-signature-ed25519'), 64);
    const timestamp = headerValue(headers, 'telnyx-timestamp');
    if (!keyBytes || !signature || !/^\d{10}$/.test(timestamp) || !Number.isFinite(now)) return false;
    if (Math.abs(now / 1000 - Number(timestamp)) > 300) return false;
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, keyBytes]), type: 'spki', format: 'der' });
    const signed = Buffer.concat([Buffer.from(`${timestamp}|`, 'utf8'), body]);
    return verify(null, signed, key, signature);
  } catch {
    return false;
  }
}

function configuration({ assistantId, agentNumber }) {
  const agent = normalizePhone(agentNumber);
  if (typeof assistantId !== 'string' || !ID_PATTERN.test(assistantId) || !agent) {
    throw new SecurityError('invalid_configuration', 'Assistant and agent configuration is required.', 503);
  }
  return { assistantId, agent };
}

function sessionKey(secret) {
  const key = typeof secret === 'string' ? Buffer.from(secret, 'utf8') : secret;
  if (!Buffer.isBuffer(key) || key.byteLength < 32) {
    throw new SecurityError('invalid_configuration', 'A session secret of at least 32 bytes is required.', 503);
  }
  return key;
}

export function createSessionToken({ secret, assistantId, callControlId, caller, agent, now = Date.now() } = {}) {
  const key = sessionKey(secret);
  configuration({ assistantId, agentNumber: agent });
  const normalizedCaller = normalizePhone(caller);
  const normalizedAgent = normalizePhone(agent);
  if (!validCallControlId(callControlId) || !normalizedCaller || normalizedCaller === normalizedAgent || !Number.isFinite(now)) {
    throw new SecurityError('invalid_session', 'A valid call session is required.');
  }
  const iat = Math.floor(now / 1000);
  const claims = { v: 1, assistantId, callControlId, caller: normalizedCaller, agent: normalizedAgent, iat, exp: iat + MAX_SESSION_SECONDS };
  const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  const signature = createHmac('sha256', key).update(`nia-session-v1.${payload}`).digest('base64url');
  return `${payload}.${signature}`;
}

/** Return verified claims or null. Every expected binding must be supplied by the route. */
export function verifySessionToken({ token, secret, assistantId, callControlId, caller, agent, now = Date.now() } = {}) {
  try {
    const key = sessionKey(secret);
    configuration({ assistantId, agentNumber: agent });
    if (typeof token !== 'string' || token.length > 8192 || !validCallControlId(callControlId) || !normalizePhone(caller) || !Number.isFinite(now)) return null;
    const parts = token.split('.');
    if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[A-Za-z0-9_-]{43}$/.test(parts[1])) return null;
    const expected = createHmac('sha256', key).update(`nia-session-v1.${parts[0]}`).digest();
    const received = Buffer.from(parts[1], 'base64url');
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) return null;
    const claims = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    const seconds = Math.floor(now / 1000);
    if (!object(claims) || claims.v !== 1 || !Number.isInteger(claims.iat) || !Number.isInteger(claims.exp)) return null;
    if (claims.iat > seconds + 30 || claims.exp <= seconds || claims.exp - claims.iat !== MAX_SESSION_SECONDS) return null;
    if (claims.assistantId !== assistantId || claims.callControlId !== callControlId || claims.caller !== normalizePhone(caller) || claims.agent !== normalizePhone(agent)) return null;
    if (claims.caller === claims.agent) return null;
    return claims;
  } catch {
    return null;
  }
}

/** Build an initialization response after the caller has verified the raw webhook. */
export function initialize(event, { assistantId, agentNumber, sessionSecret, now = Date.now() } = {}) {
  const expected = configuration({ assistantId, agentNumber });
  const data = event?.data;
  if (!object(data) || data.event_type !== 'assistant.initialization' || (data.record_type !== undefined && data.record_type !== 'event') || !object(data.payload)) {
    throw new SecurityError('unexpected_event', 'An assistant initialization event is required.');
  }
  const payload = data.payload;
  if (payload.assistant_id !== expected.assistantId) throw new SecurityError('assistant_mismatch', 'The event does not belong to this assistant.', 403);
  if (payload.telnyx_conversation_channel !== 'phone_call') throw new SecurityError('channel_mismatch', 'Only phone-call sessions are supported.', 403);
  if (normalizePhone(payload.telnyx_agent_target) !== expected.agent) throw new SecurityError('agent_mismatch', 'The event does not belong to this number.', 403);
  const caller = normalizePhone(payload.telnyx_end_user_target);
  const response = {
    dynamic_variables: {
      preferred_name: 'Kal', callback_context_found: 'no', callback_business: '',
      callback_thread_id: '', callback_mission: '', callback_summary: '', callback_missing_items: '',
      nia_session_token: ''
    },
    conversation: { metadata: { nia_memory_version: 'v2', nia_caller_match: 'none', nia_assistant_id: expected.assistantId } }
  };
  if (!caller || caller === expected.agent) return response;
  const query = new URLSearchParams({
    'metadata->assistant_id': `eq.${expected.assistantId}`,
    'metadata->telnyx_agent_target': `eq.${expected.agent}`,
    'metadata->telnyx_end_user_target': `eq.${caller}`,
    'metadata->telnyx_conversation_channel': 'eq.phone_call',
    limit: '5', order: 'last_message_at.desc'
  });
  response.memory = { conversation_query: query.toString() };
  // A scoped query is not evidence that any matching history was returned.
  response.conversation.metadata.nia_caller_match = 'query_requested';
  if (sessionSecret && validCallControlId(payload.call_control_id)) {
    response.dynamic_variables.nia_session_token = createSessionToken({
      secret: sessionSecret, assistantId: expected.assistantId, callControlId: payload.call_control_id,
      caller, agent: expected.agent, now
    });
  }
  return response;
}

function requiredId(value, label) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) throw new SecurityError('invalid_event', `A valid ${label} is required.`);
  return value;
}

function timestampOrNull(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

/** Parse supported terminal events; API ownership verification is still required. */
export function parsePostCallEvent(body, { assistantId, agentNumber, insightGroupId } = {}) {
  const wrapped = object(body?.data) ? body.data : null;
  const eventType = wrapped?.event_type ?? body?.event_type;
  if (!['call.conversation.ended', 'conversation_insight_result'].includes(eventType)) return null;
  const expected = configuration({ assistantId, agentNumber });
  if (eventType === 'call.conversation.ended') {
    if (!wrapped || !object(wrapped.payload)) throw new SecurityError('invalid_event', 'Invalid call-ended event.');
    const payload = wrapped.payload;
    if (payload.assistant_id !== expected.assistantId) throw new SecurityError('assistant_mismatch', 'The event does not belong to this assistant.', 403);
    if (payload.metadata?.assistant_id !== undefined && payload.metadata.assistant_id !== expected.assistantId) throw new SecurityError('assistant_mismatch', 'The event does not belong to this assistant.', 403);
    const channel = payload.telnyx_conversation_channel ?? payload.metadata?.telnyx_conversation_channel;
    if (channel !== undefined && channel !== 'phone_call') throw new SecurityError('channel_mismatch', 'Only phone-call sessions are supported.', 403);
    const declaredAgent = payload.telnyx_agent_target ?? payload.metadata?.telnyx_agent_target;
    if (declaredAgent !== undefined && normalizePhone(declaredAgent) !== expected.agent) throw new SecurityError('agent_mismatch', 'The event does not belong to this number.', 403);
    const from = normalizePhone(payload.from);
    const to = normalizePhone(payload.to);
    if (from && to && from !== expected.agent && to !== expected.agent) throw new SecurityError('agent_mismatch', 'The event does not belong to this number.', 403);
    if (!validCallControlId(payload.call_control_id)) throw new SecurityError('invalid_event', 'A valid call control ID is required.');
    return {
      eventId: requiredId(wrapped.id, 'event ID'), eventType,
      conversationId: requiredId(payload.conversation_id, 'conversation ID'),
      callControlId: payload.call_control_id, occurredAt: timestampOrNull(wrapped.occurred_at)
    };
  }
  // Insight-group deliveries are flat; the never-shipped conversation.insights.completed is ignored.
  if (wrapped || !object(body?.payload)) throw new SecurityError('invalid_event', 'Invalid insight-result event.');
  const payload = body.payload;
  if (!['completed', 'failed'].includes(payload.status)) return null;
  if (insightGroupId && payload.insight_group_id !== insightGroupId) throw new SecurityError('insight_group_mismatch', 'The insight does not belong to this group.', 403);
  const metadata = object(payload.metadata) ? payload.metadata : {};
  if (metadata.assistant_id !== undefined && metadata.assistant_id !== expected.assistantId) throw new SecurityError('assistant_mismatch', 'The event does not belong to this assistant.', 403);
  if (metadata.telnyx_agent_target !== undefined && normalizePhone(metadata.telnyx_agent_target) !== expected.agent) throw new SecurityError('agent_mismatch', 'The event does not belong to this number.', 403);
  if (metadata.telnyx_conversation_channel !== undefined && metadata.telnyx_conversation_channel !== 'phone_call') throw new SecurityError('channel_mismatch', 'Only phone-call sessions are supported.', 403);
  return {
    eventId: requiredId(payload.request_id, 'insight request ID'), eventType,
    insightStatus: payload.status,
    conversationId: requiredId(payload.conversation_id, 'conversation ID'),
    callControlId: validCallControlId(metadata.call_control_id) ? metadata.call_control_id : null,
    occurredAt: timestampOrNull(body.occurred_at ?? payload.occurred_at)
  };
}
