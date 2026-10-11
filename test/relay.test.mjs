import test from 'node:test';
import assert from 'node:assert/strict';
import { Relay, insightSummary } from '../lib/relay.mjs';
import { TelnyxClient } from '../lib/telnyx.mjs';
import { NotionAmbiguousWriteError } from '../lib/notion.mjs';
import { parsePostCallEvent } from '../lib/security.mjs';
import { deadlineSignal, remainingMs } from '../lib/deadline.mjs';
import {
  clone, ASSISTANT, AGENT, CALLER, ORIGINAL, CALLBACK, CALLBACK_TWO, PAGE, config,
  FakeNotion, canonicalPage, ledgerFixture
} from './helpers.mjs';

const THREAD = 'example-store-thread';
const details = { business: 'Example Store', location: 'Springfield', topic: 'widget availability' };
const callId = cid => `v3:${cid}`;
const makeConversation = (cid, { startedAt = '2026-10-11T12:00:00Z', endedAt = '2026-10-11T12:02:00Z', caller = CALLER, inbound = true, metadata = {} } = {}) => ({
  id: cid, created_at: startedAt, last_message_at: endedAt, metadata: {
    assistant_id: ASSISTANT, telnyx_agent_target: AGENT, telnyx_end_user_target: caller,
    telnyx_conversation_channel: 'phone_call', call_control_id: callId(cid),
    from: inbound ? caller : AGENT, to: inbound ? AGENT : caller, ...metadata
  }
});

class FakeTelnyx {
  conversations = new Map(); transcripts = new Map(); insights = new Map(); reads = [];
  checker = new TelnyxClient({ apiKey: config.telnyxApiKey, assistantId: ASSISTANT, agentNumber: AGENT, fetchImpl: async () => { throw new Error('No network is allowed in integration fixtures'); } });
  add(cid, options = {}) {
    const conversation = makeConversation(cid, options);
    this.conversations.set(cid, conversation);
    this.transcripts.set(cid, { complete: true, pageCount: 1, messages: [
      { role: 'assistant', text: 'How can I help with the widget inquiry?', created_at: conversation.created_at },
      { role: 'user', text: 'The widget is available; please let Kal review the details.', created_at: conversation.last_message_at }
    ] });
    this.insights.set(cid, { data: [{ id: `insight-${cid}`, status: 'completed', created_at: conversation.last_message_at, conversation_insights: [{ insight_id: 'summary-one', result: options.summary || 'The caller answered the widget inquiry.' }] }], meta: { page_number: 1, page_size: 20, total_pages: 1, total_results: 1 } });
    return conversation;
  }
  async getConversation(cid) {
    this.reads.push({ op: 'getConversation', cid });
    return clone(this.checker.assertOwnership(this.conversations.get(cid), { id: cid }));
  }
  async getMessages(cid) { this.reads.push({ op: 'getMessages', cid }); return clone(this.transcripts.get(cid)); }
  async getInsights(cid) { this.reads.push({ op: 'getInsights', cid }); return clone(this.insights.get(cid)); }
}

async function fixture({ page = {}, registration = {}, seed = true, telnyx: suppliedTelnyx } = {}) {
  const persistence = ledgerFixture();
  const notion = new FakeNotion([canonicalPage(page)]);
  const telnyx = suppliedTelnyx || new FakeTelnyx();
  const queued = [];
  const relay = new Relay({ config, ledger: persistence.ledger, notion, telnyx, enqueue: async id => { queued.push(id); }, now: persistence.now });
  const registered = {
    ...notion.thread(), kind: 'business', lookupAllowed: true, aliases: ['Example Store'], location: 'Springfield',
    callerPhones: [CALLER], approvedMemory: { request: 'Ask about widget availability and current store price.', knownFacts: ['One widget was requested.'], missingItems: ['Current price'] }, ...registration
  };
  if (seed) await relay.registerThread(registered);
  const session = (cid = CALLBACK, caller = CALLER) => ({ assistantId: ASSISTANT, caller, agent: AGENT, callControlId: callId(cid), iat: Math.floor(persistence.now() / 1000), exp: Math.floor(persistence.now() / 1000) + 7200 });
  const bind = async (cid, input = details) => { const result = await relay.lookup(session(cid), input); assert.equal(result.status, 'matched'); return result; };
  const event = (cid = CALLBACK, suffix = 'ended', eventType = 'call.conversation.ended') => ({
    eventId: `event-${cid}-${suffix}`, eventType, conversationId: cid, callControlId: callId(cid), occurredAt: telnyx.conversations.get(cid)?.last_message_at || '2026-10-11T12:02:00Z'
  });
  const deliver = async value => { await relay.acceptEvent(value); await relay.processQueuedEvent(value.eventId); };
  return { ...persistence, relay, notion, telnyx, queued, registered, session, bind, event, deliver };
}

test('duplicate delivery and end-plus-insight events append one transcript and increment the callback count once', async () => {
  const f = await fixture(); f.telnyx.add(CALLBACK); await f.bind(CALLBACK);
  const ended = f.event(); await f.deliver(ended);
  const before = f.notion.writes.length;
  assert.deepEqual(await f.relay.acceptEvent(ended), { accepted: true, duplicate: true });
  await f.relay.processQueuedEvent(ended.eventId);
  await f.deliver(f.event(CALLBACK, 'insight', 'conversation_insight_result'));
  assert.equal(f.notion.writes.length, before);
  assert.equal(f.notion.writes.filter(write => write.op === 'appendConversation').length, 1);
  assert.equal(f.notion.thread().callbackCount, 1);
  assert.equal(f.notion.pages.size, 1);
  assert.equal((await f.ledger.getConversation(CALLBACK)).value.state, 'completed');
  assert.equal((await f.ledger.read('pending-events')).value.ids.length, 0);
});

test('event identity conflicts reject and a failed enqueue stays durable for redelivery without a false acknowledgment', async () => {
  const f = await fixture(); const event = f.event();
  let attempts = 0;
  f.relay.enqueue = async id => { attempts += 1; if (attempts === 1) throw new Error('Queue unavailable'); f.queued.push(id); };
  await assert.rejects(f.relay.acceptEvent(event), /Queue unavailable/);
  assert.equal((await f.ledger.getEvent(event.eventId)).value.state, 'received');
  assert.ok((await f.ledger.read('pending-events')).value.ids.includes(event.eventId));
  assert.equal((await f.relay.acceptEvent(event)).accepted, true);
  assert.equal(attempts, 2);
  await assert.rejects(f.relay.acceptEvent({ ...event, conversationId: CALLBACK_TWO }), { code: 'event_conflict' });
  assert.equal(f.notion.writes.length, 0);
});

test('seeding previously verified calls does not append, duplicate pages, or rebase legacy callback counts', async () => {
  const f = await fixture({ page: { callbackCount: 2 }, registration: { verifiedConversationIds: [CALLBACK, CALLBACK_TWO] } });
  for (const cid of [ORIGINAL, CALLBACK, CALLBACK_TWO]) {
    await f.deliver(f.event(cid));
    assert.equal((await f.ledger.getConversation(cid)).value.legacy, true);
  }
  assert.equal(f.telnyx.reads.length, 0); assert.equal(f.notion.writes.length, 0);
  assert.equal(f.notion.thread().callbackCount, 2); assert.equal(f.notion.pages.size, 1);
});

test('separate callbacks share the original page and reimporting current totals cannot count one twice', async () => {
  const f = await fixture();
  for (const cid of [CALLBACK, CALLBACK_TWO]) { f.telnyx.add(cid); await f.bind(cid); }
  await f.deliver(f.event(CALLBACK));
  await f.relay.registerThread({ ...f.registered, ...f.notion.thread() });
  await f.deliver(f.event(CALLBACK_TWO));
  const row = f.notion.thread();
  assert.equal(row.callbackCount, 2); assert.equal(f.notion.pages.size, 1);
  assert.equal(row.originalConversationId, ORIGINAL); assert.equal(row.direction, 'Outbound');
  assert.equal(row.startedAt, '2026-10-10T10:00:00.000Z');
  assert.equal((await f.ledger.read(`thread:${THREAD}`)).value.baselineCallbackCount, 0);
});

test('out-of-order callbacks preserve the latest summary and contact time while retaining both transcripts', async () => {
  const f = await fixture();
  f.telnyx.add(CALLBACK, { startedAt: '2026-10-11T13:00:00Z', endedAt: '2026-10-11T13:04:00Z', summary: 'Newest employee update.' });
  f.telnyx.add(CALLBACK_TWO, { startedAt: '2026-10-11T11:00:00Z', endedAt: '2026-10-11T11:02:00Z', summary: 'Older incomplete update.' });
  await f.bind(CALLBACK); await f.bind(CALLBACK_TWO);
  await f.deliver(f.event(CALLBACK)); await f.deliver(f.event(CALLBACK_TWO));
  const row = f.notion.thread();
  assert.equal(row.callbackCount, 2); assert.equal(row.lastContact, '2026-10-11T13:04:00.000Z');
  assert.match(row.summary, /Newest employee update/); assert.doesNotMatch(row.summary, /Older incomplete update/);
  assert.equal(f.notion.transcripts.size, 2);
  assert.equal(f.notion.transcripts.get(`${PAGE}:${CALLBACK_TWO}`).direction, 'Inbound');
});

test('transcript timestamps prefer actual send time over provider ingestion time', async () => {
  const f = await fixture(); f.telnyx.add(CALLBACK); await f.bind(CALLBACK);
  const transcript = f.telnyx.transcripts.get(CALLBACK);
  transcript.messages[0].sent_at = '2026-10-11T12:00:10Z';
  transcript.messages[0].created_at = '2026-10-11T12:02:10Z';
  transcript.messages[1].created_at = '2026-10-11T12:02:00Z';
  await f.deliver(f.event());
  const saved = f.notion.transcripts.get(`${PAGE}:${CALLBACK}`).transcript;
  assert.equal(saved[0].timestamp, '2026-10-11T12:00:10.000Z');
  assert.equal(saved[1].timestamp, '2026-10-11T12:02:00.000Z');
});

test('an incomplete or empty transcript can never produce a Notion write or completed receipt', async () => {
  for (const transcript of [
    { complete: false, messages: [{ role: 'user', text: 'Partial' }], pageCount: 1, retryAfterMs: 60_000 },
    { complete: true, messages: [], pageCount: 1 }
  ]) {
    const f = await fixture(); f.telnyx.add(CALLBACK); f.telnyx.transcripts.set(CALLBACK, transcript);
    const event = f.event(); await f.relay.acceptEvent(event);
    await assert.rejects(f.relay.processQueuedEvent(event.eventId), error => ['transcript_incomplete', 'transcript_unavailable'].includes(error.code));
    assert.equal(f.notion.writes.length, 0);
    assert.equal((await f.ledger.getEvent(event.eventId)).value.state, 'retry_pending');
    assert.notEqual((await f.ledger.getConversation(CALLBACK))?.value.state, 'completed');
  }
});

test('terminal failed insight delivery still captures the transcript with an explicit review summary', async () => {
  const f = await fixture(); f.telnyx.add(CALLBACK); await f.bind(CALLBACK);
  f.telnyx.insights.set(CALLBACK, { data: [{ status: 'failed', conversation_insights: [] }] });
  const event = parsePostCallEvent({ record_type: 'event', event_type: 'conversation_insight_result', payload: {
    request_id: 'failed-insight-event', conversation_id: CALLBACK, insight_group_id: config.insightGroupId, status: 'failed', metadata: {}
  } }, config);
  assert.equal(event.insightStatus, 'failed');
  await f.deliver(event);
  assert.equal(f.notion.thread().callbackCount, 1); assert.match(f.notion.thread().summary, /need review/);
  assert.equal(f.notion.writes.filter(write => write.op === 'appendConversation').length, 1);
  assert.equal((await f.ledger.getEvent(event.eventId)).value.attempts, 1);
});

test('pending insights wait for bounded deliveries, then save an explicitly incomplete analysis with the full transcript', async () => {
  const f = await fixture(); f.telnyx.add(CALLBACK); await f.bind(CALLBACK);
  f.telnyx.insights.set(CALLBACK, { data: [{ status: 'in_progress', conversation_insights: [] }] });
  const event = f.event(); await f.relay.acceptEvent(event);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(f.relay.processQueuedEvent(event.eventId), { code: 'insights_pending' });
    assert.equal(f.notion.writes.length, 0);
  }
  await f.relay.processQueuedEvent(event.eventId);
  assert.equal(f.notion.thread().callbackCount, 1); assert.match(f.notion.thread().summary, /need review/);
});

test('an ambiguous append without a complete provider receipt is quarantined and never blindly retried', async () => {
  const f = await fixture(); f.telnyx.add(CALLBACK); await f.bind(CALLBACK);
  let attempts = 0;
  f.notion.appendConversation = async () => { attempts += 1; throw new NotionAmbiguousWriteError('append'); };
  const event = f.event(); await f.relay.acceptEvent(event);
  await assert.rejects(f.relay.processQueuedEvent(event.eventId), { code: 'MUTATION_UNCERTAIN' });
  await assert.rejects(f.relay.processQueuedEvent(event.eventId), { code: 'MUTATION_UNCERTAIN' });
  assert.equal(attempts, 1); assert.equal(f.notion.thread().callbackCount, 0);
  assert.equal((await f.ledger.getReceipt(CALLBACK, 'append-transcript-v1')).value.state, 'uncertain');
  assert.equal((await f.ledger.getEvent(event.eventId)).value.state, 'needs_review');
});

test('a lost append acknowledgment can reconcile from verified provider content without a second append', async () => {
  const f = await fixture(); f.telnyx.add(CALLBACK); await f.bind(CALLBACK);
  const append = f.notion.appendConversation.bind(f.notion); let attempts = 0;
  f.notion.appendConversation = async (...args) => {
    attempts += 1; const result = await append(...args);
    if (attempts === 1) throw new NotionAmbiguousWriteError('append');
    return result;
  };
  const event = f.event(); await f.relay.acceptEvent(event);
  await assert.rejects(f.relay.processQueuedEvent(event.eventId), { code: 'MUTATION_UNCERTAIN' });
  await f.relay.processQueuedEvent(event.eventId);
  assert.equal(attempts, 1); assert.equal(f.notion.thread().callbackCount, 1);
  assert.equal((await f.ledger.getReceipt(CALLBACK, 'append-transcript-v1')).value.reconciled, true);
  assert.equal((await f.ledger.read(`thread:${THREAD}`)).value.pendingMutation, null);
});

test('an uncertain aggregate blocks a newer callback before any subsequent provider write', async () => {
  const f = await fixture();
  f.telnyx.add(CALLBACK); f.telnyx.add(CALLBACK_TWO, { startedAt: '2026-10-11T14:00:00Z', endedAt: '2026-10-11T14:02:00Z' });
  await f.bind(CALLBACK); await f.bind(CALLBACK_TWO);
  let attempts = 0;
  f.notion.updateThread = async () => { attempts += 1; throw new NotionAmbiguousWriteError('update'); };
  const first = f.event(CALLBACK), later = f.event(CALLBACK_TWO);
  await f.relay.acceptEvent(first); await assert.rejects(f.relay.processQueuedEvent(first.eventId), { code: 'MUTATION_UNCERTAIN' });
  const written = f.notion.writes.length;
  await f.relay.acceptEvent(later); await assert.rejects(f.relay.processQueuedEvent(later.eventId), { code: 'MUTATION_UNCERTAIN' });
  await assert.rejects(f.relay.processQueuedEvent(first.eventId), { code: 'MUTATION_UNCERTAIN' });
  assert.equal(attempts, 1); assert.equal(f.notion.writes.length, written);
  assert.equal(f.notion.transcripts.has(`${PAGE}:${CALLBACK_TWO}`), false);
  assert.equal((await f.ledger.read(`thread:${THREAD}`)).value.pendingMutation.kind, 'aggregate');
});

test('an uncertain new-page create cannot create a duplicate even when an exact query still returns nothing', async () => {
  const f = await fixture({ seed: false }); f.telnyx.add(CALLBACK);
  let attempts = 0;
  f.notion.createThread = async () => { attempts += 1; throw new NotionAmbiguousWriteError('create'); };
  const event = f.event(); await f.relay.acceptEvent(event);
  await assert.rejects(f.relay.processQueuedEvent(event.eventId), { code: 'MUTATION_UNCERTAIN' });
  await assert.rejects(f.relay.processQueuedEvent(event.eventId), { code: 'MUTATION_UNCERTAIN' });
  assert.equal(attempts, 1); assert.equal(f.notion.pages.size, 1); assert.equal(f.notion.transcripts.size, 0);
});

test('lookup requires caller, business, topic and location agreement and does not expose personal records', async () => {
  const f = await fixture({ registration: { approvedMemory: {
    request: 'Check widget availability; private@example.test is withheld.',
    knownFacts: ['Callback number +13125550999 must stay private.'], missingItems: ['Current price']
  } } });
  const personal = { ...f.registered, pageId: null, threadId: 'personal-private-thread', originalConversationId: '20000000-0000-4000-8000-000000000099', type: 'Personal', kind: 'personal', lookupAllowed: false, business: 'A private relative', approvedMemory: { request: 'Unrelated private family matter', knownFacts: [], missingItems: [] } };
  await f.relay.registerThread(personal);
  for (const [session, input] of [
    [f.session(CALLBACK, '+13125550456'), details],
    [f.session(), { ...details, business: 'Unrelated Company' }],
    [f.session(), { ...details, topic: 'Insurance billing' }],
    [f.session(), { ...details, location: 'Different City' }],
    [f.session(), { business: 'A private relative', topic: 'private family matter' }]
  ]) {
    const result = await f.relay.lookup(session, input);
    assert.notEqual(result.status, 'matched');
    assert.equal(Object.hasOwn(result, 'request'), false);
    assert.doesNotMatch(JSON.stringify(result), /private relative|family matter|private@example/);
  }
  const result = await f.bind(CALLBACK);
  assert.equal(result.identity_verified, false);
  assert.doesNotMatch(JSON.stringify(result), /private@example\.test|13125550999|personal-private-thread/);
  assert.match(JSON.stringify(result), /withheld/);
  assert.equal(f.notion.writes.length, 0);
});

test('two matching business inquiries require clarification and do not bind the session', async () => {
  const f = await fixture();
  await f.relay.registerThread({ ...f.registered, pageId: null, threadId: 'second-widget-thread', originalConversationId: CALLBACK_TWO });
  const result = await f.relay.lookup(f.session(), details);
  assert.equal(result.status, 'ambiguous'); assert.equal(Object.hasOwn(result, 'request'), false);
  assert.equal(await f.ledger.read(`session:${callId(CALLBACK)}`), null);
});

test('fresh Notion closure and reviewed reimport prevent a stale inquiry from being offered again', async () => {
  const f = await fixture();
  f.notion.pages.get(PAGE).properties.Status.select.name = 'Completed';
  assert.notEqual((await f.relay.lookup(f.session(), details)).status, 'matched');
  await f.relay.registerThread({ ...f.registered, ...f.notion.thread() });
  assert.equal((await f.ledger.read(`thread:${THREAD}`)).value.status, 'Completed');
  assert.notEqual((await f.relay.lookup(f.session(), details)).status, 'matched');
  assert.equal(f.notion.writes.length, 0);
});

test('an unmatched topic gets a separate review row instead of merging calls solely by caller number', async () => {
  const f = await fixture(); f.telnyx.add(CALLBACK);
  assert.notEqual((await f.relay.lookup(f.session(), { ...details, topic: 'Piano maintenance' })).status, 'matched');
  await f.deliver(f.event());
  assert.equal(f.notion.pages.size, 2); assert.equal(f.notion.thread().callbackCount, 0);
  const review = [...f.notion.pages.keys()].find(id => id !== PAGE);
  assert.equal(f.notion.thread(review).originalConversationId, CALLBACK);
  assert.equal(f.notion.thread(review).direction, 'Inbound');
  assert.equal(f.notion.thread(review).callbackCount, 0);
});

test('notes have stable durable receipts, reject ID reuse for different text, and capture opt-outs immediately', async () => {
  const f = await fixture();
  const note = { ...details, note: 'Please review this request; no callback is scheduled.', note_type: 'request', operation_id: 'request-1' };
  const first = await f.relay.saveNote(f.session(), note);
  const again = await f.relay.saveNote(f.session(), note);
  assert.equal(first.saved, true); assert.equal(first.durable, true); assert.equal(first.notion_saved, false);
  assert.equal(again.receipt_id, first.receipt_id);
  assert.equal((await f.ledger.read(`notes:${callId(CALLBACK)}`)).value.ids.length, 1);
  await assert.rejects(f.relay.saveNote(f.session(), { ...note, note: 'A different request' }), { code: 'operation_conflict', status: 409 });
  await f.relay.saveNote(f.session(), { ...note, operation_id: 'optout-1', note_type: 'do_not_contact', note: 'Please stop contacting this number.' });
  assert.equal((await f.ledger.read(`optout:${CALLER}`)).value.doNotContact, true);
  assert.notEqual((await f.relay.lookup(f.session(), details)).status, 'matched');
  assert.equal(f.notion.writes.length, 0);
});

test('note persistence failure cannot return a save receipt; retry completes the same recorded note', async () => {
  const f = await fixture();
  const note = { ...details, note: 'Review requested.', note_type: 'request', operation_id: 'request-1' };
  const path = f.ledger.pathFor(`notes:${callId(CALLBACK)}`);
  const put = f.storage.put.bind(f.storage); let fail = true;
  f.storage.put = async (pathname, ...args) => {
    if (fail && pathname === path) throw new Error('Durable note index unavailable');
    return put(pathname, ...args);
  };
  await assert.rejects(f.relay.saveNote(f.session(), note), /Durable note index unavailable/);
  assert.ok(await f.ledger.read(`note:${callId(CALLBACK)}:request-1`));
  fail = false;
  assert.equal((await f.relay.saveNote(f.session(), note)).saved, true);
  assert.deepEqual((await f.ledger.read(`notes:${callId(CALLBACK)}`)).value.ids, ['request-1']);
});

test('captured corrections remain proposed requests in the transcript and never mutate contact fields', async () => {
  const f = await fixture(); f.telnyx.add(CALLBACK); await f.bind(CALLBACK);
  await f.relay.saveNote(f.session(), { ...details, note: 'Proposed corrected email: updated@example.test.', note_type: 'proposed_contact_correction', operation_id: 'correction-1' });
  await f.deliver(f.event());
  const saved = f.notion.transcripts.get(`${PAGE}:${CALLBACK}`);
  assert.match(saved.transcript.at(-1).text, /proposed_contact_correction/);
  assert.match(saved.transcript.at(-1).speaker, /not an executed action/);
  assert.equal(f.notion.thread().phone, CALLER);
  assert.ok(f.notion.writes.filter(write => write.op === 'updateThread').every(write => !Object.hasOwn(write.values, 'Phone')));
});

test('worker budget checkpoints preserve the frozen call and resume without a second append', async () => {
  const f = await fixture(); f.telnyx.add(CALLBACK); await f.bind(CALLBACK);
  const append = f.notion.appendConversation.bind(f.notion);
  f.notion.appendConversation = async (...args) => { const result = await append(...args); f.advance(29_000); return result; };
  const event = f.event(); await f.relay.acceptEvent(event);
  await assert.rejects(f.relay.processQueuedEvent(event.eventId), { code: 'worker_budget' });
  const reads = f.telnyx.reads.length;
  assert.equal(f.notion.transcripts.size, 1); assert.equal(f.notion.thread().callbackCount, 0);
  await f.relay.processQueuedEvent(event.eventId);
  assert.equal(f.telnyx.reads.length, reads); assert.equal(f.notion.transcripts.size, 1);
  assert.equal(f.notion.thread().callbackCount, 1);
  assert.equal(f.notion.writes.filter(write => write.op === 'appendConversation').length, 1);
});

test('a stale lease cannot clear or overwrite a successor pending mutation or dispatch another provider write', async () => {
  const f = await fixture();
  const stale = await f.ledger.acquireLease(`thread:${THREAD}`);
  const original = { kind: 'append', conversationId: CALLBACK, operationId: 'append-original', pageId: PAGE, leaseOwner: stale.owner };
  await f.relay.updateThreadWithLease(THREAD, stale, value => ({ ...value, pendingMutation: original }));
  f.advance(120_001);
  const successor = await f.ledger.acquireLease(`thread:${THREAD}`);
  try {
    await f.relay.reconcileThreadMutation((await f.ledger.read(`thread:${THREAD}`)).value, successor);
    const pending = { kind: 'aggregate', conversationId: CALLBACK_TWO, operationId: 'aggregate-newer', pageId: PAGE, leaseOwner: successor.owner };
    await f.relay.updateThreadWithLease(THREAD, successor, value => ({ ...value, pendingMutation: pending }));
    await assert.rejects(f.relay.clearPending(THREAD, original, stale), { code: 'LEASE_LOST' });
    await assert.rejects(f.relay.updateThreadWithLease(THREAD, stale, value => ({ ...value, pendingMutation: original })), { code: 'LEASE_LOST' });
    // Even the current lease cannot clear a journal using an obsolete snapshot.
    await assert.rejects(f.relay.clearPending(THREAD, original, successor), { code: 'MUTATION_UNCERTAIN' });
    let dispatched = 0;
    await assert.rejects(f.relay.trackedMutation(THREAD, original, {
      conversationId: CALLBACK, operationId: 'append-original', request: {}, lease: stale, timeoutMs: 1000,
      perform: async () => { dispatched += 1; return { verified: true }; }
    }), { code: 'LEASE_LOST' });
    assert.equal(dispatched, 0);
    assert.deepEqual((await f.ledger.read(`thread:${THREAD}`)).value.pendingMutation, pending);
    assert.equal(await f.ledger.getReceipt(CALLBACK, 'append-original'), null);
  } finally { await successor.release(); }
});

test('lease takeover during a delayed CAS rechecks ownership before retrying a pending-journal clear', async () => {
  const f = await fixture();
  const stale = await f.ledger.acquireLease(`thread:${THREAD}`);
  const original = { kind: 'append', conversationId: CALLBACK, operationId: 'append-original', pageId: PAGE, leaseOwner: stale.owner };
  await f.relay.updateThreadWithLease(THREAD, stale, value => ({ ...value, pendingMutation: original }));
  const threadPath = f.ledger.pathFor(`thread:${THREAD}`);
  const put = f.storage.put.bind(f.storage);
  let release, reached, delayNextClear = true;
  const entered = new Promise(resolve => { reached = resolve; });
  f.storage.put = async (path, body, options) => {
    if (delayNextClear && path === threadPath && JSON.parse(body).value.pendingMutation === null) {
      delayNextClear = false; reached(); await new Promise(resolve => { release = resolve; });
    }
    return put(path, body, options);
  };
  const delayedResult = f.relay.clearPending(THREAD, original, stale).then(() => null, error => error);
  await entered;
  let successor;
  try {
    f.advance(120_001);
    successor = await f.ledger.acquireLease(`thread:${THREAD}`);
    await f.relay.reconcileThreadMutation((await f.ledger.read(`thread:${THREAD}`)).value, successor);
    const pending = { kind: 'aggregate', conversationId: CALLBACK_TWO, operationId: 'aggregate-newer', pageId: PAGE, leaseOwner: successor.owner };
    await f.relay.updateThreadWithLease(THREAD, successor, value => ({ ...value, pendingMutation: pending }));
    release();
    assert.equal((await delayedResult)?.code, 'LEASE_LOST');
    assert.deepEqual((await f.ledger.read(`thread:${THREAD}`)).value.pendingMutation, pending);
  } finally { release?.(); if (successor) await successor.release(); }
});

test('processing has a fresh request-scoped 50-second deadline and does not leak cancellation into another delivery', async () => {
  const f = await fixture();
  for (const cid of [CALLBACK, CALLBACK_TWO]) { f.telnyx.add(cid); await f.bind(cid); }
  const getConversation = f.telnyx.getConversation.bind(f.telnyx);
  const observations = [];
  f.telnyx.getConversation = async cid => {
    const signal = deadlineSignal(); const budget = remainingMs();
    assert.ok(signal instanceof AbortSignal); assert.equal(signal.aborted, false);
    assert.ok(budget > 0 && budget <= 50_000);
    observations.push({ signal, budget });
    return getConversation(cid);
  };
  assert.equal(deadlineSignal(), undefined);
  await f.deliver(f.event(CALLBACK));
  assert.equal(observations[0].signal.aborted, true);
  assert.equal(deadlineSignal(), undefined);
  await f.deliver(f.event(CALLBACK_TWO));
  assert.equal(observations.length, 2);
  assert.notEqual(observations[0].signal, observations[1].signal);
  assert.equal(observations[1].signal.aborted, true);
  assert.equal(deadlineSignal(), undefined); assert.equal(remainingMs(), Infinity);
  assert.equal(f.notion.thread().callbackCount, 2);
  assert.equal(f.notion.writes.filter(write => write.op === 'appendConversation').length, 2);
});

test('insight summaries support real nested text/JSON results and never report a pending group as ready', () => {
  assert.equal(insightSummary({ data: [{ status: 'in_progress', conversation_insights: [] }] }).ready, false);
  assert.equal(insightSummary({ data: [{ status: 'failed', conversation_insights: [] }] }).ready, true);
  for (const result of ['Plain summary.', '{"summary":"Structured summary."}']) {
    const value = insightSummary({ data: [{ status: 'completed', conversation_insights: [{ insight_id: 'summary', result }] }] });
    assert.equal(value.ready, true); assert.match(value.summary, /review required/);
  }
});
