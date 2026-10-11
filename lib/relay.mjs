import { LedgerConflictError, UncertainMutationError, requestDigest } from './ledger.mjs';
import { SecurityError, normalizePhone } from './security.mjs';
import { conversationDirection } from './telnyx.mjs';
import { pageToThread } from './notion.mjs';
import { matchThreads, publicMemory, lookupInput, noteInput } from './matching.mjs';
import { withDeadline } from './deadline.mjs';

const ID = /^[A-Za-z0-9_-]{1,160}$/;
const TYPES = new Set(['Business Outreach','Store Inquiry','Personal','Order Status','Other']);
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const short = (value, max = 1200) => typeof value === 'string' && value.length <= max && !value.includes('\0') ? value : fail('invalid_thread', 'Invalid thread text');
const unique = values => [...new Set(values)];

export function insightSummary(envelope) {
  const groups = Array.isArray(envelope?.data) ? envelope.data : [];
  for (const group of groups.filter(g => g.status === 'completed')) for (const insight of group.conversation_insights || []) {
    if (typeof insight.result !== 'string' || !insight.result.trim()) continue;
    let result = insight.result;
    try {
      const parsed = JSON.parse(result);
      if (typeof parsed?.summary === 'string') result = parsed.summary;
      else if (typeof parsed === 'string') result = parsed;
      else continue;
    } catch { /* Plain-text summaries are a supported Telnyx result. */ }
    return { ready: true, summary: `Telnyx-generated summary (review required): ${result.slice(0, 6000)}` };
  }
  return { ready: groups.length > 0 && groups.every(g => g.status === 'failed' || g.status === 'completed'), summary: '' };
}

export class Relay {
  constructor({ config, ledger, telnyx, notion, enqueue, now = Date.now }) {
    Object.assign(this, { config, ledger, telnyx, notion, enqueue, now });
  }

  async putOnce(key, value) {
    try { return { created: true, record: await this.ledger.create(key, value) }; }
    catch (error) {
      if (!(error instanceof LedgerConflictError)) throw error;
      const record = await this.ledger.read(key);
      if (!record) throw error;
      return { created: false, record };
    }
  }

  async indexAdd(key, id, limit = 1000) {
    await this.putOnce(key, { ids: [] });
    await this.ledger.update(key, value => {
      if (value.ids.includes(id)) return undefined;
      if (value.ids.length >= limit) fail('index_full', 'The bounded service index needs review');
      return { ...value, ids: [...value.ids, id] };
    });
  }

  async indexRemove(key, id) {
    if (await this.ledger.read(key)) await this.ledger.update(key, v => ({ ...v, ids: v.ids.filter(x => x !== id) }));
  }

  /** Import reviewed Notion rows or register an approved mission. No Notion writes. */
  async registerThread(input) {
    if (!input || !ID.test(input.threadId || '') || !ID.test(input.originalConversationId || '')) fail('invalid_thread', 'Thread and original conversation IDs are required');
    if (!TYPES.has(input.type) || !['Outbound','Inbound'].includes(input.direction) || !iso(input.startedAt)) fail('invalid_thread', 'Thread type, direction, and start time are required');
    const callerPhones = unique(input.callerPhones || (input.phone ? [input.phone] : []));
    if (callerPhones.length > 10 || callerPhones.some(p => normalizePhone(p) !== p)) fail('invalid_thread', 'Thread caller numbers must be canonical E.164');
    const baselineCallbackCount = input.baselineCallbackCount ?? input.callbackCount ?? 0;
    if (!Number.isSafeInteger(baselineCallbackCount) || baselineCallbackCount < 0) fail('invalid_thread', 'Invalid baseline callback count');
    const known = unique(input.verifiedConversationIds || []);
    if (known.length > 500 || known.some(id => !ID.test(id))) fail('invalid_thread', 'Invalid verified conversation IDs');
    const kind = input.kind === 'business' ? 'business' : 'personal';
    const approved = input.approvedMemory || {};
    const memory = { request: short(approved.request || ''), knownFacts: (approved.knownFacts || []).map(v => short(v)), missingItems: (approved.missingItems || []).map(v => short(v)) };
    if (memory.knownFacts.length > 8 || memory.missingItems.length > 8) fail('invalid_thread', 'Approved memory exceeds the limit');
    const lookupAllowed = input.lookupAllowed === true;
    if (lookupAllowed && (kind !== 'business' || !memory.request || !callerPhones.length)) fail('invalid_thread', 'Business callback lookup requires an approved request and caller scope');
    const aliases = (input.aliases || []).map(v => short(v, 120));
    if (aliases.length > 12) fail('invalid_thread', 'Too many business aliases');
    const thread = {
      threadId: input.threadId, pageId: input.pageId || null, title: short(input.title || input.business || 'Nia call', 2000),
      business: short(input.business || '', 120), location: short(input.location || '', 160), phone: callerPhones[0] || '',
      callerPhones, aliases, kind, qa: input.qa === true, lookupAllowed, approvedMemory: memory,
      mission: short(input.mission || '', 12000), type: input.type, direction: input.direction,
      startedAt: iso(input.startedAt), originalConversationId: input.originalConversationId,
      baselineCallbackCount, legacyConversationIds: input.pageId ? unique([input.originalConversationId, ...known]) : [], processedCalls: {}, lastContact: iso(input.lastContact) || iso(input.startedAt),
      summary: short(input.summary || '', 12000), outcome: short(input.outcome || '', 12000), nextAction: short(input.nextAction || '', 12000),
      status: ['Follow-up','Completed','Failed'].includes(input.status) ? input.status : 'Follow-up', doNotContact: false
    };
    if (thread.pageId) {
      const page = pageToThread(await this.notion.getPage(thread.pageId));
      if (page.threadId !== thread.threadId || page.originalConversationId !== thread.originalConversationId) fail('thread_binding_mismatch', 'The Notion row does not match this thread');
    }
    return this.ledger.withLease(`thread:${thread.threadId}`, async () => {
      const { created, record } = await this.putOnce(`thread:${thread.threadId}`, thread);
      if (!created) {
        if (record.value.originalConversationId !== thread.originalConversationId || (thread.pageId && record.value.pageId !== thread.pageId)) fail('thread_binding_mismatch', 'An existing thread cannot be rebound');
        // Reimporting current Notion counts must not add already processed calls again.
        await this.ledger.update(`thread:${thread.threadId}`, v => ({ ...v, aliases, location: thread.location, callerPhones, lookupAllowed, approvedMemory: memory, qa: thread.qa, kind, status: thread.status, legacyConversationIds: unique([...(v.legacyConversationIds || []), ...thread.legacyConversationIds]) }));
      }
      for (const caller of callerPhones) await this.indexAdd(`caller:${caller}`, thread.threadId, 50);
      if (thread.pageId) for (const cid of unique([thread.originalConversationId, ...known])) {
        const saved = await this.ledger.recordConversation(cid, { threadId: thread.threadId });
        if (saved.record.value.threadId !== thread.threadId) fail('conversation_binding_mismatch', 'A conversation is already assigned to another thread');
        if (saved.record.value.state !== 'completed') await this.ledger.updateConversation(cid, { state: 'completed', legacy: true, threadId: thread.threadId, notionPageId: thread.pageId });
      }
      return { threadId: thread.threadId, created, seededConversations: thread.pageId ? unique([thread.originalConversationId, ...known]).length : 0 };
    });
  }

  async callerThreads(caller) {
    const index = await this.ledger.read(`caller:${caller}`);
    const ids = index?.value.ids || [];
    if (ids.length > 50) fail('index_full', 'Caller history needs review');
    const records = await Promise.all(ids.map(id => this.ledger.read(`thread:${id}`)));
    return records.filter(Boolean).map(record => record.value);
  }

  async lookup(session, body) {
    const input = lookupInput(body);
    if (await this.ledger.read(`optout:${session.caller}`)) return { status: 'no_match', instruction: 'A do-not-contact request is on record. Respect it; capture only a new request the caller voluntarily makes.' };
    const result = matchThreads(await this.callerThreads(session.caller), { caller: session.caller, ...input });
    if (result.status !== 'matched') return { status: result.status, instruction: 'Ask the caller to describe the business, location, and original request. Do not list other calls or claim to remember a match.' };
    if (result.thread.pageId) {
      const current = pageToThread(await this.notion.getPage(result.thread.pageId));
      if (current.threadId !== result.thread.threadId || current.status !== 'Follow-up' || current.mission !== result.thread.mission) return { status: 'no_match', instruction: 'The current record is closed or has changed. Ask for the present request; do not revive the old inquiry.' };
    }
    const binding = { threadId: result.thread.threadId, caller: session.caller, assistantId: session.assistantId, expiresAt: session.exp * 1000 };
    const { record } = await this.putOnce(`session:${session.callControlId}`, binding);
    if (record.value.threadId !== binding.threadId || record.value.caller !== binding.caller || record.value.assistantId !== binding.assistantId || record.value.expiresAt <= this.now()) return { status: 'ambiguous', instruction: 'This session is already linked to a different request or has expired. Ask for clarification and capture a separate note.' };
    return publicMemory(result.thread);
  }

  async saveNote(session, body) {
    const input = noteInput(body);
    const key = `note:${session.callControlId}:${input.operationId}`;
    const digest = requestDigest(input);
    const value = { ...input, digest, caller: session.caller, assistantId: session.assistantId, createdAt: new Date(this.now()).toISOString(), callControlId: session.callControlId };
    const { record } = await this.putOnce(key, value);
    if (record.value.digest !== digest || record.value.caller !== session.caller) throw new SecurityError('operation_conflict', 'The note ID was already used for different content.', 409);
    await this.indexAdd(`notes:${session.callControlId}`, input.operationId, 20);
    if (input.noteType === 'do_not_contact') await this.putOnce(`optout:${session.caller}`, { doNotContact: true, capturedAt: value.createdAt, callControlId: session.callControlId });
    return { saved: true, durable: true, notion_saved: false, receipt_id: requestDigest({ key, digest }).slice(0, 32), instruction: 'You may say the request was captured for review. It has not yet been confirmed in Notion. Do not say a message was sent, a contact corrected, a callback arranged, or a booking made.' };
  }

  async acceptEvent(event) {
    const { record } = await this.ledger.recordEvent(event.eventId, event);
    for (const key of ['eventType','conversationId','callControlId']) if ((record.value[key] || null) !== (event[key] || null)) fail('event_conflict', 'An event ID was reused for different data');
    if (record.value.state === 'completed') return { accepted: true, duplicate: true };
    await this.indexAdd('pending-events', event.eventId);
    await this.enqueue(event.eventId); // A recorded event still needs enqueue after an interrupted delivery.
    await this.ledger.updateEvent(event.eventId, { queuedAt: new Date(this.now()).toISOString() });
    return { accepted: true, duplicate: false };
  }

  async processQueuedEvent(eventId) {
    return withDeadline(50_000, () => this.processQueuedEventScoped(eventId));
  }

  async processQueuedEventScoped(eventId) {
    const stored = await this.ledger.getEvent(eventId);
    if (!stored) fail('missing_event', 'Queued event is missing from the durable ledger');
    if (stored.value.state === 'completed') { await this.indexRemove('pending-events', eventId); return; }
    if (stored.value.eventType === 'nia.healthcheck') {
      await this.ledger.updateEvent(eventId, { state: 'completed', processedAt: new Date(this.now()).toISOString() });
      await this.indexRemove('pending-events', eventId);
      return;
    }
    try {
      await this.ledger.updateEvent(eventId, v => ({ ...v, state: 'processing', attempts: (v.attempts || 0) + 1 }));
      const deadline = this.now() + 45_000;
      await this.ledger.withLease(`conversation:${stored.value.conversationId}`, async () => this.processConversation(stored.value, { deadline }));
      await this.ledger.updateEvent(eventId, { state: 'completed', completedAt: new Date(this.now()).toISOString() });
      await this.indexRemove('pending-events', eventId);
    } catch (error) {
      const code = /^[A-Za-z0-9_]{1,80}$/.test(error?.code || '') ? error.code : error instanceof UncertainMutationError ? 'uncertain_write' : 'processing_failed';
      await this.ledger.updateEvent(eventId, { state: error instanceof UncertainMutationError ? 'needs_review' : 'retry_pending', lastError: code }).catch(() => {});
      throw error;
    }
  }

  async selectThread(conversation, direction) {
    const caller = normalizePhone(conversation.metadata.telnyx_end_user_target);
    if (!caller) fail('caller_unverified', 'The conversation caller is unavailable');
    const existing = await this.ledger.getConversation(conversation.id);
    let threadId = existing?.value.threadId;
    if (!threadId) {
      const binding = conversation.metadata.call_control_id ? await this.ledger.read(`session:${conversation.metadata.call_control_id}`) : null;
      if (binding && binding.value.caller === caller && binding.value.assistantId === this.config.assistantId) threadId = binding.value.threadId;
    }
    if (!threadId && typeof conversation.metadata.nia_thread_id === 'string') {
      const registered = await this.ledger.read(`thread:${conversation.metadata.nia_thread_id}`);
      if (registered?.value.callerPhones.includes(caller)) threadId = registered.value.threadId;
    }
    if (threadId) {
      const found = await this.ledger.read(`thread:${threadId}`);
      if (!found || !found.value.callerPhones.includes(caller)) fail('thread_binding_mismatch', 'The call does not belong to the registered thread');
      return found.value;
    }
    // A shared number is insufficient to merge topics; unmatched calls get a review row.
    const startedAt = iso(conversation.created_at);
    if (!startedAt) fail('timestamp_unverified', 'Conversation start time is unavailable');
    const thread = { threadId: `call-${conversation.id}`, originalConversationId: conversation.id, title: `Nia ${direction.toLowerCase()} call — ${startedAt.slice(0, 10)}`, business: '', phone: caller, callerPhones: [caller], type: 'Other', kind: 'personal', direction, startedAt, lastContact: startedAt, status: 'Follow-up', mission: 'Unclassified call. Review the transcript and confirm the request.', lookupAllowed: false };
    await this.registerThread(thread);
    return (await this.ledger.read(`thread:${thread.threadId}`)).value;
  }

  async processConversation(event, { deadline = this.now() + 45_000 } = {}) {
    const cid = event.conversationId;
    const prior = await this.ledger.getConversation(cid);
    if (prior?.value.state === 'completed') return;
    let call = prior?.value.call;
    let thread;
    if (!call) {
      const conversation = await this.telnyx.getConversation(cid);
      if (event.callControlId && conversation.metadata.call_control_id !== event.callControlId) fail('call_binding_mismatch', 'The event and conversation call IDs differ');
      const rawDirection = conversationDirection(conversation, this.config.agentNumber);
      const direction = rawDirection === 'inbound' ? 'Inbound' : 'Outbound';
      const result = await this.telnyx.getMessages(cid);
      if (!result.complete) { const error = new Error('The complete transcript is not available yet'); error.code = 'transcript_incomplete'; error.retryAfterMs = result.retryAfterMs; throw error; }
      const transcript = result.messages.filter(m => ['user','assistant'].includes(m.role) && typeof m.text === 'string' && m.text.trim()).map(m => ({ speaker: m.role === 'assistant' ? 'Nia' : 'Other participant', text: m.text, ...((iso(m.sent_at) || iso(m.created_at)) ? { timestamp: iso(m.sent_at) || iso(m.created_at) } : {}) }));
      if (!transcript.length) fail('transcript_unavailable', 'A nonempty transcript is not available');
      let insights = { ready: false, summary: '' };
      try { insights = insightSummary(await this.telnyx.getInsights(cid)); } catch { /* Transcript-only review is valid if insight generation fails. */ }
      const freshEvent = await this.ledger.getEvent(event.eventId);
      if (!insights.ready && (freshEvent?.value.attempts || 0) < 3) fail('insights_pending', 'Waiting briefly for the after-call summary');
      thread = await this.selectThread(conversation, direction);
      const noteIndex = conversation.metadata.call_control_id ? await this.ledger.read(`notes:${conversation.metadata.call_control_id}`) : null;
      const notes = await Promise.all((noteIndex?.value.ids || []).map(id => this.ledger.read(`note:${conversation.metadata.call_control_id}:${id}`)));
      for (const note of notes.filter(Boolean)) transcript.push({ speaker: 'Service-captured request; not an executed action', text: `[${note.value.noteType}] ${note.value.note}`, timestamp: note.value.createdAt });
      const startedAt = iso(conversation.created_at);
      // Last spoken message is a known contact time, not a fabricated hangup timestamp.
      const endedAt = iso(conversation.last_message_at) || iso(event.occurredAt);
      if (!startedAt || !endedAt || endedAt < startedAt) fail('timestamp_unverified', 'Conversation timestamps are unavailable or inconsistent');
      const optedOut = Boolean(await this.ledger.read(`optout:${normalizePhone(conversation.metadata.telnyx_end_user_target)}`));
      call = { conversationId: cid, startedAt, endedAt, direction, transcript, participants: ['Nia (AI assistant)', 'Other participant (identity not verified)'], summary: insights.summary || 'Transcript captured. Summary and outcome need review.', outcome: optedOut ? 'Do-not-contact request captured.' : 'Outcome needs review; no completion assumed.', nextAction: optedOut ? 'Do not contact. Review the opt-out and any remaining request.' : 'Review the transcript and confirm the next action.', optedOut };
      await this.ledger.recordConversation(cid, { threadId: thread.threadId });
      await this.ledger.updateConversation(cid, { threadId: thread.threadId, call });
    } else {
      thread = (await this.ledger.read(`thread:${prior.value.threadId}`))?.value;
      if (!thread) fail('missing_thread', 'Saved conversation thread is missing');
    }
    await this.ledger.withLease(`thread:${thread.threadId}`, async lease => {
      thread = (await this.ledger.read(`thread:${thread.threadId}`)).value;
      await this.reconcileThreadMutation(thread, lease);
      thread = (await this.ledger.read(`thread:${thread.threadId}`)).value;
      this.requireBudget(deadline, thread.pageId ? 2000 : 17000);
      const pageId = await this.ensurePage(thread, lease);
      this.requireBudget(deadline, 25000);
      await this.appendCall(thread.threadId, pageId, call, lease);
      await this.updateThreadWithLease(thread.threadId, lease, value => {
        const isLatest = !value.lastContact || call.endedAt >= value.lastContact;
        return { ...value, pageId, processedCalls: { ...value.processedCalls, [cid]: { endedAt: call.endedAt } }, doNotContact: value.doNotContact || call.optedOut, ...(isLatest ? { lastContact: call.endedAt, summary: call.summary, outcome: call.outcome, nextAction: call.nextAction, status: 'Follow-up' } : {}) };
      });
      const current = (await this.ledger.read(`thread:${thread.threadId}`)).value;
      const count = current.baselineCallbackCount + Object.keys(current.processedCalls).filter(id => id !== current.originalConversationId).length;
      const patch = { 'Callback Count': count, 'date:Last Contact:start': current.lastContact, Summary: current.summary, Outcome: current.doNotContact ? 'Do-not-contact request captured.' : current.outcome, 'Next Action': current.doNotContact ? 'Do not contact. Review the opt-out and any remaining request.' : current.nextAction, Status: current.status, Transcript: 'Full transcripts and verified conversation markers are in the page body.', 'Who Talked': 'Nia (AI assistant) ↔ other participant; identity not verified' };
      this.requireBudget(deadline, 17000);
      await this.updateAggregate(thread.threadId, pageId, cid, patch, lease);
      await this.ledger.updateConversation(cid, { state: 'completed', notionPageId: pageId, completedAt: new Date(this.now()).toISOString() });
    });
  }

  requireBudget(deadline, minimumMs) {
    if (deadline - this.now() < minimumMs) fail('worker_budget', 'Continue the saved work in another queue delivery');
  }

  async updateThreadWithLease(threadId, lease, updater) {
    return this.ledger.update(`thread:${threadId}`, async value => {
      await lease.assertOwned();
      return updater(value);
    });
  }

  async clearPending(threadId, pending, lease, patch = {}) {
    return this.updateThreadWithLease(threadId, lease, value => {
      const current = value.pendingMutation;
      if (!current || current.conversationId !== pending.conversationId || current.operationId !== pending.operationId || current.leaseOwner !== pending.leaseOwner) throw new UncertainMutationError('The thread mutation journal changed owners');
      return { ...value, ...patch, pendingMutation: null };
    });
  }

  async reconcileThreadMutation(thread, lease) {
    const pending = thread.pendingMutation;
    if (!pending) return;
    const receipt = await this.ledger.getReceipt(pending.conversationId, pending.operationId);
    if (!receipt || receipt.value.state === 'prepared' || receipt.value.state === 'completed') {
      await this.clearPending(thread.threadId, pending, lease);
      return;
    }
    let result;
    if (pending.kind === 'create') {
      const found = await this.notion.findThread(thread.threadId);
      if (found) {
        const canonical = pageToThread(found);
        if (canonical.originalConversationId === thread.originalConversationId) result = { pageId: canonical.pageId, verified: true };
      }
    } else if (pending.kind === 'append') {
      if (await this.notion.hasConversation(pending.pageId, pending.conversationId)) result = { pageId: pending.pageId, conversationId: pending.conversationId, verified: true, status: 'saved' };
    } else if (pending.kind === 'aggregate') {
      const page = pageToThread(await this.notion.getPage(pending.pageId));
      if (this.aggregateMatches(page, pending.patch)) result = { pageId: pending.pageId, verified: true };
    }
    if (!result) throw new UncertainMutationError('This thread has an unresolved provider write; later callbacks are held until reconciliation');
    await lease.assertOwned();
    await this.ledger.completeReceipt(pending.conversationId, pending.operationId, result, { reconciled: true });
    await this.clearPending(thread.threadId, pending, lease, pending.kind === 'create' ? { pageId: result.pageId } : {});
  }

  async trackedMutation(threadId, pending, options) {
    pending = { ...pending, leaseOwner: options.lease.owner };
    await options.lease.assertOwned({ minRemainingMs: options.timeoutMs + 1000 });
    await this.updateThreadWithLease(threadId, options.lease, value => {
      if (value.pendingMutation) throw new UncertainMutationError('Resolve the prior thread mutation before starting another');
      return { ...value, pendingMutation: pending };
    });
    const result = await this.ledger.runMutation(options);
    await this.clearPending(threadId, pending, options.lease);
    return result;
  }

  aggregateMatches(page, patch) {
    return page.callbackCount === patch['Callback Count'] && page.lastContact === patch['date:Last Contact:start'] && page.summary === patch.Summary && page.outcome === patch.Outcome && page.nextAction === patch['Next Action'] && page.status === patch.Status;
  }

  async ensurePage(thread, lease) {
    if (thread.pageId) return thread.pageId;
    const key = `thread-${thread.threadId}`;
    const operationId = 'create-page-v1';
    const receipt = await this.ledger.getReceipt(key, operationId);
    const found = await this.notion.findThread(thread.threadId);
    if (found) {
      const canonical = pageToThread(found);
      if (canonical.originalConversationId !== thread.originalConversationId) fail('thread_binding_mismatch', 'Existing Notion row has a different original conversation');
      if (receipt && ['dispatching','uncertain'].includes(receipt.value.state)) await this.ledger.completeReceipt(key, operationId, { pageId: canonical.pageId, verified: true }, { reconciled: true });
      await this.updateThreadWithLease(thread.threadId, lease, v => ({ ...v, pageId: canonical.pageId }));
      return canonical.pageId;
    }
    const request = { threadId: thread.threadId, title: thread.title, business: thread.business, phone: thread.phone, mission: thread.mission, type: thread.type, direction: thread.direction, startedAt: thread.startedAt, originalConversationId: thread.originalConversationId, summary: thread.summary, outcome: thread.outcome, nextAction: thread.nextAction, status: thread.status };
    const result = await this.trackedMutation(thread.threadId, { kind: 'create', conversationId: key, operationId }, { conversationId: key, operationId, request, lease, timeoutMs: 12000, perform: async ({ signal }) => ({ pageId: await this.notion.createThread(request, undefined, { signal }), verified: true }) });
    await this.updateThreadWithLease(thread.threadId, lease, v => ({ ...v, pageId: result.result.pageId }));
    return result.result.pageId;
  }

  async appendCall(threadId, pageId, call, lease) {
    const operationId = 'append-transcript-v1';
    const receipt = await this.ledger.getReceipt(call.conversationId, operationId);
    if (receipt && ['dispatching','uncertain'].includes(receipt.value.state)) {
      if (!await this.notion.hasConversation(pageId, call.conversationId)) throw new UncertainMutationError('The prior transcript write has no complete provider receipt; inspect it before retrying');
      await this.ledger.completeReceipt(call.conversationId, operationId, { pageId, conversationId: call.conversationId, verified: true, status: 'saved' }, { reconciled: true });
    }
    return this.trackedMutation(threadId, { kind: 'append', pageId, conversationId: call.conversationId, operationId }, { conversationId: call.conversationId, operationId, request: { pageId, call }, lease, timeoutMs: 20000, perform: ({ signal }) => this.notion.appendConversation(pageId, call, { signal }) });
  }

  async updateAggregate(threadId, pageId, cid, patch, lease) {
    const operationId = `aggregate-${requestDigest(patch)}`;
    const receipt = await this.ledger.getReceipt(cid, operationId);
    if (receipt && ['dispatching','uncertain'].includes(receipt.value.state)) {
      const page = pageToThread(await this.notion.getPage(pageId));
      const exact = this.aggregateMatches(page, patch);
      if (!exact) throw new UncertainMutationError('The prior summary update needs readback reconciliation');
      await this.ledger.completeReceipt(cid, operationId, { pageId, verified: true }, { reconciled: true });
    }
    return this.trackedMutation(threadId, { kind: 'aggregate', pageId, conversationId: cid, operationId, patch }, { conversationId: cid, operationId, request: { pageId, patch }, lease, timeoutMs: 12000, perform: ({ signal }) => this.notion.updateThread(pageId, patch, { signal }) });
  }
}
