/**
 * agent/index.js — Agent Loop 核心编排器
 *
 * V0.3 重构：
 * - 使用 WorkspaceFileService 统一文件访问
 * - 使用 capability-based Shell Policy
 * - Session Transcript 作为唯一真相源
 * - Run-scoped Approval
 * - Run Net Diff
 */

import { createProvider } from './LLM.js';
import { FileTools } from '../tools/file.js';
import { shellToolDef } from '../tools/shell.js';
import { ChangeTracker, NON_EXISTENT } from '../tracker.js';
import { Sandbox } from '../sandbox.js';
import { registry as approvalRegistry } from '../approval.js';
import { evaluate } from '../policy.js';
import { evaluateShell } from '../shellpolicy.js';
import { mergePermission } from '../permission.js';
import { RunStatus, RUN_STATUS } from '../runstatus.js';
import { buildAgentContext, CONTEXT_BUDGET, COMPACTION_TRIGGER_RATIO, HARD_BUDGET } from '../context/builder.js';
import { estimateContextSize } from '../context/estimator.js';
import { createPlan, validatePlan, transitionPlanStatus, PLAN_STATUS, PLAN_TRANSITIONS, EXECUTION_MODE, buildPlanPrompt, formatPlanForApproval } from './plan.js';

const MAX_ITERATIONS = 20;
const MAX_TOOL_OUTPUT_CHARS = 4000;

const TOOL_DESCS = {
  list_directory: '列出 workspace 中某个目录的内容，返回树状结构。',
  read_file: '读取文件内容。支持 startLine/endLine 范围读取，大文件可分段读取。',
  write_file: '创建或覆盖文件。',
  edit_file: '精确修改文件中的一段内容。oldString 必须唯一。',
  search_files: '搜索文件内容，支持正则。',
  delete_file: '删除文件或目录。危险操作，需要用户确认。',
  run_command: '在 workspace 内执行 shell 命令。安全命令自动执行，未知命令需要用户确认。',
};

const TOOL_SCHEMAS = {
  list_directory: { type: 'object', properties: { path: { type: 'string' } }, required: [] },
  read_file: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      startLine: { type: 'number' },
      endLine: { type: 'number' },
      offset: { type: 'number' },
      limit: { type: 'number' },
    },
    required: ['path'],
  },
  write_file: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
  edit_file: { type: 'object', properties: { path: { type: 'string' }, oldString: { type: 'string' }, newString: { type: 'string' } }, required: ['path', 'oldString', 'newString'] },
  search_files: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' }, maxResults: { type: 'number' } }, required: ['pattern'] },
  delete_file: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  run_command: { type: 'object', properties: { command: { type: 'string' }, timeout: { type: 'number' }, cwd: { type: 'string' } }, required: ['command'] },
};

async function runAgent(opts) {
  const { task, workspace, config, session, run, onEvent, signals, provider, projectContext, contextBuilder } = opts;
  const sandbox = new Sandbox(workspace);
  const tracker = new ChangeTracker();
  const providerInstance = provider || createProvider(config);
  const fileTools = new FileTools(workspace);

  const toolDefs = [
    { name: 'list_directory', description: TOOL_DESCS.list_directory, input_schema: TOOL_SCHEMAS.list_directory },
    { name: 'read_file', description: TOOL_DESCS.read_file, input_schema: TOOL_SCHEMAS.read_file },
    { name: 'write_file', description: TOOL_DESCS.write_file, input_schema: TOOL_SCHEMAS.write_file },
    { name: 'edit_file', description: TOOL_DESCS.edit_file, input_schema: TOOL_SCHEMAS.edit_file },
    { name: 'search_files', description: TOOL_DESCS.search_files, input_schema: TOOL_SCHEMAS.search_files },
    { name: 'delete_file', description: TOOL_DESCS.delete_file, input_schema: TOOL_SCHEMAS.delete_file, dangerous: true },
    { name: 'run_command', description: TOOL_DESCS.run_command, input_schema: TOOL_SCHEMAS.run_command },
  ];

  const toolMap = new Map(toolDefs.map((t) => [t.name, t]));

  const systemPrompt = buildSystemPrompt(sandbox, projectContext);

  // ── V0.5.0: 使用 ContextBuilder 构建 Model Context ──
  // Compactor: 调用 LLM 做结构化摘要（不调用 Coding Tools）
  const compactor = providerInstance ? {
    compact: async (existingSummary, newMessages) => {
      const { buildCompactionPrompt } = await import('../context/compactor.js');
      const prompt = buildCompactionPrompt(existingSummary, newMessages, 0);
      const result = await providerInstance.chatSimple(prompt);
      let summary;
      try {
        summary = JSON.parse(result);
      } catch {
        // 尝试提取 JSON 块
        const match = result.match(/\{[\s\S]*\}/);
        if (match) {
          try { summary = JSON.parse(match[0]); } catch { summary = null; }
        } else {
          summary = null;
        }
      }
      return summary;
    },
  } : null;

  // P0-5.0.2: 提前初始化 turnMessages，避免 overflow 分支 TDZ
  const turnMessages = [];
  turnMessages.push({ role: 'user', content: task });

  const { messages: modelMessages, contextMetadata } = await buildAgentContext({
    systemPrompt,
    projectContext,
    session,
    currentTask: task,
    compactor,
    contextBuilder,
  });

  // Emit context events
  if (contextMetadata.compactionTriggered) {
    emit(onEvent, {
      type: 'context_compacted',
      compactionCount: contextMetadata.contextState.compactionCount,
      compactedThrough: contextMetadata.contextState.compactedThrough,
      summary: contextMetadata.contextState.summary,
      status: contextMetadata.contextState.status,
      lastCompactedAt: contextMetadata.contextState.lastCompactedAt,
    });
  }

  if (contextMetadata.contextState.status === 'degraded') {
    emit(onEvent, {
      type: 'context_warning',
      message: 'Compaction 失败，已回退到原始历史上下文',
      contextState: contextMetadata.contextState,
    });
  }

  // P0-4: Hard Budget Closure — overflow 时不能继续调用 LLM
  if (contextMetadata.overflow) {
    emit(onEvent, {
      type: 'context_overflow',
      message: `Context 超过 Hard Budget (${contextMetadata.estimatedSize.chars} chars)，无法继续执行。请开启新 Session 或减少历史上下文。`,
      estimatedSize: contextMetadata.estimatedSize,
      hardBudget: contextMetadata.hardBudget,
    });
    return {
      messages: turnMessages,
      changes: { files: [], totalChanges: 0 },
      finalContent: '',
      iteration: 0,
      stopped: false,
      contextMetadata,
      error: 'context_overflow',
    };
  }

  // ── V0.5.1.1: Plan Mode ──────────────────────────────────
  const planMode = opts.planMode || false;
  const executionMode = opts.executionMode || EXECUTION_MODE.PLAN_EXECUTE;
  let activePlan = null;

  if (planMode) {
    // 生成计划
    const planPrompt = buildPlanPrompt(task, projectContext, {
      summary: contextMetadata.contextState.summary,
      status: contextMetadata.contextState.status,
    });

    try {
      const planResult = await providerInstance.chatSimple(planPrompt);
      let planData;
      try {
        planData = JSON.parse(planResult);
      } catch {
        const match = planResult.match(/\{[\s\S]*\}/);
        if (match) {
          try { planData = JSON.parse(match[0]); } catch { planData = null; }
        }
      }

      if (planData) {
        activePlan = createPlan({
          goal: planData.goal,
          steps: planData.steps,
          risks: planData.risks,
          files: planData.files,
          context: { estimatedChanges: planData.estimatedChanges },
          runId: run?.runId || null,
          executionMode,
        });

        const validation = validatePlan(activePlan);
        if (validation.valid) {
          session.planState = activePlan;

          // DRAFT → AWAITING_APPROVAL
          transitionPlanStatus(activePlan, PLAN_STATUS.AWAITING_APPROVAL);
          session.planState = activePlan;

          emit(onEvent, {
            type: 'plan_generated',
            plan: {
              id: activePlan.id,
              runId: activePlan.runId,
              goal: activePlan.goal,
              steps: activePlan.steps,
              risks: activePlan.risks,
              files: activePlan.files,
              estimatedChanges: activePlan.context.estimatedChanges,
              executionMode: activePlan.executionMode,
              status: activePlan.status,
            },
          });

          // plan-only 模式：不等待审批，直接结束
          if (executionMode === EXECUTION_MODE.PLAN_ONLY) {
            emit(onEvent, {
              type: 'plan_completed',
              planId: activePlan.id,
              message: '计划已生成（仅查看模式，未执行）',
            });
            return {
              messages: turnMessages,
              changes: { files: [], totalChanges: 0 },
              finalContent: formatPlanForApproval(activePlan),
              iteration: 0,
              stopped: false,
              plan: activePlan,
            };
          }

          // 等待用户审批计划
          runStatus.transition(RUN_STATUS.WAITING_APPROVAL, 'plan');
          emit(onEvent, {
            type: 'status',
            status: runStatus.status,
            label: runStatus.label,
            detail: 'plan',
          });

          const approved = await approvalRegistry.register(run?.runId || 'default', `plan_${activePlan.id}`);

          if (!approved) {
            // AWAITING_APPROVAL → REJECTED
            transitionPlanStatus(activePlan, PLAN_STATUS.REJECTED);
            session.planState = activePlan;
            emit(onEvent, { type: 'plan_rejected', planId: activePlan.id, status: activePlan.status });
            emit(onEvent, {
              type: 'error',
              message: '计划被用户拒绝',
            });
            return {
              messages: turnMessages,
              changes: { files: [], totalChanges: 0 },
              finalContent: '计划已被拒绝。',
              iteration: 0,
              stopped: false,
              plan: activePlan,
            };
          }

          // AWAITING_APPROVAL → APPROVED
          transitionPlanStatus(activePlan, PLAN_STATUS.APPROVED);
          session.planState = activePlan;
          emit(onEvent, { type: 'plan_approved', planId: activePlan.id, status: activePlan.status });
        } else {
          // P0-5.1.1: Plan Mode 下不允许静默 fallback
          emit(onEvent, {
            type: 'error',
            message: '计划生成失败：' + validation.errors.join('; ') + '。Plan Mode 下不允许直接执行。',
          });
          return {
            messages: turnMessages,
            changes: { files: [], totalChanges: 0 },
            finalContent: '计划生成失败，无法继续。',
            iteration: 0,
            stopped: false,
            plan: activePlan,
            error: 'plan_validation_failed',
          };
        }
      } else {
        // P0-5.1.1: Plan Mode 下不允许静默 fallback
        emit(onEvent, {
          type: 'error',
          message: '无法从 LLM 响应中解析计划。Plan Mode 下不允许直接执行。',
        });
        return {
          messages: turnMessages,
          changes: { files: [], totalChanges: 0 },
          finalContent: '计划生成失败，无法继续。',
          iteration: 0,
          stopped: false,
          plan: null,
          error: 'plan_parse_failed',
        };
      }
    } catch (err) {
      // P0-5.1.1: Plan Mode 下不允许静默 fallback
      emit(onEvent, {
        type: 'error',
        message: '计划生成失败: ' + err.message + '。Plan Mode 下不允许直接执行。',
      });
      return {
        messages: turnMessages,
        changes: { files: [], totalChanges: 0 },
        finalContent: '计划生成失败，无法继续。',
        iteration: 0,
        stopped: false,
        plan: null,
        error: 'plan_generation_failed',
      };
    }
  }

  // 从 modelMessages 中提取本轮新增的 assistant/tool 消息
  let messages = [...modelMessages];

  let iteration = 0;
  let finalContent = '';
  let stopped = false;

  // V0.4.0: Run Status
  const runStatus = new RunStatus();
  runStatus.transition(RUN_STATUS.THINKING);

  while (iteration < MAX_ITERATIONS) {
    iteration++;

    if (run?.isStopped() || signals?.signal?.aborted) {
      stopped = true;
      runStatus.transition(RUN_STATUS.CANCELLED);
      emit(onEvent, { type: 'status', status: runStatus.status, label: runStatus.label });
      emit(onEvent, { type: 'error', message: '任务被用户取消' });
      break;
    }

    // ── 每轮 LLM 前检查 Context Pressure ──
    const currentSize = estimateContextSize(messages);
    if (currentSize.chars > CONTEXT_BUDGET * 1.2) {
      emit(onEvent, {
        type: 'context_warning',
        message: `Context 压力过大 (~${Math.round(currentSize.chars / CONTEXT_BUDGET * 100)}%)`,
        estimatedSize: currentSize,
      });
    }

    // P0-4: Hard Budget — 超过硬限制则不调用 LLM
    if (currentSize.chars > HARD_BUDGET) {
      emit(onEvent, {
        type: 'context_overflow',
        message: `Context 超过 Hard Budget (${currentSize.chars} chars)，当前轮无法继续。`,
        estimatedSize: currentSize,
        hardBudget: HARD_BUDGET,
      });
      runStatus.transition(RUN_STATUS.FAILED, 'context_overflow');
      emit(onEvent, { type: 'status', status: runStatus.status, label: runStatus.label });
      break;
    }

    emit(onEvent, { type: 'iteration', iteration, max: MAX_ITERATIONS });

    let assistantMsg;
    try {
      assistantMsg = await callLLMStream(providerInstance, messages, toolDefs, onEvent, signals);
    } catch (err) {
      if (run?.isStopped() || err.name === 'AbortError') {
        stopped = true;
        runStatus.transition(RUN_STATUS.CANCELLED);
        emit(onEvent, { type: 'status', status: runStatus.status, label: runStatus.label });
        emit(onEvent, { type: 'error', message: '任务被用户取消' });
        break;
      }
      runStatus.transition(RUN_STATUS.FAILED, 'llm_error');
      emit(onEvent, { type: 'status', status: runStatus.status, label: runStatus.label });
      emit(onEvent, { type: 'error', message: `LLM 调用失败: ${err.message}` });
      break;
    }

    if (assistantMsg.tool_calls && assistantMsg.tool_calls.length > 0) {
      // 将 assistant 消息加入上下文（保持为一个消息）
      messages.push(assistantMsg);
      turnMessages.push(assistantMsg);

      for (const tc of assistantMsg.tool_calls) {
        if (run?.isStopped() || signals?.signal?.aborted) {
          stopped = true;
          emit(onEvent, { type: 'error', message: '任务被用户取消' });
          break;
        }

        const toolName = tc.function.name;
        let args;
        try { args = JSON.parse(tc.function.arguments); } catch { args = {}; }

        // ── Policy 评估（Base Policy 始终执行 → Permission Mode 合并）──
        const mode = session?.permissionMode || 'standard';

        // ── Step 1: Base Policy 始终执行 ─────────────────
        let baseDecision, baseCategory, baseReason;
        if (toolName === 'run_command') {
          const shellResult = evaluateShell(args.command || '');
          baseDecision = shellResult.decision;
          baseCategory = shellResult.category;
          baseReason = shellResult.reason;
        } else {
          const toolDef = toolMap.get(toolName);
          if (!toolDef) {
            emit(onEvent, {
              type: 'tool_result',
              toolCall: { id: tc.id, name: toolName, args },
              result: { error: `未知工具: ${toolName}` },
            });
            messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ error: `未知工具: ${toolName}` }) });
            turnMessages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ error: `未知工具: ${toolName}` }) });
            continue;
          }
          const policyResult = evaluate(toolDef, args, { sandbox, tracker, workspace, run });
          baseDecision = policyResult.decision;
          baseCategory = policyResult.category;
          baseReason = policyResult.reason;
        }

        // ── Step 2: Permission Mode 合并 Base Policy ────
        const finalDecision = mergePermission({ mode, baseDecision, baseCategory, toolName });

        // Hard Deny 不可被 Mode 覆盖
        if (finalDecision === 'deny') {
          emit(onEvent, {
            type: 'tool_result',
            toolCall: { id: tc.id, name: toolName, args },
            result: { error: baseReason || `拒绝执行: ${baseCategory}`, denied: true },
          });
          messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ error: baseReason || `拒绝执行: ${baseCategory}` }) });
          turnMessages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ error: baseReason || `拒绝执行: ${baseCategory}` }) });
          continue;
        }

        // 构造最终 policyResult
        const policyResult = {
          decision: finalDecision,
          category: baseCategory,
          reason: finalDecision === 'requireApproval' ? (baseReason || '需要用户确认') : '',
        };

        emit(onEvent, {
          type: 'tool_call',
          toolCall: { id: tc.id, name: toolName, args },
          policy: policyResult.decision,
          category: policyResult.category,
          planId: activePlan ? activePlan.id : null,
        });

        // P0: Plan ↔ Execution Binding
        if (activePlan) {
          const { bindToolCall, transitionPlanStatus, PLAN_STATUS, detectPlanDrift } = await import('./plan.js');
          bindToolCall(activePlan, run?.runId || activePlan.runId, tc.id, toolName, args);

          // APPROVED → EXECUTING on first tool execution
          if (activePlan.status === PLAN_STATUS.APPROVED) {
            transitionPlanStatus(activePlan, PLAN_STATUS.EXECUTING);
            session.planState = activePlan;
            emit(onEvent, { type: 'plan_executing', planId: activePlan.id, status: activePlan.status });
          }

          // V0.5.2: Emit step status update
          const updatedSteps = activePlan.steps.filter(s => s.status === 'running' || s.status === 'completed');
          if (updatedSteps.length > 0) {
            emit(onEvent, {
              type: 'plan_step_update',
              planId: activePlan.id,
              steps: activePlan.steps.map(s => ({
                id: s.id,
                status: s.status,
                completedAt: s.completedAt,
              })),
            });
          }
        }

        // 更新 Run Status
        const newStatus = runStatus.inferFromTool(toolName);
        if (newStatus !== runStatus.status) {
          runStatus.transition(newStatus, toolName);
          emit(onEvent, { type: 'status', status: runStatus.status, label: runStatus.label, detail: toolName });
        }

        if (policyResult.decision === 'deny') {
          emit(onEvent, {
            type: 'tool_result',
            toolCall: { id: tc.id, name: toolName, args },
            result: { error: `拒绝执行: ${policyResult.reason}`, denied: true },
          });
          messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ error: `拒绝执行: ${policyResult.reason}` }) });
          turnMessages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ error: `拒绝执行: ${policyResult.reason}` }) });
          continue;
        }

        if (policyResult.decision === 'requireApproval') {
          runStatus.transition(RUN_STATUS.WAITING_APPROVAL, toolName);
          emit(onEvent, { type: 'status', status: runStatus.status, label: runStatus.label, detail: toolName });
          emit(onEvent, {
            type: 'approval_needed',
            toolCall: { id: tc.id, name: toolName, args },
            reason: policyResult.reason,
            category: policyResult.category,
            runId: run?.runId,
            permissionMode: session?.permissionMode,
          });

          run?.setPendingApproval(tc.id);
          const approved = await approvalRegistry.register(run?.runId || 'default', tc.id);
          run?.clearPendingApproval();

          // Approval 后恢复到对应 tool 的状态
          const postApprovalStatus = runStatus.inferFromTool(toolName);
          runStatus.transition(postApprovalStatus, toolName);
          emit(onEvent, { type: 'status', status: runStatus.status, label: runStatus.label, detail: toolName });

          if (!approved) {
            emit(onEvent, {
              type: 'tool_result',
              toolCall: { id: tc.id, name: toolName, args },
              result: { error: '用户拒绝执行', cancelled: true },
            });
            messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ error: '用户拒绝执行' }) });
            turnMessages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ error: '用户拒绝执行' }) });
            continue;
          }
        }

        // ── 执行工具 ────────────────────────────────
        let result;
        try {
          if (toolName === 'run_command') {
            result = await shellToolDef.run_command.execute(args, { sandbox, tracker, workspace, run });
          } else {
            const method = {
              list_directory: fileTools.listDirectory.bind(fileTools),
              read_file: fileTools.readFile.bind(fileTools),
              write_file: fileTools.writeFile.bind(fileTools),
              edit_file: fileTools.editFile.bind(fileTools),
              search_files: fileTools.searchFiles.bind(fileTools),
              delete_file: fileTools.deleteFile.bind(fileTools),
            }[toolName];
            if (!method) {
              result = { error: `工具未实现: ${toolName}` };
            } else {
              result = await method(args);
            }
          }

          // 记录变更到 tracker（使用真实 before/after 内容）
          if (result.path && (toolName === 'write_file' || toolName === 'edit_file' || toolName === 'delete_file')) {
            tracker.record({
              type: toolName === 'write_file' ? (result.action === 'created' ? 'create' : 'modify')
                : toolName === 'delete_file' ? 'delete' : 'modify',
              path: result.path,
              oldContent: result.before,
              newContent: result.after,
            });
            // 目录删除：记录子文件（使用真实 before content）
            if (result.deletedFiles && result.deletedFiles.length > 0) {
              for (const sub of result.deletedFiles) {
                tracker.record({
                  type: 'delete',
                  path: sub.path,
                  oldContent: sub.before,
                  newContent: NON_EXISTENT,
                });
              }
            }
          }
        } catch (err) {
          result = { error: err.message };
          // P0-5.1.1: tool error → plan FAILED
          if (activePlan && (activePlan.status === PLAN_STATUS.EXUTING || activePlan.status === PLAN_STATUS.APPROVED)) {
            const { transitionPlanStatus, PLAN_STATUS } = await import('./plan.js');
            transitionPlanStatus(activePlan, PLAN_STATUS.FAILED);
            session.planState = activePlan;
            emit(onEvent, { type: 'plan_failed', planId: activePlan.id, status: activePlan.status, error: err.message });
          }
        }

        // 截断过大的 tool output
        const resultStr = JSON.stringify(result);
        const truncated = resultStr.length > MAX_TOOL_OUTPUT_CHARS;
        const finalResult = truncated
          ? { ...result, _truncated: true, _originalLength: resultStr.length }
          : result;

        emit(onEvent, {
          type: 'tool_result',
          toolCall: { id: tc.id, name: toolName, args },
          result: finalResult,
        });

        // 记录 command 结果（用于 Completion Summary verification evidence）
        if (toolName === 'run_command' && finalResult) {
          emit(onEvent, {
            type: 'command_result',
            command: finalResult.command,
            exitCode: finalResult.exitCode,
            duration: finalResult.duration,
            stopped: finalResult.stopped,
            timedOut: finalResult.timedOut,
            terminationReason: finalResult.terminationReason,
          });
        }

        const toolContent = truncated
          ? resultStr.slice(0, MAX_TOOL_OUTPUT_CHARS) + '\n...[输出已截断]'
          : resultStr;
        messages.push({ role: 'tool', tool_call_id: tc.id, content: toolContent });
        turnMessages.push({ role: 'tool', tool_call_id: tc.id, content: toolContent });
      }

      if (stopped) break;
    } else {
      finalContent = assistantMsg.content || '';
      // 将最终 assistant 消息加入 canonical transcript
      const finalAssistantMsg = { role: 'assistant', content: finalContent };
      messages.push(finalAssistantMsg);
      turnMessages.push(finalAssistantMsg);
      // 不要自动伪造 Verifying：没有真实 verification action 就直接 Completed
      runStatus.transition(RUN_STATUS.COMPLETED);
      emit(onEvent, { type: 'status', status: runStatus.status, label: runStatus.label });
      emit(onEvent, { type: 'done', content: finalContent, iteration });
      break;
    }
  }

  if (iteration >= MAX_ITERATIONS && !finalContent && !stopped) {
    runStatus.transition(RUN_STATUS.FAILED, 'max_iterations');
    emit(onEvent, { type: 'status', status: runStatus.status, label: runStatus.label });
    emit(onEvent, { type: 'error', message: `已达到最大迭代次数 (${MAX_ITERATIONS})` });
  }

  // ── V0.5.1.1: Plan Lifecycle Closure ──────────────────
  if (activePlan) {
    const { transitionPlanStatus, PLAN_STATUS, detectPlanDrift } = await import('./plan.js');

    if (stopped) {
      transitionPlanStatus(activePlan, PLAN_STATUS.CANCELLED);
    } else if (runStatus.status === RUN_STATUS.FAILED || contextMetadata.overflow) {
      transitionPlanStatus(activePlan, PLAN_STATUS.FAILED);
    } else if (activePlan.status === PLAN_STATUS.APPROVED || activePlan.status === PLAN_STATUS.EXECUTING) {
      transitionPlanStatus(activePlan, PLAN_STATUS.COMPLETED);
    }

    // V0.5.2: Plan Drift Detection
    const actualFiles = [...new Set(
      activePlan.toolCallBindings
        .filter(b => b.toolName === 'write_file' || b.toolName === 'edit_file' || b.toolName === 'delete_file')
        .map(b => b.args?.path || b.args?.file)
        .filter(Boolean)
    )];
    const drift = detectPlanDrift(activePlan, actualFiles);
    if (drift.drift) {
      emit(onEvent, {
        type: 'plan_drift',
        planId: activePlan.id,
        unexpected: drift.unexpected,
        missing: drift.missing,
      });
    }

    session.planState = activePlan;
    emit(onEvent, {
      type: 'plan_completed',
      planId: activePlan.id,
      status: activePlan.status,
      toolCallCount: activePlan.toolCallBindings.length,
      steps: activePlan.steps.map(s => ({
        id: s.id,
        status: s.status,
        completedAt: s.completedAt,
      })),
    });
  }

  // 计算净变更
  const netDiff = tracker.getNetDiff();

  // 返回本轮消息（turnMessages），不含旧 session 消息和 system prompt
  return {
    messages: turnMessages,
    changes: netDiff,
    finalContent,
    iteration,
    stopped,
    contextMetadata,
    plan: activePlan,
  };
}

async function callLLMStream(provider, messages, toolDefs, onEvent, signals) {
  const stream = await provider.chatStream({
    messages,
    tools: toolDefs.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.input_schema },
    })),
    signal: signals?.signal,
  });

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let toolCalls = [];

  emit(onEvent, { type: 'assistant_start' });

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data: ')) continue;
      const data = trimmed.slice(6);
      if (data === '[DONE]') continue;

      let parsed;
      try { parsed = JSON.parse(data); } catch { continue; }

      const choice = parsed.choices?.[0];
      if (!choice) continue;

      const delta = choice.delta;
      if (delta?.content) {
        content += delta.content;
        emit(onEvent, { type: 'token', content: delta.content });
      }
      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          if (!toolCalls[idx]) {
            toolCalls[idx] = { id: tc.id || '', name: tc.function?.name || '', arguments: '' };
          }
          if (tc.id) toolCalls[idx].id = tc.id;
          if (tc.function?.name) toolCalls[idx].name = tc.function.name;
          if (tc.function?.arguments) toolCalls[idx].arguments += tc.function.arguments;
        }
      }
    }
  }

  const validToolCalls = toolCalls.filter(Boolean);
  const assistantMsg = {
    role: 'assistant',
    content: content || null,
    tool_calls: validToolCalls.length > 0
      ? validToolCalls.map((tc) => ({
          id: tc.id, type: 'function',
          function: { name: tc.name, arguments: tc.arguments },
        }))
      : null,
  };

  emit(onEvent, { type: 'assistant_end', content, toolCalls: validToolCalls.length });
  return assistantMsg;
}

function buildSystemPrompt(sandbox, projectContext) {
  let prompt = `你是 Mini Coding Agent，一个在本地 workspace 中执行编码任务的自主 Agent。

## 工具
- list_directory: 查看目录结构
- read_file: 读取文件（支持 startLine/endLine 范围）
- write_file: 创建或覆盖文件
- edit_file: 精确修改（推荐）
- search_files: 搜索内容（支持正则）
- delete_file: 删除文件（需确认）
- run_command: 执行 shell 命令

## 流程
1. list_directory 了解结构
2. search_files 定位
3. read_file 精确读取
4. edit_file / write_file 修改
5. run_command 验证
6. 迭代直到完成

## 规则
- 只在 workspace 内操作
- 优先 edit_file 精确修改
- 修改后主动验证
- 遇到错误分析并修复
- 不读取 .env、密钥等敏感文件
- 不执行读取敏感环境变量的命令`;

  // V0.5.0: Project Instructions (AGENTS.md)
  if (projectContext && projectContext.loaded) {
    prompt += `\n\n## PROJECT INSTRUCTIONS
Source: ${projectContext.source}${projectContext.truncated ? ' (partial)' : ''}
${projectContext.content}`;
  }

  return prompt;
}

function emit(onEvent, event) {
  if (onEvent) onEvent(event);
}

export { runAgent };