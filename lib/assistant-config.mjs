import { readFile } from 'node:fs/promises';

export const nativeTools = [
  { type: 'send_dtmf', send_dtmf: {} },
  { type: 'skip_turn', skip_turn: { description: 'Remain quiet while a menu, hold announcement, or another speaker is talking.' } },
  { type: 'hangup', hangup: { description: 'End politely when the task is complete, the person declines, the menu is unresolvable, or the approved time budget is reached.' } }
];

export async function instructions({ liveLookup = false } = {}) {
  const text = await readFile(new URL('../config/nia-instructions.txt', import.meta.url), 'utf8');
  return liveLookup ? stripLegacyFallback(text) : text;
}

export function stripLegacyFallback(text) {
  return text.replace(/\nTEMPORARY OPEN [^\n]*INQUIRY[\s\S]*$/, '').trimEnd() + '\n';
}

// Detail retrieval resolves shared tools; list-assistants can omit them.
// Replacing inline tools must not duplicate a shared native tool.
export function mergeAssistantTools(resolvedTools, {baseUrl, assistantId} = {}) {
  const ownedNames = new Set(['lookup_open_thread', 'save_call_note']);
  if (baseUrl && (resolvedTools || []).some(t => t.shared && ownedNames.has(t.webhook?.name))) throw new Error('A shared relay tool must be reviewed before installing an inline tool with the same name');
  const inline = (resolvedTools || []).filter(t => !t.shared && !(baseUrl && ownedNames.has(t.webhook?.name))).map(t => {
    const {tool_id, shared, ...definition} = t;
    return definition;
  });
  for (const tool of nativeTools) if (!(resolvedTools || []).some(t => t.type === tool.type)) inline.push(tool);
  if (baseUrl) inline.push(...relayTools(baseUrl, assistantId));
  return inline;
}

export function relayTools(baseUrl, assistantId) {
  const url = new URL(baseUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('An HTTPS relay origin is required');
  const preset = purpose => ({ purpose, assistant_id: assistantId, call_control_id: '{{call_control_id}}', agent_target: '{{telnyx_agent_target}}', caller_target: '{{telnyx_end_user_target}}', channel: '{{telnyx_conversation_channel}}', session_token: '{{nia_session_token}}' });
  return [
    { type: 'webhook', timeout_ms: 8000, webhook: {
      name: 'lookup_open_thread', description: 'Find one relevant open inquiry after the caller states their business, location, and callback topic. A match does not verify identity.',
      url: new URL('/api/lookup-open-thread', url).href, method: 'POST', async: false,
      preset_body_fields: preset('lookup_open_thread'),
      body_parameters: { type: 'object', additionalProperties: false, properties: { business: {type:'string',maxLength:120}, location:{type:'string',maxLength:160}, topic:{type:'string',maxLength:240} }, required:['business','topic'] },
      messages: [{type:'request_start',content:'Let me pull up the earlier request.'},{type:'request_response_delayed',timing_ms:3500,content:'Thanks for waiting.'}]
    } },
    { type: 'webhook', timeout_ms: 8000, webhook: {
      name: 'save_call_note', description: 'Durably capture a caller request, proposed correction, or opt-out for Kal. This never books, sends a message, or promises a follow-up. Claim Notion save only if the receipt confirms it.',
      url: new URL('/api/save-call-note', url).href, method:'POST', async:false,
      preset_body_fields:preset('save_call_note'),
      body_parameters:{type:'object',additionalProperties:false,properties:{business:{type:'string',maxLength:120},location:{type:'string',maxLength:160},topic:{type:'string',maxLength:240},note:{type:'string',maxLength:3000},note_type:{type:'string',enum:['request','proposed_contact_correction','do_not_contact']},operation_id:{type:'string',maxLength:80,description:'Use a new short letters/digits/underscore/hyphen ID for each distinct note. Reuse exactly the same ID and identical content only when retrying that note.'}},required:['business','topic','note','note_type','operation_id']},
      messages:[{type:'request_start',content:'Let me make a note of that.'}]
    } }
  ];
}
