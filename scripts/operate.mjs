import { randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import { instructions, mergeAssistantTools } from '../lib/assistant-config.mjs';
import { pageToThread } from '../lib/notion.mjs';
import { LedgerConflictError, requestDigest } from '../lib/ledger.mjs';
import { validateEventId, queueIdempotencyKey } from '../lib/queue.mjs';

// Verified 2026-10-11 against primary Telnyx documentation:
// https://developers.telnyx.com/api-reference/assistants/update-an-assistant
// https://developers.telnyx.com/api-reference/assistants/get-an-assistant
// https://developers.telnyx.com/api-reference/conversations/update-insight-template-group
// https://developers.telnyx.com/docs/inference/ai-insights/insight-groups
// Assistant updates use POST; group updates use PUT. Never send tool_ids or
// edit a TeXML/phone-number/routing resource. Config snapshots stay private.
const API = 'https://api.telnyx.com/v2';
const ID = /^[A-Za-z0-9_-]{1,200}$/;
const SIGNED_ROUTES = ['/api/assistant-initialization', '/api/lookup-open-thread', '/api/save-call-note', '/api/telnyx-events'];
const STATES = new Set(['received', 'queued', 'processing', 'completed', 'retry_pending', 'needs_review']);
const MAX_PENDING = 1000;
const MAX_CONVERSATIONS = 5000;
const MAX_RESPONSE_BYTES = 1024 * 1024;

export class OperationError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = 'OperationError'; this.code = code; Object.assign(this, details); }
}
const fail = (code, message, details) => { throw new OperationError(code, message, details); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function identifier(value) { if (typeof value !== 'string' || !ID.test(value)) fail('invalid_identifier', 'A bounded letters/digits/underscore/hyphen identifier is required.'); return value; }
function unwrap(value) {
  const result = object(value) && Object.hasOwn(value, 'data') ? value.data : value;
  if (!object(result)) fail('invalid_response', 'A provider returned a malformed object.');
  return result;
}
export function httpsOrigin(value) {
  let url; try { url = new URL(value); } catch { fail('invalid_origin', 'A complete HTTPS origin is required.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') fail('invalid_origin', 'Use an HTTPS origin without credentials, path, query, or fragment.');
  return url.origin;
}
function scope(relay, origin) {
  const c = relay?.config;
  if (!c || !c.insightGroupId) fail('configuration_missing', 'NIA_INSIGHT_GROUP_ID must identify the already-bound dedicated insight group.');
  identifier(c.assistantId); identifier(c.insightGroupId); identifier(c.dataSourceId);
  if (typeof c.namespace !== 'string' || !c.namespace || c.namespace.length > 200 || /[\x00-\x1f]/.test(c.namespace)) fail('configuration_missing', 'A bounded ledger namespace is required.');
  return { origin: httpsOrigin(origin), assistantId: c.assistantId, dataSourceId: c.dataSourceId, namespace: c.namespace, insightGroupId: c.insightGroupId };
}
async function upsert(ledger, key, value) {
  try { return await ledger.create(key, value); }
  catch (error) { if (!(error instanceof LedgerConflictError)) throw error; return ledger.update(key, () => value); }
}
async function boundedJson(response) {
  const reader = response.body?.getReader?.();
  if (!reader) fail('invalid_response', 'A provider returned no JSON body.');
  const chunks = []; let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) fail('response_too_large', 'A provider response exceeded the byte limit.');
      chunks.push(Buffer.from(part.value));
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { fail('invalid_response', 'A provider returned invalid JSON.'); }
  } finally { await reader.cancel().catch(() => {}); }
}
async function request(url, options, { fetchImpl = globalThis.fetch, statusOnly = false } = {}) {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetchImpl(url, { ...options, redirect: 'error', credentials: 'omit', cache: 'no-store', signal: controller.signal });
    if (statusOnly) { await response.body?.cancel?.().catch(() => {}); return response.status; }
    if (!response.ok) { await response.body?.cancel?.().catch(() => {}); fail('provider_http_error', 'A provider request failed.', { httpStatus: response.status }); }
    return await boundedJson(response);
  } catch (error) {
    if (error instanceof OperationError) throw error;
    fail(controller.signal.aborted ? 'request_timeout' : 'network_error', 'A provider request did not return a verified response.');
  } finally { clearTimeout(timer); }
}

/** Fixed host and two configuration resources only; no automatic write retries. */
export async function telnyxWrite({ config, resource, id, payload, fetchImpl = globalThis.fetch }) {
  identifier(id);
  if (!object(payload) || typeof config?.telnyxApiKey !== 'string' || !config.telnyxApiKey || /[\r\n]/.test(config.telnyxApiKey)) fail('invalid_write', 'A dedicated Telnyx credential and structured payload are required.');
  const route = resource === 'assistant' ? { method: 'POST', path: `/ai/assistants/${id}` }
    : resource === 'insightGroup' ? { method: 'PUT', path: `/ai/conversations/insight-groups/${id}` } : null;
  if (!route) fail('invalid_write', 'Unsupported configuration resource.');
  const body = JSON.stringify(payload);
  if (Buffer.byteLength(body) > 400_000) fail('invalid_write', 'Configuration exceeds the write limit.');
  return unwrap(await request(API + route.path, { method: route.method, headers: { Authorization: `Bearer ${config.telnyxApiKey}`, Accept: 'application/json', 'Content-Type': 'application/json' }, body }, { fetchImpl }));
}

async function providerDetails(relay, expected) {
  const [assistantResult, groupResult] = await Promise.all([
    relay.telnyx.request(`/ai/assistants/${expected.assistantId}`),
    relay.telnyx.request(`/ai/conversations/insight-groups/${expected.insightGroupId}`),
  ]);
  const assistant = unwrap(assistantResult), group = unwrap(groupResult);
  if (assistant.id !== expected.assistantId || group.id !== expected.insightGroupId) fail('provider_binding_mismatch', 'Provider objects do not match configured IDs.');
  if (assistant.insight_settings?.insight_group_id !== expected.insightGroupId) fail('insight_group_mismatch', 'The configured insight group must already be bound to this assistant.');
  if (!Array.isArray(assistant.tools) || assistant.tools.length > 100 || !Array.isArray(group.insights) || group.insights.length > 100) fail('invalid_response', 'Assistant tools or insight templates are malformed or exceed bounds.');
  return { assistant, group };
}

async function importedBindings(relay) {
  const listing = await relay.notion.listThreads({ limit: 500, status: null });
  if (!listing || !Array.isArray(listing.pages) || listing.pages.length > 500 || listing.complete !== true) fail('incomplete_listing', 'Preflight requires a complete Notion listing of at most 500 pages.');
  const seen = new Set(); const owners = new Map(); let threads = 0, skipped = 0, callbackCount = 0;
  for (const page of listing.pages) {
    const canonical = pageToThread(page);
    if (!canonical.threadId) { skipped++; continue; }
    identifier(canonical.threadId); identifier(canonical.originalConversationId);
    if (seen.has(canonical.threadId)) fail('duplicate_thread', 'Multiple Notion rows use the same thread ID.');
    seen.add(canonical.threadId);
    const record = await relay.ledger.read(`thread:${canonical.threadId}`); const thread = record?.value;
    if (!thread || thread.pageId !== canonical.pageId || thread.threadId !== canonical.threadId || thread.originalConversationId !== canonical.originalConversationId) fail('thread_binding_mismatch', 'Every identified Notion thread must be imported with its original binding.');
    if (!Array.isArray(thread.legacyConversationIds) || thread.legacyConversationIds.length > 501 || !object(thread.processedCalls) || !Number.isSafeInteger(thread.baselineCallbackCount) || thread.baselineCallbackCount < 0) fail('invalid_import', 'Imported legacy IDs and callback baseline need review.');
    const legacy = new Set(thread.legacyConversationIds.map(identifier)); const processed = Object.keys(thread.processedCalls).map(identifier);
    const legacyCallbacks = [...legacy].filter(cid => cid !== thread.originalConversationId).length;
    if ((!legacy.has(thread.originalConversationId) && !processed.includes(thread.originalConversationId)) || legacy.size !== thread.legacyConversationIds.length || legacyCallbacks !== thread.baselineCallbackCount) fail('legacy_seed_mismatch', 'Every historical callback must have exactly one explicit verified legacy seed.');
    if (processed.some(cid => cid !== thread.originalConversationId && legacy.has(cid))) fail('callback_count_mismatch', 'A legacy callback also appears in newly processed calls.');
    const expectedCount = thread.baselineCallbackCount + processed.filter(cid => cid !== thread.originalConversationId).length;
    if (canonical.callbackCount !== expectedCount) fail('callback_count_mismatch', 'Notion and the durable callback count disagree.');
    for (const cid of new Set([...legacy, ...processed])) {
      if (owners.has(cid) && owners.get(cid) !== canonical.threadId) fail('conversation_binding_mismatch', 'A call is assigned to multiple threads.');
      owners.set(cid, canonical.threadId);
      if (owners.size > MAX_CONVERSATIONS) fail('preflight_limit', 'Preflight exceeds the bounded conversation verification limit.');
      const saved = (await relay.ledger.getConversation(cid))?.value;
      if (!saved || saved.state !== 'completed' || saved.threadId !== canonical.threadId || saved.notionPageId !== canonical.pageId) fail('unverified_conversation', 'An imported or processed call lacks a completed durable binding.');
    }
    threads++; callbackCount += canonical.callbackCount;
  }
  return { pages: listing.pages.length, threads, skipped, conversations: owners.size, callbacks: callbackCount };
}

async function withDeadline(promise, ms) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new OperationError('queue_timeout', 'Queue delivery was not confirmed within the polling window.')), ms); })]); }
  finally { clearTimeout(timer); }
}

/** Read provider/Notion bindings, probe public auth, then prove queue delivery. */
export async function preflight({ relay, origin, fetchImpl = globalThis.fetch, now = Date.now, sleepImpl = pause, uuidImpl = randomUUID, pollMs = 40_000 }) {
  const expected = scope(relay, origin);
  if (!Number.isInteger(pollMs) || pollMs < 1 || pollMs > 40_000) fail('invalid_poll_window', 'Queue polling must remain within 40 seconds.');
  const details = await providerDetails(relay, expected);
  const bindings = await importedBindings(relay);
  const health = await request(expected.origin + '/api/health', { method: 'GET', headers: { Accept: 'application/json' } }, { fetchImpl });
  if (health?.ok !== true || health.service !== 'nia-relay' || health.version !== 2) fail('health_mismatch', 'The origin did not identify the configured relay health endpoint.');
  const rejected = await Promise.all(SIGNED_ROUTES.map(path => request(expected.origin + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }, { fetchImpl, statusOnly: true })));
  if (rejected.some(status => status !== 401)) fail('authentication_probe_failed', 'Every signed endpoint must reject an unsigned empty request with HTTP 401.');
  const eventId = validateEventId(`health-${uuidImpl()}`);
  await relay.acceptEvent({ eventId, eventType: 'nia.healthcheck', conversationId: null, callControlId: null, occurredAt: new Date(now()).toISOString() });
  const deadline = now() + pollMs; let complete = false;
  for (let attempt = 0; attempt <= 40 && now() < deadline; attempt++) {
    const event = await withDeadline(relay.ledger.getEvent(eventId), Math.max(1, deadline - now()));
    if (event?.value.eventType === 'nia.healthcheck' && event.value.state === 'completed') { complete = true; break; }
    await sleepImpl(Math.min(1000, Math.max(0, deadline - now())));
  }
  if (!complete) fail('queue_timeout', 'Queue delivery was not confirmed within 40 seconds.', { eventId });
  const proof = { ...expected, at: new Date(now()).toISOString(), queueVerified: true, queueEventId: eventId };
  await upsert(relay.ledger, 'preflight:last', proof);
  return { command: 'preflight', status: 'verified', ...expected, ...bindings, insightTemplates: details.group.insights.length, unsignedRoutesRejected: SIGNED_ROUTES.length, queueVerified: true, queueEventId: eventId, at: proof.at };
}

export async function pending({ relay, limit = 100 }) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) fail('invalid_limit', 'Pending output is limited to 1–500 events.');
  const index = await relay.ledger.read('pending-events');
  const ids = index ? index.value?.ids : [];
  if (!Array.isArray(ids) || ids.length > MAX_PENDING || new Set(ids).size !== ids.length) fail('invalid_pending_index', 'The bounded pending-event index needs review.');
  ids.forEach(validateEventId);
  const events = [];
  for (const eventId of ids.slice(0, limit)) {
    const value = (await relay.ledger.getEvent(eventId))?.value;
    events.push({ eventId, state: value ? (STATES.has(value.state) ? value.state : 'unknown') : 'missing', error: value?.lastError ? (/^[A-Za-z0-9_]{1,80}$/.test(value.lastError) ? value.lastError : 'unknown_error') : null });
  }
  return { command: 'pending', total: ids.length, shown: events.length, complete: ids.length <= limit, events };
}

export async function redrive({ relay, eventId, uuidImpl = randomUUID }) {
  validateEventId(eventId);
  const record = await relay.ledger.getEvent(eventId);
  if (!record) fail('missing_event', 'Redrive requires an existing durable event.');
  const redriveId = uuidImpl();
  queueIdempotencyKey(eventId, { redriveId });
  await relay.enqueue(eventId, { redriveId });
  return { command: 'redrive', status: 'enqueued', eventId, redriveId, previousState: STATES.has(record.value.state) ? record.value.state : 'unknown' };
}

async function freshPreflight(relay, expected, now) {
  const proof = (await relay.ledger.read('preflight:last'))?.value;
  const age = now() - Date.parse(proof?.at);
  if (!proof || proof.queueVerified !== true || !Number.isFinite(age) || age < 0 || age > 30 * 60_000 || Object.entries(expected).some(([key, value]) => proof[key] !== value)) fail('preflight_required', 'Run a matching preflight within 30 minutes before configuration.');
}
function subset(actual, wanted) {
  if (Array.isArray(wanted)) return Array.isArray(actual) && actual.length === wanted.length && wanted.every((value, i) => subset(actual[i], value));
  if (object(wanted)) return object(actual) && Object.entries(wanted).every(([key, value]) => Object.hasOwn(actual, key) && subset(actual[key], value));
  return isDeepStrictEqual(actual, wanted);
}
function stripTool(tool) { const { tool_id, shared, ...value } = tool; return value; }
function unorderedTools(actual, wanted, { exact = false } = {}) {
  if (!Array.isArray(actual) || actual.length !== wanted.length) return false;
  const available = actual.map(stripTool);
  for (const tool of wanted.map(stripTool)) {
    const index = available.findIndex(value => exact ? isDeepStrictEqual(value, tool) : subset(value, tool));
    if (index < 0) return false; available.splice(index, 1);
  }
  return true;
}
function assistantMatches(actual, payload, before) {
  if (!object(actual) || actual.id !== before.id || !Array.isArray(actual.tools)) return false;
  const { tools, ...fields } = payload;
  if (!subset(actual, fields) || !unorderedTools(actual.tools.filter(tool => !tool.shared), tools)) return false;
  if (!unorderedTools(actual.tools.filter(tool => tool.shared), before.tools.filter(tool => tool.shared), { exact: true })) return false;
  for (const key of ['model', 'voice_settings', 'tool_ids', 'greeting', 'messaging_settings', 'insight_settings']) if (!isDeepStrictEqual(actual[key], before[key])) return false;
  if (!isDeepStrictEqual(actual.telephony_settings?.default_texml_app_id, before.telephony_settings?.default_texml_app_id)) return false;
  return true;
}
function groupMatches(actual, payload, before) {
  return object(actual) && subset(actual, payload) && ['id', 'name', 'description', 'insights'].every(key => isDeepStrictEqual(actual[key], before[key]));
}
async function configurationPlan(details, expected, instructionsImpl) {
  const { assistant } = details;
  if (assistant.dynamic_variables != null && !object(assistant.dynamic_variables)) fail('invalid_response', 'Configured dynamic variables must be an object.');
  const payload = {
    instructions: await instructionsImpl({ liveLookup: true }),
    tools: mergeAssistantTools(assistant.tools, { baseUrl: expected.origin, assistantId: expected.assistantId }),
    dynamic_variables: { ...(assistant.dynamic_variables || {}), mission_packet: '', nia_session_token: '' },
    dynamic_variables_webhook_url: expected.origin + '/api/assistant-initialization',
    telephony_settings: { time_limit_secs: 360, disable_dtmf: false, recording_settings: { enabled: false } },
  };
  if (typeof payload.instructions !== 'string' || !payload.instructions.trim() || Buffer.byteLength(JSON.stringify(payload)) > 400_000) fail('invalid_configuration', 'Prepared assistant configuration is invalid or exceeds bounds.');
  return { payload, groupPayload: { webhook: expected.origin + '/api/telnyx-events' } };
}
function configurationSummary(expected, details, plan) {
  return { command: 'configure', ...expected, liveLookup: true, inlineTools: plan.payload.tools.length,
    sharedToolsPreserved: details.assistant.tools.filter(tool => tool.shared).length,
    dynamicVariables: Object.keys(plan.payload.dynamic_variables).length,
    initializationPath: '/api/assistant-initialization', terminalInsightsPath: '/api/telnyx-events',
    terminalInsightStatuses: ['completed', 'failed'], timeLimitSeconds: 360, dtmfEnabled: true, recordingEnabled: false };
}

/** Preview by default. Durable snapshots and dispatch markers precede writes. */
export async function configure({ relay, origin, apply = false, fetchImpl = globalThis.fetch, now = Date.now, uuidImpl = randomUUID, instructionsImpl = instructions }) {
  if (typeof apply !== 'boolean') fail('invalid_arguments', 'Apply must be an explicit boolean.');
  const expected = scope(relay, origin);
  await freshPreflight(relay, expected, now);
  const run = async lease => {
    const details = await providerDetails(relay, expected); const plan = await configurationPlan(details, expected, instructionsImpl);
    const summary = configurationSummary(expected, details, plan);
    if (!apply) return { ...summary, status: 'preview', applied: false };
    const digest = requestDigest({ expected, ...plan }); const key = `configuration:change:${digest}`;
    const latest = (await relay.ledger.read('configuration:last'))?.value;
    if (latest && latest.state !== 'completed' && latest.changeKey !== key) fail('configuration_needs_review', 'A prior configuration change must be reconciled before starting a different change.', { configurationId: latest.configurationId });
    let record = await relay.ledger.read(key);
    if (!record) {
      const configurationId = identifier(uuidImpl()), snapshotKey = `configuration:before:${configurationId}`;
      await relay.ledger.create(snapshotKey, { at: new Date(now()).toISOString(), ...expected, ...details, ...plan });
      record = await relay.ledger.create(key, { ...expected, configurationId, snapshotKey, state: 'prepared', assistantState: 'pending', groupState: 'pending', at: new Date(now()).toISOString() });
    }
    const snapshot = (await relay.ledger.read(record.value.snapshotKey))?.value;
    if (!snapshot || requestDigest({ expected, payload: snapshot.payload, groupPayload: snapshot.groupPayload }) !== digest) fail('configuration_needs_review', 'The private configuration snapshot could not be verified.');
    let state = record.value;
    const mark = async patch => {
      state = (await relay.ledger.update(key, value => ({ ...value, ...patch, updatedAt: new Date(now()).toISOString() }))).value;
      await upsert(relay.ledger, 'configuration:last', { ...expected, configurationId: state.configurationId, changeKey: key, snapshotKey: state.snapshotKey, state: state.state, at: state.updatedAt });
    };
    await mark({ state: state.state });
    let writes = 0;
    const stage = async (name, resource, id, payload, before, current, matches, path) => {
      if (!matches(current, payload, before)) {
        if (state[`${name}State`] !== 'pending') {
          await mark({ state: 'needs_review', failedStage: name });
          fail('configuration_needs_review', 'An earlier write is not confirmed by readback; it was not repeated.', { configurationId: state.configurationId, phase: name });
        }
        await lease.assertOwned({ minRemainingMs: 15_000 });
        await mark({ state: `${name}_dispatching`, [`${name}State`]: 'dispatching' });
        try { writes++; await telnyxWrite({ config: relay.config, resource, id, payload, fetchImpl }); } catch { /* A timeout can commit. Read back before deciding. */ }
        try { current = unwrap(await relay.telnyx.request(path)); } catch { current = null; }
        if (!matches(current, payload, before)) {
          await mark({ state: 'needs_review', failedStage: name });
          fail('configuration_needs_review', 'A configuration write lacks verified readback; inspect the private snapshot before retrying.', { configurationId: state.configurationId, phase: name });
        }
      }
      await mark({ state: `${name}_verified`, [`${name}State`]: 'verified', failedStage: null });
    };
    await stage('assistant', 'assistant', expected.assistantId, snapshot.payload, snapshot.assistant, details.assistant, assistantMatches, `/ai/assistants/${expected.assistantId}`);
    // A group update is allowed only after the assistant passed full readback.
    await stage('group', 'insightGroup', expected.insightGroupId, snapshot.groupPayload, snapshot.group, details.group, groupMatches, `/ai/conversations/insight-groups/${expected.insightGroupId}`);
    await mark({ state: 'completed', completedAt: new Date(now()).toISOString() });
    return { ...summary, status: writes ? 'configured' : 'already_configured', applied: true, verified: true, configurationId: state.configurationId, providerWrites: writes };
  };
  return apply ? relay.ledger.withLease(`configuration:${expected.assistantId}`, run, { ttlMs: 120_000 }) : run();
}

const HELP = `Usage:
  node scripts/operate.mjs --help
  node scripts/operate.mjs preflight HTTPS_ORIGIN
  node scripts/operate.mjs pending
  node scripts/operate.mjs redrive EVENT_ID
  node scripts/operate.mjs configure HTTPS_ORIGIN [--apply]

Preflight verifies provider access, complete Notion/import bindings, historical
callback seeds/counts, unsigned HTTP rejection, and a real queued health event.
It records a private proof valid for 30 minutes and polls the queue for at most
40 seconds. Import reviewed threads and all verified legacy callbacks first.

Configure defaults to preview. --apply requires that fresh matching proof and
NIA_INSIGHT_GROUP_ID already bound to this assistant. Declare a group dedicated
to Nia. Only inline tools, instructions, dynamic variables/initialization URL,
the three displayed telephony settings, and that group's webhook are updated.
Model, voice, shared tools, and TeXML routing are preserved and read back.

Before configuration writes, private ledger snapshots and dispatch markers are
saved. A partial or uncertain write is held for readback/manual reconciliation;
it is never blindly repeated. Do not erase those records to force a retry.
Pending prints at most 100 events. Redrive re-enqueues an existing event with a
fresh queue deduplication ID; durable call receipts and states are not reset.
These commands do not place calls, send messages, or purchase/change numbers.
`;

export async function main(argv = process.argv.slice(2), { getRuntimeImpl, write = value => process.stdout.write(value), ...options } = {}) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) { write(HELP); return { command: 'help' }; }
  const [command, argument, flag] = argv;
  const valid = command === 'pending' ? argv.length === 1
    : command === 'redrive' || command === 'preflight' ? argv.length === 2
    : command === 'configure' ? (argv.length === 2 || (argv.length === 3 && flag === '--apply')) : false;
  if (!valid) fail('invalid_arguments', 'Use --help for the supported operational commands.');
  if (command === 'preflight' || command === 'configure') httpsOrigin(argument);
  if (command === 'redrive') identifier(argument);
  const factory = getRuntimeImpl ?? (await import('../lib/runtime.mjs')).getRuntime;
  const relay = await factory();
  const result = command === 'preflight' ? await preflight({ ...options, relay, origin: argument })
    : command === 'configure' ? await configure({ ...options, relay, origin: argument, apply: flag === '--apply' })
    : command === 'redrive' ? await redrive({ ...options, relay, eventId: argument }) : await pending({ relay });
  write(JSON.stringify(result, null, 2) + '\n'); return result;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(error => {
    const code = error instanceof OperationError ? error.code : 'operation_failed';
    const reference = error instanceof OperationError && ID.test(error.configurationId || '') ? ` Configuration ID: ${error.configurationId}.` : '';
    process.stderr.write(`Operation failed (${code}).${reference}\n`); process.exitCode = 1;
  });
}
