import { createPublicKey, verify } from 'node:crypto';
export const config = { api: { bodyParser: false } };
const prefix = Buffer.from('302a300506032b6570032100', 'hex');

export function normalizePhone(value) {
  const source = String(value ?? '').trim();
  const digits = source.replace(/\D/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
  if (source.startsWith('+') && digits.length >= 8 && digits.length <= 15) return '+' + digits;
  return '';
}

export function verifyTelnyxWebhook({ rawBody, headers, publicKey, now = Date.now() }) {
  const pub = Buffer.from(publicKey || '', 'base64');
  const sig = Buffer.from(String(headers['telnyx-signature-ed25519'] || ''), 'base64');
  const ts = String(headers['telnyx-timestamp'] || '');
  if (pub.length !== 32 || sig.length !== 64 || !/^\d{10}$/.test(ts)) return false;
  if (Math.abs(now / 1000 - Number(ts)) > 300) return false;
  const key = createPublicKey({ key: Buffer.concat([prefix, pub]), format: 'der', type: 'spki' });
  return verify(null, Buffer.from(ts + '|' + rawBody), key, sig);
}

export function memoryResponse(payload) {
  const caller = normalizePhone(payload?.telnyx_end_user_target);
  const target = normalizePhone(payload?.telnyx_agent_target);
  const expected = normalizePhone(process.env.NIA_AGENT_NUMBER);
  const inbound = payload?.telnyx_conversation_channel === 'phone_call' && target && target === expected;
  const response = {
    dynamic_variables: {
      preferred_name: 'Kal', callback_context_found: 'no',
      callback_business: '', callback_thread_id: '', callback_mission: '',
      callback_summary: '', callback_missing_items: ''
    },
    conversation: { metadata: { nia_memory_version: 'v1', nia_caller_match: 'none' } }
  };
  // Never give an unidentified caller someone else's conversation history.
  if (!inbound || !caller || caller === target) return response;
  response.memory = {
    conversation_query: 'metadata->telnyx_agent_target=eq.' + target +
      '&metadata->telnyx_end_user_target=eq.' + caller +
      '&limit=5&order=last_message_at.desc'
  };
  response.conversation.metadata.nia_caller_match = 'same_number';
  response.dynamic_variables.callback_context_found = 'phone_history_available';
  return response;
}

async function readRaw(req) {
  if (typeof req.rawBody === 'string') return req.rawBody;
  if (Buffer.isBuffer(req.rawBody)) return req.rawBody.toString('utf8');
  let raw = '';
  for await (const chunk of req) {
    raw += Buffer.from(chunk).toString('utf8');
    if (raw.length > 64000) throw new Error('Oversize body');
  }
  return raw;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({error: 'POST required'});
  if (!process.env.TELNYX_PUBLIC_KEY || !process.env.NIA_AGENT_NUMBER || !process.env.NIA_ASSISTANT_ID)
    return res.status(503).json({error: 'Configuration missing'});
  try {
    const rawBody = await readRaw(req);
    if (!verifyTelnyxWebhook({rawBody, headers: req.headers, publicKey: process.env.TELNYX_PUBLIC_KEY}))
      return res.status(401).json({error: 'Invalid webhook signature'});
    const data = JSON.parse(rawBody)?.data;
    if (data?.event_type !== 'assistant.initialization' || data?.payload?.assistant_id !== process.env.NIA_ASSISTANT_ID)
      return res.status(400).json({error: 'Unexpected event'});
    return res.status(200).json(memoryResponse(data.payload));
  } catch {
    return res.status(400).json({error: 'Invalid webhook request'});
  }
}
