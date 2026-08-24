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
  [TASK_STATUS.RUNNING]: [TASK_STATUS.VERIFYING, TASK_STATUS.FAILED, TASK_STATUS.CANCELLED, TASK_STATUS.SUPERSEDED],
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
      type: RUNTIME_EVENT_TYPES.VERIFICATION_STARTED,
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
      type: 'task_superseded',
      data: {
        previousStatus,
        reason: task.supersededReason,
        evidenceRefs: task.evidenceRefs,
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
};