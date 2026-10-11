import test from 'node:test';
import assert from 'node:assert/strict';
import { TelnyxClient, conversationDirection } from '../lib/telnyx.mjs';

const settings = { apiKey: 'synthetic-server-api-key', assistantId: 'assistant-test', agentNumber: '+13125550100', maxRetries: 0 };
const callControlId = 'v3:abc+def/example';
const conversation = () => ({ id: 'conversation-one', metadata: {
  assistant_id: settings.assistantId, telnyx_agent_target: settings.agentNumber,
  telnyx_end_user_target: '+13125550123', telnyx_conversation_channel: 'phone_call', call_control_id: callControlId
} });
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const page = (number, data, { totalPages = 2, totalResults = 3 } = {}) => ({ data, meta: { page_number: number, page_size: 2, total_pages: totalPages, total_results: totalResults } });
const messages = [
  { role: 'user', text: 'A question', sent_at: '2026-10-11T20:00:01Z' },
  { role: 'assistant', text: 'An answer', sent_at: '2026-10-11T20:00:02Z' },
  { role: 'user', text: 'Thank you', sent_at: '2026-10-11T20:00:03Z' }
];

test('getConversation validates native assistant, phone, channel, and requested ID', async () => {
  const calls = [];
  const client = new TelnyxClient({ ...settings, fetchImpl: async (url, init) => {
    calls.push([url, init]); return json({ data: conversation() });
  } });
  assert.deepEqual(await client.getConversation('conversation-one'), conversation());
  assert.equal(calls[0][1].method, 'GET');
  assert.equal(calls[0][1].redirect, 'error');
  assert.equal(calls[0][1].headers.Authorization, `Bearer ${settings.apiKey}`);
  assert.equal(JSON.stringify(client).includes(settings.apiKey), false);
  for (const alteration of [
    (value) => { value.metadata.assistant_id = 'assistant-other'; },
    (value) => { value.metadata.telnyx_agent_target = '+13125550999'; },
    (value) => { value.metadata.telnyx_conversation_channel = 'sms_chat'; },
    (value) => { delete value.metadata; },
    (value) => { value.id = 'conversation-other'; }
  ]) {
    const bad = conversation(); alteration(bad);
    const unsafe = new TelnyxClient({ ...settings, fetchImpl: async () => json({ data: bad }) });
    await assert.rejects(unsafe.getConversation('conversation-one'), { code: 'ownership_mismatch' });
  }
});

test('direction requires both native endpoint pairs and never guesses from a direction label', () => {
  const value = conversation();
  const caller = value.metadata.telnyx_end_user_target;
  value.metadata.from = caller;
  value.metadata.to = settings.agentNumber;
  value.direction = 'outbound';
  value.metadata.direction = 'outbound';
  assert.equal(conversationDirection(value, settings.agentNumber), 'inbound');
  value.metadata.from = settings.agentNumber;
  value.metadata.to = caller;
  assert.equal(conversationDirection(value, settings.agentNumber), 'outbound');
  for (const alteration of [
    (candidate) => { delete candidate.metadata.from; },
    (candidate) => { delete candidate.metadata.to; },
    (candidate) => { candidate.metadata.to = '+13125550999'; },
    (candidate) => { candidate.metadata.from = '+13125550999'; },
    (candidate) => { candidate.metadata.from = 'sip:caller@example.test'; },
    (candidate) => { candidate.metadata.telnyx_agent_target = '+13125550999'; },
    (candidate) => { candidate.metadata.telnyx_end_user_target = settings.agentNumber; },
    (candidate) => { candidate.metadata.telnyx_conversation_channel = 'web_call'; },
    (candidate) => { delete candidate.metadata; }
  ]) {
    const invalid = structuredClone(value); alteration(invalid);
    assert.throws(() => conversationDirection(invalid, settings.agentNumber), { code: 'direction_unverified' });
  }
  assert.throws(() => conversationDirection(value, '+13125550999'), { code: 'direction_unverified' });
});

test('full transcript traverses every declared page and preserves message timestamps', async () => {
  const urls = [];
  const client = new TelnyxClient({ ...settings, fetchImpl: async (url) => {
    urls.push(new URL(url));
    if (!url.includes('/messages')) return json({ data: conversation() });
    const number = Number(new URL(url).searchParams.get('page[number]'));
    return json(number === 1 ? page(1, messages.slice(0, 2)) : page(2, messages.slice(2)));
  } });
  assert.deepEqual(await client.getMessages('conversation-one'), { messages, complete: true, pageCount: 2 });
  assert.equal(urls.length, 3);
  assert.equal(urls[1].searchParams.get('page[size]'), '100');
  assert.equal(urls[2].searchParams.get('page[number]'), '2');
});

test('messages and insights never become available before ownership verification', async () => {
  for (const method of ['getMessages', 'getInsights']) {
    let calls = 0;
    const bad = conversation(); bad.metadata.assistant_id = 'assistant-other';
    const client = new TelnyxClient({ ...settings, fetchImpl: async () => { calls += 1; return json({ data: bad }); } });
    await assert.rejects(client[method]('conversation-one'), { code: 'ownership_mismatch' });
    assert.equal(calls, 1);
  }
});

test('missing metadata, absent pages, changed totals, and page limits can never claim completeness', async () => {
  const cases = [
    { pages: [page(1, [{ role: 'user' }], { totalPages: 1, totalResults: 1 })], reason: 'invalid_page' },
    { pages: [{ data: messages }], reason: 'pagination_unverified' },
    { pages: [page(1, messages.slice(0, 2)), page(2, [])], reason: 'pagination_inconsistent' },
    { pages: [page(1, messages.slice(0, 2)), page(1, messages.slice(2))], reason: 'pagination_unverified' },
    { pages: [page(1, messages.slice(0, 2)), page(2, messages.slice(2), { totalPages: 3, totalResults: 4 })], reason: 'pagination_changed' },
    { pages: [page(1, messages.slice(0, 2))], reason: 'page_limit', maxPages: 1 }
  ];
  for (const scenario of cases) {
    let index = 0;
    const client = new TelnyxClient({ ...settings, maxPages: scenario.maxPages ?? 10, fetchImpl: async (url) => {
      if (!url.includes('/messages')) return json({ data: conversation() });
      return json(scenario.pages[index++]);
    } });
    const result = await client.getMessages('conversation-one');
    assert.equal(result.complete, false);
    assert.equal(result.reason, scenario.reason);
  }
});

test('a failed later page returns explicitly partial data; verified empty transcript is complete', async () => {
  let index = 0;
  const client = new TelnyxClient({ ...settings, fetchImpl: async (url) => {
    if (!url.includes('/messages')) return json({ data: conversation() });
    return index++ === 0 ? json(page(1, messages.slice(0, 2))) : json({ error: 'unavailable' }, 503);
  } });
  const result = await client.getMessages('conversation-one');
  assert.equal(result.complete, false);
  assert.deepEqual(result.messages, messages.slice(0, 2));
  assert.equal(result.reason, 'http_error');
  const empty = new TelnyxClient({ ...settings, fetchImpl: async (url) => json(url.includes('/messages') ? page(1, [], { totalPages: 0, totalResults: 0 }) : { data: conversation() }) });
  assert.deepEqual(await empty.getMessages('conversation-one'), { messages: [], complete: true, pageCount: 1 });
});

test('insights retain their REST envelope after ownership verification', async () => {
  const insights = { data: [{ id: 'result-one', status: 'completed', created_at: '2026-10-11T20:01:00Z',
    conversation_insights: [{ insight_id: 'insight-one', result: 'A plain summary.' },
      { insight_id: 'insight-two', result: '{"outcome":"known"}' }] }],
    meta: { page_number: 1, page_size: 20, total_pages: 1, total_results: 1 } };
  const client = new TelnyxClient({ ...settings, fetchImpl: async (url) => json(url.endsWith('/insights') ? insights : { data: conversation() }) });
  assert.deepEqual(await client.getInsights('conversation-one'), insights);
});

test('live linkage uses server-side assistant/number/channel filters and safely encodes call IDs', async () => {
  let requested;
  const client = new TelnyxClient({ ...settings, fetchImpl: async (url) => {
    requested = new URL(url); return json({ data: [conversation()], meta: { total_results: 1, total_pages: 1 } });
  } });
  const result = await client.listConversations({ callControlId, limit: 5 });
  assert.equal(result.complete, true);
  assert.equal(requested.searchParams.get('metadata->assistant_id'), `eq.${settings.assistantId}`);
  assert.equal(requested.searchParams.get('metadata->telnyx_agent_target'), `eq.${settings.agentNumber}`);
  assert.equal(requested.searchParams.get('metadata->call_control_id'), `eq.${callControlId}`);
  assert.equal(requested.searchParams.get('metadata->telnyx_conversation_channel'), 'eq.phone_call');
  assert.equal(requested.searchParams.get('limit'), '5');
  const bad = conversation(); bad.metadata.call_control_id = 'v3:other-call';
  const mismatch = new TelnyxClient({ ...settings, fetchImpl: async () => json({ data: [bad] }) });
  await assert.rejects(mismatch.listConversations({ callControlId }), { code: 'ownership_mismatch' });
  await assert.rejects(client.listConversations({ callControlId: 'v3:x&or=anything' }), { code: 'invalid_filter' });
});

test('retry only bounded read calls; upstream secrets and raw errors are never returned', async () => {
  let attempts = 0;
  const methods = [];
  const client = new TelnyxClient({ ...settings, maxRetries: 1, fetchImpl: async (_url, init) => {
    methods.push(init.method);
    return attempts++ === 0 ? json({ secret: settings.apiKey }, 503, { 'retry-after': '0' }) : json({ data: conversation() });
  } });
  assert.equal((await client.getConversation('conversation-one')).id, 'conversation-one');
  assert.deepEqual(methods, ['GET', 'GET']);
  let badAttempts = 0;
  const rejected = new TelnyxClient({ ...settings, maxRetries: 3, fetchImpl: async () => { badAttempts += 1; return json({ secret: settings.apiKey }, 401); } });
  await assert.rejects(rejected.getConversation('conversation-one'), (error) => error.code === 'http_error' && !error.message.includes(settings.apiKey));
  assert.equal(badAttempts, 1);
  let limitedAttempts = 0;
  const limited = new TelnyxClient({ ...settings, maxRetries: 3, fetchImpl: async () => { limitedAttempts += 1; return json({}, 429, { 'retry-after': '60' }); } });
  await assert.rejects(limited.getConversation('conversation-one'), { code: 'http_error', retryAfterMs: 60_000, deferRetry: true });
  assert.equal(limitedAttempts, 1);
});

test('Retry-After HTTP dates are respected and page failures carry the provider wait to the worker', async () => {
  const retryDate = new Date(Date.now() + 60_000).toUTCString();
  let attempts = 0;
  const dated = new TelnyxClient({ ...settings, maxRetries: 3, fetchImpl: async () => {
    attempts += 1;
    return json({}, 429, { 'retry-after': retryDate });
  } });
  await assert.rejects(dated.getConversation('conversation-one'), (error) =>
    error.code === 'http_error' && error.retryable && error.deferRetry && error.retryAfterMs > 58_000 && error.retryAfterMs <= 60_000);
  assert.equal(attempts, 1);
  const transcript = new TelnyxClient({ ...settings, maxRetries: 3, fetchImpl: async (url) =>
    url.includes('/messages') ? json({}, 429, { 'retry-after': '60' }) : json({ data: conversation() }) });
  assert.deepEqual(await transcript.getMessages('conversation-one'), {
    messages: [], complete: false, pageCount: 0, reason: 'http_error', retryAfterMs: 60_000
  });
});

test('timeouts, malformed JSON, oversized responses, and unconfigured credentials fail predictably', async () => {
  const timeout = new TelnyxClient({ ...settings, timeoutMs: 10, fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('private network detail')), { once: true });
  }) });
  await assert.rejects(timeout.getConversation('conversation-one'), { code: 'timeout' });
  const malformed = new TelnyxClient({ ...settings, fetchImpl: async () => new Response('not JSON') });
  await assert.rejects(malformed.getConversation('conversation-one'), { code: 'invalid_response' });
  const large = new TelnyxClient({ ...settings, fetchImpl: async () => json({}, 200, { 'content-length': String(6 * 1024 * 1024) }) });
  await assert.rejects(large.getConversation('conversation-one'), { code: 'response_too_large' });
  assert.throws(() => new TelnyxClient({ ...settings, apiKey: '' }), { code: 'invalid_configuration' });
});
