import { createHash } from 'node:crypto';
import { setTimeout as waitFor } from 'node:timers/promises';
import { awaitWithSignal, deadlineSignal, remainingMs, throwIfExpired } from './deadline.mjs';

/**
 * Dedicated-token Notion REST adapter; never accepts a ChatGPT connector token.
 * API contract checked against official docs on 2026-10-11:
 * https://developers.notion.com/reference/versioning
 * https://developers.notion.com/reference/parent-object
 * https://developers.notion.com/reference/query-a-data-source
 * https://developers.notion.com/guides/data-apis/working-with-page-content
 * https://developers.notion.com/reference/request-limits
 *
 * Callers MUST serialize writes per thread and persist ambiguous errors in their
 * durable job ledger. Notion has no transaction/unique-key/idempotent-create API.
 * An ambiguous write is reconciled by reading, never blindly replayed here.
 *
 * thread: { threadId, title, business?, phone?, mission?, type?, direction?,
 *   startedAt?, originalConversationId?, summary?, outcome?, nextAction?, status? }
 * call: { conversationId, startedAt, direction, transcript: string |
 *   [{speaker, text, timestamp?}], endedAt?, participants?: string|string[],
 *   summary?, outcome?, nextAction? }
 * updateThread takes flat existing Notion property names and scalar values.
 * Methods accept a trailing {signal}; listThreads accepts signal in its options.
 */
export const NOTION_VERSION = '2026-03-11';
const API = 'https://api.notion.com/v1';
const MAX_TEXT = 20_000;
const MAX_TRANSCRIPT = 500_000;
const MAX_REQUEST_BYTES = 450_000;
const HEADING = 'Nia conversation: ';
const COMPLETE = 'NIA_CALL_COMPLETE v1 ';
const TEXT_PROPERTIES = new Set(['Business / Person', 'Callback Of', 'Conversation ID', 'Mission', 'Next Action', 'Outcome', 'Summary', 'Thread ID', 'Transcript', 'Who Talked']);
const SELECTS = {
  Direction: ['Outbound', 'Inbound'],
  Status: ['Completed', 'Follow-up', 'Failed'],
  Type: ['Business Outreach', 'Store Inquiry', 'Personal', 'Order Status', 'Other'],
};
const IMMUTABLE = new Set(['Thread ID', 'Conversation ID', 'Direction', 'Timestamp', 'date:Timestamp:start', 'date:Timestamp:end', 'date:Timestamp:is_datetime']);

export class NotionError extends Error {
  constructor(message, details = {}) { super(message); this.name = 'NotionError'; Object.assign(this, details); }
}
export class NotionAmbiguousWriteError extends NotionError {
  constructor(operation, details = {}) {
    super(`Notion ${operation} needs reconciliation; the write was not replayed.`, { code: 'ambiguous_write', ambiguous: true, retrySafe: false, operation, ...details });
    this.name = 'NotionAmbiguousWriteError';
  }
}
function invalid(message) { throw new NotionError(message, { code: 'invalid_data', retrySafe: false }); }
function integrity(message) { throw new NotionError(message, { code: 'integrity_error', retrySafe: false }); }
function text(value, name, max = MAX_TEXT, optional = false) {
  if (optional && value == null) return '';
  if (typeof value !== 'string' || value.length > max || value.includes('\0') || (!optional && !value.trim())) invalid(`Invalid ${name}.`);
  return value;
}
function id(value, name = 'Notion ID') {
  if (typeof value !== 'string' || !/^(?:[a-f\d]{32}|[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12})$/i.test(value)) invalid(`Invalid ${name}.`);
  const h = value.replaceAll('-', '').toLowerCase();
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}
function sameId(a, b) { return typeof a === 'string' && typeof b === 'string' && a.replaceAll('-', '').toLowerCase() === b.replaceAll('-', '').toLowerCase(); }
function conversationId(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z\d_-]{1,128}$/.test(value)) invalid('Invalid conversation ID.');
  return value;
}
function iso(value, name) {
  if (typeof value !== 'string' || !/T.*(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) invalid(`Invalid ${name}.`);
  return new Date(value).toISOString();
}
function pieces(value, size = 2000) {
  const out = [];
  for (let start = 0; start < value.length;) {
    let end = Math.min(start + size, value.length);
    if (end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1]) && /[\uDC00-\uDFFF]/.test(value[end])) end--;
    out.push(value.slice(start, end)); start = end;
  }
  return out;
}
function rich(value) { return pieces(value).map(content => ({ type: 'text', text: { content } })); }
function block(type, value, children) {
  return { object: 'block', type, [type]: { rich_text: rich(value), ...(children ? { children } : {}) } };
}
function rawText(blockValue) {
  const entries = blockValue?.[blockValue?.type]?.rich_text;
  if (!Array.isArray(entries) || entries.length > 100) invalid('Malformed Notion block rich text.');
  return entries.map(part => {
    if (part?.type !== 'text' || typeof part.text?.content !== 'string') invalid('Malformed Notion block text.');
    return part.text.content;
  }).join('');
}
function digest(metadata, transcript) { return createHash('sha256').update(JSON.stringify({ metadata, transcript })).digest('hex'); }
function callData(call) {
  if (!call || typeof call !== 'object' || Array.isArray(call)) invalid('Missing call.');
  const cid = conversationId(call.conversationId);
  const startedAt = iso(call.startedAt, 'call start');
  const endedAt = call.endedAt == null ? '' : iso(call.endedAt, 'call end');
  if (endedAt && endedAt < startedAt) invalid('Call ends before it starts.');
  const direction = SELECTS.Direction.find(s => s.toLowerCase() === String(call.direction).toLowerCase());
  if (!direction) invalid('Invalid call direction.');
  let transcript;
  if (typeof call.transcript === 'string') transcript = text(call.transcript, 'transcript', MAX_TRANSCRIPT);
  else if (Array.isArray(call.transcript) && call.transcript.length && call.transcript.length <= 5000) {
    transcript = call.transcript.map(turn => {
      if (!turn || typeof turn !== 'object') invalid('Malformed transcript turn.');
      const speaker = text(turn.speaker, 'speaker', 100);
      const stamp = turn.timestamp == null ? '' : `[${text(turn.timestamp, 'turn timestamp', 100)}] `;
      return `${stamp}${speaker}: ${text(turn.text, 'transcript turn', MAX_TRANSCRIPT)}\n`;
    }).join('');
    text(transcript, 'transcript', MAX_TRANSCRIPT);
  } else invalid('A nonempty transcript is required.');
  const participants = Array.isArray(call.participants)
    ? (call.participants.length <= 20 ? call.participants.map(p => text(p, 'participant', 200)).join(' ↔ ') : invalid('Too many participants.'))
    : text(call.participants, 'participants', 2000, true);
  const metadata = [
    `Started: ${startedAt}`, ...(endedAt ? [`Ended: ${endedAt}`] : []), `Direction: ${direction}`,
    ...(participants ? [`Who talked: ${participants}`] : []),
    ...['summary', 'outcome', 'nextAction'].flatMap(key => {
      const value = text(call[key], key, MAX_TEXT, true);
      return value ? [`${{ summary: 'Summary', outcome: 'Outcome', nextAction: 'Next action' }[key]}: ${value}`] : [];
    }),
  ].join('\n');
  const paragraphs = pieces(transcript).map(value => block('paragraph', value));
  const groups = []; let group = [];
  for (const paragraph of paragraphs) {
    const candidate = [...group, paragraph];
    if (group.length && (candidate.length > 90 || Buffer.byteLength(JSON.stringify(candidate)) > 350_000)) { groups.push(group); group = []; }
    group.push(paragraph);
  }
  if (group.length) groups.push(group);
  return { cid, startedAt, endedAt, direction, metadata, transcript, groups, hash: digest(metadata, transcript) };
}
function propertiesFromFlat(values) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) invalid('Invalid page properties.');
  const result = {};
  for (const [key, value] of Object.entries(values)) {
    if (/^date:(Timestamp|Last Contact):(start|end|is_datetime)$/.test(key)) continue;
    if (key === 'Call') result[key] = { title: rich(text(value, key, 2000)) };
    else if (TEXT_PROPERTIES.has(key)) result[key] = { rich_text: rich(value == null ? '' : text(value, key, MAX_TEXT, true)) };
    else if (SELECTS[key]) {
      if (value != null && !SELECTS[key].includes(value)) invalid(`Invalid ${key}.`);
      result[key] = { select: value == null ? null : { name: value } };
    } else if (key === 'Phone') result[key] = { phone_number: value == null ? null : text(value, key, 200, true) };
    else if (key === 'Callback Count') {
      if (!Number.isSafeInteger(value) || value < 0) invalid('Invalid callback count.');
      result[key] = { number: value };
    } else invalid(`Unsupported Notion property: ${key}.`);
  }
  for (const name of ['Timestamp', 'Last Contact']) {
    const startKey = `date:${name}:start`, endKey = `date:${name}:end`, flagKey = `date:${name}:is_datetime`;
    if (Object.hasOwn(values, endKey) || Object.hasOwn(values, flagKey)) {
      if (!Object.hasOwn(values, startKey)) invalid(`Missing ${name} start.`);
    }
    if (!Object.hasOwn(values, startKey)) continue;
    if (values[flagKey] != null && values[flagKey] !== 1) invalid('Call timestamps must include a time.');
    const start = values[startKey] == null ? null : iso(values[startKey], name);
    const end = values[endKey] == null ? null : iso(values[endKey], `${name} end`);
    if (end && (!start || end < start)) invalid(`Invalid ${name} date range.`);
    result[name] = { date: start ? { start, end } : null };
  }
  return result;
}
function propertyValue(prop, expectedType) {
  if (!prop || (prop.type && prop.type !== expectedType)) invalid('Malformed Notion page property.');
  if (expectedType === 'rich_text' || expectedType === 'title') {
    const entries = prop[expectedType];
    if (!Array.isArray(entries)) invalid('Missing Notion text property.');
    return entries.map(p => {
      if (typeof p?.plain_text === 'string') return p.plain_text;
      if (p?.type === 'text' && typeof p.text?.content === 'string') return text(p.text.content, 'property text', MAX_TEXT, true);
      invalid('Malformed Notion rich-text entry.');
    }).join('');
  }
  if (!Object.hasOwn(prop, expectedType)) invalid('Missing Notion property value.');
  if (expectedType === 'select') return prop.select?.name ?? null;
  if (expectedType === 'date') return prop.date == null ? null : { start: iso(prop.date.start, 'readback date'), end: prop.date.end == null ? null : iso(prop.date.end, 'readback date end') };
  return prop[expectedType];
}
/** Convert a REST page to the relay's canonical read model; no remote calls. */
export function pageToThread(page) {
  if (page?.object !== 'page' || !page.properties || typeof page.properties !== 'object' || Array.isArray(page.properties)) invalid('Malformed Notion page.');
  const optional = (name, type, fallback = '') => page.properties[name] == null ? fallback : (propertyValue(page.properties[name], type) ?? fallback);
  const date = name => optional(name, 'date', null)?.start ?? null;
  const count = optional('Callback Count', 'number', 0);
  if (!Number.isSafeInteger(count) || count < 0) invalid('Malformed callback count.');
  const title = optional('Call', 'title'); text(title, 'call title', 2000);
  return {
    pageId: id(page.id), threadId: optional('Thread ID', 'rich_text'), title,
    business: optional('Business / Person', 'rich_text'), phone: optional('Phone', 'phone_number'),
    mission: optional('Mission', 'rich_text'), type: optional('Type', 'select'), direction: optional('Direction', 'select'),
    startedAt: date('Timestamp'), originalConversationId: optional('Conversation ID', 'rich_text'),
    summary: optional('Summary', 'rich_text'), outcome: optional('Outcome', 'rich_text'),
    nextAction: optional('Next Action', 'rich_text'), status: optional('Status', 'select'),
    callbackCount: count, lastContact: date('Last Contact'),
  };
}
function checkSignal(signal) {
  throwIfExpired();
  if (signal == null) return;
  if (typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function') invalid('Invalid abort signal.');
  if (signal.aborted) throw new NotionError('Notion operation was cancelled.', { code: 'aborted', retrySafe: false });
}
async function withSignal(promise, signal) {
  signal = deadlineSignal(signal);
  checkSignal(signal);
  if (!signal) return promise;
  let listener;
  const cancellation = new Promise((_, reject) => {
    listener = () => reject(new NotionError('Notion operation was cancelled.', { code: 'aborted', retrySafe: false }));
    signal.addEventListener('abort', listener, { once: true });
  });
  try { const result = await Promise.race([promise, cancellation]); checkSignal(signal); return result; }
  finally { signal.removeEventListener('abort', listener); }
}
function propertiesMatch(page, expected) {
  return Object.entries(expected).every(([name, value]) => {
    const type = Object.keys(value)[0];
    return JSON.stringify(propertyValue(page.properties[name], type)) === JSON.stringify(propertyValue(value, type));
  });
}

export class NotionClient {
  #token; #source; #fetch; #sleep; #timeout; #retries; #maxWait; #scanLimit; #cachedBotId;
  #uncertainCreates = new Set(); #uncertainAppends = new Map();
  constructor({ token, dataSourceId, fetchImpl = globalThis.fetch, sleepImpl = (ms, options) => waitFor(ms, undefined, options), timeoutMs = 15_000, maxRetries = 3, maxInlineRetryAfterMs = 60_000, maxScanBlocks = 2000 } = {}) {
    this.#token = text(token, 'Notion credential', 2048);
    if (/[\r\n]/.test(token)) invalid('Invalid Notion credential.');
    this.#source = id(dataSourceId, 'data source ID');
    if (typeof fetchImpl !== 'function' || typeof sleepImpl !== 'function') invalid('Invalid HTTP or sleep implementation.');
    if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 5 || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000 || !Number.isFinite(maxInlineRetryAfterMs) || maxInlineRetryAfterMs < 0 || maxInlineRetryAfterMs > 60_000 || !Number.isInteger(maxScanBlocks) || maxScanBlocks < 100 || maxScanBlocks > 10_000) invalid('Invalid Notion client bounds.');
    this.#fetch = fetchImpl; this.#sleep = sleepImpl; this.#timeout = timeoutMs; this.#retries = maxRetries; this.#maxWait = maxInlineRetryAfterMs; this.#scanLimit = maxScanBlocks;
  }
  async #pause(ms, signal) {
    signal = deadlineSignal(signal);
    checkSignal(signal);
    try { await withSignal(this.#sleep(ms, { signal }), signal); }
    catch (error) { checkSignal(signal); throw error; }
  }
  async #request(method, path, body, { readOnly = method === 'GET', signal } = {}) {
    signal = deadlineSignal(signal);
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    if (encoded && Buffer.byteLength(encoded) > MAX_REQUEST_BYTES) invalid('Notion request exceeds the local byte limit.');
    for (let attempt = 0; ; attempt++) {
      checkSignal(signal);
      const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), Math.max(1, Math.ceil(remainingMs(this.#timeout)))); timer.unref?.();
      const onAbort = () => controller.abort(); signal?.addEventListener('abort', onAbort, { once: true });
      let response, data;
      try {
        response = await awaitWithSignal(this.#fetch(API + path, { method, headers: { Authorization: `Bearer ${this.#token}`, 'Notion-Version': NOTION_VERSION, 'Content-Type': 'application/json' }, ...(encoded === undefined ? {} : { body: encoded }), signal: controller.signal, redirect: 'error' }));
        try { data = await awaitWithSignal(response.json()); } catch { data = null; }
        throwIfExpired();
      } catch {
        if (!readOnly) throw new NotionAmbiguousWriteError(method, { resourcePath: path });
        checkSignal(signal);
        if (attempt >= this.#retries) throw new NotionError('Notion read failed.', { code: 'transport_error', retrySafe: true });
      } finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); }
      if (!response) { await this.#pause(250 * 2 ** attempt, signal); continue; }
      if (response.ok) {
        if (!data || typeof data !== 'object') {
          if (!readOnly) throw new NotionAmbiguousWriteError(method, { resourcePath: path });
          invalid('Malformed Notion response.');
        }
        return data;
      }
      const status = response.status;
      const code = typeof data?.code === 'string' && /^[a-z_]{1,80}$/.test(data.code) ? data.code : 'http_error';
      const blocked = data?.additional_data?.rate_limit_reason === 'public_api_request_blocked';
      const rawWait = response.headers?.get?.('retry-after') ?? data?.additional_data?.retry_after;
      const seconds = rawWait != null && /^\d+$/.test(String(rawWait)) ? Number(rawWait) : null;
      const wait = seconds != null && Number.isFinite(seconds) ? seconds * 1000 : 250 * 2 ** attempt;
      const retryable = !blocked && ([429, 529].includes(status) || (readOnly && [500, 502, 503, 504].includes(status)));
      if (retryable && attempt < this.#retries && wait <= this.#maxWait) { await this.#pause(wait, signal); continue; }
      const details = { status, code, retrySafe: retryable, ...(retryable ? { retryAfterMs: wait } : {}) };
      if (!readOnly && status >= 500 && status !== 529) {
        const committed = data?.additional_data?.committed_resource_id;
        let committedResourceId;
        if (typeof committed === 'string' && /^[a-f\d-]{32,36}$/i.test(committed)) { try { committedResourceId = id(committed); } catch {} }
        throw new NotionAmbiguousWriteError(method, { ...details, retrySafe: false, resourcePath: path, ...(committedResourceId ? { committedResourceId } : {}) });
      }
      throw new NotionError(`Notion request failed (${status} ${code}).`, details);
    }
  }
  #page(page, expectedId) {
    if (page?.object !== 'page' || !page.properties || typeof page.properties !== 'object') invalid('Malformed Notion page.');
    id(page.id);
    if (expectedId && !sameId(page.id, expectedId)) integrity('Notion returned a different page.');
    if (page.parent?.type !== 'data_source_id' || !sameId(page.parent.data_source_id, this.#source)) throw new NotionError('Page is outside the configured call log.', { code: 'scope_error', retrySafe: false });
    if (page.archived || page.in_trash || page.is_archived) throw new NotionError('Call-log page is archived.', { code: 'scope_error', retrySafe: false });
    return page;
  }
  async getPage(pageId, { signal } = {}) { const pid = id(pageId); return this.#page(await this.#request('GET', `/pages/${pid}`, undefined, { signal }), pid); }
  async findThread(threadId, { signal } = {}) {
    text(threadId, 'thread ID', 256);
    const found = []; const cursors = new Set(); let cursor;
    for (let n = 0; n < 20; n++) {
      const result = await this.#request('POST', `/data_sources/${this.#source}/query`, { filter: { property: 'Thread ID', rich_text: { equals: threadId } }, page_size: 2, ...(cursor ? { start_cursor: cursor } : {}) }, { readOnly: true, signal });
      if (result.object !== 'list' || !Array.isArray(result.results) || typeof result.has_more !== 'boolean' || result.request_status?.type === 'incomplete') invalid('Malformed or incomplete Notion query.');
      for (const raw of result.results) {
        const page = this.#page(raw);
        if (propertyValue(page.properties['Thread ID'], 'rich_text') !== threadId) integrity('Notion thread query returned a nonmatching row.');
        found.push(page);
      }
      if (found.length > 1) throw new NotionError('Multiple Notion pages match this thread.', { code: 'duplicate_thread', retrySafe: false });
      if (!result.has_more) return found[0] ?? null;
      if (typeof result.next_cursor !== 'string' || !result.next_cursor || cursors.has(result.next_cursor)) invalid('Malformed Notion query pagination.');
      cursor = result.next_cursor; cursors.add(cursor);
    }
    invalid('Notion query pagination limit reached.');
  }
  async listThreads({ limit = 50, status = 'Follow-up', signal } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500 || (status != null && !SELECTS.Status.includes(status))) invalid('Invalid thread-list bounds or status.');
    const pages = []; const cursors = new Set(); const pageIds = new Set(); let cursor;
    for (let n = 0; n < 20; n++) {
      const result = await this.#request('POST', `/data_sources/${this.#source}/query`, {
        ...(status == null ? {} : { filter: { property: 'Status', select: { equals: status } } }),
        page_size: Math.min(100, limit - pages.length), ...(cursor ? { start_cursor: cursor } : {}),
      }, { readOnly: true, signal });
      if (result.object !== 'list' || !Array.isArray(result.results) || typeof result.has_more !== 'boolean') invalid('Malformed Notion thread list.');
      if (result.results.length > limit - pages.length) invalid('Notion thread list exceeded its bound.');
      for (const value of result.results) {
        const page = this.#page(value); const pid = id(page.id);
        if (pageIds.has(pid)) integrity('Notion pagination repeated a page.');
        pageIds.add(pid); pages.push(page);
      }
      if (!result.has_more) return { pages, complete: result.request_status?.type !== 'incomplete' };
      if (pages.length >= limit) return { pages, complete: false };
      if (typeof result.next_cursor !== 'string' || !result.next_cursor || cursors.has(result.next_cursor)) invalid('Malformed Notion thread-list pagination.');
      cursor = result.next_cursor; cursors.add(cursor);
    }
    return { pages, complete: false };
  }
  async #botId(signal) {
    checkSignal(signal);
    if (!this.#cachedBotId) {
      // Cache only the immutable identity, not an in-flight promise tied to a
      // different request's deadline or cancellation signal.
      const user = await this.#request('GET', '/users/me', undefined, { signal });
      if (user.object !== 'user' || user.type !== 'bot') invalid('A dedicated Notion connection is required.');
      this.#cachedBotId = id(user.id, 'Notion bot ID');
    }
    checkSignal(signal);
    return this.#cachedBotId;
  }
  async #children(parentId, signal) {
    const result = []; const cursors = new Set(); let cursor;
    for (;;) {
      const query = new URLSearchParams({ page_size: '100', ...(cursor ? { start_cursor: cursor } : {}) });
      const page = await this.#request('GET', `/blocks/${id(parentId)}/children?${query}`, undefined, { signal });
      if (page.object !== 'list' || !Array.isArray(page.results) || typeof page.has_more !== 'boolean') invalid('Malformed Notion block list.');
      for (const child of page.results) {
        if (child?.object !== 'block' || typeof child.type !== 'string') invalid('Malformed Notion child block.');
        id(child.id, 'block ID'); result.push(child);
      }
      if (result.length > this.#scanLimit) invalid('Notion block scan limit reached.');
      if (!page.has_more) return result;
      if (typeof page.next_cursor !== 'string' || !page.next_cursor || cursors.has(page.next_cursor)) invalid('Malformed Notion block pagination.');
      cursors.add(page.next_cursor); cursor = page.next_cursor;
    }
  }
  #owned(blockValue, botId) { return sameId(blockValue?.created_by?.id, botId) && sameId(blockValue?.last_edited_by?.id, botId) && !blockValue.archived && !blockValue.in_trash && !blockValue.is_archived; }
  async #inspect(pageId, cid, signal) {
    const bot = await this.#botId(signal); const top = await this.#children(pageId, signal);
    const headings = top.map((value, index) => ({ value, index })).filter(({ value }) => value.type === 'heading_3' && rawText(value) === HEADING + cid);
    if (!headings.length) {
      if (top.some(value => value.type === 'paragraph' && rawText(value).startsWith(COMPLETE + cid + ' ') && this.#owned(value, bot))) integrity('Orphaned conversation completion marker.');
      return { exists: false, complete: false, parts: [] };
    }
    if (headings.length > 1) integrity('Duplicate conversation headings require reconciliation.');
    const { value: heading, index } = headings[0];
    const metadataBlock = top[index + 1];
    if (!this.#owned(heading, bot) || metadataBlock?.type !== 'paragraph' || !this.#owned(metadataBlock, bot)) integrity('Conversation scaffold is missing or was edited outside this connection.');
    const metadata = rawText(metadataBlock); const parts = []; let marker;
    for (let i = index + 2; i < top.length; i++) {
      const value = top[i];
      if (value.type === 'heading_3' && rawText(value).startsWith(HEADING)) break;
      if (value.type === 'toggle' && rawText(value).startsWith(`Transcript ${cid} part `)) {
        if (!this.#owned(value, bot)) integrity('Transcript part was edited outside this connection.');
        const match = rawText(value).match(new RegExp(`^Transcript ${cid} part (\\d+)\\/(\\d+)$`));
        if (!match || Number(match[1]) !== parts.length + 1 || Number(match[2]) < Number(match[1]) || Number(match[2]) > 1000) integrity('Malformed transcript part sequence.');
        const children = await this.#children(value.id, signal);
        if (!children.length || children.some(child => child.type !== 'paragraph' || !this.#owned(child, bot) || child.has_children)) integrity('Malformed transcript content blocks.');
        parts.push({ index: Number(match[1]), total: Number(match[2]), text: children.map(rawText).join('') });
      }
      if (value.type === 'paragraph' && rawText(value).startsWith(COMPLETE + cid + ' ')) {
        if (marker || !this.#owned(value, bot)) integrity('Invalid conversation completion marker.');
        const match = rawText(value).match(new RegExp(`^${COMPLETE}${cid} ([a-f0-9]{64}) (\\d+)$`));
        if (!match) integrity('Malformed conversation completion marker.');
        marker = { hash: match[1], count: Number(match[2]) };
      }
    }
    const hash = digest(metadata, parts.map(part => part.text).join(''));
    if (marker && (parts.length !== marker.count || !parts.length || parts.some(part => part.total !== marker.count) || marker.hash !== hash)) integrity('Saved conversation content does not match its completion receipt.');
    return { exists: true, complete: Boolean(marker), metadata, parts, hash };
  }
  async hasConversation(pageId, cid, { signal } = {}) {
    const pid = id(pageId); conversationId(cid); await this.getPage(pid, { signal });
    return (await this.#inspect(pid, cid, signal)).complete;
  }
  async #appendVerified(pageId, cid, children, matches, phase, signal) {
    const key = `${pageId}:${cid}`; let writeError;
    try { await this.#request('PATCH', `/blocks/${pageId}/children`, { children }, { signal }); }
    catch (error) { if (!error.ambiguous) throw error; writeError = error; }
    let observed;
    try { await this.getPage(pageId, { signal }); observed = await this.#inspect(pageId, cid, signal); }
    catch { this.#uncertainAppends.set(key, matches); throw new NotionAmbiguousWriteError('append', { pageId, conversationId: cid, phase }); }
    if (!matches(observed)) {
      this.#uncertainAppends.set(key, matches);
      throw new NotionAmbiguousWriteError('append', { pageId, conversationId: cid, phase, ...(writeError?.status ? { status: writeError.status } : {}) });
    }
    this.#uncertainAppends.delete(key); return observed;
  }
  async appendConversation(pageId, call, { signal } = {}) {
    const pid = id(pageId); const expected = callData(call); await this.getPage(pid, { signal });
    const key = `${pid}:${expected.cid}`; let observed = await this.#inspect(pid, expected.cid, signal);
    const uncertain = this.#uncertainAppends.get(key);
    if (uncertain && !uncertain(observed)) throw new NotionAmbiguousWriteError('append', { pageId: pid, conversationId: expected.cid });
    if (uncertain) this.#uncertainAppends.delete(key);
    if (observed.exists && observed.metadata !== expected.metadata) integrity('This conversation ID already has different metadata.');
    if (observed.complete) {
      if (observed.hash !== expected.hash) integrity('This conversation ID already has a different transcript.');
      return { pageId: pid, conversationId: expected.cid, verified: true, status: 'already_saved', contentHash: expected.hash };
    }
    if (!observed.exists) observed = await this.#appendVerified(pid, expected.cid, [block('heading_3', HEADING + expected.cid), block('paragraph', expected.metadata)], result => result.exists && result.metadata === expected.metadata, 'scaffold', signal);
    for (let i = 0; i < expected.groups.length; i++) {
      const expectedPart = expected.groups[i].map(rawText).join('');
      if (observed.parts[i]) {
        if (observed.parts[i].text !== expectedPart || observed.parts[i].total !== expected.groups.length) integrity('An existing partial transcript conflicts with this call.');
        continue;
      }
      observed = await this.#appendVerified(pid, expected.cid,
        [block('toggle', `Transcript ${expected.cid} part ${i + 1}/${expected.groups.length}`, expected.groups[i])],
        result => result.parts[i]?.text === expectedPart && result.parts[i]?.total === expected.groups.length, `transcript_part_${i + 1}`, signal);
    }
    if (observed.parts.length !== expected.groups.length || observed.hash !== expected.hash) integrity('Transcript verification failed before completion.');
    observed = await this.#appendVerified(pid, expected.cid, [block('paragraph', `${COMPLETE}${expected.cid} ${expected.hash} ${expected.groups.length}`)], result => result.complete && result.hash === expected.hash, 'completion', signal);
    return { pageId: pid, conversationId: expected.cid, verified: true, status: 'saved', contentHash: observed.hash };
  }
  async createThread(thread, call, { signal } = {}) {
    if (!thread || typeof thread !== 'object' || Array.isArray(thread)) invalid('Missing thread.');
    const tid = text(thread.threadId, 'thread ID', 256); text(thread.title, 'thread title', 2000);
    const normalizedCall = call === undefined ? null : callData(call);
    const values = { Call: thread.title, 'Thread ID': tid, Status: thread.status ?? 'Follow-up', 'Callback Count': 0 };
    const mapping = { business: 'Business / Person', phone: 'Phone', mission: 'Mission', type: 'Type', direction: 'Direction', originalConversationId: 'Conversation ID', summary: 'Summary', outcome: 'Outcome', nextAction: 'Next Action' };
    for (const [source, destination] of Object.entries(mapping)) if (thread[source] != null) values[destination] = thread[source];
    if (normalizedCall) {
      if (thread.originalConversationId && thread.originalConversationId !== normalizedCall.cid) invalid('Original conversation ID differs from the supplied call.');
      if (thread.direction && thread.direction !== normalizedCall.direction) invalid('Original direction differs from the supplied call.');
      values['Conversation ID'] = normalizedCall.cid; values.Direction = normalizedCall.direction;
    }
    if (thread.startedAt || normalizedCall) { values['date:Timestamp:start'] = iso(thread.startedAt ?? normalizedCall.startedAt, 'thread start'); values['date:Timestamp:is_datetime'] = 1; }
    const properties = propertiesFromFlat(values);
    let page = await this.findThread(tid, { signal });
    if (!page) {
      if (this.#uncertainCreates.has(tid)) throw new NotionAmbiguousWriteError('create', { threadId: tid });
      let createdPageId, accepted = false;
      try {
        const result = await this.#request('POST', '/pages', { parent: { type: 'data_source_id', data_source_id: this.#source }, properties }, { signal });
        accepted = true; createdPageId = id(result.id);
        page = await this.getPage(createdPageId, { signal });
        if (!propertiesMatch(page, properties)) throw new NotionAmbiguousWriteError('create', { threadId: tid, pageId: page.id });
      } catch (error) {
        if (!error.ambiguous && !accepted) throw error;
        this.#uncertainCreates.add(tid);
        const knownPageId = error.committedResourceId ?? createdPageId;
        try { page = knownPageId ? await this.getPage(knownPageId, { signal }) : await this.findThread(tid, { signal }); } catch { page = null; }
        if (!page || !propertiesMatch(page, properties)) throw new NotionAmbiguousWriteError('create', { threadId: tid, ...(knownPageId ? { pageId: knownPageId } : {}) });
      }
      this.#uncertainCreates.delete(tid);
    }
    page = await this.getPage(page.id, { signal });
    if (propertyValue(page.properties['Thread ID'], 'rich_text') !== tid) integrity('Created page does not match the requested thread.');
    if (values['Conversation ID'] && propertyValue(page.properties['Conversation ID'], 'rich_text') !== values['Conversation ID']) integrity('Thread already belongs to a different original conversation.');
    if (call !== undefined) await this.appendConversation(page.id, call, { signal });
    return id(page.id);
  }
  async updateThread(pageId, properties, { signal } = {}) {
    const pid = id(pageId);
    if (!properties || typeof properties !== 'object' || Array.isArray(properties)) invalid('Invalid page properties.');
    for (const name of Object.keys(properties)) if (IMMUTABLE.has(name)) invalid('Original thread identifiers, direction, and timestamp are immutable.');
    const expected = propertiesFromFlat(properties); const before = await this.getPage(pid, { signal });
    if (propertiesMatch(before, expected)) return { pageId: pid, verified: true };
    try { await this.#request('PATCH', `/pages/${pid}`, { properties: expected }, { signal }); }
    catch (error) { if (!error.ambiguous) throw error; }
    let page;
    try { page = await this.getPage(pid, { signal }); }
    catch { throw new NotionAmbiguousWriteError('update', { pageId: pid }); }
    if (!propertiesMatch(page, expected)) throw new NotionAmbiguousWriteError('update', { pageId: pid });
    return { pageId: pid, verified: true };
  }
}
