/**
 * fake-llm.js — Deterministic Test LLM Provider
 *
 * 仅用于 Browser E2E 测试。通过 E2E_FAKE_LLM=1 注入 Server → runAgent。
 * 不暴露为产品 Feature。
 *
 * 设计：根据 task + messages 中已有的 assistant 消息轮次，返回 deterministic sequence。
 * 每轮 tool_calls 可以不同，避免 edit → edit → edit 无限循环。
 * 返回 OpenAI-compatible SSE ReadableStream，与 callLLMStream 解析逻辑对齐。
 */

/**
 * 将场景编码为 OpenAI-compatible SSE ReadableStream
 */
function encodeSSE(response, toolCalls) {
  const chunks = [];

  // 发送 content delta
  if (response) {
    chunks.push(
      `data: ${JSON.stringify({ choices: [{ delta: { content: response } }] })}\n\n`
    );
  }

  // 发送 tool_calls delta
  if (toolCalls && toolCalls.length > 0) {
    for (let i = 0; i < toolCalls.length; i++) {
      const tc = toolCalls[i];
      chunks.push(
        `data: ${JSON.stringify({
          choices: [{
            delta: {
              tool_calls: [{
                index: i,
                id: tc.id,
                type: 'function',
                function: { name: tc.name, arguments: JSON.stringify(tc.args) },
              }],
            },
          }],
        })}\n\n`
      );
    }
  }

  // 结束标记
  chunks.push('data: [DONE]\n\n');

  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

/**
 * 创建 Fake Provider（可注入 runAgent opts.provider）
 * 返回的 provider.chatStream() 兼容 callLLMStream 的解析逻辑。
 */
export function createProvider(scenarios) {
  return {
    name: 'fake',
    async chatStream({ messages, signal }) {
      const lastUser = messages.filter(m => m.role === 'user').pop();
      const task = lastUser?.content || '';

      const scenario = scenarios[task];
      if (!scenario) {
        const msg = `I don't know how to "${task.slice(0, 40)}…"`;
        return encodeSSE(msg, []);
      }

      // 确定轮次：仅统计当前 Run 内的 assistant 消息（跳过 Session 历史）
      // 找到最后一个 user 消息的位置，只统计其后的 assistant 消息
      let lastUserIdx = -1;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'user') { lastUserIdx = i; break; }
      }
      const currentRunAssistantCount = messages
        .slice(lastUserIdx + 1)
        .filter(m => m.role === 'assistant').length;
      const round = currentRunAssistantCount;

      const toolCalls = scenario.toolCalls[round] || [];
      const response = scenario.responses[round] || '';

      return encodeSSE(response, toolCalls);
    },
    async chatSimple(prompt) {
      // V0.5.0: Compaction support — deterministic structured summary
      // Check if this is a compaction prompt
      if (prompt.includes('[COMPACTED SESSION CONTEXT]') || prompt.includes('Existing Summary')) {
        return JSON.stringify({
          goal: ['Complete the coding task'],
          constraints: ['Use ESM only', 'Do not modify app.js'],
          decisions: ['Changes use Run Net Diff'],
          progress: ['Previous work completed'],
          files: ['package.json'],
          verification: ['npm test → PASS'],
          openItems: ['Continue with current task'],
        });
      }
      return 'OK';
    },
  };
}

// ── Pre-built E2E Scenarios ──────────────────────────

export const E2E_SCENARIOS = {
  // ── Agent E2E A: Standard Edit (no approval) ──────
  'TEST_STANDARD_EDIT': {
    responses: ['I will read and edit the file.', 'Done.'],
    toolCalls: [
      [
        { id: 'tc-a-read', name: 'read_file', args: { path: 'package.json' } },
        { id: 'tc-a-edit', name: 'edit_file', args: { path: 'package.json', oldString: '  "version": "0.4.2",', newString: '  "version": "0.4.3",' } },
      ],
      [],
    ],
  },

  // ── Agent E2E B: Safe Edit → Approval ─────────────
  'TEST_SAFE_EDIT': {
    responses: ['I need to edit a file.', 'Done.'],
    toolCalls: [
      [
        { id: 'tc-b-edit', name: 'edit_file', args: { path: 'package.json', oldString: '  "version": "0.4.2",', newString: '  "version": "0.4.3",' } },
      ],
      [],
    ],
  },

  // ── Agent E2E C: Reject Approval ──────────────────
  'TEST_REJECT_APPROVAL': {
    responses: ['I need to edit a file.', 'Done.'],
    toolCalls: [
      [
        { id: 'tc-c-edit', name: 'edit_file', args: { path: 'package.json', oldString: '  "version": "0.4.2",', newString: '  "version": "0.4.3",' } },
      ],
      [],
    ],
  },

  // ── Agent E2E D: Command → Terminal ───────────────
  'TEST_COMMAND': {
    responses: ['I will run a command.', 'Done.'],
    toolCalls: [
      [
        { id: 'tc-d-cmd', name: 'run_command', args: { command: 'echo hello-agent' } },
      ],
      [], // Round 1: final response
    ],
  },

  // ── Agent E2E E: Directory Delete ─────────────────
  'TEST_DELETE_DIR': {
    responses: ['I will delete the directory.', 'Done.'],
    toolCalls: [
      [
        { id: 'tc-e-del', name: 'delete_file', args: { path: 'foo' } },
      ],
      [], // Round 1: final response
    ],
  },

  // ── Agent E2E F: Stop / Late Event ────────────────
  'TEST_STOP_LATE': {
    responses: ['Starting long task.', 'Done.'],
    toolCalls: [
      [
        { id: 'tc-f-cmd', name: 'run_command', args: { command: 'echo step1' } },
        { id: 'tc-f-cmd2', name: 'run_command', args: { command: 'echo step2' } },
      ],
      [], // Round 1: final response
    ],
  },

  // ── Read-only task (no mutations) ─────────────────
  'TEST_READ_ONLY': {
    responses: ['Let me read the file.', 'Done.'],
    toolCalls: [
      [
        { id: 'tc-r-read', name: 'read_file', args: { path: 'package.json' } },
      ],
      [], // Round 1: final response
    ],
  },

  // ── Agent E2E H: Project Instructions ──────────────
  'TEST_PROJECT_INSTRUCTIONS': {
    responses: ['I see AGENTS.md. I will set description to FROM_AGENTS.', 'Done.'],
    toolCalls: [
      [
        { id: 'tc-h-edit', name: 'edit_file', args: { path: 'package.json', oldString: '"description": "Test workspace for E2E"', newString: '"description": "FROM_AGENTS"' } },
      ],
      [],
    ],
  },

  // ── Agent E2E I: Long Session Compaction ───────────
  'TEST_LONG_SESSION': {
    responses: ['Reading files.', 'Working on task.', 'Done.'],
    toolCalls: [
      [
        { id: 'tc-i-read', name: 'read_file', args: { path: 'package.json' } },
      ],
      [
        { id: 'tc-i-read2', name: 'read_file', args: { path: 'README.md' } },
      ],
      [],
    ],
  },

  // ── Agent E2E J: Constraint Survives Compaction ────
  'TEST_CONSTRAINT_SURVIVES': {
    responses: ['I remember not to modify app.js. I will edit README instead.', 'Done.'],
    toolCalls: [
      [
        { id: 'tc-j-edit', name: 'edit_file', args: { path: 'README.md', oldString: 'Version: 0.4.2', newString: 'Version: 0.5.0' } },
      ],
      [],
    ],
  },

  // ── V1.3.0 Scenario 4: Multi-step Coding Task ──────
  'TEST_MULTI_STEP': {
    responses: ['Reading target file.', 'Searching for the pattern.', 'Editing file A.', 'Editing file B.', 'Running tests.', 'All done.'],
    toolCalls: [
      [
        { id: 'tc-m-read', name: 'read_file', args: { path: 'package.json' } },
      ],
      [
        { id: 'tc-m-search', name: 'search_files', args: { pattern: 'version' } },
      ],
      [
        { id: 'tc-m-edit-a', name: 'edit_file', args: { path: 'package.json', oldString: '"version": "0.4.2"', newString: '"version": "0.4.3"' } },
      ],
      [
        { id: 'tc-m-edit-b', name: 'write_file', args: { path: 'README.md', content: '# Test Workspace\n\nVersion: 0.4.3\n' } },
      ],
      [
        { id: 'tc-m-test', name: 'run_command', args: { command: 'echo tests-passed' } },
      ],
      [],
    ],
  },

  // ── V1.3.0 Scenario 5: Failed Validation ────────────
  'TEST_FAILED_VALIDATION': {
    responses: ['I will edit and test.', 'Done.'],
    toolCalls: [
      [
        { id: 'tc-f-edit', name: 'edit_file', args: { path: 'package.json', oldString: '"version": "0.4.2"', newString: '"version": "0.4.3"' } },
        { id: 'tc-f-test', name: 'run_command', args: { command: 'false' } },
      ],
      [],
    ],
  },

  // ── V1.5.0 Scenario 6: Code Search ──────────────────
  'TEST_CODE_SEARCH': {
    responses: ['Let me search for the UserService definition.', 'Found it in services/user.js. Now let me read it.', 'The UserService class is defined in services/user.js.'],
    toolCalls: [
      [
        { id: 'tc-cs-search', name: 'search_code', args: { pattern: 'UserService', matchType: 'all' } },
      ],
      [
        { id: 'tc-cs-read', name: 'read_file', args: { path: 'services/user.js' } },
      ],
      [],
    ],
  },

  // ── V1.5.0 Scenario 7: Find Symbol ──────────────────
  'TEST_FIND_SYMBOL': {
    responses: ['I will find the UserService class definition.', 'Found it.', 'The UserService class is defined in services/user.js.'],
    toolCalls: [
      [
        { id: 'tc-fs-find', name: 'find_symbol', args: { name: 'UserService', kind: 'class' } },
      ],
      [
        { id: 'tc-fs-read', name: 'read_file', args: { path: 'services/user.js' } },
      ],
      [],
    ],
  },

  // ── V1.5.0 Scenario 8: Find References ──────────────
  'TEST_FIND_REFS': {
    responses: ['Let me find all references to UserService.', 'Found references in multiple files.', 'UserService is referenced in app.js and utils/validate.js.'],
    toolCalls: [
      [
        { id: 'tc-fr-find', name: 'find_refs', args: { name: 'UserService', definitionPath: 'services/user.js' } },
      ],
      [
        { id: 'tc-fr-read1', name: 'read_file', args: { path: 'app.js' } },
        { id: 'tc-fr-read2', name: 'read_file', args: { path: 'utils/validate.js' } },
      ],
      [],
    ],
  },

  // ── V1.5.0 Scenario 9: Bug Fix with Preflight ───────
  'Fix the bug in UserService findById': {
    responses: ['Let me understand the codebase first.', 'The bug is in findById. Let me fix it.', 'Fixed.'],
    toolCalls: [
      [
        { id: 'tc-bug-search', name: 'search_code', args: { pattern: 'UserService', matchType: 'all' } },
      ],
      [
        { id: 'tc-bug-read', name: 'read_file', args: { path: 'services/user.js' } },
      ],
      [
        { id: 'tc-bug-edit', name: 'edit_file', args: { path: 'services/user.js', oldString: 'return this.users.find(u => u.id === id) || null;', newString: 'const user = this.users.find(u => u.id === id); if (!user) return null; return user;' } },
      ],
      [],
    ],
  },

  // ── V1.5.0 Scenario 10: Create File (no preflight) ───
  'TEST_CREATE_FILE': {
    responses: ['I will create a new config file.', 'Done.'],
    toolCalls: [
      [
        { id: 'tc-cf-write', name: 'write_file', args: { path: 'config.json', content: '{}' } },
      ],
      [],
    ],
  },

  // ── V1.5.0 Scenario 11: Natural Language Bug (no identifiers) ──
  'Fix the bug in login handler': {
    responses: ['Let me search for the login handler.', 'Found it in auth.js.', 'Fixed the login bug.'],
    toolCalls: [
      [
        { id: 'tc-nl-search', name: 'search_code', args: { pattern: 'login', matchType: 'all' } },
      ],
      [
        { id: 'tc-nl-read', name: 'read_file', args: { path: 'auth.js' } },
      ],
      [],
    ],
  },

  // ── V1.5.0 Scenario 12: Chinese Bug Description ──
  '修复登录模块偶发报错': {
    responses: ['让我搜索登录模块。', '找到了 auth.js。', '修复完成。'],
    toolCalls: [
      [
        { id: 'tc-cn-search', name: 'search_code', args: { pattern: '登录', matchType: 'all' } },
      ],
      [
        { id: 'tc-cn-read', name: 'read_file', args: { path: 'auth.js' } },
      ],
      [],
    ],
  },

  // ── V1.5.0 Scenario 13: Same task with preflight DISABLED ──
  '[NO PREFLIGHT] Fix the bug in login handler': {
    responses: ['Let me look around the workspace.', 'I see auth.js and services/user.js.', 'Fixed the bug.', 'Done.'],
    toolCalls: [
      [
        { id: 'tc-np-read1', name: 'read_file', args: { path: 'auth.js' } },
      ],
      [
        { id: 'tc-np-read2', name: 'read_file', args: { path: 'services/user.js' } },
      ],
      [
        { id: 'tc-np-edit', name: 'edit_file', args: { path: 'auth.js', old: 'res.status(401)', new: 'res.status(401)' } },
      ],
      [],
    ],
  },
};