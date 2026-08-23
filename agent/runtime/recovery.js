/**
 * agent/runtime/recovery.js — Runtime Recovery Manager
 *
 * V0.9.4.1
 * - RuntimeRecoveryManager: restore Runtime state from Snapshot
 * - Validates consistency after recovery
 * - Recovers pending tasks and approvals
 * - Restores ApprovalRequest back to ExecutionGate
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
 * V0.9.4.1: RuntimeRecoveryManager — restores Runtime from Snapshot.
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
    this.autoResetRunning = options.autoResetRunning || false;
  }

  /**
   * V0.9.4.1: Restore Runtime state from a Snapshot v2.
   *
   * @param {object} snapshot - Snapshot v2 object
   * @param {object} [executionGate] - Optional ExecutionGate to restore approvals into
   * @returns {object} Recovery result { restored, issues, actions, plan, taskStatusMap, approvalStatusMap, approvalRequests }
   */
  restore(snapshot, executionGate) {
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
      approvalRequests: [],
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

        if (status === TASK_STATUS.RUNNING && this.autoResetRunning) {
          result.taskStatusMap.set(task.id, TASK_STATUS.PENDING);
          result.actions.push({
            type: 'task_reset',
            taskId: task.id,
            from: TASK_STATUS.RUNNING,
            to: TASK_STATUS.PENDING,
          });
        }
      }
    }

    // 3. Restore ApprovalRequests from snapshot
    if (snapshot.approvals && Array.isArray(snapshot.approvals)) {
      for (const approvalData of snapshot.approvals) {
        const approval = this.restoreApproval(approvalData);
        if (approval) {
          result.approvalRequests.push(approval);
          result.approvalStatusMap.set(approval.target.id, approval.status);

          // Restore into ExecutionGate if provided
          if (executionGate) {
            executionGate.restoreRequest(approval);
            result.actions.push({
              type: 'approval_restored',
              approvalId: approval.id,
              targetId: approval.target.id,
              status: approval.status,
            });
          }
        }
      }
    }

    // 4. Validate consistency
    const validation = this.validateConsistency(snapshot, result);
    result.issues.push(...validation.issues);

    // 5. Emit recovery event
    if (this.emitter) {
      this.emitter.emit({
        runId: snapshot.runId,
        type: RUNTIME_EVENT_TYPES.RUNTIME_RESTORED,
        data: {
          snapshotId: snapshot.id,
          actions: result.actions.length,
          issues: result.issues.length,
          approvalsRestored: result.approvalRequests.length,
        },
      });
    }

    return result;
  }

  /**
   * V0.9.4.1: Restore a single ApprovalRequest from snapshot data.
   * Does NOT auto-approve. Preserves original status.
   */
  restoreApproval(data) {
    if (!data) return null;
    return {
      ...data,
      createdAt: data.createdAt || Date.now(),
      resolvedAt: data.resolvedAt || null,
      expiresAt: data.expiresAt || null,
    };
  }

  /**
   * V0.9.4.1: Validate Runtime consistency after restore.
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

    // Check for running tasks in draft plan
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

    // Check for orphaned tasks
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

    // V0.9.4.1: Check for pending approvals with expired timestamps
    const approvalRequests = recovery.approvalRequests || [];
    const now = Date.now();
    for (const approval of approvalRequests) {
      if (approval.status === APPROVAL_STATUS.PENDING && approval.expiresAt && now > approval.expiresAt) {
        issues.push({
          severity: 'warning',
          type: 'expired_approval',
          message: `Approval ${approval.id} has expired but status is still PENDING`,
          approvalId: approval.id,
          targetId: approval.target.id,
        });
      }
    }

    return { issues };
  }

  /**
   * V0.9.4.1: Recover pending tasks — return tasks that should be retried.
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
   * V0.9.4.1: Recover pending approvals — return approvals that are still pending.
   * Uses the actual recovery approvalStatusMap, not an empty map.
   */
  recoverPendingApprovals(approvalStatusMap) {
    if (!approvalStatusMap) return [];
    const pending = [];
    for (const [taskId, status] of approvalStatusMap) {
      if (status === APPROVAL_STATUS.PENDING) {
        pending.push(taskId);
      }
    }
    return pending;
  }

  /**
   * V0.9.4.1: Check if recovery is safe to auto-continue.
   *
   * Returns false if:
   * - Any pending approvals exist
   * - Plan is in FAILED state
   * - Runtime consistency validation has critical errors
   *
   * @param {object} recovery - Recovery result from restore()
   * @returns {boolean}
   */
  canAutoContinue(recovery) {
    if (!recovery) return false;

    // 1. Check pending approvals — use actual recovery data
    const pendingApprovals = this.recoverPendingApprovals(recovery.approvalStatusMap);
    if (pendingApprovals.length > 0) {
      return false;
    }

    // 2. Check plan state
    if (recovery.plan) {
      if (recovery.plan.status === 'failed') {
        return false;
      }
      if (recovery.plan.status === 'cancelled') {
        return false;
      }
    }

    // 3. Check for critical consistency errors
    const criticalIssues = (recovery.issues || []).filter(
      i => i.severity === 'error' || i.severity === 'critical'
    );
    if (criticalIssues.length > 0) {
      return false;
    }

    // 4. Check for expired approvals that should have been resolved
    const expiredApprovals = (recovery.approvalRequests || []).filter(
      a => a.status === APPROVAL_STATUS.PENDING &&
           a.expiresAt &&
           Date.now() > a.expiresAt
    );
    if (expiredApprovals.length > 0) {
      return false;
    }

    return true;
  }

  /**
   * V0.9.4.1: Check if recovery has pending approvals.
   */
  hasPendingApprovals(recovery) {
    if (!recovery) return false;
    return this.recoverPendingApprovals(recovery.approvalStatusMap).length > 0;
  }
}

/**
 * V0.9.4.1: Create a RuntimeRecoveryManager.
 */
function createRecoveryManager(options) {
  return new RuntimeRecoveryManager(options);
}

export {
  RuntimeRecoveryManager,
  createRecoveryManager,
};