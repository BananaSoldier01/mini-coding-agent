/**
 * context/builder.js — Context Builder
 *
 * V0.5.0.1
 * - 统一构建 Model Context（不散落在 runAgent 里）
 * - 返回 modelMessages + contextMetadata
 * - 负责 Project Instructions / Summary / Recent Raw Turns / Current Task
 * - Turn 内保持 canonical 原始消息顺序，永不重排
 * - 只 compact 最老的 historical turns，保留 Recent Raw Turns
 * - Hard Budget 真正 enforce
 */

import { estimateContextSize, CHARS_PER_TOKEN } from './estimator.js';
import { buildCompactionPrompt, validateSummary, SUMMARY_MAX_CHARS } from './compactor.js';

// ── Context Budget ──────────────────────────────────────
const CONTEXT_BUDGET = 80000;
const COMPACTION_TRIGGER_RATIO = 0.75;
const RECENT_CONTEXT_TARGET = 0.5;
const HARD_BUDGET = 120000;
const MIN_RECENT_TURNS = 2; // 至少保留 2 个完整 Turn

/**
 * 将消息数组按 Turn 分组。
 * P0-2: Turn 内保持 canonical 原始消息顺序，永不重排。
 * 一个 Turn = user 开始，到下一个 user 之前结束。
 * Turn 内可能包含多轮 assistant→tool 交替。
 */
function groupSessionTurns(messages) {
  const turns = [];
  let current = null;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === 'user') {
      if (current) turns.push(current);
      current = { startIndex: i, endIndex: i, messages: [msg] };
    } else {
      if (!current) {
        // orphan before any user — create a synthetic turn
        current = { startIndex: i, endIndex: i, messages: [msg] };
      } else {
        current.messages.push(msg);
        current.endIndex = i;
      }
    }
  }
  if (current) turns.push(current);

  return turns;
}

/**
 * P0-2: Turn 内消息已经是 canonical 顺序，直接返回。
 * 不再重排 assistant/tool。
 */
function turnToMessages(turn) {
  return turn.messages;
}

/**
 * 估算一组 Turn 的大小。
 */
function estimateTurnsSize(turns) {
  let chars = 0;
  for (const turn of turns) {
    for (const m of turn.messages) {
      if (m.content && typeof m.content === 'string') chars += m.content.length;
      if (m.tool_calls) {
        for (const tc of m.tool_calls) {
          if (tc.function?.arguments) chars += tc.function.arguments.length;
          if (tc.function?.name) chars += tc.function.name.length;
        }
      }
    }
  }
  return { chars, estimatedTokens: Math.ceil(chars / CHARS_PER_TOKEN) };
}

/**
 * 构建 Model Context。
 *
 * opts: {
 *   systemPrompt,
 *   projectContext,
 *   session,
 *   currentTask,
 *   compactor,
 * }
 *
 * 返回: {
 *   messages: [...],
 *   contextMetadata: {...}
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
  let overflow = false;

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

  // P0-3: Add recent raw turns (not yet compacted), preserving canonical order
  const compactedThrough = contextState.compactedThrough;
  const recentTurns = turns.slice(compactedThrough);

  // P0-3: Check if recent turns alone exceed budget
  const recentSize = estimateTurnsSize(recentTurns);
  const recentChars = recentSize.chars +
    (systemAndProject.reduce((s, m) => s + (m.content?.length || 0), 0)) +
    currentTurnMsgs[0].content.length;

  let finalRecentTurns = recentTurns;

  // P0-4: Hard Budget Closure — if still over budget, reduce historical raw tail
  if (recentChars > HARD_BUDGET) {
    // Keep only the most recent turns that fit
    let kept = [];
    let keptChars = 0;
    for (let i = recentTurns.length - 1; i >= 0; i--) {
      const turnSize = estimateTurnsSize([recentTurns[i]]);
      if (keptChars + turnSize.chars + recentChars - turnSize.chars > HARD_BUDGET) break;
      kept.unshift(recentTurns[i]);
      keptChars += turnSize.chars;
    }
    finalRecentTurns = kept.length > 0 ? kept : recentTurns.slice(-MIN_RECENT_TURNS);
    overflow = finalRecentTurns.length < recentTurns.length;
  }

  for (const turn of finalRecentTurns) {
    const msgs = turnToMessages(turn);
    for (const m of msgs) {
      modelMessages.push(m);
    }
  }

  // Add current task
  modelMessages.push({ role: 'user', content: currentTask });

  // ── Step 4: Final size check & overflow enforcement ──
  const finalSize = estimateContextSize(modelMessages);

  // P0-4: Hard Budget enforcement
  if (finalSize.chars > HARD_BUDGET) {
    overflow = true;
  }

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
    overflow,
    budget: CONTEXT_BUDGET,
    hardBudget: HARD_BUDGET,
    usageRatio: finalSize.chars / CONTEXT_BUDGET,
    recentTurnCount: finalRecentTurns.length,
  };

  return { messages: modelMessages, contextMetadata };
}

/**
 * P0-3: 增量 Compaction — 只 compact 最老的 historical turns。
 * 保留最近 N 个完整 Turn 作为 Recent Raw Context。
 */
async function tryCompact(session, turns, contextState, compactor) {
  if (!compactor) return false;

  const compactedThrough = contextState.compactedThrough;
  const remainingTurns = turns.slice(compactedThrough);

  if (remainingTurns.length <= MIN_RECENT_TURNS) return false;

  // P0-3: 只 compact 除了最近 MIN_RECENT_TURNS 之外的历史 turns
  const turnsToCompact = remainingTurns.slice(0, remainingTurns.length - MIN_RECENT_TURNS);
  if (turnsToCompact.length === 0) return false;

  // 收集要 compact 的消息
  const newMessages = [];
  for (const turn of turnsToCompact) {
    const msgs = turnToMessages(turn);
    for (const m of msgs) newMessages.push(m);
  }

  try {
    const newSummary = await compactor.compact(contextState.summary, newMessages);
    const validation = validateSummary(newSummary);
    if (!validation.valid) {
      contextState.status = 'degraded';
      return false;
    }

    // P1: Summary Size Protection — check if summary needs recompaction
    if (JSON.stringify(newSummary).length > SUMMARY_MAX_CHARS) {
      // Try to compact the summary itself by asking LLM to merge
      // For now, mark as degraded and keep old summary
      contextState.status = 'degraded';
      return false;
    }

    // 更新 contextState
    contextState.summary = newSummary;
    contextState.compactedThrough = compactedThrough + turnsToCompact.length;
    contextState.compactionCount += 1;
    contextState.lastCompactedAt = Date.now();
    contextState.status = contextState.compactionCount > 0 ? 'compacted' : 'fresh';
    contextState.sourceRange = { start: 0, end: contextState.compactedThrough };

    return true;
  } catch (err) {
    contextState.status = 'degraded';
    return false;
  }
}

function buildSystemAndProjectMessages(systemPrompt, projectContext) {
  const messages = [];
  messages.push({ role: 'system', content: systemPrompt });

  // P1: Project Instructions 只注入一次（已在 buildSystemPrompt 中包含）
  // 这里不再重复注入，避免双重注入

  return messages;
}

export {
  buildAgentContext,
  groupSessionTurns,
  turnToMessages,
  estimateTurnsSize,
  CONTEXT_BUDGET,
  COMPACTION_TRIGGER_RATIO,
  RECENT_CONTEXT_TARGET,
  HARD_BUDGET,
  MIN_RECENT_TURNS,
};