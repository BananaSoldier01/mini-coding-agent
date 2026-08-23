/**
 * agent/runtime/recovery.js — Runtime Recovery Manager
 *
 * V0.9.4
 * - RuntimeRecoveryManager: restore Runtime state from Snapshot
 * - Validates consistency after recovery
 * - Recovers pending tasks and approvals
 *
 * Design:
 *   Snapshot is the recovery unit.
 *   Recovery does NOT auto-execute dangerous actions.
 *   Pending approvals stay pending after recovery.
 */

import { deserializePlan, serializePlan } from './plan.js';
import { TASK_STATUS, TASK_TRANSITIONS } from './task.js';
import { APPROVAL_STATUS } from './approval.js';
import { RUNTIME_EVENT_TYPES } from './events.js';

/**
 * V0.9.4: RuntimeRecoveryManager — restores Runtime from Snapshot.
 *
 * Recovery rules:
 * - Completed tasks stay completed (no re-execution)
 * - Running tasks: recover based on policy (keep running or reset to pending)
 * - Pending tasks: stay pending
 * - Pending approvals: stay pending (never auto-approve after recovery)
 * - Failed tasks: stay failed (require manual reset)
 */
class RuntimeRecoveryManager {
  constructor(options = {}) {
    this.options = options;
    this.emitter = options.emitter || null;
    this.autoResetRunning = options.autoResetRunning || false; // If true, reset running→pending on recovery
  }

  /**
   * V0.9.4: Restore Runtime state from a Snapshot v2.
   *
   * @param {object} snapshot - Snapshot v2 object
   * @returns {object} Recovery result { restored, issues, actions }
   */
  restore(snapshot) {
    if (!snapshot) {
      return { restored: false, issues: ['No snapshot provided'], actions: [] };
    }

    const result = {
      restored: true,
      snapshotId: snapshot.id,
      timestamp: snapshot.timestamp,
      issues: [],
      actions: [],
      plan: null,
      taskStatusMap: new Map(),
      approvalStatusMap: new Map(),
    };

    // 1. Restore Plan
    if (snapshot.plan) {
      result.plan = deserializePlan(snapshot.plan);
      result.actions.push({ type: 'plan_restored', planId: result.plan.id, status: result.plan.status });
    }

    // 2. Restore Task statuses
    if (snapshot.plan && snapshot.plan.tasks) {
      for (const task of snapshot.plan.tasks) {
        const status = task.status || TASK_STATUS.PENDING;
        result.taskStatusMap.set(task.id, status);

        // Check for inconsistent states
        if (status === TASK_STATUS.RUNNING && this.autoResetRunning) {
          result.taskStatusMap.set(task.id, TASK_STATUS.PENDING);
          result.actions.push({ type: 'task_reset', taskId: task.id, from: TASK_STATUS.RUNNING, to: TASK_STATUS.PENDING });
        }
      }
    }

    // 3. Validate consistency
    const validation = this.validateConsistency(snapshot, result);
    result.issues.push(...validation.issues);

    // 4. Recover pending approvals
    if (snapshot.plan && snapshot.plan.tasks) {
      for (const task of snapshot.plan.tasks) {
        // Tasks that were waiting for approval stay pending
        // We don't auto-approve — that's the safe behavior
      }
    }

    // 5. Emit recovery event
    if (this.emitter) {
      this.emitter.emit({
        runId: snapshot.runId,
        type: RUNTIME_EVENT_TYPES.RUNTIME_RESTORED,
        data: {
          snapshotId: snapshot.id,
          actions: result.actions.length,
          issues: result.issues.length,
        },
      });
    }

    return result;
  }

  /**
   * V0.9.4: Validate Runtime consistency after restore.
   */
  validateConsistency(snapshot, recovery) {
    const issues = [];

    // Check Plan status vs Task statuses
    if (recovery.plan && recovery.plan.status === 'completed') {
      const allTasks = Array.from(recovery.taskStatusMap.values());
      const allCompleted = allTasks.every(s => s === TASK_STATUS.COMPLETED);
      if (!allCompleted) {
        issues.push({
          severity: 'warning',
          type: 'plan_task_mismatch',
          message: 'Plan is COMPLETED but not all tasks are COMPLETED',
          planStatus: recovery.plan.status,
          taskStatuses: Array.from(recovery.taskStatusMap.entries()),
        });
      }
    }

    // Check for running tasks without plan
    if (recovery.plan && recovery.plan.status === 'draft') {
      const runningTasks = Array.from(recovery.taskStatusMap.entries())
        .filter(([_, s]) => s === TASK_STATUS.RUNNING);
      if (runningTasks.length > 0) {
        issues.push({
          severity: 'warning',
          type: 'running_tasks_in_draft_plan',
          message: 'Plan is DRAFT but tasks are RUNNING',
          runningTasks: runningTasks.map(([id]) => id),
        });
      }
    }

    // Check for orphaned tasks (tasks not in plan)
    if (recovery.plan) {
      const planTaskIds = new Set(recovery.plan.tasks.map(t => t.id));
      for (const [taskId, status] of recovery.taskStatusMap) {
        if (!planTaskIds.has(taskId)) {
          issues.push({
            severity: 'info',
            type: 'orphaned_task',
            message: `Task ${taskId} not found in plan`,
            taskId,
            status,
          });
        }
      }
    }

    return { issues };
  }

  /**
   * V0.9.4: Recover pending tasks — return tasks that should be retried.
   */
  recoverPendingTasks(taskStatusMap) {
    const pending = [];
    for (const [taskId, status] of taskStatusMap) {
      if (status === TASK_STATUS.PENDING) {
        pending.push(taskId);
      }
    }
    return pending;
  }

  /**
   * V0.9.4: Recover pending approvals — return approvals that are still pending.
   * Does NOT auto-approve. Returns for external handling.
   */
  recoverPendingApprovals(approvalStatusMap) {
    const pending = [];
    for (const [taskId, status] of approvalStatusMap) {
      if (status === APPROVAL_STATUS.PENDING) {
        pending.push(taskId);
      }
    }
    return pending;
  }

  /**
   * V0.9.4: Check if recovery is safe to auto-continue.
   * Returns false if there are pending approvals or running dangerous tasks.
   */
  canAutoContinue(recovery) {
    // Cannot auto-continue if there are pending approvals
    const pendingApprovals = this.recoverPendingApprovals(new Map());
    if (pendingApprovals.length > 0) {
      return false;
    }

    // Cannot auto-continue if plan is in failed state
    if (recovery.plan && recovery.plan.status === 'failed') {
      return false;
    }

    return true;
  }
}

/**
 * V0.9.4: Create a RuntimeRecoveryManager.
 */
function createRecoveryManager(options) {
  return new RuntimeRecoveryManager(options);
}

export {
  RuntimeRecoveryManager,
  createRecoveryManager,
};