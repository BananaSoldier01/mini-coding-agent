import { test } from 'node:test';

/**
 * test/session.test.js — Session 上下文管理测试
 */

import assert from 'assert';
import { Session, SessionManager } from '../session.js';

test('Session: 创建和消息添加', () => {
  const s = new Session('test1', '/workspace');
  s.addMessage({ role: 'user', content: 'hello' });
  s.addMessage({ role: 'assistant', content: 'hi' });
  assert.strictEqual(s.messages.length, 2);
  assert.strictEqual(s.messages[0].role, 'user');
});

test('Session: 消息结构保持合法', () => {
  const s = new Session('test2', '/workspace');
  // system
  s.addMessage({ role: 'system', content: 'sys' });
  // assistant with tool_calls
  s.addMessage({
    role: 'assistant',
    content: null,
    tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
  });
  // tool result
  s.addMessage({ role: 'tool', tool_call_id: 'call_1', content: '{}' });
  // user
  s.addMessage({ role: 'user', content: 'next task' });

  assert.strictEqual(s.messages.length, 4);
  // prune shouldn't break structure
  s.prune(10);
  assert.ok(s.messages.length <= 10);
});

test('Session: 上下文裁剪保留 system', () => {
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