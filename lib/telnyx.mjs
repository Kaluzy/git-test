import { normalizePhone, validCallControlId } from './security.mjs';
import { setTimeout as waitFor } from 'node:timers/promises';
import { awaitWithSignal, deadlineSignal, remainingMs, throwIfExpired } from './deadline.mjs';

const API_BASE = 'https://api.telnyx.com/v2';
const ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;
const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

export class TelnyxError extends Error {
  constructor(code, message, status = 502, retryable = false) {
    super(message);
    this.name = 'TelnyxError';
    this.code = code;
    this.status = status;
    this.statusCode = status;
    this.retryable = retryable;
  }
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function identifier(value) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) throw new TelnyxError('invalid_identifier', 'A valid conversation identifier is required.', 400);
  return value;
}

async function pause(milliseconds) {
  const signal = deadlineSignal();
  await awaitWithSignal(waitFor(milliseconds, undefined, { signal }), signal);
  throwIfExpired();
}

function retryAfterMilliseconds(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const header = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(header)) {
    const milliseconds = Number(header) * 1000;
    return Number.isFinite(milliseconds) ? Math.ceil(milliseconds) : Number.MAX_SAFE_INTEGER;
  }
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

/** After ownership verification, infer direction only from matching native endpoint pairs. */
export function conversationDirection(conversation, agentNumber) {
  const metadata = conversation?.metadata;
  const agent = normalizePhone(agentNumber);
  const caller = normalizePhone(metadata?.telnyx_end_user_target);
  const from = normalizePhone(metadata?.from);
  const to = normalizePhone(metadata?.to);
  if (agent && caller && caller !== agent && normalizePhone(metadata?.telnyx_agent_target) === agent && metadata?.telnyx_conversation_channel === 'phone_call') {
    if (from === caller && to === agent) return 'inbound';
    if (from === agent && to === caller) return 'outbound';
  }
  throw new TelnyxError('direction_unverified', 'Call direction could not be verified.', 422);
}

async function responseJson(response, signal) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new TelnyxError('response_too_large', 'Telnyx response exceeds the size limit.');
  if (!response.body?.getReader) {
    const text = await awaitWithSignal(response.text(), signal);
    if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) throw new TelnyxError('response_too_large', 'Telnyx response exceeds the size limit.');
    try { return JSON.parse(text); } catch { throw new TelnyxError('invalid_response', 'Telnyx returned invalid JSON.'); }
  }
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await awaitWithSignal(reader.read(), signal);
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) throw new TelnyxError('response_too_large', 'Telnyx response exceeds the size limit.');
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  try { return JSON.parse(Buffer.concat(chunks, length).toString('utf8')); }
  catch { throw new TelnyxError('invalid_response', 'Telnyx returned invalid JSON.'); }
}

/** A read-only Telnyx client. Every returned conversation is checked against both owners. */
export class TelnyxClient {
  #apiKey;

  constructor({ apiKey, assistantId, agentNumber, fetchImpl = fetch, timeoutMs = 3500, maxRetries = 1, maxPages = 100 } = {}) {
    if (typeof apiKey !== 'string' || !apiKey.trim() || typeof assistantId !== 'string' || !ID_PATTERN.test(assistantId) || !normalizePhone(agentNumber)) {
      throw new TelnyxError('invalid_configuration', 'Telnyx credentials and assistant configuration are required.', 503);
    }
    if (typeof fetchImpl !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || !Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 3 || !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 1000) {
      throw new TelnyxError('invalid_configuration', 'Invalid Telnyx client limits.', 503);
    }
    this.#apiKey = apiKey;
    this.assistantId = assistantId;
    this.agentNumber = normalizePhone(agentNumber);
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.maxRetries = maxRetries;
    this.maxPages = maxPages;
  }

  assertOwnership(conversation, { id, callControlId } = {}) {
    if (!object(conversation) || typeof conversation.id !== 'string' || !ID_PATTERN.test(conversation.id)) throw new TelnyxError('invalid_response', 'Telnyx returned an invalid conversation.');
    const metadata = conversation.metadata;
    if (!object(metadata) || metadata.assistant_id !== this.assistantId || normalizePhone(metadata.telnyx_agent_target) !== this.agentNumber || metadata.telnyx_conversation_channel !== 'phone_call') {
      throw new TelnyxError('ownership_mismatch', 'Conversation ownership could not be verified.', 403);
    }
    if ((id && conversation.id !== id) || (callControlId && metadata.call_control_id !== callControlId)) throw new TelnyxError('ownership_mismatch', 'Conversation linkage could not be verified.', 403);
    return conversation;
  }

  async request(path, query) {
    throwIfExpired();
    const url = new URL(`${API_BASE}${path}`);
    if (query) for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      throwIfExpired();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.max(1, Math.ceil(remainingMs(this.timeoutMs))));
      const signal = deadlineSignal(controller.signal);
      let retryDelay = Math.min(150 * (2 ** attempt), 1000);
      try {
        const response = await awaitWithSignal(this.fetchImpl(url.toString(), {
          method: 'GET', headers: { Authorization: `Bearer ${this.#apiKey}`, Accept: 'application/json' },
          signal, redirect: 'error'
        }), signal);
        if (!response.ok) {
          const retryAfterMs = retryAfterMilliseconds(response.headers?.get?.('retry-after'));
          const error = new TelnyxError('http_error', `Telnyx read failed (HTTP ${response.status}).`, response.status, RETRYABLE.has(response.status));
          if (retryAfterMs !== null) {
            error.retryAfterMs = retryAfterMs;
            // Defer a long provider backoff to the durable worker instead of retrying early.
            if (error.retryAfterMs > 1000) error.deferRetry = true;
            else retryDelay = error.retryAfterMs;
          }
          void response.body?.cancel?.().catch(() => {});
          throw error;
        }
        const result = await responseJson(response, signal);
        throwIfExpired();
        if (!object(result)) throw new TelnyxError('invalid_response', 'Telnyx returned an invalid response envelope.');
        return result;
      } catch (error) {
        throwIfExpired();
        const normalized = error instanceof TelnyxError ? error : new TelnyxError(controller.signal.aborted ? 'timeout' : 'network_error', controller.signal.aborted ? 'Telnyx read timed out.' : 'Telnyx read was unavailable.', 502, true);
        if (!normalized.retryable || normalized.deferRetry || attempt === this.maxRetries) throw normalized;
      } finally {
        clearTimeout(timer);
      }
      await pause(retryDelay);
    }
    throw new TelnyxError('unavailable', 'Telnyx read was unavailable.');
  }

  async getConversation(id) {
    identifier(id);
    const response = await this.request(`/ai/conversations/${encodeURIComponent(id)}`);
    return this.assertOwnership(response.data, { id });
  }

  async getMessages(id) {
    identifier(id);
    await this.getConversation(id);
    const messages = [];
    let pageCount = 0;
    let totalPages = null;
    let totalResults = null;
    for (let page = 1; page <= this.maxPages; page += 1) {
      let response;
      try {
        response = await this.request(`/ai/conversations/${encodeURIComponent(id)}/messages`, { 'page[size]': 100, 'page[number]': page });
      } catch (error) {
        throwIfExpired();
        return { messages, complete: false, pageCount, reason: error.code ?? 'page_request_failed',
          ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}) };
      }
      if (!Array.isArray(response.data) || response.data.some((entry) => !object(entry) || typeof entry.role !== 'string' || !entry.role ||
        !(typeof entry.text === 'string' || entry.text === null || (Array.isArray(entry.tool_calls) && entry.tool_calls.length > 0)))) {
        return { messages, complete: false, pageCount, reason: 'invalid_page' };
      }
      pageCount += 1;
      const meta = response.meta;
      if (!object(meta) || !Number.isInteger(meta.page_number) || meta.page_number !== page || !Number.isInteger(meta.total_pages) || meta.total_pages < 0 || !Number.isInteger(meta.total_results) || meta.total_results < 0) {
        messages.push(...response.data);
        return { messages, complete: false, pageCount, reason: 'pagination_unverified' };
      }
      if (totalPages !== null && (meta.total_pages !== totalPages || meta.total_results !== totalResults)) {
        return { messages, complete: false, pageCount, reason: 'pagination_changed' };
      }
      totalPages = meta.total_pages;
      totalResults = meta.total_results;
      messages.push(...response.data);
      if ((totalPages === 0 && page === 1 && totalResults === 0 && messages.length === 0) || (page === totalPages && messages.length === totalResults)) {
        return { messages, complete: true, pageCount };
      }
      if (page >= totalPages || response.data.length === 0 || messages.length >= totalResults) {
        return { messages, complete: false, pageCount, reason: 'pagination_inconsistent' };
      }
    }
    return { messages, complete: false, pageCount, reason: 'page_limit' };
  }

  async getInsights(id) {
    identifier(id);
    await this.getConversation(id);
    return this.request(`/ai/conversations/${encodeURIComponent(id)}/insights`);
  }

  async listConversations({ callControlId, limit = 10 } = {}) {
    if (!validCallControlId(callControlId) || !Number.isInteger(limit) || limit < 1 || limit > 50) throw new TelnyxError('invalid_filter', 'A valid call control ID and bounded limit are required.', 400);
    const response = await this.request('/ai/conversations', {
      'metadata->assistant_id': `eq.${this.assistantId}`,
      'metadata->telnyx_agent_target': `eq.${this.agentNumber}`,
      'metadata->telnyx_conversation_channel': 'eq.phone_call',
      'metadata->call_control_id': `eq.${callControlId}`,
      limit, order: 'last_message_at.desc'
    });
    if (!Array.isArray(response.data)) throw new TelnyxError('invalid_response', 'Telnyx returned an invalid conversation list.');
    const conversations = response.data.map((conversation) => this.assertOwnership(conversation, { callControlId }));
    const meta = object(response.meta) ? response.meta : {};
    const totalKnown = Number.isInteger(meta.total_results) && meta.total_results >= 0;
    const morePages = Number.isInteger(meta.total_pages) && meta.total_pages > 1;
    const complete = !morePages && (totalKnown ? meta.total_results === conversations.length : conversations.length < limit);
    return { conversations, complete };
  }
}
