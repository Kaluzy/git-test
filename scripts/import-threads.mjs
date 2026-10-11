import { open } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { pageToThread } from '../lib/notion.mjs';
import { normalizePhone } from '../lib/security.mjs';

/**
 * Import existing Notion thread mappings into the private relay ledger.
 * No Notion page or schema is mutated. Preview is the default; --apply performs
 * idempotent registerThread calls after the entire import has been validated.
 *
 * Keep the real JSON file outside the repository. approvedMemory must be
 * operator-reviewed material appropriate to disclose to a matching caller.
 * Nothing is inferred from transcripts. verifiedConversationIds is an explicit
 * operator assertion that each listed legacy call was checked in the existing
 * log/provider and already saved. Listing an ID does NOT verify it remotely.
 * registerThread seeds the original call ID recorded by Notion plus those
 * explicitly asserted legacy IDs in its durable completed-call ledger.
 * Do not list a pending, hypothetical, unrelated, or unverified conversation.
 *
 * Public input format: {version:1, threads:[{threadId, aliases?, location?, qa?,
 * lookupAllowed?, callerPhones?, approvedMemory?, verifiedConversationIds?}]}.
 */
const MAX_CONFIG_BYTES = 1024 * 1024;
const OVERRIDE_FIELDS = new Set(['threadId', 'aliases', 'location', 'qa', 'lookupAllowed', 'callerPhones', 'approvedMemory', 'verifiedConversationIds']);
const BUSINESS_TYPES = new Set(['Business Outreach', 'Store Inquiry']);
const TYPES = new Set(['Business Outreach', 'Store Inquiry', 'Personal', 'Order Status', 'Other']);
const STATUSES = new Set(['Follow-up', 'Completed', 'Failed']);
const IDENTIFIER = /^[A-Za-z0-9_-]{1,160}$/;

export class ImportError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = 'ImportError'; this.code = code; Object.assign(this, details); }
}
function fail(code, message, details) { throw new ImportError(code, message, details); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function bounded(value, name, max, { optional = false } = {}) {
  if (optional && value == null) return '';
  if (typeof value !== 'string' || value.length > max || value.includes('\0') || (!optional && !value.trim())) fail('invalid_config', `Invalid ${name}.`);
  return value.trim();
}
function identifier(value, name, code = 'invalid_config') {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) fail(code, `Invalid ${name}.`);
  return value;
}
function strings(value, name, { maxItems = 20, maxLength = 120 } = {}) {
  if (!Array.isArray(value) || value.length > maxItems) fail('invalid_config', `Invalid ${name}.`);
  return [...new Set(value.map(entry => bounded(entry, name, maxLength)))];
}
/** Normalize formatting only when an explicit international prefix is present. */
export function canonicalPhone(value) {
  if (typeof value !== 'string') return '';
  const raw = value.trim();
  if (!/^\+[\d\s().-]+$/.test(raw)) return '';
  return normalizePhone(raw.replace(/[\s().-]/g, ''));
}
function approvedMemory(value) {
  if (!object(value) || Object.keys(value).some(key => !['request', 'knownFacts', 'missingItems'].includes(key))) fail('invalid_config', 'Invalid approved memory.');
  return {
    request: bounded(value.request, 'approved request', 1200),
    knownFacts: strings(value.knownFacts ?? [], 'approved facts', { maxItems: 8, maxLength: 1200 }),
    missingItems: strings(value.missingItems ?? [], 'missing items', { maxItems: 8, maxLength: 1200 }),
  };
}
function validateConfig(config) {
  if (!object(config) || (config.version !== undefined && config.version !== 1) || !Array.isArray(config.threads) || config.threads.length > 500 || Object.keys(config).some(key => !['version', 'threads'].includes(key))) fail('invalid_config', 'Expected a version 1 thread override document.');
  const overrides = new Map(); const seededIds = new Set();
  for (const supplied of config.threads) {
    if (!object(supplied) || Object.keys(supplied).some(key => !OVERRIDE_FIELDS.has(key))) fail('invalid_config', 'Unsupported thread override field.');
    const tid = identifier(supplied.threadId, 'thread ID');
    if (overrides.has(tid)) fail('duplicate_override', 'Each thread may have only one override.');
    const entry = { threadId: tid };
    for (const name of ['qa', 'lookupAllowed']) {
      if (Object.hasOwn(supplied, name)) {
        if (typeof supplied[name] !== 'boolean') fail('invalid_config', `Invalid ${name}.`);
        entry[name] = supplied[name];
      }
    }
    if (Object.hasOwn(supplied, 'aliases')) entry.aliases = strings(supplied.aliases, 'aliases', { maxItems: 12 });
    if (Object.hasOwn(supplied, 'location')) entry.location = bounded(supplied.location, 'location', 160, { optional: true });
    if (Object.hasOwn(supplied, 'callerPhones')) {
      entry.callerPhones = strings(supplied.callerPhones, 'caller phones', { maxItems: 10, maxLength: 100 }).map(phone => {
        const normalized = canonicalPhone(phone);
        if (!normalized) fail('invalid_config', 'Caller phones require an explicit valid international number.');
        return normalized;
      });
      entry.callerPhones = [...new Set(entry.callerPhones)];
    }
    if (Object.hasOwn(supplied, 'approvedMemory')) entry.approvedMemory = approvedMemory(supplied.approvedMemory);
    if (Object.hasOwn(supplied, 'verifiedConversationIds')) {
      entry.verifiedConversationIds = strings(supplied.verifiedConversationIds, 'verified conversation IDs', { maxItems: 500, maxLength: 160 }).map(cid => {
        identifier(cid, 'conversation ID');
        if (seededIds.has(cid)) fail('conflicting_seed', 'A verified legacy call cannot belong to multiple threads.');
        seededIds.add(cid); return cid;
      });
    }
    overrides.set(tid, entry);
  }
  return overrides;
}

/** Match Relay.registerThread's input bounds before any registration starts. */
function validateImportedThread(thread) {
  identifier(thread.threadId, 'stored thread ID', 'invalid_thread');
  identifier(thread.originalConversationId, 'stored original conversation ID', 'invalid_thread');
  if (!TYPES.has(thread.type) || !['Outbound', 'Inbound'].includes(thread.direction)) fail('invalid_thread', 'Stored thread type and direction are required.');
  if (typeof thread.startedAt !== 'string' || !Number.isFinite(Date.parse(thread.startedAt))) fail('invalid_thread', 'A valid stored thread start time is required.');
  if (thread.lastContact != null && (typeof thread.lastContact !== 'string' || !Number.isFinite(Date.parse(thread.lastContact)))) fail('invalid_thread', 'Invalid stored last-contact time.');
  if (!STATUSES.has(thread.status)) fail('invalid_thread', 'A valid stored thread status is required.');
  for (const [name, max] of Object.entries({ title: 2000, business: 120, mission: 12000, summary: 12000, outcome: 12000, nextAction: 12000 })) {
    const value = thread[name];
    if (typeof value !== 'string' || value.length > max || value.includes('\0')) fail('invalid_thread', `Invalid stored ${name}.`);
  }
  if (!Number.isSafeInteger(thread.baselineCallbackCount) || thread.baselineCallbackCount < 0) fail('invalid_thread', 'Invalid stored callback count.');
}

/** Read-only preview unless apply=true. Validate everything before registering. */
export async function importThreads({ notion, registerThread, config, apply = false, signal } = {}) {
  if (!notion || typeof notion.listThreads !== 'function' || (apply && typeof registerThread !== 'function') || typeof apply !== 'boolean') fail('invalid_dependencies', 'Notion reader and registration callback are required.');
  const overrides = validateConfig(config);
  const result = await notion.listThreads({ limit: 500, status: null, signal });
  if (!result || !Array.isArray(result.pages) || result.pages.length > 500 || result.complete !== true) fail('incomplete_listing', 'Notion listing is incomplete; no thread registration was attempted.');
  const threads = []; const foundIds = new Set(); const skipped = [];
  for (const page of result.pages) {
    const canonical = pageToThread(page);
    if (!canonical.threadId) { skipped.push({ pageId: canonical.pageId, reason: 'missing_thread_id' }); continue; }
    identifier(canonical.threadId, 'stored thread ID', 'invalid_thread');
    if (foundIds.has(canonical.threadId)) fail('duplicate_thread', 'Multiple Notion rows use the same thread ID.');
    foundIds.add(canonical.threadId);
    const override = overrides.get(canonical.threadId) ?? {};
    const phone = canonicalPhone(canonical.phone);
    const thread = {
      ...canonical, phone,
      kind: BUSINESS_TYPES.has(canonical.type) ? 'business' : 'personal',
      aliases: [], location: '', qa: false, lookupAllowed: false,
      callerPhones: phone ? [phone] : [],
      verifiedConversationIds: [],
      ...override,
      // These values always come from Notion, never from the override document.
      pageId: canonical.pageId, originalConversationId: canonical.originalConversationId,
      baselineCallbackCount: canonical.callbackCount, callbackCount: canonical.callbackCount,
      lastContact: canonical.lastContact, status: canonical.status,
    };
    validateImportedThread(thread);
    if (thread.lookupAllowed) {
      if (thread.kind !== 'business') fail('unsafe_lookup', 'Only explicitly business-classified threads can enable live lookup.');
      if (!Object.hasOwn(override, 'approvedMemory') || !thread.callerPhones.length) fail('unsafe_lookup', 'Live lookup requires reviewed memory and an explicit or existing valid caller number.');
      bounded(thread.business, 'stored business label', 120);
    }
    threads.push(thread);
  }
  for (const tid of overrides.keys()) if (!foundIds.has(tid)) fail('unknown_thread', 'An override refers to a thread not found in the complete Notion listing.');
  const conversationOwners = new Map();
  for (const thread of threads) {
    for (const cid of new Set([thread.originalConversationId, ...thread.verifiedConversationIds])) {
      const owner = conversationOwners.get(cid);
      if (owner && owner !== thread.threadId) fail('conflicting_seed', 'A stored original or verified legacy call cannot belong to multiple threads.');
      conversationOwners.set(cid, thread.threadId);
    }
  }

  let registered = 0;
  if (apply) {
    for (const thread of threads) {
      if (signal?.aborted) fail('aborted', 'Import was cancelled.', { registered });
      try { await registerThread(thread); registered++; }
      catch { fail('registration_failed', 'Thread registration stopped; completed registrations can be reconciled before retry.', { registered }); }
    }
  }
  // Report mapping IDs, but omit contact fields, memory, transcripts, and secrets.
  return {
    mode: apply ? 'applied' : 'preview', complete: true,
    discovered: result.pages.length, eligible: threads.length, registered,
    lookupEnabled: threads.filter(thread => thread.lookupAllowed).length,
    assertedLegacySeeds: threads.reduce((count, thread) => count + thread.verifiedConversationIds.length, 0),
    threads: threads.map(thread => ({ threadId: thread.threadId, pageId: thread.pageId, kind: thread.kind, qa: thread.qa, lookupAllowed: thread.lookupAllowed, legacySeedCount: thread.verifiedConversationIds.length })),
    skipped,
  };
}

const HELP = `Usage: node scripts/import-threads.mjs /absolute/path/to/private-threads.json [--apply]

Without --apply, read Notion and preview the private-ledger import.
With --apply, register validated mappings and explicitly asserted legacy IDs.
Neither mode changes Notion pages or its schema. Existing threads default to
lookupAllowed:false. Enabling lookup requires reviewed approvedMemory.

Keep the real JSON outside the repository. The committed example contains no
real contacts. Each verifiedConversationIds entry is your explicit assertion
that you checked that call against the existing log/provider. The importer
does not remotely verify these additional IDs. Original call IDs come from
Notion; other legacy calls are seeded only when explicitly listed.
`;

async function readConfigFile(filename) {
  const file = await open(filename, 'r');
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size > MAX_CONFIG_BYTES) fail('invalid_config_file', 'Configuration must be a bounded regular file.');
    const raw = await file.readFile();
    if (raw.byteLength > MAX_CONFIG_BYTES) fail('invalid_config_file', 'Configuration exceeds the byte limit.');
    try { return JSON.parse(raw.toString('utf8')); }
    catch { fail('invalid_config_file', 'Configuration is not valid JSON.'); }
  } finally { await file.close(); }
}

export async function main(argv = process.argv.slice(2), { getRuntimeImpl, readConfigImpl = readConfigFile, write = value => process.stdout.write(value) } = {}) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) { write(HELP); return { mode: 'help' }; }
  const positional = argv.filter(value => !value.startsWith('--'));
  if (positional.length !== 1 || argv.some(value => value.startsWith('--') && value !== '--apply') || argv.filter(value => value === '--apply').length > 1) fail('invalid_arguments', 'Provide one private configuration file and optional --apply.');
  const config = await readConfigImpl(positional[0]);
  validateConfig(config);
  const runtimeFactory = getRuntimeImpl ?? (await import('../lib/runtime.mjs')).getRuntime;
  const relay = await runtimeFactory();
  if (!relay || typeof relay.registerThread !== 'function') fail('invalid_dependencies', 'Relay runtime cannot register threads.');
  const result = await importThreads({ notion: relay.notion, registerThread: thread => relay.registerThread(thread), config, apply: argv.includes('--apply') });
  write(JSON.stringify(result, null, 2) + '\n'); return result;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(error => {
    const code = error instanceof ImportError ? error.code : 'import_failed';
    process.stderr.write(`Import failed (${code}).${Number.isInteger(error.registered) ? ` ${error.registered} registrations completed before the failure.` : ''}\n`);
    process.exitCode = 1;
  });
}
