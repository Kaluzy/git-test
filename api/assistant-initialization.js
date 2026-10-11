function normalizePhone(value = '') {
  const digits = String(value).replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (String(value).startsWith('+') && digits.length >= 8) return `+${digits}`;
  return digits ? `+${digits}` : '';
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const payload = req.body?.data?.payload ?? {};
  const endUser = normalizePhone(payload.telnyx_end_user_target ?? '');

  return res.status(200).json({
    dynamic_variables: {
      preferred_name: 'Kal',
      callback_context_found: 'unknown',
      callback_business: '',
      callback_thread_id: '',
      callback_mission: '',
      callback_summary: '',
      callback_missing_items: ''
    },
    memory: {
      conversation_query: endUser
        ? `metadata->telnyx_end_user_target=eq.${endUser}&limit=5&order=last_message_at.desc`
        : 'limit=3&order=last_message_at.desc'
    },
    conversation: {
      metadata: {
        memory_scope_phone: endUser,
        memory_strategy: 'same-caller-last-5'
      }
    }
  });
}
