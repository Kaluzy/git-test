import test from 'node:test';
import assert from 'node:assert/strict';
import { configure, httpsOrigin, main, pending, preflight, redrive, telnyxWrite } from '../scripts/operate.mjs';
import { Relay } from '../lib/relay.mjs';
import { pageToThread } from '../lib/notion.mjs';
import { queueIdempotencyKey } from '../lib/queue.mjs';
import { FakeNotion, canonicalPage, ledgerFixture, config, ASSISTANT, SOURCE, ORIGINAL, CALLBACK, CALLBACK_TWO } from './helpers.mjs';

const ORIGIN = 'https://relay.example.test';
const THREAD = 'example-store-thread';
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const clone = value => structuredClone(value);

class ProviderFixture {
  assistant = {
    id: ASSISTANT, name: 'Fixture assistant', model: 'fixture-model', greeting: 'Hello.',
    voice_settings: { voice: 'fixture-voice', speed: 1.1 }, tool_ids: ['fixture-shared-tool'],
    messaging_settings: { conversation_inactivity_minutes: 10 },
    insight_settings: { insight_group_id: config.insightGroupId },
    dynamic_variables: { locale: 'en', mission_packet: 'Old static mission', nia_session_token: 'synthetic-old-session-value' },
    dynamic_variables_webhook_url: '',
    telephony_settings: { default_texml_app_id: 'fixture-existing-routing', time_limit_secs: 900, disable_dtmf: true, recording_settings: { enabled: true, channels: 'dual' } },
    tools: [
      { type: 'send_dtmf', shared: true, tool_id: 'fixture-shared-tool', send_dtmf: {} },
      { type: 'webhook', shared: false, tool_id: 'fixture-inline-tool', webhook: { name: 'existing_business_tool', description: 'Existing approved tool.', url: 'https://example.test/existing-tool', method: 'POST' } },
    ],
  };
  group = { id: config.insightGroupId, name: 'Fixture dedicated group', description: 'Existing insight group.', webhook: '', insights: [{ id: 'fixture-summary-insight', instructions: 'Summarize the conversation.' }] };
  requests = []; writes = []; faults = []; readFailures = new Set(); unsignedStatus = 401; healthy = true;
  constructor(ledger) { this.ledger = ledger; }
  request = async path => {
    const kind = path === `/ai/assistants/${ASSISTANT}` ? 'assistant' : path === `/ai/conversations/insight-groups/${config.insightGroupId}` ? 'group' : null;
    assert.ok(kind, 'operations must only read the configured assistant/group');
    this.requests.push({ kind: 'read', resource: kind });
    if (this.readFailures.delete(kind)) throw new Error('Private provider readback failure');
    return kind === 'assistant' ? clone(this.assistant) : { data: clone(this.group) };
  };
  fetch = async (urlValue, options) => {
    const url = new URL(urlValue);
    assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit'); assert.ok(options.signal instanceof AbortSignal);
    if (url.origin === ORIGIN) {
      assert.equal(options.headers.Authorization, undefined);
      if (url.pathname === '/api/health') { assert.equal(options.method, 'GET'); return json({ ok: this.healthy, service: 'nia-relay', version: 2 }); }
      assert.ok(['/api/assistant-initialization', '/api/lookup-open-thread', '/api/save-call-note', '/api/telnyx-events'].includes(url.pathname));
      assert.equal(options.method, 'POST'); assert.equal(options.body, '{}');
      return json({ error: 'Unauthorized' }, this.unsignedStatus);
    }
    assert.equal(url.origin, 'https://api.telnyx.com');
    assert.equal(options.headers.Authorization, `Bearer ${config.telnyxApiKey}`);
    const kind = url.pathname === `/v2/ai/assistants/${ASSISTANT}` ? 'assistant' : url.pathname === `/v2/ai/conversations/insight-groups/${config.insightGroupId}` ? 'group' : null;
    assert.ok(kind, 'no calls, messages, phones, or TeXML endpoints are permitted');
    assert.equal(options.method, kind === 'assistant' ? 'POST' : 'PUT');
    const body = JSON.parse(options.body); this.writes.push({ kind, body }); this.requests.push({ kind: 'write', resource: kind });
    const latest = (await this.ledger.read('configuration:last'))?.value;
    assert.equal(latest?.state, `${kind}_dispatching`, 'a durable dispatch marker must precede a provider write');
    const snapshot = (await this.ledger.read(latest.snapshotKey))?.value;
    assert.ok(snapshot?.assistant && snapshot.group, 'the complete private snapshot must precede provider writes');
    assert.equal(JSON.stringify(snapshot).includes(config.telnyxApiKey), false);
    const faultIndex = this.faults.findIndex(fault => fault.resource === kind);
    const fault = faultIndex < 0 ? null : this.faults.splice(faultIndex, 1)[0];
    if (fault?.mode === 'before_timeout') throw new Error('Private timeout before commit');
    if (kind === 'assistant') {
      assert.deepEqual(Object.keys(body).sort(), ['dynamic_variables', 'dynamic_variables_webhook_url', 'instructions', 'telephony_settings', 'tools']);
      assert.deepEqual(body.telephony_settings, { time_limit_secs: 360, disable_dtmf: false, recording_settings: { enabled: false } });
      const old = clone(this.assistant);
      Object.assign(this.assistant, clone(body));
      this.assistant.telephony_settings = { ...old.telephony_settings, ...body.telephony_settings, recording_settings: { ...old.telephony_settings.recording_settings, ...body.telephony_settings.recording_settings } };
      this.assistant.tools = [...old.tools.filter(tool => tool.shared), ...body.tools.map((tool, index) => ({ ...clone(tool), shared: false, tool_id: `generated-inline-${index}` }))];
      if (fault?.mode === 'voice_drift') this.assistant.voice_settings.voice = 'unexpected-voice';
      if (fault?.mode === 'routing_drift') this.assistant.telephony_settings.default_texml_app_id = 'unexpected-routing';
    } else { assert.deepEqual(Object.keys(body), ['webhook']); Object.assign(this.group, clone(body)); }
    if (fault?.mode === 'after_timeout') throw new Error('Private timeout after commit');
    if (fault?.mode === 'readback_failure') this.readFailures.add(kind);
    return kind === 'assistant' ? json(this.assistant) : json({ data: this.group });
  };
}

async function fixture({ queueCompletes = true } = {}) {
  const clock = ledgerFixture(); const notion = new FakeNotion([canonicalPage({ callbackCount: 2 })]);
  const provider = new ProviderFixture(clock.ledger); const enqueued = []; let relay;
  const enqueue = async (eventId, options) => {
    queueIdempotencyKey(eventId, options);
    enqueued.push({ eventId, options });
    const event = await clock.ledger.getEvent(eventId);
    if (queueCompletes && event?.value.eventType === 'nia.healthcheck') await relay.processQueuedEvent(eventId);
  };
  relay = new Relay({ config, ledger: clock.ledger, notion, telnyx: provider, enqueue, now: clock.now });
  await relay.registerThread({ ...pageToThread(notion.pages.values().next().value), verifiedConversationIds: [CALLBACK, CALLBACK_TWO] });
  let sequence = 0;
  return { ...clock, relay, notion, provider, enqueued, origin: ORIGIN, fetchImpl: provider.fetch,
    uuidImpl: () => `40000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`, sleepImpl: async ms => { clock.advance(ms); },
    instructionsImpl: async options => { assert.deepEqual(options, { liveLookup: true }); return 'Reviewed production fixture instructions.\n'; } };
}
async function proof(f, overrides = {}) {
  await f.ledger.create('preflight:last', { origin: ORIGIN, assistantId: ASSISTANT, dataSourceId: SOURCE, namespace: config.namespace,
    insightGroupId: config.insightGroupId, at: new Date(f.now()).toISOString(), queueVerified: true, ...overrides });
}

test('help and invalid origins/arguments never initialize credentials or perform network requests', async () => {
  let output = ''; const options = { getRuntimeImpl: async () => assert.fail('runtime must not initialize'), write: text => { output += text; } };
  await main(['--help'], options); assert.match(output, /configure HTTPS_ORIGIN \[--apply\]/); assert.match(output, /not reset/);
  for (const origin of ['http://example.test', 'https://user:secret@example.test', 'https://example.test/path', 'https://example.test/?token=secret', 'https://example.test/#fragment']) assert.throws(() => httpsOrigin(origin), error => error.code === 'invalid_origin');
  assert.equal(httpsOrigin(ORIGIN + '/'), ORIGIN);
  await assert.rejects(main(['configure', ORIGIN, '--force'], options), error => error.code === 'invalid_arguments');
  await assert.rejects(main(['redrive', '../unsafe'], options), error => error.code === 'invalid_identifier');
});

test('preflight verifies complete imports, all signed-route probes, and a genuinely processed queue event', async () => {
  const f = await fixture(); const result = await preflight(f);
  assert.equal(result.status, 'verified'); assert.equal(result.threads, 1); assert.equal(result.callbacks, 2); assert.equal(result.conversations, 3);
  assert.equal(result.unsignedRoutesRejected, 4); assert.equal(result.queueVerified, true);
  assert.equal(f.enqueued.length, 1); assert.equal((await f.ledger.getEvent(result.queueEventId)).value.state, 'completed');
  const saved = (await f.ledger.read('preflight:last')).value;
  assert.equal(saved.origin, ORIGIN); assert.equal(saved.assistantId, ASSISTANT); assert.equal(saved.dataSourceId, SOURCE); assert.equal(saved.namespace, config.namespace); assert.equal(saved.insightGroupId, config.insightGroupId);
  assert.equal(f.provider.writes.length, 0); assert.equal(f.notion.writes.length, 0);
  assert.equal(JSON.stringify(result).includes(config.telnyxApiKey), false);
});

test('preflight refuses incomplete Notion listings and wrong group binding before enqueue', async () => {
  const incomplete = await fixture(); incomplete.notion.listThreads = async () => ({ pages: [], complete: false });
  await assert.rejects(preflight(incomplete), error => error.code === 'incomplete_listing'); assert.equal(incomplete.enqueued.length, 0);
  const mismatched = await fixture(); mismatched.provider.assistant.insight_settings.insight_group_id = 'different-group';
  await assert.rejects(preflight(mismatched), error => error.code === 'insight_group_mismatch'); assert.equal(mismatched.enqueued.length, 0);
});

test('preflight catches unseeded history, mismatched counts, wrong originals, and unfinished durable calls', async () => {
  for (const mutate of [
    f => f.ledger.update(`thread:${THREAD}`, thread => ({ ...thread, legacyConversationIds: [ORIGINAL, CALLBACK] })),
    f => f.ledger.update(`thread:${THREAD}`, thread => ({ ...thread, baselineCallbackCount: 1 })),
    f => f.ledger.update(`thread:${THREAD}`, thread => ({ ...thread, originalConversationId: 'unrelated-original' })),
    f => f.ledger.updateConversation(CALLBACK, { state: 'pending' }),
    async f => { f.notion.pages.values().next().value.properties['Callback Count'].number = 99; },
  ]) {
    const f = await fixture(); await mutate(f);
    await assert.rejects(preflight(f)); assert.equal(f.enqueued.length, 0); assert.equal(await f.ledger.read('preflight:last'), null);
  }
});

test('health and authentication failures never create a successful proof or health event', async () => {
  for (const change of [provider => { provider.healthy = false; }, provider => { provider.unsignedStatus = 403; }, provider => { provider.unsignedStatus = 200; }]) {
    const f = await fixture(); change(f.provider);
    await assert.rejects(preflight(f)); assert.equal(f.enqueued.length, 0); assert.equal(await f.ledger.read('preflight:last'), null);
  }
});

test('queue polling is bounded and a queued-but-unprocessed event is never called verified', async () => {
  const f = await fixture({ queueCompletes: false }); const started = f.now();
  await assert.rejects(preflight({ ...f, pollMs: 3000 }), error => error.code === 'queue_timeout');
  assert.ok(f.now() - started <= 3000); assert.equal(f.enqueued.length, 1); assert.equal(await f.ledger.read('preflight:last'), null);
  await assert.rejects(preflight({ ...f, pollMs: 40_001 }), error => error.code === 'invalid_poll_window');
});

test('pending is bounded and exposes only event IDs, known states, and sanitized error codes', async () => {
  const f = await fixture({ queueCompletes: false });
  await f.relay.acceptEvent({ eventId: 'pending-one', eventType: 'fixture', conversationId: 'private-conversation', note: 'Private transcript.' });
  await f.ledger.updateEvent('pending-one', { state: 'needs_review', lastError: 'uncertain_write', private: 'Hidden provider credential' });
  await f.relay.acceptEvent({ eventId: 'pending-two', eventType: 'fixture' });
  await f.ledger.updateEvent('pending-two', { lastError: 'private error with sensitive contents' });
  const result = await pending({ relay: f.relay, limit: 1 });
  assert.equal(result.total, 2); assert.equal(result.shown, 1); assert.equal(result.complete, false);
  assert.deepEqual(result.events, [{ eventId: 'pending-one', state: 'needs_review', error: 'uncertain_write' }]);
  assert.equal((await pending(f)).events[1].error, 'unknown_error');
  assert.equal(JSON.stringify(result).includes('Private'), false);
  await f.ledger.update('pending-events', () => ({})); await assert.rejects(pending(f), error => error.code === 'invalid_pending_index');
});

test('redrive requires an existing event, changes queue deduplication ID, and never resets state or receipts', async () => {
  const f = await fixture({ queueCompletes: false });
  await assert.rejects(redrive({ ...f, eventId: 'absent' }), error => error.code === 'missing_event');
  await f.relay.acceptEvent({ eventId: 'event-to-redrive', eventType: 'fixture', conversationId: CALLBACK });
  await f.ledger.updateEvent('event-to-redrive', { state: 'needs_review', lastError: 'uncertain_write' });
  await f.ledger.create('fixture-private-receipt', { state: 'uncertain', requestDigest: 'fixture' });
  const before = await f.ledger.getEvent('event-to-redrive'); const writesBefore = f.storage.calls.filter(call => call.op === 'put').length;
  const first = await redrive({ ...f, eventId: 'event-to-redrive' }), second = await redrive({ ...f, eventId: 'event-to-redrive' });
  assert.notEqual(first.redriveId, second.redriveId); assert.deepEqual(f.enqueued.at(-1).options, { redriveId: second.redriveId });
  assert.deepEqual(await f.ledger.getEvent('event-to-redrive'), before);
  assert.equal(f.storage.calls.filter(call => call.op === 'put').length, writesBefore);
  assert.equal((await f.ledger.read('fixture-private-receipt')).value.state, 'uncertain');
});

test('configure requires a fresh proof matching every scoped identity, including origin and group', async () => {
  for (const overrides of [null, { at: '2020-01-01T00:00:00Z' }, { origin: 'https://different.example.test' }, { assistantId: 'assistant-other' }, { dataSourceId: 'other-source' }, { namespace: 'other-environment' }, { insightGroupId: 'other-group' }, { queueVerified: false }]) {
    const f = await fixture(); if (overrides !== null) await proof(f, overrides);
    await assert.rejects(configure(f), error => error.code === 'preflight_required'); assert.equal(f.provider.writes.length, 0);
  }
});

test('configure preview displays settings/counts without changing the ledger or exposing prompts/tokens', async () => {
  const f = await fixture(); await proof(f); const writes = f.storage.calls.filter(call => call.op === 'put').length;
  const result = await configure(f);
  assert.equal(result.status, 'preview'); assert.equal(result.applied, false); assert.equal(result.sharedToolsPreserved, 1); assert.equal(result.recordingEnabled, false);
  assert.equal(f.provider.writes.length, 0); assert.equal(f.storage.calls.filter(call => call.op === 'put').length, writes);
  assert.equal(await f.ledger.read('configuration:last'), null);
  const output = JSON.stringify(result); assert.equal(output.includes('Reviewed production'), false); assert.equal(output.includes('synthetic-old-session-value'), false); assert.equal(output.includes(config.telnyxApiKey), false);
});

test('configure applies POST then readback then group PUT, preserving model/voice/shared tools/routing', async () => {
  const f = await fixture(); await proof(f); const before = clone(f.provider.assistant);
  const result = await configure({ ...f, apply: true });
  assert.equal(result.verified, true); assert.equal(result.providerWrites, 2);
  assert.deepEqual(f.provider.writes.map(write => write.kind), ['assistant', 'group']);
  const actions = f.provider.requests.map(entry => `${entry.kind}:${entry.resource}`);
  assert.ok(actions.indexOf('read:assistant', actions.indexOf('write:assistant')) < actions.indexOf('write:group'));
  assert.equal(f.provider.assistant.model, before.model); assert.deepEqual(f.provider.assistant.voice_settings, before.voice_settings);
  assert.deepEqual(f.provider.assistant.tool_ids, before.tool_ids); assert.equal(f.provider.assistant.telephony_settings.default_texml_app_id, before.telephony_settings.default_texml_app_id);
  assert.equal(f.provider.assistant.dynamic_variables.locale, 'en'); assert.equal(f.provider.assistant.dynamic_variables.mission_packet, ''); assert.equal(f.provider.assistant.dynamic_variables.nia_session_token, '');
  assert.equal(f.provider.assistant.dynamic_variables_webhook_url, ORIGIN + '/api/assistant-initialization'); assert.equal(f.provider.group.webhook, ORIGIN + '/api/telnyx-events');
  assert.equal((await f.ledger.read('configuration:last')).value.state, 'completed');
  const again = await configure({ ...f, apply: true }); assert.equal(again.status, 'already_configured'); assert.equal(f.provider.writes.length, 2);
});

test('a timeout after assistant commit is reconciled by GET without a repeated POST', async () => {
  const f = await fixture(); await proof(f); f.provider.faults.push({ resource: 'assistant', mode: 'after_timeout' });
  const result = await configure({ ...f, apply: true });
  assert.equal(result.verified, true); assert.equal(f.provider.writes.filter(write => write.kind === 'assistant').length, 1); assert.equal(f.provider.writes.length, 2);
});

test('an unconfirmed assistant write is held across invocations and never reaches group configuration', async () => {
  const f = await fixture(); await proof(f); f.provider.faults.push({ resource: 'assistant', mode: 'before_timeout' });
  await assert.rejects(configure({ ...f, apply: true }), error => error.code === 'configuration_needs_review' && error.phase === 'assistant');
  assert.equal((await f.ledger.read('configuration:last')).value.state, 'needs_review');
  await assert.rejects(configure({ ...f, apply: true }), error => error.code === 'configuration_needs_review');
  assert.equal(f.provider.writes.length, 1); assert.equal(f.provider.writes[0].kind, 'assistant');
  await assert.rejects(configure({ ...f, apply: true, instructionsImpl: async () => 'A different configuration.' }), error => error.code === 'configuration_needs_review');
  assert.equal(f.provider.writes.length, 1);
});

test('partial group configuration records failure and can later reconcile a committed write without replay', async () => {
  const f = await fixture(); await proof(f); f.provider.faults.push({ resource: 'group', mode: 'readback_failure' });
  await assert.rejects(configure({ ...f, apply: true }), error => error.code === 'configuration_needs_review' && error.phase === 'group');
  assert.equal((await f.ledger.read('configuration:last')).value.state, 'needs_review'); assert.equal(f.provider.writes.length, 2);
  const result = await configure({ ...f, apply: true });
  assert.equal(result.verified, true); assert.equal(result.providerWrites, 0); assert.equal(f.provider.writes.length, 2);
});

test('voice or routing drift fails assistant readback and prevents the group update', async () => {
  for (const mode of ['voice_drift', 'routing_drift']) {
    const f = await fixture(); await proof(f); f.provider.faults.push({ resource: 'assistant', mode });
    await assert.rejects(configure({ ...f, apply: true }), error => error.code === 'configuration_needs_review');
    assert.equal(f.provider.writes.length, 1); assert.equal(f.provider.group.webhook, '');
  }
});

test('raw write helper rejects other resources/paths and never exposes failed provider bodies or credentials', async () => {
  let requests = 0;
  const fetchImpl = async () => { requests++; return json({ error: `Private body ${config.telnyxApiKey}` }, 500); };
  await assert.rejects(telnyxWrite({ config, resource: 'phone', id: 'fixture', payload: {}, fetchImpl }), error => error.code === 'invalid_write');
  await assert.rejects(telnyxWrite({ config, resource: 'assistant', id: '../unsafe', payload: {}, fetchImpl }), error => error.code === 'invalid_identifier');
  await assert.rejects(telnyxWrite({ config, resource: 'assistant', id: ASSISTANT, payload: {}, fetchImpl }), error => error.code === 'provider_http_error' && !String(error).includes(config.telnyxApiKey));
  assert.equal(requests, 1);
});

test('CLI uses injected runtime and emits a self-contained sanitized configuration preview', async () => {
  const f = await fixture(); await proof(f); let output = '';
  const result = await main(['configure', ORIGIN], { ...f, getRuntimeImpl: async () => f.relay, write: text => { output += text; } });
  assert.equal(result.status, 'preview'); assert.deepEqual(JSON.parse(output), result); assert.equal(f.provider.writes.length, 0);
});
