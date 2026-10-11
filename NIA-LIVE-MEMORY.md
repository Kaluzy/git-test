# Nia Live Memory v1 — same-number callback pilot

Status: **Staged, not deployed**. Never claim this is live until a Vercel endpoint is deployed, verified, and configured on the Telnyx assistant.

## Purpose
When the same person calls back on the same telephone number used previously, Telnyx receives an authenticated initialization webhook, safely scopes memory to prior conversations between the same assistant phone number and that caller number, and gives Nia the relevant previous context before the first speech turn. If caller identification is missing, no third-party conversation history is returned.

## Files
- `api/assistant-initialization.js`: verifies signed Telnyx Ed25519 request (raw timestamp + original payload), validates event and assistant, returns caller-specific memory query.
- `test.mjs`: synthetic signed webhook, same-number memory, unknown-caller isolation, tampering/replay rejection.
- `vercel.json`: API function runtime duration limit.
- `package.json`: Node ES module and test command.

## Configuration required after deployment
Set **protected server-side** environment variables `TELNYX_PUBLIC_KEY`, `NIA_AGENT_NUMBER`, and `NIA_ASSISTANT_ID` on the deployment. The public signing verification key is not the Telnyx API secret; no Telnyx API secret is required for this read-only initialization endpoint. Do not put credentials into GitHub files or URLs.

Deploy the feature branch as an isolated Vercel Preview first. Test the HTTPS `POST /api/assistant-initialization` endpoint with signed synthetic requests; reject unsigned or replayed calls. Only then set Nia's `dynamic_variables_webhook_url` to the confirmed HTTPS URL. The assistant greeting should remain generic until a caller identifies the specific follow-up topic.

## Real-world acceptance test
Call Nia from the exact number used in the earlier coffee-startup sales test. Say: “Hi, it's the coffee shop we spoke with earlier. I was expecting an update, but nobody contacted me. Can you remind me what you and I discussed?” Do not mention the ordering problem, contact email or any other previously known details unless Nia asks.

Pass: Nia remembers the coffee website's broken online ordering and that the business was taking orders by phone, clearly states that no follow-up has been confirmed, offers to record a request without falsely promising action, and uses “Kal” naturally. If the caller number is different or the topic is ambiguous, she asks for identification and context rather than inventing details. An unrelated caller must never hear details of previous calls.

Check the new Telnyx conversation and insights afterward. Notion post-call automatic merge and mid-call lookup from **different numbers** remain **separate, unimplemented follow-on work**; do not claim either passed during this pilot.

## Safety
- No audio recording.
- Never reveal account credentials, PII, or another caller's history.
- Caller ID is a match hint, **not identity verification**. Confirm topic/business before discussing private matters.
- Signed webhooks with stale timestamps or bad signatures fail closed.
- Return no memory if no recognized caller/assistant number.
- Do not promise a call, text, booking, purchase, or email unless actually performed or confirmed.
