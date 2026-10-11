import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import handler, { normalizePhone, memoryResponse, verifyTelnyxWebhook } from './api/assistant-initialization.js';

process.env.NIA_AGENT_NUMBER = '+13125550100';
process.env.NIA_ASSISTANT_ID = 'assistant-example';
const payload = {
  telnyx_agent_target: '+13125550100',
  telnyx_end_user_target: '+13125550123',
  telnyx_conversation_channel: 'phone_call',
  assistant_id: 'assistant-example'
};
assert.equal(normalizePhone('(312) 555-0123'), '+13125550123');
const scoped = memoryResponse(payload);
assert.equal(scoped.dynamic_variables.callback_context_found, 'phone_history_available');
assert.match(scoped.memory.conversation_query, /end_user_target=eq.\+13125550123/);
assert.match(scoped.memory.conversation_query, /agent_target=eq.\+13125550100/);
for (const invalid of ['', 'unknown', '+13125550100']) {
  assert.equal(memoryResponse({ ...payload, telnyx_end_user_target: invalid }).memory, undefined);
}
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const pub = publicKey.export({format:'der', type:'spki'}).subarray(-32).toString('base64');
const ts = String(Math.floor(Date.now()/1000));
const raw = JSON.stringify({data:{event_type:'assistant.initialization',payload}});
const headers = {
  'telnyx-timestamp': ts,
  'telnyx-signature-ed25519': sign(null, Buffer.from(ts + '|' + raw), privateKey).toString('base64')
};
assert.equal(verifyTelnyxWebhook({rawBody:raw,headers,publicKey:pub}), true);
assert.equal(verifyTelnyxWebhook({rawBody:raw+' ',headers,publicKey:pub}), false);
assert.equal(verifyTelnyxWebhook({rawBody:raw,headers:{...headers,'telnyx-timestamp':String(Number(ts)-400)},publicKey:pub}), false);
const makeRes=()=>({status(n){this.code=n; return this;},json(value){this.value=value;return this;}});
process.env.TELNYX_PUBLIC_KEY=pub;
const valid={method:'POST',headers,async *[Symbol.asyncIterator](){yield Buffer.from(raw)}};
const ok=makeRes();await handler(valid,ok);
assert.equal(ok.code,200);
assert.equal(ok.value.conversation.metadata.nia_caller_match,'same_number');
const bad=makeRes();await handler({...valid,headers:{}},bad);
assert.equal(bad.code,401);
console.log('PASS: scoped caller memory, signature authentication, replay and tamper defense, live endpoint');
