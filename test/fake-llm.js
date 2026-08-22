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
};