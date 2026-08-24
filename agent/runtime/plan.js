/**
 * agent/runtime/plan.js — Plan Runtime
 *
 * V0.9.1
 * - Plan Object: user goal decomposition container
 * - Plan Lifecycle: DRAFT → APPROVED → EXECUTING → VERIFYING → COMPLETED/FAILED/CANCELLED
 * - Task Dependency: resolve, check
 * - Runtime Snapshot v2: Plan + Task + ToolExecution + Evidence
 */

import { RUNTIME_EVENT_TYPES } from './events.js';

// ── Plan Status ───────────────────────────────────────────

const PLAN_STATUS = {
  DRAFT: 'draft',
  APPROVED: 'approved',
  EXECUTING: 'executing',
  VERIFYING: 'verifying',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
};

const PLAN_TRANSITIONS = {
  [PLAN_STATUS.DRAFT]: [PLAN_STATUS.APPROVED, PLAN_STATUS.CANCELLED],
  [PLAN_STATUS.APPROVED]: [PLAN_STATUS.EXECUTING, PLAN_STATUS.CANCELLED],
  [PLAN_STATUS.EXECUTING]: [PLAN_STATUS.VERIFYING, PLAN_STATUS.COMPLETED, PLAN_STATUS.FAILED, PLAN_STATUS.CANCELLED],
  // V0.9.0.1: EXECUTING cannot directly complete — must go through VERIFYING
  [PLAN_STATUS.VERIFYING]: [PLAN_STATUS.COMPLETED, PLAN_STATUS.FAILED, PLAN_STATUS.CANCELLED],
  [PLAN_STATUS.COMPLETED]: [],
  [PLAN_STATUS.FAILED]: [],
  [PLAN_STATUS.CANCELLED]: [],
};

// ── Plan Factory ──────────────────────────────────────────

/**
 * Create a new Plan.
 */
function createPlan(runId, goal, options = {}) {
  return {
    id: options.id || `plan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    runId,
    goal,
    status: PLAN_STATUS.DRAFT,
    tasks: options.tasks || [],
    dependencies: options.dependencies || [],
    evidenceRefs: options.evidenceRefs || [],
    // V0.9.6: Revision history persistence
    revisions: options.revisions || [],
    revision: options.revision || 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    approvedAt: null,
    completedAt: null,
    failedAt: null,
    cancelledAt: null,
    reason: null,
  };
}

// ── Plan Lifecycle ────────────────────────────────────────

/**
 * Approve a plan — DRAFT → APPROVED.
 */
function approvePlan(plan, emitter, context = {}) {
  if (!plan) return false;
  if (plan.status !== PLAN_STATUS.DRAFT) {
    console.warn(`[Plan] Cannot approve plan in status: ${plan.status}`);
    return false;
  }

  plan.status = PLAN_STATUS.APPROVED;
  plan.updatedAt = Date.now();
  plan.approvedAt = Date.now();

  if (emitter) {
    emitter.emit({
      runId: plan.runId,
      planId: plan.id,
      type: 'plan_approved',
      data: { goal: plan.goal, taskCount: plan.tasks.length },
    });
  }

  return true;
}

/**
 * Start plan execution — APPROVED → EXECUTING.
 */
function startPlan(plan, emitter, context = {}) {
  if (!plan) return false;
  if (plan.status !== PLAN_STATUS.APPROVED) {
    console.warn(`[Plan] Cannot start plan in status: ${plan.status}`);
    return false;
  }

  plan.status = PLAN_STATUS.EXECUTING;
  plan.updatedAt = Date.now();

  if (emitter) {
    emitter.emit({
      runId: plan.runId,
      planId: plan.id,
      type: 'plan_executing',
      data: { taskCount: plan.tasks.length },
    });
  }

  return true;
}

/**
 * Start plan verification — EXECUTING → VERIFYING.
 */
function startPlanVerification(plan, emitter, context = {}) {
  if (!plan) return false;
  if (plan.status !== PLAN_STATUS.EXECUTING) {
    console.warn(`[Plan] Cannot verify plan in status: ${plan.status}`);
    return false;
  }

  plan.status = PLAN_STATUS.VERIFYING;
  plan.updatedAt = Date.now();

  if (emitter) {
    emitter.emit({
      runId: plan.runId,
      planId: plan.id,
      type: RUNTIME_EVENT_TYPES.VERIFICATION_STARTED,
      data: { taskCount: plan.tasks.length },
    });
  }

  return true;
}

/**
 * Complete a plan — VERIFYING → COMPLETED.
 * V0.9.0.1: Strict — must be in VERIFYING state.
 */
function completePlan(plan, emitter, context = {}) {
  if (!plan) return false;
  if (plan.status !== PLAN_STATUS.VERIFYING) {
    console.warn(
      `[Plan] Cannot complete plan in status: ${plan.status}. ` +
      `Plan must go through VERIFYING before COMPLETED.`
    );
    return false;
  }

  plan.status = PLAN_STATUS.COMPLETED;
  plan.updatedAt = Date.now();
  plan.completedAt = Date.now();

  if (emitter) {
    emitter.emit({
      runId: plan.runId,
      planId: plan.id,
      type: 'plan_completed',
      data: { evidenceRefs: plan.evidenceRefs },
    });
  }

  return true;
}

/**
 * Fail a plan — EXECUTING/VERIFYING → FAILED.
 */
function failPlan(plan, emitter, context = {}) {
  if (!plan) return false;
  if (plan.status !== PLAN_STATUS.EXECUTING && plan.status !== PLAN_STATUS.VERIFYING) {
    console.warn(`[Plan] Cannot fail plan in status: ${plan.status}`);
    return false;
  }

  plan.status = PLAN_STATUS.FAILED;
  plan.updatedAt = Date.now();
  plan.failedAt = Date.now();
  plan.reason = context.reason || 'Plan failed';

  if (emitter) {
    emitter.emit({
      runId: plan.runId,
      planId: plan.id,
      type: 'plan_failed',
      data: { reason: plan.reason },
    });
  }

  return true;
}

/**
 * Cancel a plan — any non-terminal → CANCELLED.
 */
function cancelPlan(plan, emitter, context = {}) {
  if (!plan) return false;
  if (plan.status === PLAN_STATUS.COMPLETED || plan.status === PLAN_STATUS.FAILED) {
    console.warn(`[Plan] Cannot cancel plan in terminal state: ${plan.status}`);
    return false;
  }

  plan.status = PLAN_STATUS.CANCELLED;
  plan.updatedAt = Date.now();
  plan.cancelledAt = Date.now();
  plan.reason = context.reason || 'Plan cancelled';

  if (emitter) {
    emitter.emit({
      runId: plan.runId,
      planId: plan.id,
      type: 'plan_cancelled',
      data: { reason: plan.reason },
    });
  }

  return true;
}

/**
 * Get plan status.
 */
function getPlanStatus(plan) {
  return plan ? plan.status : null;
}

/**
 * Check if plan transition is valid.
 */
function canTransitionPlan(plan, newStatus) {
  if (!plan) return false;
  return (PLAN_TRANSITIONS[plan.status] || []).includes(newStatus);
}

// ── Task Dependency ───────────────────────────────────────

/**
 * V0.9.1: Add a task dependency.
 * Format: { from: taskId, to: taskId } meaning 'from' must complete before 'to'.
 */
function addTaskDependency(plan, fromTaskId, toTaskId) {
  if (!plan) return false;
  // Avoid duplicates
  const exists = plan.dependencies.some(d => d.from === fromTaskId && d.to === toTaskId);
  if (!exists) {
    plan.dependencies.push({ from: fromTaskId, to: toTaskId });
    plan.updatedAt = Date.now();
  }
  return true;
}

/**
 * V0.9.1: Check if a task can execute (all dependencies satisfied).
 * A task can execute when all 'from' tasks are COMPLETED.
 *
 * @param {object} plan - The plan
 * @param {string} taskId - The task to check
 * @param {Map} taskStatusMap - taskId → Task status
 * @returns {object} { canExecute, blockedBy }
 */
function canTaskExecute(plan, taskId, taskStatusMap) {
  if (!plan) return { canExecute: false, blockedBy: [] };

  // Find dependencies where this task is the 'to' (dependent)
  const deps = plan.dependencies.filter(d => d.to === taskId);

  const blockedBy = [];
  for (const dep of deps) {
    const fromStatus = taskStatusMap.get(dep.from);
    if (fromStatus !== 'completed') {
      blockedBy.push({
        taskId: dep.from,
        status: fromStatus || 'unknown',
      });
    }
  }

  return {
    canExecute: blockedBy.length === 0,
    blockedBy,
  };
}

/**
 * V0.9.1: Get execution order respecting dependencies.
 * Returns task IDs in dependency-respecting order.
 */
function getExecutionOrder(plan) {
  if (!plan) return [];

  const taskIds = plan.tasks.map(t => t.id);
  const visited = new Set();
  const order = [];

  // Topological sort
  function visit(taskId) {
    if (visited.has(taskId)) return;
    visited.add(taskId);

    // Visit dependencies first
    const deps = plan.dependencies.filter(d => d.to === taskId);
    for (const dep of deps) {
      if (taskIds.includes(dep.from)) {
        visit(dep.from);
      }
    }

    order.push(taskId);
  }

  for (const id of taskIds) {
    visit(id);
  }

  return order;
}

// ── Snapshot v2 ───────────────────────────────────────────

/**
 * V0.9.1: Create a Runtime Snapshot v2 — includes Plan + Task + ToolExecution + Evidence.
 * V0.9.4.1: Added executionGate parameter for approval state.
 *
 * @param {string} runId - Run ID
 * @param {object} runtimeContext - AgentRuntimeContext
 * @param {object} plan - Current Plan
 * @param {object} evidenceRegistry - EvidenceRegistry
 * @param {object} eventLog - RuntimeEventLog
 * @param {string} status - Overall status
 * @param {object} [executionGate] - ExecutionGate for approval state
 * @returns {object} Snapshot v2
 */
function createSnapshotV2(runId, runtimeContext, plan, evidenceRegistry, eventLog, status, executionGate) {
  const snapshot = {
    id: `snap_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    runId,
    timestamp: Date.now(),
    version: '2',
    status: status || 'unknown',
    // V0.9.1: Full state capture
    runtimeContext: runtimeContext ? runtimeContext.serialize() : null,
    plan: plan ? serializePlan(plan) : null,
    evidenceRegistry: evidenceRegistry ? evidenceRegistry.serialize() : null,
    eventLog: eventLog ? eventLog.serialize() : null,
  };

  // V0.9.4.1: Include approval requests from ExecutionGate
  if (executionGate && executionGate.getRequestsByRun) {
    const approvals = executionGate.getRequestsByRun(runId);
    if (approvals.length > 0) {
      snapshot.approvals = approvals.map(a => ({
        id: a.id,
        runId: a.runId,
        target: a.target,
        reason: a.reason,
        context: a.context,
        status: a.status,
        createdAt: a.createdAt,
        resolvedAt: a.resolvedAt,
        resolvedBy: a.resolvedBy,
        resolutionReason: a.resolutionReason,
        timeoutMs: a.timeoutMs,
        expiresAt: a.expiresAt,
      }));
    }
  }

  return snapshot;
}

/**
 * V0.9.1: Serialize Plan for snapshot.
 */
function serializePlan(plan) {
  if (!plan) return null;
  return {
    id: plan.id,
    runId: plan.runId,
    goal: plan.goal,
    status: plan.status,
    tasks: plan.tasks,
    dependencies: plan.dependencies,
    evidenceRefs: plan.evidenceRefs,
    // V0.9.6: Revision history
    revisions: plan.revisions || [],
    revision: plan.revision || 1,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
    approvedAt: plan.approvedAt,
    completedAt: plan.completedAt,
    failedAt: plan.failedAt,
    cancelledAt: plan.cancelledAt,
    reason: plan.reason,
  };
}

/**
 * V0.9.1: Deserialize Plan from snapshot.
 */
function deserializePlan(data) {
  if (!data) return null;
  return {
    ...data,
    createdAt: data.createdAt || Date.now(),
    updatedAt: data.updatedAt || Date.now(),
  };
}

// ── Plan Revision ─────────────────────────────────────────

/**
 * V0.9.2: Create a new revision of a plan.
 * Returns a new plan object with incremented revision number.
 * Does NOT mutate the original.
 *
 * @param {object} plan - Current plan
 * @param {object} changes - Changes to apply
 * @returns {object} New plan with revision
 */
function revisePlan(plan, changes) {
  if (!plan) return null;
  return {
    ...plan,
    ...changes,
    revision: (plan.revision || 1) + 1,
    previousRevision: plan.revision || 1,
    updatedAt: Date.now(),
    // Preserve original creation time
    createdAt: plan.createdAt,
  };
}

// ── PlanRuntimeService ────────────────────────────────────

/**
 * V0.9.2: PlanRuntimeService — Event Sourcing style plan state projection.
 *
 * Responsible for:
 * - Listening to Task events
 * - Projecting Plan state from Task states
 * - Advancing Plan lifecycle when appropriate
 *
 * This prevents Task from directly modifying Plan,
 * keeping Plan state as a projection of Task states.
 */
class PlanRuntimeService {
  constructor(plan, taskStatusMap, emitter) {
    this.plan = plan;
    this.taskStatusMap = taskStatusMap; // taskId → status
    this.emitter = emitter;
  }

  /**
   * V0.9.2: Project Plan state from current Task states.
   * Called after any Task state change.
   *
   * Rules:
   * - If all tasks COMPLETED → advance to VERIFYING (if in EXECUTING)
   * - If any task FAILED → fail the plan
   * - If any task CANCELLED → cancel the plan
   */
  projectPlanState() {
    if (!this.plan) return this.plan?.status || null;

    const statuses = Array.from(this.taskStatusMap.values());
    if (statuses.length === 0) return this.plan.status;

    const allCompleted = statuses.every(s => s === 'completed');
    const anyFailed = statuses.some(s => s === 'failed');
    const anyCancelled = statuses.some(s => s === 'cancelled');
    const allTerminal = statuses.every(s =>
      s === 'completed' || s === 'failed' || s === 'cancelled'
    );

    const currentStatus = this.plan.status;

    // EXECUTING → VERIFYING when all tasks complete
    if (currentStatus === 'executing' && allCompleted) {
      startPlanVerification(this.plan, this.emitter);
    }

    // EXECUTING/VERIFYING → FAILED when any task fails
    if ((currentStatus === 'executing' || currentStatus === 'verifying') && anyFailed) {
      failPlan(this.plan, this.emitter, { reason: 'A task failed' });
    }

    // EXECUTING/VERIFYING → CANCELLED when any task cancelled
    if ((currentStatus === 'executing' || currentStatus === 'verifying') && anyCancelled) {
      cancelPlan(this.plan, this.emitter, { reason: 'A task was cancelled' });
    }

    return this.plan.status;
  }

  /**
   * V0.9.2: Check if plan can transition to a given status.
   */
  canTransition(targetStatus) {
    return canTransitionPlan(this.plan, targetStatus);
  }

  /**
   * V0.9.2: Get task completion summary.
   */
  getTaskSummary() {
    const statuses = Array.from(this.taskStatusMap.values());
    return {
      total: statuses.length,
      completed: statuses.filter(s => s === 'completed').length,
      running: statuses.filter(s => s === 'running').length,
      pending: statuses.filter(s => s === 'pending').length,
      verifying: statuses.filter(s => s === 'verifying').length,
      failed: statuses.filter(s => s === 'failed').length,
      cancelled: statuses.filter(s => s === 'cancelled').length,
    };
  }
}

export {
  PLAN_STATUS,
  PLAN_TRANSITIONS,
  createPlan,
  approvePlan,
  startPlan,
  startPlanVerification,
  completePlan,
  failPlan,
  cancelPlan,
  getPlanStatus,
  canTransitionPlan,
  addTaskDependency,
  canTaskExecute,
  getExecutionOrder,
  createSnapshotV2,
  serializePlan,
  deserializePlan,
  // V0.9.2
  revisePlan,
  PlanRuntimeService,
};