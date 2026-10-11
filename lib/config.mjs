import { normalizePhone } from './security.mjs';

export function configuration(env = process.env, { full = true } = {}) {
  const required = name => {
    const value = env[name];
    if (typeof value !== 'string' || !value.trim()) throw Object.assign(new Error(`Missing ${name}`), { code: 'configuration_missing', status: 503 });
    return value.trim();
  };
  const result = {
    assistantId: required('NIA_ASSISTANT_ID'),
    agentNumber: required('NIA_AGENT_NUMBER'),
    publicKey: required('TELNYX_PUBLIC_KEY'),
    sessionSecret: required('NIA_SESSION_SECRET'),
    insightGroupId: env.NIA_INSIGHT_GROUP_ID || undefined,
    namespace: env.NIA_LEDGER_NAMESPACE || env.VERCEL_ENV || 'development'
  };
  if (!/^assistant-[A-Za-z0-9_-]{1,180}$/.test(result.assistantId) || !normalizePhone(result.agentNumber)) throw new Error('Invalid assistant or agent configuration');
  if (!/^[A-Za-z0-9+/]{43}=$/.test(result.publicKey) || Buffer.from(result.publicKey, 'base64').length !== 32) throw new Error('Invalid Telnyx public key');
  if (Buffer.byteLength(result.sessionSecret) < 32) throw new Error('NIA_SESSION_SECRET must contain at least 32 bytes');
  if (full) {
    result.telnyxApiKey = required('TELNYX_API_KEY');
    result.notionToken = required('NOTION_TOKEN');
    result.dataSourceId = required('NOTION_DATA_SOURCE_ID');
    result.hashSecret = required('NIA_LEDGER_HASH_SECRET');
    if (Buffer.byteLength(result.hashSecret) < 32) throw new Error('NIA_LEDGER_HASH_SECRET must contain at least 32 bytes');
    if (result.hashSecret === result.sessionSecret) throw new Error('Use separate ledger and session secrets');
  }
  return result;
}
