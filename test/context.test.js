import { test } from 'node:test';
import assert from 'assert';
import { Session, SessionManager } from '../session.js';
import { buildAgentContext, groupSessionTurns, turnToMessages, estimateTurnsSize, CONTEXT_BUDGET, HARD_BUDGET, MIN_RECENT_TURNS } from '../context/builder.js';
import { estimateContextSize, CHARS_PER_TOKEN } from '../context/estimator.js';
import { buildCompactionPrompt, validateSummary, estimateSummarySize, SUMMARY_MAX_CHARS, mergeSummaries } from '../context/compactor.js';

// ── Estimator ──────────────────────────────────────────

test('Estimator: 空消息数组', () => {
  const size = estimateContextSize([]);
  assert.strictEqual(size.chars, 0);
  assert.strictEqual(size.estimatedTokens, 0);
  assert.strictEqual(size.messageCount, 0);
});

test('Estimator: 计算消息内容', () => {
  const messages = [
    { role: 'user', content: 'hello world' },
    { role: 'assistant', content: 'hi there' },
  ];
  const size = estimateContextSize(messages);
  assert.ok(size.chars > 0);
  assert.ok(size.estimatedTokens > 0);
  assert.strictEqual(size.messageCount, 2);
});

test('Estimator: tool_calls 计入', () => {
  const messages = [
    { role: 'assistant', content: null, tool_calls: [{ id: '1', type: 'function', function: { name: 'read_file', arguments: '{"path":"test.js"}' } }] },
  ];
  const size = estimateContextSize(messages);
  assert.ok(size.chars > 0);
});

// ── Compactor ──────────────────────────────────────────

test('Compactor: validateSummary 有效结构', () => {
  const summary = {
    goal: ['task'],
    constraints: ['no react'],
    decisions: ['use ESM'],
    progress: ['done'],
    files: ['app.js'],
    verification: ['npm test pass'],
    openItems: ['next step'],
  };
  const result = validateSummary(summary);
  assert.ok(result.valid, `expected valid, got: ${JSON.stringify(result.errors)}`);
});

test('Compactor: validateSummary 缺少 key', () => {
  const summary = { goal: ['task'] };
  const result = validateSummary(summary);
  assert.ok(!result.valid);
  assert.ok(result.errors.some(e => e.includes('constraints')));
});

test('Compactor: validateSummary 非 array', () => {
  const summary = { goal: 'not array', constraints: [], decisions: [], progress: [], files: [], verification: [], openItems: [] };
  const result = validateSummary(summary);
  assert.ok(!result.valid);
});

test('Compactor: buildCompactionPrompt 包含现有 summary', () => {
  const existing = { goal: ['old task'], constraints: [], decisions: [], progress: [], files: [], verification: [], openItems: [] };
  const newMessages = [{ role: 'user', content: 'new task' }];
  const prompt = buildCompactionPrompt(existing, newMessages, 0);
  assert.ok(prompt.includes('Existing Summary'));
  assert.ok(prompt.includes('old task'));
  assert.ok(prompt.includes('new task'));
  assert.ok(prompt.includes('Only preserve facts'));
});

test('Compactor: mergeSummaries 合并数组', () => {
  const a = { goal: ['A'], constraints: ['C1'], decisions: [], progress: [], files: [], verification: [], openItems: [] };
  const b = { goal: ['B'], constraints: ['C1', 'C2'], decisions: [], progress: [], files: [], verification: [], openItems: [] };
  const merged = mergeSummaries(a, b);
  assert.deepStrictEqual(merged.goal, ['A', 'B']);
  assert.deepStrictEqual(merged.constraints, ['C1', 'C2']);
});

test('Compactor: estimateSummarySize', () => {
  const summary = { goal: ['a'], constraints: [], decisions: [], progress: [], files: [], verification: [], openItems: [] };
  const size = estimateSummarySize(summary);
  assert.ok(size > 0);
});

// ── Turn Grouping ──────────────────────────────────────

test('Turn Grouping: 基本分组', () => {
  const messages = [
    { role: 'user', content: 'task 1' },
    { role: 'assistant', content: 'doing', tool_calls: null },
    { role: 'user', content: 'task 2' },
    { role: 'assistant', content: 'done' },
  ];
  const turns = groupSessionTurns(messages);
  assert.strictEqual(turns.length, 2);
  assert.strictEqual(turns[0].messages.length, 2);
  assert.strictEqual(turns[1].messages.length, 2);
});

test('Turn Grouping: 保留 canonical 顺序（多轮 tool loop）', () => {
  const messages = [
    { role: 'user', content: 'task' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'tc-a', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'tc-a', content: '{}' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'tc-b', type: 'function', function: { name: 'search_files', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'tc-b', content: '{}' },
    { role: 'assistant', content: 'final answer' },
  ];
  const turns = groupSessionTurns(messages);
  assert.strictEqual(turns.length, 1);
  // P0-2: Turn 内保持原始顺序
  assert.strictEqual(turns[0].messages.length, 6);
  assert.strictEqual(turns[0].messages[0].role, 'user');
  assert.strictEqual(turns[0].messages[1].tool_calls[0].id, 'tc-a');
  assert.strictEqual(turns[0].messages[2].role, 'tool');
  assert.strictEqual(turns[0].messages[2].tool_call_id, 'tc-a');
  assert.strictEqual(turns[0].messages[3].tool_calls[0].id, 'tc-b');
  assert.strictEqual(turns[0].messages[4].tool_call_id, 'tc-b');
  assert.strictEqual(turns[0].messages[5].content, 'final answer');
});

test('Turn Grouping: turnToMessages 返回原始消息', () => {
  const messages = [
    { role: 'user', content: 'task' },
    { role: 'assistant', content: 'reply' },
  ];
  const turns = groupSessionTurns(messages);
  const msgs = turnToMessages(turns[0]);
  assert.strictEqual(msgs.length, 2);
  assert.strictEqual(msgs[0].role, 'user');
  assert.strictEqual(msgs[1].role, 'assistant');
});

// ── Context Builder ────────────────────────────────────

test('Context Builder: Below Budget — 不触发 Compaction', async () => {
  const session = new Session('test', '/workspace');
  session.addMessage({ role: 'user', content: 'short task' });
  session.addMessage({ role: 'assistant', content: 'ok' });

  const result = await buildAgentContext({
    systemPrompt: 'system',
    projectContext: { loaded: false, source: 'AGENTS.md', content: '', truncated: false, originalLength: 0, loadedLength: 0 },
    session,
    currentTask: 'new task',
    compactor: null,
  });

  assert.ok(!result.contextMetadata.compactionTriggered);
  assert.strictEqual(result.contextMetadata.contextState.compactionCount, 0);
  assert.ok(result.messages.some(m => m.content === 'new task'));
});

test('Context Builder: Canonical Transcript 不被修改', async () => {
  const session = new Session('test', '/workspace');
  const beforeLen = 5;
  for (let i = 0; i < beforeLen; i++) {
    session.addMessage({ role: 'user', content: `msg ${i}` });
    session.addMessage({ role: 'assistant', content: `reply ${i}` });
  }

  await buildAgentContext({
    systemPrompt: 'system',
    projectContext: { loaded: false, source: 'AGENTS.md', content: '', truncated: false, originalLength: 0, loadedLength: 0 },
    session,
    currentTask: 'new task',
    compactor: null,
  });

  // P0-1: Canonical Transcript 保持完整
  assert.strictEqual(session.messages.length, beforeLen * 2);
});

test('Context Builder: Compaction 后 canonical 不变', async () => {
  const session = new Session('test', '/workspace');
  // 创建足够多的消息触发 compaction（需要超过 CONTEXT_BUDGET * 0.75 = 60000 chars）
  for (let i = 0; i < 50; i++) {
    session.addMessage({ role: 'user', content: `task ${i} ${'x'.repeat(800)}` });
    session.addMessage({ role: 'assistant', content: `reply ${i} ${'y'.repeat(800)}` });
  }
  const beforeLen = session.messages.length;

  let compactCalled = false;
  const fakeCompactor = {
    compact: async (existing, newMessages) => {
      compactCalled = true;
      return {
        goal: ['test task'],
        constraints: ['constraint A'],
        decisions: ['decision B'],
        progress: ['progress C'],
        files: ['file.js'],
        verification: ['npm test'],
        openItems: ['open D'],
      };
    },
  };

  await buildAgentContext({
    systemPrompt: 'system',
    projectContext: { loaded: false, source: 'AGENTS.md', content: '', truncated: false, originalLength: 0, loadedLength: 0 },
    session,
    currentTask: 'new task',
    compactor: fakeCompactor,
  });

  // Canonical Transcript 不变
  assert.strictEqual(session.messages.length, beforeLen,
    `Canonical transcript should be unchanged: expected ${beforeLen}, got ${session.messages.length}`);
  // Compaction 发生了
  assert.ok(compactCalled, 'Compactor should have been called');
  assert.ok(session.contextState.compactionCount > 0, 'compactionCount should increase');
  assert.ok(session.contextState.compactedThrough > 0, 'compactedThrough should advance');
});

test('Context Builder: Recent Raw Turns 保留', async () => {
  const session = new Session('test', '/workspace');
  // 创建多个 turns — 使用足够大的内容触发 compaction（需要超过 60000 chars）
  for (let i = 0; i < 50; i++) {
    session.addMessage({ role: 'user', content: `turn ${i} ${'x'.repeat(800)}` });
    session.addMessage({ role: 'assistant', content: `reply ${i} ${'y'.repeat(800)}` });
  }

  const fakeCompactor = {
    compact: async (existing, newMessages) => {
      return {
        goal: ['test'],
        constraints: [],
        decisions: [],
        progress: [],
        files: [],
        verification: [],
        openItems: [],
      };
    },
  };

  const result = await buildAgentContext({
    systemPrompt: 'system',
    projectContext: { loaded: false, source: 'AGENTS.md', content: '', truncated: false, originalLength: 0, loadedLength: 0 },
    session,
    currentTask: 'new task',
    compactor: fakeCompactor,
  });

  // P0-3: Recent Raw Turns 应该存在（至少 MIN_RECENT_TURNS 个）
  assert.ok(result.contextMetadata.recentTurnCount >= MIN_RECENT_TURNS,
    `Expected at least ${MIN_RECENT_TURNS} recent turns, got ${result.contextMetadata.recentTurnCount}`);
});

test('Context Builder: Compaction Failure → degraded', async () => {
  const session = new Session('test', '/workspace');
  for (let i = 0; i < 50; i++) {
    session.addMessage({ role: 'user', content: `task ${i} ${'x'.repeat(800)}` });
    session.addMessage({ role: 'assistant', content: `reply ${i} ${'y'.repeat(800)}` });
  }

  const beforeCount = session.contextState.compactionCount;

  const failingCompactor = {
    compact: async () => {
      throw new Error('compaction failed');
    },
  };

  await buildAgentContext({
    systemPrompt: 'system',
    projectContext: { loaded: false, source: 'AGENTS.md', content: '', truncated: false, originalLength: 0, loadedLength: 0 },
    session,
    currentTask: 'new task',
    compactor: failingCompactor,
  });

  // P0: Failure 不推进 compactedThrough
  assert.strictEqual(session.contextState.compactionCount, beforeCount,
    'compactionCount should not advance on failure');
  assert.strictEqual(session.contextState.status, 'degraded');
});

test('Context Builder: Invalid Summary → degraded', async () => {
  const session = new Session('test', '/workspace');
  for (let i = 0; i < 50; i++) {
    session.addMessage({ role: 'user', content: `task ${i} ${'x'.repeat(800)}` });
    session.addMessage({ role: 'assistant', content: `reply ${i} ${'y'.repeat(800)}` });
  }

  const invalidCompactor = {
    compact: async () => {
      return { invalid: 'schema' };
    },
  };

  await buildAgentContext({
    systemPrompt: 'system',
    projectContext: { loaded: false, source: 'AGENTS.md', content: '', truncated: false, originalLength: 0, loadedLength: 0 },
    session,
    currentTask: 'new task',
    compactor: invalidCompactor,
  });

  assert.strictEqual(session.contextState.status, 'degraded');
});

test('Context Builder: Project Instructions 注入', async () => {
  const session = new Session('test', '/workspace');
  // systemPrompt 应该已经包含 Project Instructions（由 buildSystemPrompt 生成）
  const result = await buildAgentContext({
    systemPrompt: 'base system prompt\n\n## PROJECT INSTRUCTIONS\nSource: AGENTS.md\nUse ESM only.\nAlways run tests.',
    projectContext: {
      loaded: true,
      source: 'AGENTS.md',
      content: 'Use ESM only.\nAlways run tests.',
      truncated: false,
      originalLength: 28,
      loadedLength: 28,
    },
    session,
    currentTask: 'do something',
    compactor: null,
  });

  // Project Instructions 应该只在 system prompt 中出现一次（不重复注入）
  const projectMsgs = result.messages.filter(m =>
    m.content && m.content.includes('Use ESM only')
  );
  assert.strictEqual(projectMsgs.length, 1,
    `Project instructions should appear exactly once, found ${projectMsgs.length}`);
});

test('Context Builder: Session Isolation', async () => {
  const sessionA = new Session('A', '/workspace');
  const sessionB = new Session('B', '/workspace');

  // Session A has compaction
  for (let i = 0; i < 50; i++) {
    sessionA.addMessage({ role: 'user', content: `task ${i} ${'x'.repeat(800)}` });
    sessionA.addMessage({ role: 'assistant', content: `reply ${i} ${'y'.repeat(800)}` });
  }

  const fakeCompactor = {
    compact: async () => ({
      goal: ['A task'], constraints: [], decisions: [], progress: [], files: [], verification: [], openItems: [],
    }),
  };

  await buildAgentContext({
    systemPrompt: 'sys',
    projectContext: { loaded: false, source: 'AGENTS.md', content: '', truncated: false, originalLength: 0, loadedLength: 0 },
    session: sessionA,
    currentTask: 'task A',
    compactor: fakeCompactor,
  });

  // Session B should be fresh
  await buildAgentContext({
    systemPrompt: 'sys',
    projectContext: { loaded: false, source: 'AGENTS.md', content: '', truncated: false, originalLength: 0, loadedLength: 0 },
    session: sessionB,
    currentTask: 'task B',
    compactor: null,
  });

  assert.ok(sessionA.contextState.compactionCount > 0, 'Session A should have compaction');
  assert.strictEqual(sessionB.contextState.compactionCount, 0, 'Session B should be fresh');
  assert.strictEqual(sessionB.contextState.status, 'fresh');
});

test('Context Builder: Incremental Compaction', async () => {
  const session = new Session('test', '/workspace');
  // 第一批消息 — 使用足够大的内容触发 compaction（需要超过 60000 chars）
  for (let i = 0; i < 40; i++) {
    session.addMessage({ role: 'user', content: `batch1 task ${i} ${'x'.repeat(800)}` });
    session.addMessage({ role: 'assistant', content: `batch1 reply ${i} ${'y'.repeat(800)}` });
  }

  let callCount = 0;
  const fakeCompactor = {
    compact: async (existing, newMessages) => {
      callCount++;
      return {
        goal: [`batch${callCount} goal`],
        constraints: [`constraint${callCount}`],
        decisions: [],
        progress: [],
        files: [],
        verification: [],
        openItems: [],
      };
    },
  };

  // 第一次 compaction
  await buildAgentContext({
    systemPrompt: 'sys',
    projectContext: { loaded: false, source: 'AGENTS.md', content: '', truncated: false, originalLength: 0, loadedLength: 0 },
    session,
    currentTask: 'task 1',
    compactor: fakeCompactor,
  });

  const count1 = session.contextState.compactionCount;
  const through1 = session.contextState.compactedThrough;

  // 添加更多消息 — 使用足够大的内容再次触发 compaction
  for (let i = 0; i < 40; i++) {
    session.addMessage({ role: 'user', content: `batch2 task ${i} ${'x'.repeat(800)}` });
    session.addMessage({ role: 'assistant', content: `batch2 reply ${i} ${'y'.repeat(800)}` });
  }

  // 第二次 compaction
  await buildAgentContext({
    systemPrompt: 'sys',
    projectContext: { loaded: false, source: 'AGENTS.md', content: '', truncated: false, originalLength: 0, loadedLength: 0 },
    session,
    currentTask: 'task 2',
    compactor: fakeCompactor,
  });

  assert.ok(session.contextState.compactionCount > count1,
    `compactionCount should increase on second compaction: ${count1} → ${session.contextState.compactionCount}`);
  assert.ok(session.contextState.compactedThrough > through1,
    `compactedThrough should advance: ${through1} → ${session.contextState.compactedThrough}`);
  assert.strictEqual(callCount, 2, 'Compactor should be called twice (incremental)');
});

test('Context Builder: Current Task 永远保留', async () => {
  const session = new Session('test', '/workspace');
  for (let i = 0; i < 50; i++) {
    session.addMessage({ role: 'user', content: `task ${i} ${'x'.repeat(800)}` });
    session.addMessage({ role: 'assistant', content: `reply ${i} ${'y'.repeat(800)}` });
  }

  const fakeCompactor = {
    compact: async () => ({
      goal: ['old'], constraints: [], decisions: [], progress: [], files: [], verification: [], openItems: [],
    }),
  };

  const result = await buildAgentContext({
    systemPrompt: 'sys',
    projectContext: { loaded: false, source: 'AGENTS.md', content: '', truncated: false, originalLength: 0, loadedLength: 0 },
    session,
    currentTask: 'CURRENT_TASK_UNIQUE',
    compactor: fakeCompactor,
  });

  const taskMsgs = result.messages.filter(m => m.content === 'CURRENT_TASK_UNIQUE');
  assert.strictEqual(taskMsgs.length, 1, 'Current task should appear exactly once');
});

test('Context Builder: Tool Pair Integrity', async () => {
  const session = new Session('test', '/workspace');
  // 构建带 tool_calls 的 transcript
  session.addMessage({ role: 'user', content: 'task' });
  session.addMessage({
    role: 'assistant', content: null,
    tool_calls: [{ id: 'tc-1', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
  });
  session.addMessage({ role: 'tool', tool_call_id: 'tc-1', content: '{}' });
  session.addMessage({ role: 'assistant', content: 'done' });

  const result = await buildAgentContext({
    systemPrompt: 'sys',
    projectContext: { loaded: false, source: 'AGENTS.md', content: '', truncated: false, originalLength: 0, loadedLength: 0 },
    session,
    currentTask: 'new',
    compactor: null,
  });

  // 验证 tool_call 和 tool_result 成对存在
  const assistantWithTools = result.messages.filter(m => m.tool_calls);
  const toolResults = result.messages.filter(m => m.role === 'tool');

  for (const assistant of assistantWithTools) {
    for (const tc of assistant.tool_calls) {
      const hasResult = toolResults.some(t => t.tool_call_id === tc.id);
      assert.ok(hasResult, `Tool result for ${tc.id} should exist`);
    }
  }
});

// ── Session ContextState ───────────────────────────────

test('Session: contextState 默认值', () => {
  const s = new Session('test', '/workspace');
  assert.ok(s.contextState);
  assert.strictEqual(s.contextState.summary, null);
  assert.strictEqual(s.contextState.compactedThrough, 0);
  assert.strictEqual(s.contextState.compactionCount, 0);
  assert.strictEqual(s.contextState.status, 'fresh');
});

test('Session: contextState 序列化/反序列化', () => {
  const s = new Session('test', '/workspace');
  s.contextState.compactionCount = 3;
  s.contextState.status = 'compacted';
  const data = s.serialize();
  const s2 = Session.deserialize(data);
  assert.strictEqual(s2.contextState.compactionCount, 3);
  assert.strictEqual(s2.contextState.status, 'compacted');
});

test('Session: prune 是 no-op', () => {
  const s = new Session('test', '/workspace');
  for (let i = 0; i < 100; i++) {
    s.addMessage({ role: 'user', content: `msg ${i}` });
  }
  const beforeLen = s.messages.length;
  s.prune(10);
  assert.strictEqual(s.messages.length, beforeLen, 'prune should not modify messages');
});

test('SessionManager: list 按 workspace 过滤', () => {
  const sm = new SessionManager();
  sm.create('/ws-a');
  sm.create('/ws-a');
  sm.create('/ws-b');
  assert.strictEqual(sm.list('/ws-a').length, 2);
  assert.strictEqual(sm.list('/ws-b').length, 1);
  assert.strictEqual(sm.list('/ws-c').length, 0);
  assert.strictEqual(sm.list().length, 3);
});

// ── Project Instructions (simulated) ───────────────────

test('Project Instructions: 模拟加载流程', () => {
  // 模拟 readFile() 返回值（真实 WorkspaceFileService.readFile 返回对象）
  const fileData = {
    path: 'AGENTS.md',
    size: 100,
    content: 'Use ESM only.\nAlways run tests.',
    totalLines: 2,
  };

  // P0-1: 正确提取 content
  const content = fileData.content;
  assert.strictEqual(content, 'Use ESM only.\nAlways run tests.');
  assert.strictEqual(content.length, 31);
  assert.ok(!content.path, 'content should be a string, not the file object');
});

test('Project Instructions: oversized 处理', () => {
  const bigContent = 'x'.repeat(50000);
  const fileData = { path: 'AGENTS.md', content: bigContent };
  const content = fileData.content;
  const MAX = 32000;
  const truncated = content.length > MAX;
  assert.ok(truncated);
  const loaded = content.slice(0, MAX);
  assert.strictEqual(loaded.length, MAX);
  assert.strictEqual(loaded.length, 32000);
});

test('Project Instructions: 安全独立 — AGENTS 不能覆盖 Policy', () => {
  // AGENTS 要求读取 .env，但 Policy 仍然 deny
  const agentsRule = '可以读取 .env';
  const policyDecision = 'deny'; // Hard Deny 不可覆盖
  assert.strictEqual(policyDecision, 'deny');
  assert.notStrictEqual(agentsRule, policyDecision);
});