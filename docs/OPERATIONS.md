# Nia relay operations

This is a deployable implementation, not a deployment receipt. The October 11,
2026 source release was validated locally with injected storage/provider fakes.
No production relay, Blob store, queue, or dedicated provider credentials were
available in that session. Live voice acceptance remains a separate gate.

## What the service does

The signed initialization route returns a Telnyx history query restricted to
Nia's assistant ID, her configured phone number, the current caller number, and
the phone-call channel. It also issues a short-lived, call-bound HMAC token for
the two live tools. A requested history query is never reported as a found match.

`lookup_open_thread` searches a private, reviewed caller/thread index. The caller
must supply the business and topic; location narrows the match when provided.
One exact business/topic candidate is required. The service reads the current
Notion row before returning approved memory. Closed, changed, personal,
unapproved, ambiguous, and unrelated records cannot be returned. The response
contains reviewed non-sensitive facts, never a full transcript or stored contact
identifier. Caller ID remains a matching hint, not identity verification.

`save_call_note` captures a request, proposed contact correction, or opt-out in
the private ledger and returns an idempotent receipt. It explicitly returns
`notion_saved:false`. The after-call process includes these notes in the call's
transcript section. This tool does not send messages, book appointments, change
contacts, or arrange a human callback. Opt-outs immediately suppress lookup and
are preserved in the eventual thread summary. This is not a global block on
someone independently placing a call through another Telnyx tool.

After-call insight-group webhooks carry `conversation_insight_result` with a
terminal `completed` or `failed` status. The route also supports
`call.conversation.ended` when an existing call integration sends that event.
The supplied setup uses the already-bound insight group; it does not change a
TeXML voice/routing URL. Failed insights still permit a transcript-only review
record. Insight text is labeled generated and requiring review.

The external webhook receives success only after its minimal event record and
queue publication are durable. Queue messages carry an event ID, not a
transcript. The worker verifies native Telnyx ownership, obtains every declared
transcript page, and freezes the call payload before writing to Notion.

## Required access and configuration

Use Node 22.x. The pinned dependencies and lockfile are in the repository. In
an authenticated Vercel project, attach a **private** Blob store and enable the
Queues feature in the configured `iad1` region. Use a plan permitted for this
business workload. Vercel's Hobby plan is restricted to noncommercial personal
use. Do not upgrade a paid plan without the owner's authorization.

Configure the following through the host's protected environment settings:

| Variable | Value |
| --- | --- |
| `NIA_ASSISTANT_ID` | Nia's existing Telnyx assistant ID |
| `NIA_AGENT_NUMBER` | Nia's existing number in canonical E.164 form |
| `NIA_INSIGHT_GROUP_ID` | The insight group already assigned to Nia |
| `NOTION_DATA_SOURCE_ID` | Existing Nia Call Log data-source ID, not its database/page ID |
| `TELNYX_API_KEY` | Dedicated server credential for read-only runtime call retrieval; setup also requires assistant/group configuration access |
| `NOTION_TOKEN` | Dedicated Notion integration token with access to the existing call log and required read/insert/update capabilities |
| `TELNYX_PUBLIC_KEY` | Base64 Ed25519 verification key returned as `data.public` by authenticated `GET /v2/public_key` |
| `NIA_SESSION_SECRET` | A new random secret of at least 32 bytes |
| `NIA_LEDGER_HASH_SECRET` | A different new random secret of at least 32 bytes |
| `NIA_REGION` | `iad1`, matching `vercel.json` |
| `NIA_LEDGER_NAMESPACE` | `production`, or a distinct preview namespace |

The ChatGPT Telnyx and Notion connections do not expose reusable backend
credentials. Do not copy session cookies or connector tokens into this service.
The public verification key is not the Telnyx secret API key. Vercel SDK access
also needs an authenticated project context: production OIDC or supported
explicit server credentials. Local fake tests do not establish that access.

Keep the ledger hash secret stable. Changing it changes every logical record's
storage path and makes existing records appear absent. Rotate it only with a
planned migration. Session-secret rotation invalidates active tool tokens; it
does not rekey the ledger. Keep preview and production data isolated.

## Prepare and activate

1. Install the locked dependencies with `npm ci --ignore-scripts` and run
   `npm test` on Node 22. Deploy this branch to the intended authenticated
   Vercel project with the environment above. Do not point Telnyx at a preview
   whose protection prevents webhook access. The signed API routes must be
   reachable over HTTPS; the queue consumer remains private.
2. Use the private thread-mapping JSON prepared from the existing Notion rows.
   Keep it outside the repository. `config/threads.example.json` describes the
   format with generic placeholders. Preview the import, then apply it:

   ```sh
   node scripts/import-threads.mjs /absolute/path/to/private-threads.json
   node scripts/import-threads.mjs /absolute/path/to/private-threads.json --apply
   ```

   Run these commands with the same authenticated project/environment and
   private store used by the deployment. The importer reads Notion; it never
   modifies its pages or schema. It validates the complete bounded list before
   registration and preserves the original conversation, direction, timestamp,
   last contact, and callback baseline. Legacy call IDs are explicit reviewed
   assertions, not guesses extracted from arbitrary text. All existing callback
   IDs must be seeded before replay: a row with four historical callbacks needs
   those four distinct already-saved IDs. QA threads remain flagged as tests.
3. Run the operational preflight against the deployed origin:

   ```sh
   node scripts/operate.mjs preflight https://YOUR-RELAY-ORIGIN
   ```

   This checks provider reads, existing row/ledger mappings, unsigned webhook
   rejection, and a harmless queued health event. The health event performs no
   call, SMS, or Notion write. `/api/health` by itself only checks configuration;
   it is not evidence that providers or the queue work.
4. Review and apply the concrete assistant configuration:

   ```sh
   node scripts/operate.mjs configure https://YOUR-RELAY-ORIGIN
   node scripts/operate.mjs configure https://YOUR-RELAY-ORIGIN --apply
   ```

   Configure requires a fresh matching preflight. It preserves unrelated tools,
   voice, model, and shared tool attachments; adds the two relay tools; sets the
   initialization URL; and connects the already-bound insight group's webhook.
   It retains recording off, keypad navigation enabled, and a 360-second cap.
   A private before-state and mutation journal support readback and recovery.
   Any temporary static inquiry fallback is removed from the deployed instructions.
   A partial or uncertain setup is reported as such, never as activated.
5. Complete the controlled voice acceptance below. A successful HTTP test does
   not establish speech quality, interruption behavior, real DTMF navigation,
   or real end-to-end Notion persistence.

These steps are operational commands, not permission to create new accounts,
change billing, place calls, or message anyone. Real call targets and actions
must be authorized by Kal's actual mission.

## Controlled voice acceptance

| Scenario | Required result |
| --- | --- |
| Same-number coffee QA callback | Caller gives only business/topic first. Nia recalls approved broken-ordering/phone-order context, says Kal naturally, and makes no invented handoff promise. |
| Different or withheld caller number | Nia asks for context without revealing the earlier caller's details. |
| Two possible topics or locations | Nia asks a concise clarification; no thread is silently chosen. |
| Proposed contact correction | Nia reads it back if asked, records a proposed correction, and does not claim an external contact changed. |
| Save unavailable | Nia explicitly says the handoff is not confirmed. No success receipt or appointment promise. |
| IVR, hold, interruption | Nia listens, presses the relevant keypad choice, stays quiet during playback, and respects the hold/call budgets. |
| Voicemail | Nia records that no employee-confirmed answer was obtained. No claimed stock, price, or guaranteed callback. |
| Opt-out | Nia stops the pitch, captures the opt-out if possible, and ends politely. |
| Call finishes | Exactly one matching thread contains one complete new conversation section and the correct absolute callback count. No automatic log SMS. |

After every authorized acceptance call, inspect the actual Telnyx transcript
and the Notion row. Preserve the original row identity and original provenance.
The existing roleplay is not a real lead and must not trigger real outreach.

## Failure recovery and limits

Use `node scripts/operate.mjs pending` to inspect pending event IDs and status.
After repairing the concrete problem, use
`node scripts/operate.mjs redrive EVENT_ID`. A manual redrive bypasses the
queue's short deduplication window while retaining permanent event,
conversation, and provider-mutation receipts. It never clears an uncertain
receipt or automatically decides a missing write failed.

The queue worker has a request-scoped 50-second deadline inside the host's
60-second limit. Provider and storage requests share cancellation, and safe
phase checkpoints let a later delivery continue frozen work. Live tools have a
6.5-second service deadline inside Telnyx's eight-second tool timeout. These
bounds limit delays; a timeout still requires an honest unavailable/pending
response and does not prove that a remote write failed.

The queue is at-least-once and may deliver out of order. The private ledger uses
conditional writes and thread leases. Notion has no transactional unique
constraint for these pages. Before every provider mutation, the relay persists
an intent and a thread-level pending-operation pointer. Verified completion
clears it. An uncertain write holds later callbacks on that thread until an
independent read confirms completion. Never delete that pointer just to make a
retry run.

An incomplete transcript, missing caller/direction linkage, provider outage,
unverified page, or exhausted read bound remains pending for review. Empty
spoken transcripts are not passed off as complete conversations. The runtime
reads at most five 100-message pages for a six-minute call. Other limits include
256 KiB inbound webhooks, 50 candidate threads per caller, 20 notes per call,
1,000 pending events, and a 2 MiB private record bound. Reaching a bound fails
explicitly; it does not silently truncate a saved transcript.

Notion transcript writing involves multiple calls. If only part of a transcript
commits before a timeout, the relay conservatively holds the thread until its
completion can be verified or an operator investigates it. It does not promise
fully automatic recovery for every partial remote write. The pending-event
index survives the queue's 20-delivery limit, but no human alert channel has
been configured; check pending work during operation. Do not add notification
SMS without Kal's instruction.

Original row fields remain immutable. Callback count is the imported baseline
plus distinct new non-original conversations. Late events keep their transcript
but do not replace a newer contact time or summary. A finished phone call never
automatically marks its business mission completed; generated results require
review. Newly unclassified calls get a separate review row and are unavailable
to live memory until reviewed and assigned an approved scope.

## Primary references checked for this release

- [Telnyx dynamic variables and initialization](https://developers.telnyx.com/docs/inference/ai-assistants/dynamic-variables)
- [Telnyx preset webhook parameters](https://developers.telnyx.com/docs/inference/ai-assistants/preset-webhook-parameters)
- [Telnyx insight groups and signed terminal events](https://developers.telnyx.com/docs/inference/ai-insights/insight-groups)
- [Telnyx conversation messages](https://developers.telnyx.com/api-reference/conversations/get-conversation-messages)
- [Notion API versioning](https://developers.notion.com/reference/versioning)
- [Notion request limits](https://developers.notion.com/reference/request-limits)
- [Vercel Queues quickstart](https://vercel.com/docs/queues/quickstart)
- [Vercel private Blob](https://vercel.com/docs/vercel-blob/using-blob-sdk)
- [Vercel Hobby commercial-use restriction](https://vercel.com/docs/plans/hobby)
