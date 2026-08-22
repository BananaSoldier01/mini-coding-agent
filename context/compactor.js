/**
 * context/compactor.js — Structured Session Summary Compactor
 *
 * V0.5.0
 * - 结构化 Summary Schema
 * - Incremental compaction（只总结新增消息）
 * - 不修改 Canonical Transcript
 * - 校验 Summary 结构
 * - Compaction 不调用 Coding Tools
 */

const SUMMARY_SCHEMA_KEYS = ['goal', 'constraints', 'decisions', 'progress', 'files', 'verification', 'openItems'];

/**
 * 构建 Compaction Prompt。
 * 只做总结已有 Context，不得决定新方向 / 执行 Tool / 修改文件。
 */
function buildCompactionPrompt(existingSummary, newMessages, compactedThrough) {
  const newContext = newMessages.map(m => {
    const parts = [];
    parts.push(`[${m.role}]`);
    if (m.content) parts.push(m.content);
    if (m.tool_calls) {
      for (const tc of m.tool_calls) {
        parts.push(`tool_call: ${tc.function.name}(${tc.function.arguments})`);
      }
    }
    if (m.tool_call_id) parts.push(`tool_result: ${m.content || ''}`);
    return parts.join(' ');
  }).join('\n');

  const existingSummaryText = existingSummary
    ? JSON.stringify(existingSummary, null, 2)
    : '(none)';

  return `You are a context compaction assistant. Your ONLY task is to produce a structured summary of the conversation below.

## Existing Summary
${existingSummaryText}

## New Messages Since Last Compaction
${newContext}

## Instructions
Produce a JSON object with these exact keys:
- "goal": array of strings — what the user wants to accomplish
- "constraints": array of strings — rules the user or project requires (e.g. "Do not modify app.js", "Use ESM only")
- "decisions": array of strings — decisions already made (e.g. "Changes use Run Net Diff")
- "progress": array of strings — what has been completed
- "files": array of strings — key files and their purpose
- "verification": array of strings — what has been verified (e.g. "npm test → PASS")
- "openItems": array of strings — what remains unresolved

Rules:
- Only preserve facts supported by the conversation.
- Do not invent decisions.
- Do not infer completed work that was not verified.
- Separate user constraints from model suggestions.
- Merge with existing summary; do not lose information from previous summary.
- If a decision was superseded, note the current decision in "decisions" and mention superseded in "progress".
- Keep each item concise (one sentence max).
- Return ONLY valid JSON, no markdown, no explanation.

Return:
{"goal": [], "constraints": [], "decisions": [], "progress": [], "files": [], "verification": [], "openItems": []}`;
}

/**
 * 校验 Summary 结构。
 * 返回 { valid, errors }
 */
function validateSummary(summary) {
  if (!summary || typeof summary !== 'object') {
    return { valid: false, errors: ['Summary is not an object'] };
  }

  const errors = [];
  for (const key of SUMMARY_SCHEMA_KEYS) {
    if (!(key in summary)) {
      errors.push(`Missing key: ${key}`);
    } else if (!Array.isArray(summary[key])) {
      errors.push(`Key "${key}" must be an array, got ${typeof summary[key]}`);
    } else {
      for (const item of summary[key]) {
        if (typeof item !== 'string') {
          errors.push(`Key "${key}" contains non-string item: ${typeof item}`);
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * 估算 Summary 大小（字符数）。
 */
function estimateSummarySize(summary) {
  return JSON.stringify(summary).length;
}

/**
 * 检查 Summary 是否需要重新 compact（去重、合并）。
 * 如果超过 SUMMARY_MAX_CHARS，返回 true。
 */
const SUMMARY_MAX_CHARS = 8000;

function summaryNeedsRecompaction(summary) {
  return estimateSummarySize(summary) > SUMMARY_MAX_CHARS;
}

/**
 * 合并两个 Summary（增量 compaction）。
 * 简单合并数组，去重。
 */
function mergeSummaries(existing, incoming) {
  if (!existing) return incoming;
  if (!incoming) return existing;

  const merged = {};
  for (const key of SUMMARY_SCHEMA_KEYS) {
    const existingItems = existing[key] || [];
    const incomingItems = incoming[key] || [];
    const seen = new Set(existingItems.map(s => s.toLowerCase()));
    merged[key] = [...existingItems];
    for (const item of incomingItems) {
      if (!seen.has(item.toLowerCase())) {
        merged[key].push(item);
        seen.add(item.toLowerCase());
      }
    }
  }
  return merged;
}

export {
  buildCompactionPrompt,
  validateSummary,
  estimateSummarySize,
  summaryNeedsRecompaction,
  mergeSummaries,
  SUMMARY_SCHEMA_KEYS,
  SUMMARY_MAX_CHARS,
};