/**
 * context/builder.js — Context Builder
 *
 * V0.5.0
 * - 统一构建 Model Context（不散落在 runAgent 里）
 * - 返回 modelMessages + contextMetadata
 * - 负责 Project Instructions / Summary / Recent Raw Turns / Current Task
 */

import { estimateContextSize, CHARS_PER_TOKEN } from './estimator.js';

// ── Context Budget ──────────────────────────────────────
const CONTEXT_BUDGET = 80000;        // estimated chars budget
const COMPACTION_TRIGGER_RATIO = 0.75; // compact at 75%
const RECENT_CONTEXT_TARGET = 0.5;    // after compaction, target ~50%
const HARD_BUDGET = 120000;           // hard limit

/**
 * 将消息数组按 Turn 分组。
 * 一个 Turn = user + assistant(tool_calls) + tool_results + assistant(final)
 */
function groupSessionTurns(messages) {
  const turns = [];
  let current = null;

  for (const msg of messages) {
    if (msg.role === 'user') {
      if (current) turns.push(current);
      current = { user: msg, assistant: [], tools: [], final: null };
    } else if (msg.role === 'assistant') {
      if (!current) {
        // orphan assistant before any user — treat as own turn
        current = { user: null, assistant: [], tools: [], final: null };
      }
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        current.assistant.push(msg);
      } else {
        current.final = msg;
      }
    } else if (msg.role === 'tool') {
      if (!current) {
        current = { user: null, assistant: [], tools: [], final: null };
      }
      current.tools.push(msg);
    }
  }
  if (current) turns.push(current);

  return turns;
}

/**
 * 将 Turn 转平为消息数组（保留 turn 边界信息）。
 */
function turnToMessages(turn) {
  const msgs = [];
  if (turn.user) msgs.push(turn.user);
  for (const a of turn.assistant) msgs.push(a);
  for (const t of turn.tools) msgs.push(t);
  if (turn.final) msgs.push(turn.final);
  return msgs;
}

/**
 * 构建 Model Context。
 *
 * opts: {
 *   systemPrompt,
 *   projectContext,   // { loaded, content, ... }
 *   session,          // Session object with .messages and .contextState
 *   currentTask,      // string
 *   compactor,        // { compact: (existing, newMessages) => Promise<summary> }
 * }
 *
 * 返回: {
 *   messages: [...],       // model-ready messages
 *   contextMetadata: {
 *     projectInstructions: {...},
 *     contextState: {...},
 *     estimatedSize: {...},
 *     compactionTriggered: bool,
 *     compactionCount: number,
 *   }
 * }
 */
async function buildAgentContext(opts) {
  const {
    systemPrompt,
    projectContext,
    session,
    currentTask,
    compactor,
  } = opts;

  const contextState = session?.contextState || {
    summary: null,
    compactedThrough: 0,
    compactionCount: 0,
    lastCompactedAt: null,
    status: 'fresh',
    sourceRange: { start: 0, end: 0 },
  };

  const allMessages = session ? session.messages : [];
  const turns = groupSessionTurns(allMessages);

  // ── Step 1: Estimate projected context size ──
  const systemAndProject = buildSystemAndProjectMessages(systemPrompt, projectContext);
  const currentTurnMsgs = [{ role: 'user', content: currentTask }];
  const projected = [...systemAndProject, ...allMessages, ...currentTurnMsgs];
  const projectedSize = estimateContextSize(projected);

  const triggerThreshold = CONTEXT_BUDGET * COMPACTION_TRIGGER_RATIO;
  let compactionTriggered = false;

  // ── Step 2: Compaction if needed ──
  if (projectedSize.estimatedTokens * CHARS_PER_TOKEN > triggerThreshold && allMessages.length > 0) {
    const compacted = await tryCompact(session, turns, contextState, compactor);
    if (compacted) {
      compactionTriggered = true;
    }
  }

  // ── Step 3: Build model messages ──
  const modelMessages = [...systemAndProject];

  // Add compacted summary as a system-level message
  if (contextState.summary) {
    modelMessages.push({
      role: 'system',
      content: `[COMPACTED SESSION CONTEXT]\n${JSON.stringify(contextState.summary, null, 2)}`,
    });
  }

  // Add recent raw turns (not yet compacted)
  const compactedThrough = contextState.compactedThrough;
  const recentTurns = turns.slice(compactedThrough);
  for (const turn of recentTurns) {
    const msgs = turnToMessages(turn);
    for (const m of msgs) {
      modelMessages.push(m);
    }
  }

  // Add current task
  modelMessages.push({ role: 'user', content: currentTask });

  // ── Step 4: Final size check ──
  const finalSize = estimateContextSize(modelMessages);

  // ── Step 5: Build metadata ──
  const contextMetadata = {
    projectInstructions: projectContext,
    contextState: {
      summary: contextState.summary,
      compactedThrough: contextState.compactedThrough,
      compactionCount: contextState.compactionCount,
      lastCompactedAt: contextState.lastCompactedAt,
      status: contextState.status,
      sourceRange: contextState.sourceRange,
    },
    estimatedSize: finalSize,
    compactionTriggered,
    budget: CONTEXT_BUDGET,
    hardBudget: HARD_BUDGET,
    usageRatio: finalSize.estimatedTokens * CHARS_PER_TOKEN / CONTEXT_BUDGET,
  };

  return { messages: modelMessages, contextMetadata };
}

/**
 * 尝试增量 Compaction。
 * 返回 true 如果 compaction 成功执行。
 */
async function tryCompact(session, turns, contextState, compactor) {
  if (!compactor) return false;

  const compactedThrough = contextState.compactedThrough;
  const newTurns = turns.slice(compactedThrough);

  if (newTurns.length === 0) return false;

  // 收集新消息（从 compactedThrough 到最后一条）
  const newMessages = [];
  for (const turn of newTurns) {
    const msgs = turnToMessages(turn);
    for (const m of msgs) newMessages.push(m);
  }

  try {
    const newSummary = await compactor.compact(contextState.summary, newMessages);
    const validation = validateSummaryInline(newSummary);
    if (!validation.valid) {
      contextState.status = 'degraded';
      return false;
    }

    // 更新 contextState
    contextState.summary = newSummary;
    contextState.compactedThrough = turns.length;
    contextState.compactionCount += 1;
    contextState.lastCompactedAt = Date.now();
    contextState.status = contextState.compactionCount > 0 ? 'compacted' : 'fresh';
    contextState.sourceRange = { start: 0, end: turns.length };

    return true;
  } catch (err) {
    contextState.status = 'degraded';
    return false;
  }
}

function validateSummaryInline(summary) {
  // inline to avoid circular import
  const keys = ['goal', 'constraints', 'decisions', 'progress', 'files', 'verification', 'openItems'];
  if (!summary || typeof summary !== 'object') return { valid: false, errors: ['not an object'] };
  const errors = [];
  for (const key of keys) {
    if (!(key in summary)) { errors.push(`Missing: ${key}`); continue; }
    if (!Array.isArray(summary[key])) { errors.push(`${key} not array`); continue; }
    for (const item of summary[key]) {
      if (typeof item !== 'string') { errors.push(`${key} non-string item`); }
    }
  }
  return { valid: errors.length === 0, errors };
}

function buildSystemAndProjectMessages(systemPrompt, projectContext) {
  const messages = [];
  messages.push({ role: 'system', content: systemPrompt });

  if (projectContext.loaded) {
    messages.push({
      role: 'system',
      content: `[PROJECT INSTRUCTIONS]\nSource: ${projectContext.source}\n${projectContext.truncated ? '(partial)' : '(complete)'}\n\n${projectContext.content}`,
    });
  }

  return messages;
}

export {
  buildAgentContext,
  groupSessionTurns,
  turnToMessages,
  CONTEXT_BUDGET,
  COMPACTION_TRIGGER_RATIO,
  RECENT_CONTEXT_TARGET,
  HARD_BUDGET,
};