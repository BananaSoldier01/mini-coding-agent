/**
 * fake-llm.js — Deterministic Test LLM Provider
 *
 * 仅用于 Browser E2E 测试。根据固定 Task 返回固定 tool_calls 序列。
 * 不暴露为产品 Feature。
 */

export function createFakeProvider(scenarios) {
  return {
    name: 'fake',
    async stream({ messages, signal }, onToken, onToolCall) {
      const lastUser = messages.filter(m => m.role === 'user').pop();
      const task = lastUser?.content || '';

      // Find matching scenario
      const scenario = scenarios[task];
      if (!scenario) {
        // Default: just respond with text
        onToken(`I don't know how to "${task.slice(0, 40)}…"`);
        return { content: `I don't know how to "${task}..."`, toolCalls: [] };
      }

      // Stream response text
      if (scenario.response) {
        for (const ch of scenario.response) {
          onToken(ch);
          await new Promise(r => setTimeout(r, 5));
        }
      }

      // Emit tool calls
      const toolCalls = [];
      if (scenario.toolCalls) {
        for (const tc of scenario.toolCalls) {
          onToolCall(tc);
          toolCalls.push(tc);
          await new Promise(r => setTimeout(r, 10));
        }
      }

      return {
        content: scenario.response || '',
        toolCalls,
      };
    },
  };
}

// ── Pre-built E2E Scenarios ──────────────────────────

export const E2E_SCENARIOS = {
  'TEST_EDIT_FILE': {
    response: 'I will edit the file for you.',
    toolCalls: [
      { id: 'tc-e2e-1', name: 'read_file', args: { path: 'package.json' } },
      { id: 'tc-e2e-2', name: 'edit_file', args: { path: 'package.json', oldText: '"version"', newText: '"version"' } },
      { id: 'tc-e2e-3', name: 'run_command', args: { command: 'echo done' } },
    ],
  },
  'TEST_DELETE_FILE': {
    response: 'I will delete the directory.',
    toolCalls: [
      { id: 'tc-e2e-d1', name: 'delete_file', args: { path: 'foo' } },
    ],
  },
  'TEST_READ_ONLY': {
    response: 'Let me read the file.',
    toolCalls: [
      { id: 'tc-e2e-r1', name: 'read_file', args: { path: 'package.json' } },
    ],
  },
};