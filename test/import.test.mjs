import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalPhone, importThreads, main } from '../scripts/import-threads.mjs';
import { Relay } from '../lib/relay.mjs';
import { pageToThread } from '../lib/notion.mjs';
import { FakeNotion, canonicalPage, ledgerFixture, config as relayConfig, PAGE, ORIGINAL, CALLBACK, CALLBACK_TWO } from './helpers.mjs';

const SECOND_PAGE = '30000000-0000-4000-8000-000000000002';
const THIRD_PAGE = '30000000-0000-4000-8000-000000000003';
const SECOND_ORIGINAL = '20000000-0000-4000-8000-000000000010';
const THREAD = 'example-store-thread';
const emptyConfig = () => ({ version: 1, threads: [] });
const override = (values = {}) => ({ version: 1, threads: [{ threadId: THREAD, ...values }] });
const memory = () => ({ request: 'Ask about product availability.', knownFacts: ['The first inquiry is awaiting a response.'], missingItems: ['Current availability.'] });
const storedPage = (values = {}) => canonicalPage({ callbackCount: 4, phone: '+1 (312) 555-0123', summary: 'Private source summary; do not infer approved memory.', ...values });
const personalPage = (values = {}) => storedPage({ pageId: SECOND_PAGE, threadId: 'example-personal-thread', originalConversationId: SECOND_ORIGINAL, type: 'Personal', ...values });

function fixture(pages = [storedPage()]) {
  const notion = new FakeNotion(pages); const queries = []; const registrations = [];
  const list = notion.listThreads.bind(notion);
  notion.listThreads = async options => { queries.push(options); return list(options); };
  return { notion, queries, registrations, registerThread: async thread => { registrations.push(structuredClone(thread)); } };
}

async function rejectsBeforeRegistration({ config = emptyConfig(), pages = [storedPage()], code, result } = {}) {
  const f = fixture(pages);
  if (result !== undefined) f.notion.listThreads = async () => result;
  await assert.rejects(importThreads({ ...f, config, apply: true }), error => !code || error.code === code);
  assert.equal(f.registrations.length, 0, 'all invalid input must be rejected before the first registration');
  assert.equal(f.notion.writes.length, 0, 'import never mutates Notion');
  return f;
}

test('preview lists every status, skips rows without thread IDs, and registers nothing', async () => {
  const f = fixture([storedPage(), personalPage(), storedPage({ pageId: THIRD_PAGE, threadId: '', originalConversationId: '', type: 'Personal' })]);
  const result = await importThreads({ ...f, config: emptyConfig() });
  assert.deepEqual(f.queries, [{ limit: 500, status: null, signal: undefined }]);
  assert.equal(result.mode, 'preview'); assert.equal(result.registered, 0);
  assert.equal(result.discovered, 3); assert.equal(result.eligible, 2);
  assert.deepEqual(result.skipped, [{ pageId: THIRD_PAGE, reason: 'missing_thread_id' }]);
  assert.equal(f.registrations.length, 0); assert.equal(f.notion.writes.length, 0);
});

test('apply preserves canonical provenance and counters while applying only explicit overrides', async () => {
  const f = fixture([storedPage(), personalPage()]);
  const config = override({ aliases: ['Example Shop'], location: 'Example City', qa: true, lookupAllowed: true,
    callerPhones: ['+1 312 555 0123'], approvedMemory: memory(), verifiedConversationIds: [CALLBACK, CALLBACK_TWO] });
  const result = await importThreads({ ...f, config, apply: true });
  assert.equal(result.registered, 2); assert.equal(result.assertedLegacySeeds, 2); assert.equal(result.lookupEnabled, 1);
  const [business, personal] = f.registrations;
  assert.equal(business.phone, '+13125550123'); assert.deepEqual(business.callerPhones, ['+13125550123']);
  assert.equal(business.pageId, PAGE); assert.equal(business.originalConversationId, ORIGINAL);
  assert.equal(business.callbackCount, 4); assert.equal(business.baselineCallbackCount, 4);
  assert.equal(business.lastContact, '2026-10-10T10:02:00.000Z'); assert.equal(business.status, 'Follow-up');
  assert.equal(business.kind, 'business'); assert.equal(business.qa, true); assert.deepEqual(business.aliases, ['Example Shop']);
  assert.deepEqual(business.verifiedConversationIds, [CALLBACK, CALLBACK_TWO]); assert.deepEqual(business.approvedMemory, memory());
  assert.equal(personal.kind, 'personal'); assert.equal(personal.lookupAllowed, false); assert.equal(personal.qa, false);
  assert.equal(personal.approvedMemory, undefined); assert.deepEqual(personal.verifiedConversationIds, []);
  assert.equal(f.notion.writes.length, 0);
  const report = JSON.stringify(result);
  for (const privateValue of [business.phone, business.business, business.summary, business.approvedMemory.request]) assert.equal(report.includes(privateValue), false);
});

test('only explicit business categories qualify; missing international prefix is never guessed', async () => {
  const f = fixture([storedPage({ type: 'Order Status', phone: '(312) 555-0123' })]);
  await importThreads({ ...f, config: emptyConfig(), apply: true });
  assert.equal(f.registrations[0].kind, 'personal'); assert.equal(f.registrations[0].phone, '');
  assert.deepEqual(f.registrations[0].callerPhones, []); assert.equal(f.registrations[0].lookupAllowed, false);
  assert.equal(canonicalPhone('+1 (312) 555-0123'), '+13125550123');
  for (const invalid of ['3125550123', '0013125550123', '+1e10', '+13125550123 extension 1', 13125550123, null]) assert.equal(canonicalPhone(invalid), '');
});

test('incomplete or malformed listings stop the entire import before writes', async () => {
  for (const result of [null, {}, { pages: [], complete: false }, { pages: {}, complete: true }, { pages: Array(501).fill(storedPage()), complete: true }]) {
    await rejectsBeforeRegistration({ result, code: 'incomplete_listing' });
  }
});

test('unknown or duplicate thread mappings fail during preflight', async () => {
  await rejectsBeforeRegistration({ config: override({ threadId: 'missing-thread' }), code: 'unknown_thread' });
  await rejectsBeforeRegistration({ pages: [storedPage(), storedPage({ pageId: SECOND_PAGE })], code: 'duplicate_thread' });
  const f = await rejectsBeforeRegistration({ config: { threads: [{ threadId: THREAD }, { threadId: THREAD }] }, code: 'duplicate_override' });
  assert.equal(f.queries.length, 0);
});

test('unsupported overrides cannot replace source identity, counts, timestamps, or status', async () => {
  for (const field of ['pageId', 'originalConversationId', 'callbackCount', 'baselineCallbackCount', 'lastContact', 'status', 'type', 'direction', 'startedAt', 'business', 'mission', 'kind']) {
    const f = await rejectsBeforeRegistration({ config: override({ [field]: 'replacement' }), code: 'invalid_config' });
    assert.equal(f.queries.length, 0);
  }
});

test('configuration bounds match Relay before querying or registering', async () => {
  const invalid = [
    { threadId: 't'.repeat(161) },
    { aliases: Array.from({ length: 13 }, (_, i) => `Alias ${i}`) },
    { aliases: ['a'.repeat(121)] },
    { callerPhones: Array.from({ length: 11 }, (_, i) => `+13125550${100 + i}`) },
    { callerPhones: ['3125550123'] },
    { verifiedConversationIds: ['c'.repeat(161)] },
    { verifiedConversationIds: Array.from({ length: 501 }, (_, i) => `legacy-${i}`) },
    { location: 'l'.repeat(161) }, { qa: 'true' }, { lookupAllowed: 1 },
    { approvedMemory: { ...memory(), request: 'r'.repeat(1201) } },
    { approvedMemory: { ...memory(), knownFacts: Array(9).fill('Fact') } },
    { approvedMemory: { ...memory(), missingItems: ['i'.repeat(1201)] } },
    { approvedMemory: { ...memory(), unreviewed: 'Unsupported' } },
  ];
  for (const values of invalid) {
    const f = await rejectsBeforeRegistration({ config: override(values), code: 'invalid_config' });
    assert.equal(f.queries.length, 0);
  }
});

test('invalid stored fields in a later row cannot cause partial registration', async t => {
  const invalid = [
    ['thread ID length', { threadId: 't'.repeat(161) }],
    ['original ID missing', { originalConversationId: '' }],
    ['original ID length', { originalConversationId: 'c'.repeat(161) }],
    ['original ID characters', { originalConversationId: 'not a valid id' }],
    ['missing type', { type: null }], ['unsupported type', { type: 'Unclassified' }],
    ['missing direction', { direction: null }], ['unsupported direction', { direction: 'outbound' }],
    ['missing start', { startedAt: null }], ['malformed start', { startedAt: 'invalid' }],
    ['missing status', { status: null }], ['unsupported status', { status: 'Pending' }],
    ['malformed contact time', { lastContact: 'invalid' }],
    ['business label length', { business: 'b'.repeat(121) }],
    ['title length', { title: 't'.repeat(2001) }],
    ...['mission', 'summary', 'outcome', 'nextAction'].map(field => [`${field} length`, { [field]: 'x'.repeat(12001) }]),
    ['NUL in source text', { summary: 'Invalid\0summary' }],
    ['negative callback count', { callbackCount: -1 }], ['noninteger callback count', { callbackCount: 1.5 }],
  ];
  for (const [name, values] of invalid) await t.test(name, async () => {
    await rejectsBeforeRegistration({ pages: [storedPage(), personalPage(values)] });
  });
});

test('maximum valid source and override bounds are accepted without truncation', async () => {
  const threadId = 't'.repeat(160), originalConversationId = 'c'.repeat(160);
  const f = fixture([storedPage({ threadId, originalConversationId, title: 't'.repeat(2000), business: 'b'.repeat(120),
    ...Object.fromEntries(['mission', 'summary', 'outcome', 'nextAction'].map(field => [field, 'x'.repeat(12000)])) })]);
  const config = override({ threadId, aliases: Array.from({ length: 12 }, (_, i) => `Alias ${i}`),
    callerPhones: Array.from({ length: 10 }, (_, i) => `+13125550${100 + i}`),
    verifiedConversationIds: ['v'.repeat(160), ...Array.from({ length: 499 }, (_, i) => `legacy-${i}`)] });
  const result = await importThreads({ ...f, config, apply: true });
  assert.equal(result.registered, 1); assert.equal(result.assertedLegacySeeds, 500);
  const thread = f.registrations[0];
  assert.equal(thread.threadId.length, 160); assert.equal(thread.originalConversationId.length, 160);
  assert.equal(thread.aliases.length, 12); assert.equal(thread.callerPhones.length, 10);
  assert.equal(thread.business.length, 120); assert.equal(thread.summary.length, 12000);
  let validated = 0;
  const relay = new Relay({ notion: f.notion, ledger: { withLease: async () => { validated++; } } });
  await relay.registerThread(thread); // Reaching the lease means the actual Relay input validation accepted the import.
  assert.equal(validated, 1);
});

test('live lookup requires explicit reviewed memory and a scoped business caller', async () => {
  await rejectsBeforeRegistration({ config: override({ lookupAllowed: true }), code: 'unsafe_lookup' });
  await rejectsBeforeRegistration({ config: override({ lookupAllowed: true, approvedMemory: memory(), callerPhones: [] }), code: 'unsafe_lookup' });
  await rejectsBeforeRegistration({ pages: [storedPage({ type: 'Personal' })], config: override({ lookupAllowed: true, approvedMemory: memory() }), code: 'unsafe_lookup' });
  await rejectsBeforeRegistration({ pages: [storedPage({ phone: '3125550123' })], config: override({ lookupAllowed: true, approvedMemory: memory() }), code: 'unsafe_lookup' });
});

test('legacy seed conflicts include original IDs, even when the conflict occurs in a later row', async () => {
  await rejectsBeforeRegistration({ pages: [storedPage(), personalPage()], config: { threads: [
    { threadId: THREAD, verifiedConversationIds: [CALLBACK] },
    { threadId: 'example-personal-thread', verifiedConversationIds: [CALLBACK] },
  ] }, code: 'conflicting_seed' });
  await rejectsBeforeRegistration({ pages: [storedPage(), personalPage({ originalConversationId: ORIGINAL })], code: 'conflicting_seed' });
  await rejectsBeforeRegistration({ pages: [storedPage(), personalPage()], config: override({ verifiedConversationIds: [SECOND_ORIGINAL] }), code: 'conflicting_seed' });
  const f = fixture();
  await importThreads({ ...f, config: override({ verifiedConversationIds: [ORIGINAL, CALLBACK, CALLBACK] }), apply: true });
  assert.deepEqual(f.registrations[0].verifiedConversationIds, [ORIGINAL, CALLBACK]);
});

test('real Relay registration seeds original and explicitly asserted calls without recounting callbacks', async () => {
  const { ledger, now } = ledgerFixture(); const notion = new FakeNotion([storedPage()]);
  const relay = new Relay({ config: relayConfig, ledger, notion, now });
  const config = override({ approvedMemory: memory(), verifiedConversationIds: [CALLBACK, CALLBACK_TWO] });
  const options = { notion, registerThread: thread => relay.registerThread(thread), config, apply: true };
  await importThreads(options); await importThreads(options);
  const stored = (await ledger.read(`thread:${THREAD}`)).value;
  assert.equal(stored.pageId, PAGE); assert.equal(stored.originalConversationId, ORIGINAL);
  assert.equal(stored.baselineCallbackCount, 4); assert.deepEqual(stored.processedCalls, {});
  assert.equal(stored.lastContact, '2026-10-10T10:02:00.000Z'); assert.equal(stored.lookupAllowed, false);
  for (const cid of [ORIGINAL, CALLBACK, CALLBACK_TWO]) {
    const record = await ledger.getConversation(cid);
    assert.equal(record.value.state, 'completed'); assert.equal(record.value.legacy, true); assert.equal(record.value.threadId, THREAD);
  }
  assert.equal(await ledger.getConversation('unlisted-legacy-call'), null);
  assert.equal(notion.writes.length, 0);
});

test('ensurePage passes cancellation in the third argument and stores the adapter page-ID string', async () => {
  const { ledger, now } = ledgerFixture(); let creates = 0;
  const notion = {
    findThread: async () => null,
    createThread: async (request, call, options) => {
      creates++; assert.equal(request.threadId, THREAD); assert.equal(call, undefined);
      assert.ok(options.signal instanceof AbortSignal); assert.equal(options.signal.aborted, false);
      return PAGE;
    },
  };
  const relay = new Relay({ config: relayConfig, ledger, notion, now });
  await relay.registerThread({ ...pageToThread(storedPage({ phone: '+13125550123' })), pageId: null });
  await ledger.withLease(`thread:${THREAD}`, async lease => {
    const thread = (await ledger.read(`thread:${THREAD}`)).value;
    assert.equal(await relay.ensurePage(thread, lease), PAGE);
    const updated = (await ledger.read(`thread:${THREAD}`)).value;
    assert.equal(updated.pageId, PAGE); assert.equal(await relay.ensurePage(updated, lease), PAGE);
  });
  assert.equal(creates, 1);
  const receipt = await ledger.getReceipt(`thread-${THREAD}`, 'create-page-v1');
  assert.equal(receipt.value.result.pageId, PAGE); assert.equal(receipt.value.result.verified, true);
});

test('registration failure reports the completed count without exposing the underlying payload', async () => {
  const f = fixture([storedPage(), personalPage()]); let attempts = 0;
  await assert.rejects(importThreads({ ...f, config: emptyConfig(), apply: true,
    registerThread: async () => { if (++attempts === 2) throw Error('private credential and payload'); },
  }), error => error.code === 'registration_failed' && error.registered === 1 && !error.message.includes('private credential'));
  assert.equal(attempts, 2);
});

test('cancellation stops registration and is forwarded to the read operation', async () => {
  const f = fixture(); const controller = new AbortController(); controller.abort();
  await assert.rejects(importThreads({ ...f, config: emptyConfig(), apply: true, signal: controller.signal }), error => error.code === 'aborted' && error.registered === 0);
  assert.equal(f.registrations.length, 0); assert.equal(f.queries[0].signal, controller.signal);
});

test('CLI help does not initialize credentials and explains explicit legacy assertions', async () => {
  let output = '';
  await main(['--help'], { getRuntimeImpl: async () => assert.fail('help must not initialize runtime'), write: value => { output += value; } });
  assert.match(output, /does not remotely verify/); assert.match(output, /Original call IDs come from/);
});

test('CLI preview and apply use the runtime contract and emit only the bounded report', async () => {
  for (const apply of [false, true]) {
    const f = fixture(); let output = '';
    const result = await main(['/private/operator-config.json', ...(apply ? ['--apply'] : [])], {
      readConfigImpl: async filename => { assert.equal(filename, '/private/operator-config.json'); return emptyConfig(); },
      getRuntimeImpl: async () => ({ notion: f.notion, registerThread: f.registerThread }), write: value => { output += value; },
    });
    assert.equal(result.mode, apply ? 'applied' : 'preview'); assert.equal(f.registrations.length, apply ? 1 : 0);
    assert.deepEqual(JSON.parse(output), result); assert.equal(output.includes('Private source summary'), false);
  }
});

test('CLI rejects malformed or oversized configuration files before runtime initialization', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nia-import-test-'));
  const options = { getRuntimeImpl: async () => assert.fail('invalid config must not initialize runtime'), write: () => assert.fail('invalid config must not print a report') };
  try {
    const malformed = join(directory, 'malformed.json'), oversized = join(directory, 'oversized.json');
    await writeFile(malformed, '{malformed'); await writeFile(oversized, ' '.repeat(1024 * 1024 + 1));
    for (const filename of [malformed, oversized, directory]) await assert.rejects(main([filename], options), error => error.code === 'invalid_config_file');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
