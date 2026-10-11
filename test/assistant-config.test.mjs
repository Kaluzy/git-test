import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeAssistantTools, relayTools, instructions, stripLegacyFallback } from '../lib/assistant-config.mjs';
import { ASSISTANT } from './helpers.mjs';

test('assistant merge preserves unrelated inline tools and avoids duplicating shared native tools', () => {
  const unrelated = { type: 'webhook', webhook: { name: 'existing_safe_tool', url: 'https://example.test/existing' }, tool_id: 'inline-identifier', shared: false };
  const shared = { type: 'send_dtmf', send_dtmf: {}, shared: true, tool_id: 'shared-keypad' };
  const original = structuredClone([unrelated, shared]);
  const merged = mergeAssistantTools([unrelated, shared]);
  assert.deepEqual([unrelated, shared], original);
  assert.equal(merged.filter(tool => tool.type === 'send_dtmf').length, 0);
  assert.equal(merged.filter(tool => tool.type === 'hangup').length, 1);
  assert.equal(merged.filter(tool => tool.type === 'skip_turn').length, 1);
  const retained = merged.find(tool => tool.webhook?.name === 'existing_safe_tool');
  assert.equal(retained.webhook.url, unrelated.webhook.url); assert.equal(retained.tool_id, undefined);
});

test('relay tools keep trusted linkage in presets outside model-controlled parameter schema', () => {
  const tools = relayTools('https://relay.example.test', ASSISTANT);
  assert.equal(tools.length, 2);
  for (const tool of tools) {
    assert.equal(tool.type, 'webhook'); assert.equal(tool.timeout_ms, 8000);
    assert.equal(tool.webhook.method, 'POST'); assert.equal(tool.webhook.async, false);
    assert.equal(tool.webhook.preset_body_fields.assistant_id, ASSISTANT);
    assert.equal(tool.webhook.preset_body_fields.call_control_id, '{{call_control_id}}');
    assert.equal(tool.webhook.preset_body_fields.session_token, '{{nia_session_token}}');
    assert.equal(tool.webhook.preset_body_fields.purpose, tool.webhook.name);
    for (const name of ['assistant_id', 'call_control_id', 'session_token', 'caller_target', 'agent_target', 'purpose', 'channel']) {
      assert.equal(tool.webhook.body_parameters.properties[name], undefined);
    }
    assert.equal(new URL(tool.webhook.url).origin, 'https://relay.example.test');
  }
  for (const url of ['http://relay.example.test', 'https://user:password@relay.example.test', 'https://relay.example.test?token=x', 'https://relay.example.test#fragment']) {
    assert.throws(() => relayTools(url, ASSISTANT));
  }
});

test('replacing owned inline relay tools is repeatable and retains unrelated tools', () => {
  const old = relayTools('https://old.example.test', ASSISTANT);
  const unrelated = { type: 'webhook', webhook: { name: 'unrelated', url: 'https://example.test/ok' } };
  const first = mergeAssistantTools([...old, unrelated], { baseUrl: 'https://new.example.test', assistantId: ASSISTANT });
  const second = mergeAssistantTools(first, { baseUrl: 'https://new.example.test', assistantId: ASSISTANT });
  assert.deepEqual(second, first);
  assert.equal(second.filter(tool => tool.webhook?.name === 'lookup_open_thread').length, 1);
  assert.equal(second.filter(tool => tool.webhook?.name === 'save_call_note').length, 1);
  assert.equal(second.filter(tool => tool.webhook?.name === 'unrelated').length, 1);
});

test('shared relay names cannot be silently duplicated and live lookup removes the temporary static inquiry', async () => {
  const shared = { ...relayTools('https://old.example.test', ASSISTANT)[0], shared: true, tool_id: 'shared-lookup' };
  assert.throws(() => mergeAssistantTools([shared], { baseUrl: 'https://new.example.test', assistantId: ASSISTANT }), /shared relay tool/);
  const baseline = await instructions(); const live = await instructions({ liveLookup: true });
  assert.equal(stripLegacyFallback('Public instructions\nTEMPORARY OPEN TEST INQUIRY\nPrivate test facts'), 'Public instructions\n');
  assert.doesNotMatch(live, /TEMPORARY OPEN .*INQUIRY|Private test facts/);
  assert.match(live, /Never fabricate memory/);
  const note = relayTools('https://relay.example.test', ASSISTANT).find(tool => tool.webhook.name === 'save_call_note');
  assert.match(note.webhook.body_parameters.properties.operation_id.description, /distinct note/);
  assert.match(note.webhook.body_parameters.properties.operation_id.description, /identical content/);
});

test('instructions explicitly distinguish memory from identity and durable capture from performed follow-up', async () => {
  const prompt = await instructions();
  assert.match(prompt, /Caller ID is only a matching hint/);
  assert.match(prompt, /Never fabricate memory/);
  assert.match(prompt, /verified durable save receipt/);
  assert.match(prompt, /not an appointment/);
  assert.match(prompt, /do not collect passwords/i);
  assert.match(prompt, /Do not talk over recordings/);
});
