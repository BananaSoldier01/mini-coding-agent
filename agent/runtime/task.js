/**
 * agent/runtime/task.js — Task Runtime
 *
 * V0.9.0
 * - Task Object: user goal decomposition unit
 * - Task Lifecycle: PENDING → RUNNING → VERIFYING → COMPLETED/FAILED/CANCELLED
 * - All transitions emit Runtime Events
 */

import { RUNTIME_EVENT_TYPES } from './events.js';

// ── Task Status ───────────────────────────────────────────

const TASK_STATUS = {
  PENDING: 'pending',
  RUNNING: 'running',
  // V0.9.8: Task waiting for human approval
  WAITING_APPROVAL: 'waiting_approval',
  VERIFYING: 'verifying',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  // V0.9.6: Task was replaced or invalidated by plan revision
  SUPERSEDED: 'superseded',
};

const TASK_TRANSITIONS = {
  [TASK_STATUS.PENDING]: [TASK_STATUS.RUNNING, TASK_STATUS.CANCELLED],
  // V0.9.0.1: RUNNING cannot directly go to COMPLETED — must pass through VERIFYING
  [TASK_STATUS.RUNNING]: [TASK_STATUS.VERIFYING, TASK_STATUS.FAILED, TASK_STATUS.CANCELLED, TASK_STATUS.SUPERSEDED, TASK_STATUS.WAITING_APPROVAL],
  // V0.9.8: WAITING_APPROVAL can go to RUNNING (approved) or FAILED/CANCELLED (rejected)
  [TASK_STATUS.WAITING_APPROVAL]: [TASK_STATUS.RUNNING, TASK_STATUS.FAILED, TASK_STATUS.CANCELLED],
  [TASK_STATUS.VERIFYING]: [TASK_STATUS.COMPLETED, TASK_STATUS.FAILED, TASK_STATUS.CANCELLED, TASK_STATUS.SUPERSEDED],
  [TASK_STATUS.COMPLETED]: [],
  [TASK_STATUS.FAILED]: [],
  [TASK_STATUS.CANCELLED]: [],
  // V0.9.6: SUPERSEDED is terminal — set by revision engine, not by normal lifecycle
  [TASK_STATUS.SUPERSEDED]: [],
};

// ── Task Factory ──────────────────────────────────────────

/**
 * Create a new Task.
 */
function createTask(runId, goal, options = {}) {
  return {
    id: options.id || `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    runId,
    goal,
    status: TASK_STATUS.PENDING,
    assignedSkills: options.assignedSkills || [],
    dependencies: options.dependencies || [],
    evidenceRefs: options.evidenceRefs || [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    completedAt: null,
    failedAt: null,
    cancelledAt: null,
    reason: null,
  };
}

// ── Task Lifecycle ────────────────────────────────────────

/**
 * Start a task — PENDING → RUNNING.
 * Emits TASK_STARTED event.
 */
function startTask(task, emitter, context = {}) {
  if (!task) return false;
  if (task.status !== TASK_STATUS.PENDING) {
    console.warn(`[Task] Cannot start task in status: ${task.status}`);
    return false;
  }

  task.status = TASK_STATUS.RUNNING;
  task.updatedAt = Date.now();

  if (emitter) {
    emitter.emit({
      runId: task.runId,
      taskId: task.id,
      type: RUNTIME_EVENT_TYPES.TASK_STARTED,
      data: { goal: task.goal },
    });
  }

  return true;
}

/**
 * Complete a task — VERIFYING → COMPLETED.
 * Emits TASK_COMPLETED event.
 * V0.9.0.1: Strict — must be in VERIFYING state (cannot complete directly from RUNNING).
 */
function completeTask(task, emitter, context = {}) {
  if (!task) return false;
  if (task.status !== TASK_STATUS.VERIFYING) {
    console.warn(
      `[Task] Cannot complete task in status: ${task.status}. ` +
      `Task must go through VERIFYING before COMPLETED.`
    );
    return false;
  }

  task.status = TASK_STATUS.COMPLETED;
  task.updatedAt = Date.now();
  task.completedAt = Date.now();

  if (emitter) {
    emitter.emit({
      runId: task.runId,
      taskId: task.id,
      type: RUNTIME_EVENT_TYPES.TASK_COMPLETED,
      data: { evidenceRefs: task.evidenceRefs },
    });
  }

  return true;
}

/**
 * Fail a task — RUNNING/VERIFYING → FAILED.
 * Emits TASK_FAILED event.
 */
function failTask(task, emitter, context = {}) {
  if (!task) return false;
  if (task.status !== TASK_STATUS.RUNNING && task.status !== TASK_STATUS.VERIFYING) {
    console.warn(`[Task] Cannot fail task in status: ${task.status}`);
    return false;
  }

  task.status = TASK_STATUS.FAILED;
  task.updatedAt = Date.now();
  task.failedAt = Date.now();
  task.reason = context.reason || 'Task failed';

  if (emitter) {
    emitter.emit({
      runId: task.runId,
      taskId: task.id,
      type: RUNTIME_EVENT_TYPES.TASK_FAILED,
      data: { reason: task.reason },
    });
  }

  return true;
}

/**
 * Cancel a task — any non-terminal → CANCELLED.
 * Emits TASK_CANCELLED event.
 */
function cancelTask(task, emitter, context = {}) {
  if (!task) return false;
  if (task.status === TASK_STATUS.COMPLETED || task.status === TASK_STATUS.FAILED) {
    console.warn(`[Task] Cannot cancel task in terminal state: ${task.status}`);
    return false;
  }

  task.status = TASK_STATUS.CANCELLED;
  task.updatedAt = Date.now();
  task.cancelledAt = Date.now();
  task.reason = context.reason || 'Task cancelled';

  if (emitter) {
    emitter.emit({
      runId: task.runId,
      taskId: task.id,
      type: RUNTIME_EVENT_TYPES.TASK_CANCELLED,
      data: { reason: task.reason },
    });
  }

  return true;
}

/**
 * Start verification for a task — RUNNING → VERIFYING.
 */
function startTaskVerification(task, emitter, context = {}) {
  if (!task) return false;
  if (task.status !== TASK_STATUS.RUNNING) {
    console.warn(`[Task] Cannot verify task in status: ${task.status}`);
    return false;
  }

  task.status = TASK_STATUS.VERIFYING;
  task.updatedAt = Date.now();

  if (emitter) {
    emitter.emit({
      runId: task.runId,
      taskId: task.id,
      type: RUNTIME_EVENT_TYPES.TASK_VERIFYING,
      data: { skillCount: task.assignedSkills.length },
    });
  }

  return true;
}

/**
 * Get task status.
 */
function getTaskStatus(task) {
  return task ? task.status : null;
}

/**
 * Check if task transition is valid (without executing).
 */
function canTransitionTask(task, newStatus) {
  if (!task) return false;
  return (TASK_TRANSITIONS[task.status] || []).includes(newStatus);
}

/**
 * V0.9.6: Mark a task as SUPERSEDED — replaced by plan revision.
 * Preserves evidence and execution history.
 * Only RUNNING, VERIFYING, PENDING, FAILED, CANCELLED tasks can be superseded.
 * COMPLETED tasks cannot be superseded (immutable).
 */
function supersedeTask(task, emitter, context = {}) {
  if (!task) return false;
  if (task.status === TASK_STATUS.COMPLETED) {
    console.warn('[Task] Cannot supersede COMPLETED task — completed tasks are immutable');
    return false;
  }
  if (task.status === TASK_STATUS.SUPERSEDED) {
    return false; // Already superseded
  }

  const previousStatus = task.status;
  task.status = TASK_STATUS.SUPERSEDED;
  task.updatedAt = Date.now();
  task.supersededAt = Date.now();
  task.supersededReason = context.reason || 'Plan revision — task superseded';
  task.previousStatus = previousStatus;

  if (emitter) {
    emitter.emit({
      runId: task.runId,
      taskId: task.id,
      type: RUNTIME_EVENT_TYPES.TASK_SUPERSEDED,
      data: {
        previousStatus,
        reason: task.supersededReason,
        evidenceRefs: task.evidenceRefs,
      },
    });
  }

  return true;
}

/**
 * V0.9.8: Request human approval — RUNNING → WAITING_APPROVAL.
 * Emits TASK_WAITING_APPROVAL and APPROVAL_REQUESTED events.
 */
function requestApproval(task, emitter, context = {}) {
  if (!task) return false;
  if (task.status !== TASK_STATUS.RUNNING) {
    console.warn(`[Task] Cannot request approval in status: ${task.status}`);
    return false;
  }

  task.status = TASK_STATUS.WAITING_APPROVAL;
  task.updatedAt = Date.now();
  task.approvalRequestedAt = Date.now();
  task.approvalReason = context.reason || 'Human approval required';
  task.approvalRiskLevel = context.riskLevel || 'medium';

  if (emitter) {
    emitter.emit({
      runId: task.runId,
      taskId: task.id,
      type: RUNTIME_EVENT_TYPES.TASK_WAITING_APPROVAL,
      data: {
        reason: task.approvalReason,
        riskLevel: task.approvalRiskLevel,
      },
    });
    emitter.emit({
      runId: task.runId,
      taskId: task.id,
      type: RUNTIME_EVENT_TYPES.APPROVAL_REQUESTED,
      data: {
        reason: task.approvalReason,
        riskLevel: task.approvalRiskLevel,
        operator: context.operator || 'system',
      },
    });
  }

  return true;
}

/**
 * V0.9.8: Approve task — WAITING_APPROVAL → RUNNING.
 * Emits APPROVAL_GRANTED and TASK_RESUMED events.
 */
function approveTask(task, emitter, context = {}) {
  if (!task) return false;
  if (task.status !== TASK_STATUS.WAITING_APPROVAL) {
    console.warn(`[Task] Cannot approve task in status: ${task.status}`);
    return false;
  }

  task.status = TASK_STATUS.RUNNING;
  task.updatedAt = Date.now();
  task.approvedAt = Date.now();
  task.approvedBy = context.operator || 'user';
  task.approvalReason = null;

  if (emitter) {
    emitter.emit({
      runId: task.runId,
      taskId: task.id,
      type: RUNTIME_EVENT_TYPES.APPROVAL_GRANTED,
      data: {
        operator: task.approvedBy,
        reason: context.reason || 'Approved',
      },
    });
    emitter.emit({
      runId: task.runId,
      taskId: task.id,
      type: RUNTIME_EVENT_TYPES.TASK_RESUMED,
      data: { resumedBy: task.approvedBy },
    });
  }

  return true;
}

/**
 * V0.9.8: Reject task — WAITING_APPROVAL → FAILED.
 * Emits APPROVAL_REJECTED event.
 */
function rejectTask(task, emitter, context = {}) {
  if (!task) return false;
  if (task.status !== TASK_STATUS.WAITING_APPROVAL) {
    console.warn(`[Task] Cannot reject task in status: ${task.status}`);
    return false;
  }

  task.status = TASK_STATUS.FAILED;
  task.updatedAt = Date.now();
  task.failedAt = Date.now();
  task.reason = context.reason || 'Human rejection';
  task.rejectedAt = Date.now();
  task.rejectedBy = context.operator || 'user';

  if (emitter) {
    emitter.emit({
      runId: task.runId,
      taskId: task.id,
      type: RUNTIME_EVENT_TYPES.APPROVAL_REJECTED,
      data: {
        operator: task.rejectedBy,
        reason: task.reason,
      },
    });
  }

  return true;
}

/**
 * V0.9.8: Pause a task — RUNNING → WAITING_APPROVAL (same state, different semantics).
 * Emits TASK_PAUSED event.
 * Note: Paused tasks are held in WAITING_APPROVAL state until resumed.
 */
function pauseTask(task, emitter, context = {}) {
  if (!task) return false;
  if (task.status !== TASK_STATUS.RUNNING) {
    console.warn(`[Task] Cannot pause task in status: ${task.status}`);
    return false;
  }

  task.status = TASK_STATUS.WAITING_APPROVAL;
  task.updatedAt = Date.now();
  task.pausedAt = Date.now();
  task.pauseReason = context.reason || 'Human pause';

  if (emitter) {
    emitter.emit({
      runId: task.runId,
      taskId: task.id,
      type: RUNTIME_EVENT_TYPES.TASK_PAUSED,
      data: {
        reason: task.pauseReason,
        operator: context.operator || 'user',
      },
    });
  }

  return true;
}

/**
 * V0.9.8: Resume a paused task — WAITING_APPROVAL → RUNNING.
 * Emits TASK_RESUMED event.
 */
function resumeTask(task, emitter, context = {}) {
  if (!task) return false;
  if (task.status !== TASK_STATUS.WAITING_APPROVAL) {
    console.warn(`[Task] Cannot resume task in status: ${task.status}`);
    return false;
  }

  task.status = TASK_STATUS.RUNNING;
  task.updatedAt = Date.now();
  task.resumedAt = Date.now();
  task.pauseReason = null;

  if (emitter) {
    emitter.emit({
      runId: task.runId,
      taskId: task.id,
      type: RUNTIME_EVENT_TYPES.TASK_RESUMED,
      data: {
        resumedBy: context.operator || 'user',
        reason: context.reason || 'Resumed',
      },
    });
  }

  return true;
}

/**
 * V0.9.8: Human override — force task to a specific state.
 * Emits HUMAN_OVERRIDE event.
 */
function humanOverride(task, emitter, context = {}) {
  if (!task) return false;
  const targetStatus = context.targetStatus;
  if (!targetStatus) return false;

  const previousStatus = task.status;
  task.status = targetStatus;
  task.updatedAt = Date.now();
  task.overriddenAt = Date.now();
  task.overriddenBy = context.operator || 'user';
  task.overrideReason = context.reason || 'Human override';

  if (emitter) {
    emitter.emit({
      runId: task.runId,
      taskId: task.id,
      type: RUNTIME_EVENT_TYPES.HUMAN_OVERRIDE,
      data: {
        previousStatus,
        targetStatus,
        operator: task.overriddenBy,
        reason: task.overrideReason,
      },
    });
  }

  return true;
}

export {
  TASK_STATUS,
  TASK_TRANSITIONS,
  createTask,
  startTask,
  supersedeTask,
  completeTask,
  failTask,
  cancelTask,
  startTaskVerification,
  getTaskStatus,
  canTransitionTask,
  // V0.9.8: Governance
  requestApproval,
  approveTask,
  rejectTask,
  pauseTask,
  resumeTask,
  humanOverride,
};