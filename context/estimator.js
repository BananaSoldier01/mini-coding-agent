/**
 * context/estimator.js — Context Size Estimator
 *
 * V0.5.0
 * - Conservative character-based estimator（不依赖 tokenizer）
 * - 明确是 estimate，UI 不显示虚假精确 token 数
 */

// Conservative: ~4 chars per token for English/Chinese mixed content
const CHARS_PER_TOKEN = 4;

/**
 * 估算消息数组的 context 大小。
 * 返回 { chars, estimatedTokens, messageCount }
 */
function estimateContextSize(messages) {
  let chars = 0;
  for (const m of messages) {
    if (m.content && typeof m.content === 'string') {
      chars += m.content.length;
    }
    // tool_calls 的 arguments 也计入
    if (m.tool_calls) {
      for (const tc of m.tool_calls) {
        if (tc.function?.arguments) chars += tc.function.arguments.length;
        if (tc.function?.name) chars += tc.function.name.length;
      }
    }
    // tool message
    if (m.tool_call_id && m.content) {
      // already counted above
    }
  }
  return {
    chars,
    estimatedTokens: Math.ceil(chars / CHARS_PER_TOKEN),
    messageCount: messages.length,
  };
}

/**
 * 返回人类可读的 context 使用描述（不制造假精度）。
 */
function formatContextUsage(usage, budget) {
  const ratio = budget > 0 ? usage.estimatedTokens / budget : 0;
  const pct = Math.round(ratio * 100);
  return `~${pct}%`;
}

export { estimateContextSize, formatContextUsage, CHARS_PER_TOKEN };