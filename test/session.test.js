import { test } from 'node:test';

import assert from 'assert';
import { Session, SessionManager } from '../session.js';

test('Session: 创建和消息添加', () => {
  const s = new Session('test1', '/workspace');
  s.addMessage({ role: 'user', content: 'hello' });
  s.addMessage({ role: 'assistant', content: 'hi' });
  assert.strictEqual(s.messages.length, 2);
  assert.strictEqual(s.messages[0].role, 'user');
});

test('Session: prune 保留 system prompt', () => {
  const s = new Session('test3', '/workspace');
  s.addMessage({ role: 'system', content: 'system prompt' });
  for (let i = 0; i < 50; i++) {
    s.addMessage({ role: 'user', content: `msg ${i}` });
    s.addMessage({ role: 'assistant', content: `reply ${i}` });
  }
  s.prune(10);
  assert.strictEqual(s.messages[0].role, 'system');
  assert.ok(s.messages.length <= 10, `裁剪后应 <= 10 条，实际 ${s.messages.length}`);
});

test('Session: prune 不产生 orphan tool message', () => {
  const s = new Session('test-orphan', '/workspace');
  s.addMessage({ role: 'system', content: 'sys' });

  // 构建多轮带 tool_calls 的 transcript，超过 MAX_SESSION_MESSAGES
  for (let round = 0; round < 20; round++) {
    s.addMessage({
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: `call_${round}_a`, type: 'function', function: { name: 'read_file', arguments: '{}' } },
        { id: `call_${round}_b`, type: 'function', function: { name: 'search_files', arguments: '{}' } },
      ],
    });
    s.addMessage({ role: 'tool', tool_call_id: `call_${round}_a`, content: '{}' });
    s.addMessage({ role: 'tool', tool_call_id: `call_${round}_b`, content: '{}' });
    s.addMessage({ role: 'user', content: `round ${round} task` });
    s.addMessage({ role: 'assistant', content: `round ${round} done` });
  }

  // 裁剪
  s.prune(30);

  // 校验：无 orphan tool message
  const toolCallIds = new Set();
  for (const m of s.messages) {
    if (m.role === 'assistant' && m.tool_calls) {
      for (const tc of m.tool_calls) toolCallIds.add(tc.id);
    }
  }
  for (const m of s.messages) {
    if (m.role === 'tool') {
      assert.ok(toolCallIds.has(m.tool_call_id),
        `orphan tool message: tool_call_id=${m.tool_call_id} 没有对应的 assistant tool_calls`);
    }
  }

  // 校验：每个 assistant tool_call 都有对应的 tool result
  const toolResultIds = new Set();
  for (const m of s.messages) {
    if (m.role === 'tool') toolResultIds.add(m.tool_call_id);
  }
  for (const m of s.messages) {
    if (m.role === 'assistant' && m.tool_calls) {
      for (const tc of m.tool_calls) {
        assert.ok(toolResultIds.has(tc.id),
          `orphan tool_call: id=${tc.id} 没有对应的 tool result`);
      }
    }
  }
});

test('Session: tool result 截断', () => {
  const s = new Session('test4', '/workspace');
  const longContent = 'x'.repeat(10000);
  s.addMessage({ role: 'tool', tool_call_id: 'call_1', content: longContent });
  assert.ok(s.messages[0].content.length < 10000, 'tool result 应被截断');
  assert.ok(s.messages[0].content.includes('[已截断]'));
});

test('SessionManager: 创建和获取', () => {
  const sm = new SessionManager();
  const s = sm.create('/workspace');
  assert.ok(s.id.startsWith('sess_'));
  const fetched = sm.get(s.id);
  assert.strictEqual(fetched, s);
  const notFound = sm.get('nonexistent');
  assert.strictEqual(notFound, undefined);
});

test('Session: 序列化和反序列化', () => {
  const s = new Session('test5', '/workspace');
  s.addMessage({ role: 'user', content: 'hello' });
  const data = s.serialize();
  const s2 = Session.deserialize(data);
  assert.strictEqual(s2.id, 'test5');
  assert.strictEqual(s2.workspace, '/workspace');
  assert.strictEqual(s2.messages.length, 1);
  assert.strictEqual(s2.messages[0].content, 'hello');
});