/**
 * agent/runtime/tool-execution.js — ToolExecution Runtime
 *
 * V0.9.0
 * - ToolExecution Object: first-class tool invocation lifecycle
 * - Lifecycle: REQUESTED → POLICY_CHECKING → APPROVED/DENIED → EXECUTING → COMPLETED/FAILED
 * - Policy enforcement integration
 * - Auto-evidence binding
 */

import { RUNTIME_EVENT_TYPES } from './events.js';

// ── ToolExecution Status ──────────────────────────────────

const TOOL_EXECUTION_STATUS = {
  REQUESTED: 'requested',
  POLICY_CHECKING: 'policy_checking',
  APPROVED: 'approved',
  DENIED: 'denied',
  EXECUTING: 'executing',
  COMPLETED: 'completed',
  FAILED: 'failed',
};

const TOOL_EXECUTION_TRANSITIONS = {
  [TOOL_EXECUTION_STATUS.REQUESTED]: [TOOL_EXECUTION_STATUS.POLICY_CHECKING],
  [TOOL_EXECUTION_STATUS.POLICY_CHECKING]: [TOOL_EXECUTION_STATUS.APPROVED, TOOL_EXECUTION_STATUS.DENIED],
  [TOOL_EXECUTION_STATUS.APPROVED]: [TOOL_EXECUTION_STATUS.EXECUTING],
  [TOOL_EXECUTION_STATUS.DENIED]: [],
  [TOOL_EXECUTION_STATUS.EXECUTING]: [TOOL_EXECUTION_STATUS.COMPLETED, TOOL_EXECUTION_STATUS.FAILED],
  [TOOL_EXECUTION_STATUS.COMPLETED]: [],
  [TOOL_EXECUTION_STATUS.FAILED]: [],
};

// ── ToolExecution Factory ─────────────────────────────────

/**
 * Create a new ToolExecution request.
 */
function createToolExecution(runId, taskId, toolName, args, options = {}) {
  return {
    id: options.id || `te_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    runId,
    taskId,
    skillId: options.skillId || null,
    toolName,
    args: args || {},
    status: TOOL_EXECUTION_STATUS.REQUESTED,
    result: null,
    error: null,
    evidenceRefs: [],
    policyCheck: null,
    approvedAt: null,
    executedAt: null,
    completedAt: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

// ── Policy Check ──────────────────────────────────────────

/**
 * V0.9.0: Check tool permission via RuntimePolicyContext.
 * Returns { allowed, reason, policySource }.
 *
 * Final permission = Skill Capability ∩ Runtime Policy ∩ Environment Constraint
 *
 * V0.9.0.1: Passes skillTools to isToolAllowed for proper skill-based checking.
 */
function checkToolPermission(toolExec, policyContext, availableTools, skillTools) {
  if (!policyContext) {
    return { allowed: true, reason: 'No policy context', policySource: 'none' };
  }

  const allowed = policyContext.isToolAllowed(toolExec.toolName, availableTools, skillTools);
  return {
    allowed,
    reason: allowed ? 'Allowed by policy' : `Tool "${toolExec.toolName}" denied by policy`,
    policySource: policyContext.environment || 'runtime',
  };
}

// ── Lifecycle Transitions ─────────────────────────────────

/**
 * Submit tool execution request — REQUESTED → POLICY_CHECKING.
 */
function submitToolExecution(toolExec, emitter, context = {}) {
  if (!toolExec) return false;
  if (toolExec.status !== TOOL_EXECUTION_STATUS.REQUESTED) {
    console.warn(`[ToolExec] Cannot submit in status: ${toolExec.status}`);
    return false;
  }

  toolExec.status = TOOL_EXECUTION_STATUS.POLICY_CHECKING;
  toolExec.updatedAt = Date.now();

  if (emitter) {
    emitter.emit({
      runId: toolExec.runId,
      taskId: toolExec.taskId,
      toolExecId: toolExec.id,
      type: RUNTIME_EVENT_TYPES.TOOL_REQUESTED,
      data: { toolName: toolExec.toolName, args: toolExec.args },
    });
  }

  return true;
}

/**
 * Complete policy check — POLICY_CHECKING → APPROVED or DENIED.
 * Returns the full policy result { allowed, reason, policySource }.
 */
function completePolicyCheck(toolExec, emitter, context = {}) {
  if (!toolExec) return { allowed: false, reason: 'No tool execution', policySource: 'none' };
  if (toolExec.status !== TOOL_EXECUTION_STATUS.POLICY_CHECKING) {
    console.warn(`[ToolExec] Cannot policy-check in status: ${toolExec.status}`);
    return { allowed: false, reason: `Cannot policy-check in status: ${toolExec.status}`, policySource: 'none' };
  }

  const result = context.policyResult || checkToolPermission(
    toolExec,
    context.policyContext,
    context.availableTools,
    context.skillTools
  );
  toolExec.policyCheck = result;

  if (result.allowed) {
    toolExec.status = TOOL_EXECUTION_STATUS.APPROVED;
    toolExec.approvedAt = Date.now();
  } else {
    toolExec.status = TOOL_EXECUTION_STATUS.DENIED;
    toolExec.error = result.reason;
    toolExec.updatedAt = Date.now();
  }

  if (emitter) {
    emitter.emit({
      runId: toolExec.runId,
      taskId: toolExec.taskId,
      toolExecId: toolExec.id,
      type: RUNTIME_EVENT_TYPES.TOOL_POLICY_CHECKED,
      data: {
        toolName: toolExec.toolName,
        allowed: result.allowed,
        reason: result.reason,
        policySource: result.policySource,
      },
    });
  }

  return result;
}

/**
 * Start execution — APPROVED → EXECUTING.
 */
function startToolExecution(toolExec, emitter, context = {}) {
  if (!toolExec) return false;
  if (toolExec.status !== TOOL_EXECUTION_STATUS.APPROVED) {
    console.warn(`[ToolExec] Cannot execute in status: ${toolExec.status}`);
    return false;
  }

  toolExec.status = TOOL_EXECUTION_STATUS.EXECUTING;
  toolExec.executedAt = Date.now();
  toolExec.updatedAt = Date.now();

  if (emitter) {
    emitter.emit({
      runId: toolExec.runId,
      taskId: toolExec.taskId,
      toolExecId: toolExec.id,
      type: RUNTIME_EVENT_TYPES.TOOL_EXECUTING,
      data: { toolName: toolExec.toolName },
    });
  }

  return true;
}

/**
 * Complete tool execution — EXECUTING → COMPLETED.
 * Auto-binds evidence.
 */
function completeToolExecution(toolExec, emitter, context = {}) {
  if (!toolExec) return false;
  if (toolExec.status !== TOOL_EXECUTION_STATUS.EXECUTING) {
    console.warn(`[ToolExec] Cannot complete in status: ${toolExec.status}`);
    return false;
  }

  toolExec.status = TOOL_EXECUTION_STATUS.COMPLETED;
  toolExec.result = context.result || null;
  toolExec.completedAt = Date.now();
  toolExec.updatedAt = Date.now();

  // V0.9.0: Auto-bind evidence
  if (context.evidenceRegistry && toolExec.skillId) {
    const evidence = context.evidenceRegistry.addEvidence({
      skillId: toolExec.skillId,
      type: 'tool_execution',
      data: {
        toolName: toolExec.toolName,
        result: toolExec.result,
        toolExecId: toolExec.id,
      },
    });
    toolExec.evidenceRefs.push(evidence.id);
  }

  if (emitter) {
    emitter.emit({
      runId: toolExec.runId,
      taskId: toolExec.taskId,
      toolExecId: toolExec.id,
      type: RUNTIME_EVENT_TYPES.TOOL_COMPLETED,
      data: {
        toolName: toolExec.toolName,
        result: toolExec.result,
        evidenceRefs: toolExec.evidenceRefs,
      },
    });
  }

  return true;
}

/**
 * Fail tool execution — EXECUTING → FAILED.
 */
function failToolExecution(toolExec, emitter, context = {}) {
  if (!toolExec) return false;
  if (toolExec.status !== TOOL_EXECUTION_STATUS.EXECUTING) {
    console.warn(`[ToolExec] Cannot fail in status: ${toolExec.status}`);
    return false;
  }

  toolExec.status = TOOL_EXECUTION_STATUS.FAILED;
  toolExec.error = context.error || 'Tool execution failed';
  toolExec.completedAt = Date.now();
  toolExec.updatedAt = Date.now();

  if (emitter) {
    emitter.emit({
      runId: toolExec.runId,
      taskId: toolExec.taskId,
      toolExecId: toolExec.id,
      type: RUNTIME_EVENT_TYPES.TOOL_FAILED,
      data: {
        toolName: toolExec.toolName,
        error: toolExec.error,
      },
    });
  }

  return true;
}

/**
 * Get tool execution status.
 */
function getToolExecutionStatus(toolExec) {
  return toolExec ? toolExec.status : null;
}

export {
  TOOL_EXECUTION_STATUS,
  TOOL_EXECUTION_TRANSITIONS,
  createToolExecution,
  checkToolPermission,
  submitToolExecution,
  completePolicyCheck,
  startToolExecution,
  completeToolExecution,
  failToolExecution,
  getToolExecutionStatus,
};