import test from 'node:test';
import assert from 'node:assert/strict';
import { NotionClient, NOTION_VERSION, NotionAmbiguousWriteError, pageToThread } from '../lib/notion.mjs';

const SOURCE = '10000000-0000-4000-8000-000000000001';
const BOT = '10000000-0000-4000-8000-000000000002';
const OTHER_BOT = '10000000-0000-4000-8000-000000000003';
const PAGE = '10000000-0000-4000-8000-000000000004';
const OTHER_SOURCE = '10000000-0000-4000-8000-000000000005';
const CID = '20000000-0000-4000-8000-000000000001';
const CALLBACK = '20000000-0000-4000-8000-000000000002';
const TOKEN = 'unit-test-dedicated-notion-token';
const clone = value => JSON.parse(JSON.stringify(value));
const response = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const rt = value => [{ type: 'text', text: { content: value } }];
const paragraph = value => ({ object: 'block', type: 'paragraph', paragraph: { rich_text: rt(value) } });
const valueOf = property => (property?.rich_text ?? property?.title ?? []).map(p => p.text.content).join('');
const thread = overrides => ({ threadId: 'fixture-store-inquiry', title: 'Fixture store — product inquiry', business: 'Example Store', mission: 'Ask whether the requested item is available.', phone: '+12125550123', type: 'Store Inquiry', direction: 'Outbound', startedAt: '2026-01-01T10:00:00Z', originalConversationId: CID, ...overrides });
const call = overrides => ({ conversationId: CID, startedAt: '2026-01-01T10:00:00Z', endedAt: '2026-01-01T10:01:00Z', direction: 'Outbound', participants: ['Nia', 'Store employee'], summary: 'The employee answered the availability question.', transcript: [{ speaker: 'Nia', text: 'Is the item available?' }, { speaker: 'Employee', text: 'Yes, it is available.' }], ...overrides });

class FakeNotion {
  pages = new Map(); children = new Map(); requests = []; sequence = 10;
  nextId() { return `30000000-0000-4000-8000-${String(this.sequence++).padStart(12, '0')}`; }
  seed(pageId = PAGE, threadId = 'fixture-store-inquiry', source = SOURCE) {
    const page = { object: 'page', id: pageId, parent: { type: 'data_source_id', data_source_id: source }, properties: {
      Call: { type: 'title', title: rt('Fixture call') },
      'Thread ID': { type: 'rich_text', rich_text: rt(threadId) },
      'Conversation ID': { type: 'rich_text', rich_text: rt(CID) },
      Direction: { type: 'select', select: { name: 'Outbound' } },
      Timestamp: { type: 'date', date: { start: '2026-01-01T10:00:00Z', end: null } },
      'Last Contact': { type: 'date', date: { start: '2026-01-01T10:01:00Z', end: null } },
      'Callback Count': { type: 'number', number: 0 },
      Summary: { type: 'rich_text', rich_text: rt('Original summary') },
      Outcome: { type: 'rich_text', rich_text: rt('Original outcome') },
      Status: { type: 'select', select: { name: 'Follow-up' } },
    } };
    this.pages.set(pageId, page); this.children.set(pageId, []); return page;
  }
  materialize(input, actor = BOT) {
    const child = clone(input), nested = child[child.type]?.children;
    child.id = this.nextId(); child.created_by = { id: actor }; child.last_edited_by = { id: actor };
    child.has_children = Boolean(nested?.length);
    if (nested) delete child[child.type].children;
    this.children.set(child.id, (nested ?? []).map(value => this.materialize(value, actor)));
    return child;
  }
  add(parentId, blocks, actor = BOT) {
    const created = blocks.map(value => this.materialize(value, actor));
    this.children.set(parentId, [...(this.children.get(parentId) ?? []), ...created]); return created;
  }
  pageProperties(properties) { return Object.fromEntries(Object.entries(properties).map(([key, value]) => [key, { type: Object.keys(value)[0], ...clone(value) }])); }
  fetch = async (urlValue, options = {}) => {
    const url = new URL(urlValue); const method = options.method ?? 'GET'; const body = options.body ? JSON.parse(options.body) : undefined;
    assert.equal(url.origin, 'https://api.notion.com');
    assert.equal(options.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(options.headers['Notion-Version'], NOTION_VERSION);
    assert.equal(options.redirect, 'error');
    this.requests.push({ path: url.pathname, query: new URLSearchParams(url.search), method, body, bytes: options.body ? Buffer.byteLength(options.body) : 0 });
    if (url.pathname === '/v1/users/me' && method === 'GET') return response({ object: 'user', id: BOT, type: 'bot' });
    if (url.pathname === `/v1/data_sources/${SOURCE}/query` && method === 'POST') {
      const found = [...this.pages.values()].filter(page => page.parent.data_source_id === SOURCE && (!body.filter || (body.filter.property === 'Thread ID' ? valueOf(page.properties['Thread ID']) === body.filter.rich_text.equals : page.properties.Status?.select?.name === body.filter.select.equals)));
      const start = body.start_cursor ? Number(body.start_cursor.split(':')[1]) : 0;
      const rows = found.slice(start, start + body.page_size); const hasMore = start + rows.length < found.length;
      return response({ object: 'list', results: rows, has_more: hasMore, next_cursor: hasMore ? `opaque:${start + rows.length}` : null });
    }
    if (url.pathname === '/v1/pages' && method === 'POST') {
      assert.deepEqual(body.parent, { type: 'data_source_id', data_source_id: SOURCE });
      const pageId = this.nextId(); const page = { object: 'page', id: pageId, parent: clone(body.parent), properties: this.pageProperties(body.properties) };
      this.pages.set(pageId, page); this.children.set(pageId, []); return response(page);
    }
    const pageMatch = url.pathname.match(/^\/v1\/pages\/([\da-f-]+)$/);
    if (pageMatch) {
      const page = this.pages.get(pageMatch[1]);
      if (!page) return response({ object: 'error', code: 'object_not_found' }, 404);
      if (method === 'PATCH') Object.assign(page.properties, this.pageProperties(body.properties));
      return response(page);
    }
    const blockMatch = url.pathname.match(/^\/v1\/blocks\/([\da-f-]+)\/children$/);
    if (blockMatch) {
      if (method === 'PATCH') {
        assert.ok(body.children.length <= 100);
        const created = this.add(blockMatch[1], body.children);
        return response({ object: 'list', results: created, has_more: false, next_cursor: null });
      }
      const all = this.children.get(blockMatch[1]) ?? [];
      const cursor = url.searchParams.get('start_cursor'); const start = cursor ? Number(cursor.split(':')[1]) : 0;
      const size = Number(url.searchParams.get('page_size')); const rows = all.slice(start, start + size); const hasMore = start + rows.length < all.length;
      return response({ object: 'list', results: rows, has_more: hasMore, next_cursor: hasMore ? `opaque:${start + rows.length}` : null });
    }
    throw new Error(`Unexpected mock route: ${method} ${url.pathname}`);
  };
  writes(path) { return this.requests.filter(r => r.method === 'PATCH' && (!path || r.path === path)); }
  creates() { return this.requests.filter(r => r.method === 'POST' && r.path === '/v1/pages'); }
}
function client(fake, options = {}) { return new NotionClient({ token: TOKEN, dataSourceId: SOURCE, fetchImpl: fake.fetch, sleepImpl: async () => {}, ...options }); }

test('requires explicit credentials, UUID scope, and bounded HTTP options', () => {
  assert.throws(() => new NotionClient({ dataSourceId: SOURCE }), /credential/);
  assert.throws(() => new NotionClient({ token: TOKEN, dataSourceId: 'not-a-uuid' }), /data source/);
  assert.throws(() => new NotionClient({ token: TOKEN, dataSourceId: SOURCE, timeoutMs: 120_000 }), /bounds/);
  assert.throws(() => new NotionClient({ token: TOKEN + '\n', dataSourceId: SOURCE }), /credential/);
  assert.equal(JSON.stringify(new NotionClient({ token: TOKEN, dataSourceId: SOURCE })), '{}');
});

test('exact thread query returns null/single and rejects duplicate rows', async () => {
  const fake = new FakeNotion(); const api = client(fake);
  assert.equal(await api.findThread('fixture-store-inquiry'), null);
  fake.seed(); assert.equal((await api.findThread('fixture-store-inquiry')).id, PAGE);
  fake.seed(fake.nextId()); await assert.rejects(api.findThread('fixture-store-inquiry'), e => e.code === 'duplicate_thread');
});

test('rejects malformed query and missing pagination rather than claiming no match', async () => {
  const fake = new FakeNotion();
  await assert.rejects(client(fake, { fetchImpl: async () => response({ results: [] }) }).findThread('fixture'), /Malformed/);
  await assert.rejects(client(fake, { fetchImpl: async () => response({ object: 'list', results: [], has_more: true, next_cursor: null }) }).findThread('fixture'), /pagination/);
});

test('rejects pages outside the configured data source and archived pages', async () => {
  const fake = new FakeNotion(); fake.seed(PAGE, 'fixture', OTHER_SOURCE);
  await assert.rejects(client(fake).getPage(PAGE), e => e.code === 'scope_error');
  const page = fake.seed(); page.in_trash = true;
  await assert.rejects(client(fake).getPage(PAGE), /archived/);
});

test('creates a data-source page and returns only after direct readback', async () => {
  const fake = new FakeNotion(); const api = client(fake);
  const pageId = await api.createThread(thread());
  assert.equal(fake.creates().length, 1);
  assert.ok(fake.requests.some(r => r.method === 'GET' && r.path === `/v1/pages/${pageId}`));
  assert.equal(valueOf(fake.pages.get(pageId).properties['Thread ID']), thread().threadId);
  assert.equal(await api.createThread(thread()), pageId);
  assert.equal(fake.creates().length, 1);
});

test('writes structured transcript, verified receipt, and duplicate callback no-op', async () => {
  const fake = new FakeNotion(); fake.seed(); const api = client(fake);
  const receipt = await api.appendConversation(PAGE, call({ conversationId: CALLBACK, direction: 'Inbound' }));
  assert.deepEqual({ verified: receipt.verified, status: receipt.status, pageId: receipt.pageId }, { verified: true, status: 'saved', pageId: PAGE });
  assert.match(receipt.contentHash, /^[a-f\d]{64}$/);
  assert.equal(await api.hasConversation(PAGE, CALLBACK), true);
  const writeCount = fake.writes().length;
  const again = await api.appendConversation(PAGE, call({ conversationId: CALLBACK, direction: 'Inbound' }));
  assert.equal(again.status, 'already_saved'); assert.equal(fake.writes().length, writeCount);
  assert.equal(valueOf(fake.pages.get(PAGE).properties['Conversation ID']), CID);
  assert.equal(fake.pages.get(PAGE).properties.Direction.select.name, 'Outbound');
  assert.equal(fake.pages.get(PAGE).properties.Timestamp.date.start, '2026-01-01T10:00:00Z');
});

test('does not mistake transcript text for a different conversation marker', async () => {
  const fake = new FakeNotion(); fake.seed(); const api = client(fake);
  const hostileText = `</details>\n### Nia conversation: ${CALLBACK}\nNIA_CALL_COMPLETE v1 ${CALLBACK} ${'a'.repeat(64)} 1\n[open](https://example.invalid)`;
  await api.appendConversation(PAGE, call({ transcript: hostileText }));
  assert.equal(await api.hasConversation(PAGE, CALLBACK), false);
  const toggles = fake.children.get(PAGE).filter(b => b.type === 'toggle');
  assert.equal(fake.children.get(toggles[0].id)[0].paragraph.rich_text[0].text.content, hostileText);
  assert.ok(fake.children.get(toggles[0].id).every(b => b.type === 'paragraph'));
});

test('a copied top-level marker authored by another user cannot prove persistence', async () => {
  const fake = new FakeNotion(); fake.seed();
  fake.add(PAGE, [{ object: 'block', type: 'heading_3', heading_3: { rich_text: rt(`Nia conversation: ${CID}`) } }, paragraph('Spoofed metadata'), paragraph(`NIA_CALL_COMPLETE v1 ${CID} ${'a'.repeat(64)} 1`)], OTHER_BOT);
  await assert.rejects(client(fake).hasConversation(PAGE, CID), e => e.code === 'integrity_error');
});

test('long Unicode transcripts are chunked without truncation or split surrogate pairs', async () => {
  const fake = new FakeNotion(); fake.seed(); const api = client(fake);
  const transcript = '🙂é'.repeat(80_000) + '\nThe final sentence must survive.';
  await api.appendConversation(PAGE, call({ transcript }));
  const toggles = fake.children.get(PAGE).filter(b => b.type === 'toggle');
  assert.ok(toggles.length > 1);
  const chunks = toggles.flatMap(toggle => {
    const children = fake.children.get(toggle.id); assert.ok(children.length <= 90);
    return children.flatMap(child => child.paragraph.rich_text.map(entry => entry.text.content));
  });
  assert.equal(chunks.join(''), transcript);
  assert.ok(chunks.every(chunk => chunk.length <= 2000 && !/[\uD800-\uDBFF]$/.test(chunk)));
  assert.ok(fake.requests.every(request => request.bytes <= 450_000));
  assert.equal(await api.hasConversation(PAGE, CID), true);
});

test('recovers an append timeout that committed without replaying that part', async () => {
  const fake = new FakeNotion(); fake.seed(); let failed = false;
  const api = client(fake, { fetchImpl: async (url, options) => {
    const body = options.body && JSON.parse(options.body);
    if (options.method === 'PATCH' && body.children?.[0]?.type === 'toggle' && !failed) {
      failed = true; await fake.fetch(url, options); throw new Error('Simulated transport loss');
    }
    return fake.fetch(url, options);
  } });
  assert.equal((await api.appendConversation(PAGE, call())).verified, true);
  assert.equal(fake.writes().filter(r => r.body.children?.[0]?.type === 'toggle').length, 1);
});

test('an uncommitted ambiguous append is held rather than blindly replayed', async () => {
  const fake = new FakeNotion(); fake.seed(); let attempts = 0;
  const api = client(fake, { fetchImpl: async (url, options) => {
    const body = options.body && JSON.parse(options.body);
    if (options.method === 'PATCH' && body.children?.[0]?.type === 'toggle') { attempts++; throw new Error('Simulated transport loss'); }
    return fake.fetch(url, options);
  } });
  await assert.rejects(api.appendConversation(PAGE, call()), e => e instanceof NotionAmbiguousWriteError && e.phase === 'transcript_part_1');
  assert.equal(await api.hasConversation(PAGE, CID), false);
  await assert.rejects(api.appendConversation(PAGE, call()), e => e.ambiguous && e.retrySafe === false);
  assert.equal(attempts, 1);
});

test('recovers a committed page-create timeout by exact thread lookup', async () => {
  const fake = new FakeNotion(); let attempts = 0;
  const api = client(fake, { fetchImpl: async (url, options) => {
    if (options.method === 'POST' && new URL(url).pathname === '/v1/pages') { attempts++; await fake.fetch(url, options); throw new Error('Simulated timeout'); }
    return fake.fetch(url, options);
  } });
  const pageId = await api.createThread(thread());
  assert.ok(fake.pages.has(pageId)); assert.equal(attempts, 1);
});

test('an ambiguous page creation with no observed page is never blindly replayed', async () => {
  const fake = new FakeNotion(); let attempts = 0;
  const api = client(fake, { fetchImpl: async (url, options) => {
    if (options.method === 'POST' && new URL(url).pathname === '/v1/pages') { attempts++; throw new Error('Simulated timeout'); }
    return fake.fetch(url, options);
  } });
  await assert.rejects(api.createThread(thread()), e => e.ambiguous && e.operation === 'create');
  await assert.rejects(api.createThread(thread()), e => e.ambiguous && e.operation === 'create');
  assert.equal(attempts, 1); assert.equal(fake.pages.size, 0);
});

test('503 committed_resource_id is reconciled directly without another create', async () => {
  const fake = new FakeNotion(); let pageId;
  const api = client(fake, { fetchImpl: async (url, options) => {
    if (options.method === 'POST' && new URL(url).pathname === '/v1/pages') {
      const committed = await (await fake.fetch(url, options)).json(); pageId = committed.id;
      return response({ object: 'error', code: 'service_unavailable', additional_data: { committed_resource_id: pageId, retry_guidance: ['Read the object again.'] } }, 503);
    }
    return fake.fetch(url, options);
  } });
  assert.equal(await api.createThread(thread()), pageId);
  assert.equal(fake.creates().length, 1);
});

test('create with original call verifies both the page and full transcript', async () => {
  const fake = new FakeNotion(); const api = client(fake);
  const pageId = await api.createThread(thread(), call());
  assert.equal(await api.hasConversation(pageId, CID), true);
  assert.equal(valueOf(fake.pages.get(pageId).properties['Conversation ID']), CID);
});

test('property updates preserve original values and verify committed timeouts', async () => {
  const fake = new FakeNotion(); fake.seed(); let attempts = 0;
  const api = client(fake, { fetchImpl: async (url, options) => {
    if (options.method === 'PATCH' && new URL(url).pathname === `/v1/pages/${PAGE}`) { attempts++; await fake.fetch(url, options); throw new Error('Simulated response loss'); }
    return fake.fetch(url, options);
  } });
  const update = { Summary: 'Updated verified summary', 'Callback Count': 1, 'date:Last Contact:start': '2026-01-02T15:00:00Z', 'date:Last Contact:is_datetime': 1 };
  assert.deepEqual(await api.updateThread(PAGE, update), { pageId: PAGE, verified: true });
  assert.equal(attempts, 1);
  assert.equal(valueOf(fake.pages.get(PAGE).properties['Conversation ID']), CID);
  assert.equal(fake.pages.get(PAGE).properties.Timestamp.date.start, '2026-01-01T10:00:00Z');
  await api.updateThread(PAGE, update); assert.equal(attempts, 1);
  await assert.rejects(api.updateThread(PAGE, { 'Conversation ID': CALLBACK }), /immutable/);
});

test('a mismatching property readback never produces a durable receipt', async () => {
  const fake = new FakeNotion(); fake.seed();
  const api = client(fake, { fetchImpl: async (url, options) => options.method === 'PATCH' ? response(fake.pages.get(PAGE)) : fake.fetch(url, options) });
  await assert.rejects(api.updateThread(PAGE, { Summary: 'A value that was not saved' }), e => e.ambiguous && e.operation === 'update');
});

test('honors Retry-After for 429 without shortening the required wait', async () => {
  const fake = new FakeNotion(); fake.seed(); const sleeps = []; let reads = 0;
  const api = client(fake, { sleepImpl: async ms => sleeps.push(ms), fetchImpl: async (url, options) => {
    if (reads++ === 0) return response({ object: 'error', code: 'rate_limited' }, 429, { 'retry-after': '2' });
    return fake.fetch(url, options);
  } });
  assert.equal((await api.getPage(PAGE)).id, PAGE); assert.deepEqual(sleeps, [2000]);
});

test('long rate-limit delays are returned for durable scheduling rather than capped early', async () => {
  const fake = new FakeNotion(); const sleeps = [];
  const api = client(fake, { sleepImpl: async ms => sleeps.push(ms), fetchImpl: async () => response({ object: 'error', code: 'rate_limited' }, 429, { 'retry-after': '120' }) });
  await assert.rejects(api.getPage(PAGE), e => e.retryAfterMs === 120_000 && e.retrySafe === true);
  assert.deepEqual(sleeps, []);
});

test('blocked API access and 401 authentication errors are not retried or echoed', async () => {
  for (const [status, data] of [[429, { code: 'rate_limited', additional_data: { rate_limit_reason: 'public_api_request_blocked' } }], [401, { code: 'unauthorized', message: TOKEN }]]) {
    let attempts = 0;
    const api = client(new FakeNotion(), { fetchImpl: async () => { attempts++; return response(data, status); } });
    await assert.rejects(api.getPage(PAGE), e => e.retrySafe === false && !e.message.includes(TOKEN));
    assert.equal(attempts, 1);
  }
});

test('pagination traverses an existing long page before matching a saved call', async () => {
  const fake = new FakeNotion(); fake.seed(); fake.add(PAGE, Array.from({ length: 205 }, (_, n) => paragraph(`Existing note ${n}`)));
  const api = client(fake); await api.appendConversation(PAGE, call());
  assert.equal(await api.hasConversation(PAGE, CID), true);
  assert.ok(fake.requests.some(r => r.query.get('start_cursor') === 'opaque:200'));
});

test('missing call data and invalid properties are rejected before writes', async () => {
  const fake = new FakeNotion(); fake.seed(); const api = client(fake);
  for (const invalidCall of [undefined, call({ transcript: '' }), call({ transcript: [{ speaker: 'Nia' }] }), call({ transcript: 'x'.repeat(500_001) }), call({ startedAt: 'yesterday' }), call({ direction: 'sideways' }), call({ endedAt: '2025-12-31T00:00:00Z' })]) await assert.rejects(api.appendConversation(PAGE, invalidCall), e => e.code === 'invalid_data');
  await assert.rejects(api.updateThread(PAGE, { 'Callback Count': -1 }), /callback count/);
  await assert.rejects(api.updateThread(PAGE, { 'Unsupported Column': 'value' }), /Unsupported/);
  assert.equal(fake.writes().length, 0);
});

test('same conversation ID with changed transcript is flagged instead of duplicated', async () => {
  const fake = new FakeNotion(); fake.seed(); const api = client(fake); await api.appendConversation(PAGE, call());
  const writes = fake.writes().length;
  await assert.rejects(api.appendConversation(PAGE, call({ transcript: 'A different conversation' })), e => e.code === 'integrity_error');
  assert.equal(fake.writes().length, writes);
});

test('missing or edited transcript content cannot pass completion verification', async () => {
  const fake = new FakeNotion(); fake.seed(); const api = client(fake); await api.appendConversation(PAGE, call());
  const toggle = fake.children.get(PAGE).find(b => b.type === 'toggle');
  fake.children.get(toggle.id)[0].paragraph.rich_text[0].text.content = 'Changed after saving';
  await assert.rejects(api.hasConversation(PAGE, CID), e => e.code === 'integrity_error');
});

test('malformed successful block-list responses do not become a false no-match', async () => {
  const fake = new FakeNotion(); fake.seed();
  const api = client(fake, { fetchImpl: async (url, options) => new URL(url).pathname.includes('/blocks/') ? response({ object: 'list', has_more: false }) : fake.fetch(url, options) });
  await assert.rejects(api.hasConversation(PAGE, CID), e => e.code === 'invalid_data');
});

test('listThreads is bounded, paginated, status-filtered, and explicit about completeness', async () => {
  const fake = new FakeNotion();
  for (let n = 0; n < 125; n++) fake.seed(fake.nextId(), `fixture-${n}`);
  const completed = fake.seed(fake.nextId(), 'completed'); completed.properties.Status.select.name = 'Completed';
  const api = client(fake);
  const bounded = await api.listThreads(); assert.equal(bounded.pages.length, 50); assert.equal(bounded.complete, false);
  const all = await api.listThreads({ limit: 200 }); assert.equal(all.pages.length, 125); assert.equal(all.complete, true);
  assert.ok(fake.requests.some(r => r.body?.start_cursor === 'opaque:100'));
  assert.equal((await api.listThreads({ limit: 200, status: null })).pages.length, 126);
  await assert.rejects(api.listThreads({ limit: 501 }), /bounds/);
});

test('pageToThread maps existing properties without inventing missing thread IDs', () => {
  const fake = new FakeNotion(); const page = fake.seed();
  const mapped = pageToThread(page);
  assert.equal(mapped.pageId, PAGE); assert.equal(mapped.threadId, 'fixture-store-inquiry');
  assert.equal(mapped.originalConversationId, CID); assert.equal(mapped.direction, 'Outbound');
  assert.equal(mapped.startedAt, '2026-01-01T10:00:00.000Z'); assert.equal(mapped.callbackCount, 0);
  assert.equal(mapped.phone, ''); assert.equal(mapped.lastContact, '2026-01-01T10:01:00.000Z');
  delete page.properties['Thread ID']; assert.equal(pageToThread(page).threadId, '');
  page.properties.Summary.rich_text = [{}]; assert.throws(() => pageToThread(page), /Malformed/);
});

test('pre-aborted signals prevent every read and mutation from making network calls', async () => {
  const fake = new FakeNotion(); const api = client(fake); const controller = new AbortController(); controller.abort();
  const signal = controller.signal;
  for (const action of [
    () => api.getPage(PAGE, { signal }), () => api.findThread('fixture', { signal }),
    () => api.listThreads({ signal }), () => api.hasConversation(PAGE, CID, { signal }),
    () => api.createThread(thread(), undefined, { signal }), () => api.appendConversation(PAGE, call(), { signal }),
    () => api.updateThread(PAGE, { Summary: 'New summary' }, { signal }),
  ]) await assert.rejects(action(), e => e.code === 'aborted');
  assert.equal(fake.requests.length, 0);
});

test('in-flight read cancellation reaches fetch and does not retry', async () => {
  const controller = new AbortController(); let attempts = 0; let observedSignal;
  const api = client(new FakeNotion(), { fetchImpl: async (_url, options) => {
    attempts++; observedSignal = options.signal;
    return new Promise((_resolve, reject) => { options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }); queueMicrotask(() => controller.abort()); });
  } });
  await assert.rejects(api.getPage(PAGE, { signal: controller.signal }), e => e.code === 'aborted');
  assert.equal(attempts, 1); assert.equal(observedSignal.aborted, true);
});

test('a mutation cancelled in flight is ambiguous and stops subsequent writes', async () => {
  const fake = new FakeNotion(); fake.seed(); const controller = new AbortController(); let mutationAttempts = 0; let observedSignal;
  const api = client(fake, { fetchImpl: async (url, options) => {
    if (options.method === 'PATCH') {
      mutationAttempts++; observedSignal = options.signal;
      return new Promise((_resolve, reject) => { options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }); queueMicrotask(() => controller.abort()); });
    }
    return fake.fetch(url, options);
  } });
  await assert.rejects(api.appendConversation(PAGE, call(), { signal: controller.signal }), e => e.ambiguous);
  assert.equal(mutationAttempts, 1); assert.equal(observedSignal.aborted, true);
  assert.equal(fake.writes().length, 0);
});

test('cancellation interrupts Retry-After waits without another request', async () => {
  const controller = new AbortController(); let attempts = 0;
  const api = client(new FakeNotion(), {
    fetchImpl: async () => { attempts++; return response({ code: 'rate_limited' }, 429, { 'retry-after': '60' }); },
    sleepImpl: async () => new Promise(() => { queueMicrotask(() => controller.abort()); }),
  });
  await assert.rejects(api.getPage(PAGE, { signal: controller.signal }), e => e.code === 'aborted');
  assert.equal(attempts, 1);
});

test('a page created before a cancelled readback is reported as ambiguous', async () => {
  const fake = new FakeNotion(); const controller = new AbortController();
  const api = client(fake, { fetchImpl: async (url, options) => {
    const result = await fake.fetch(url, options);
    if (options.method === 'POST' && new URL(url).pathname === '/v1/pages') controller.abort();
    return result;
  } });
  await assert.rejects(api.createThread(thread(), undefined, { signal: controller.signal }), e => e.ambiguous && Boolean(e.pageId));
  assert.equal(fake.creates().length, 1); assert.equal(fake.pages.size, 1);
});
