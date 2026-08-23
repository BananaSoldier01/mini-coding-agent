/**
 * agent/runtime/revision.js — Dynamic Plan Revision Runtime
 *
 * V0.9.5
 * - PlanRevision: versioned plan changes
 * - RevisionEngine: safe apply revision to running Runtime
 * - Scheduler Refresh: recompute ready tasks after revision
 * - Running Task Protection: prevent direct deletion of RUNNING tasks
 *
 * Design:
 *   Revision is Runtime Change Management, not Planner optimization.
 *   Runtime safely accepts plan changes, validates compatibility,
 *   protects running tasks, and refreshes scheduling.
 */

import { createPlan, PLAN_STATUS, PLAN_TRANSITIONS, revisePlan, deserializePlan, serializePlan } from './plan.js';
import { TASK_STATUS } from './task.js';
import { RUNTIME_EVENT_TYPES } from './events.js';

// ── Revision Status ───────────────────────────────────────

const REVISION_STATUS = {
  DRAFT: 'draft',
  APPLIED: 'applied',
  REJECTED: 'rejected',
  CONFLICT: 'conflict',
};

// ── Plan Revision ─────────────────────────────────────────

/**
 * V0.9.5: Create a Revision Request.
 *
 * A revision describes changes to a Plan while it is running.
 * Revisions are NOT applied directly — they go through Compatibility Check.
 *
 * @param {object} plan - Current Plan
 * @param {object} changes - What to change { tasks, dependencies, goal }
 * @param {string} reason - Why the plan is being revised
 * @param {object} [context] - Additional context { source, requestedBy }
 * @returns {object} RevisionRequest
 */
function createRevisionRequest(plan, changes, reason, context = {}) {
  return {
    id: `rev_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    planId: plan.id,
    runId: plan.runId,
    parentRevision: plan.revision || 1,
    changes,
    reason,
    status: REVISION_STATUS.DRAFT,
    source: context.source || 'planner',
    requestedBy: context.requestedBy || 'system',
    createdAt: Date.now(),
    appliedAt: null,
    rejectedAt: null,
    conflictReason: null,
    compatibility: null, // Filled by RevisionEngine.checkCompatibility()
  };
}

// ── Revision Engine ───────────────────────────────────────

/**
 * V0.9.5: RevisionEngine — safely applies plan revisions to running Runtime.
 *
 * Flow:
 *   Revision Request
 *     → Compatibility Check
 *       → Apply Revision
 *         → Refresh Scheduler
 *           → Continue
 */
class RevisionEngine {
  constructor(options = {}) {
    this.plan = options.plan;
    this.taskStatusMap = options.taskStatusMap || new Map();
    this.emitter = options.emitter || null;
    this.autoProtectRunning = options.autoProtectRunning !== false; // Default: protect running tasks
  }

  /**
   * V0.9.5: Check if a revision is compatible with current Runtime state.
   *
   * Returns { compatible, issues, protectedTasks }
   *
   * Supports:
   * - tasks: complete replacement set (checks for deletions)
   * - tasks_remove: explicit task IDs to remove
   * - tasks_add: tasks to add (no deletion check needed)
   * - tasks: array of task changes (checks for modifications)
   */
  checkCompatibility(revision) {
    const issues = [];
    const protectedTasks = [];

    const changes = revision.changes || {};

    // Check for explicitly removed tasks
    if (changes.tasks_remove && Array.isArray(changes.tasks_remove)) {
      for (const taskId of changes.tasks_remove) {
        const status = this.taskStatusMap.get(taskId);
        if (status === TASK_STATUS.RUNNING && this.autoProtectRunning) {
          protectedTasks.push({
            taskId,
            status,
            reason: 'Cannot delete RUNNING task — mark deprecated instead',
          });
          issues.push({
            severity: 'error',
            type: 'running_task_deletion',
            message: `Task ${taskId} is RUNNING and cannot be deleted`,
            taskId,
          });
        }
      }
    } else if (changes.tasks && Array.isArray(changes.tasks)) {
      // Complete replacement — check for deletions
      const currentTaskIds = new Set(this.plan.tasks.map(t => t.id));
      const newTaskIds = new Set(changes.tasks.map(t => t.id));

      for (const taskId of currentTaskIds) {
        if (!newTaskIds.has(taskId)) {
          const status = this.taskStatusMap.get(taskId);
          if (status === TASK_STATUS.RUNNING && this.autoProtectRunning) {
            protectedTasks.push({
              taskId,
              status,
              reason: 'Cannot delete RUNNING task — mark deprecated instead',
            });
            issues.push({
              severity: 'error',
              type: 'running_task_deletion',
              message: `Task ${taskId} is RUNNING and cannot be deleted`,
              taskId,
            });
          }
        }
      }
    }

    // Check for complete task replacement (tasks field = full set)
    if (changes.tasks && Array.isArray(changes.tasks)) {
      const currentTaskIds = new Set(this.plan.tasks.map(t => t.id));
      const newTaskIds = new Set(changes.tasks.map(t => t.id));

      // Tasks being removed (in current but not in new)
      for (const taskId of currentTaskIds) {
        if (!newTaskIds.has(taskId)) {
          const status = this.taskStatusMap.get(taskId);
          if (status === TASK_STATUS.RUNNING && this.autoProtectRunning) {
            protectedTasks.push({
              taskId,
              status,
              reason: 'Cannot delete RUNNING task — mark deprecated instead',
            });
            issues.push({
              severity: 'error',
              type: 'running_task_deletion',
              message: `Task ${taskId} is RUNNING and cannot be deleted`,
              taskId,
            });
          }
        }
      }

      // Check for modified task goals on running tasks
      for (const change of changes.tasks) {
        if (change.id) {
          const status = this.taskStatusMap.get(change.id);
          if (status === TASK_STATUS.RUNNING && change.goal) {
            issues.push({
              severity: 'warning',
              type: 'running_task_modified',
              message: `Task ${change.id} goal modified while RUNNING`,
              taskId: change.id,
            });
          }
        }
      }
    }

    const compatible = issues.filter(i => i.severity === 'error').length === 0;

    return {
      compatible,
      issues,
      protectedTasks,
      canApply: compatible,
    };
  }

  /**
   * V0.9.5: Apply a revision to the plan.
   * Only call after checkCompatibility returns compatible: true.
   *
   * @param {object} revision - RevisionRequest
   * @returns {object} { success, plan, revision }
   */
  applyRevision(revision) {
    if (!revision) {
      return { success: false, reason: 'No revision provided' };
    }

    // Check compatibility
    const compat = this.checkCompatibility(revision);
    if (!compat.compatible) {
      revision.status = REVISION_STATUS.CONFLICT;
      revision.conflictReason = compat.issues
        .filter(i => i.severity === 'error')
        .map(i => i.message)
        .join('; ');
      revision.compatibility = compat;

      if (this.emitter) {
        this.emitter.emit({
          runId: this.plan.runId,
          type: 'plan_revision_conflict',
          data: {
            revisionId: revision.id,
            reason: revision.conflictReason,
          },
        });
      }

      return { success: false, reason: revision.conflictReason, revision };
    }

    // Build the complete plan changes
    const planChanges = { ...revision.changes };

    // Merge tasks_add into tasks
    if (planChanges.tasks_add && Array.isArray(planChanges.tasks_add)) {
      const existingIds = new Set(this.plan.tasks.map(t => t.id));
      const newTasks = planChanges.tasks_add.filter(t => !existingIds.has(t.id));
      planChanges.tasks = [...this.plan.tasks, ...newTasks];
      delete planChanges.tasks_add;
    }

    // Handle tasks_remove — mark running tasks as deprecated instead of removing
    const deprecatedIds = [];
    if (planChanges.tasks_remove && Array.isArray(planChanges.tasks_remove)) {
      const safeRemoveIds = [];
      for (const taskId of planChanges.tasks_remove) {
        const status = this.taskStatusMap.get(taskId);
        if (status === TASK_STATUS.RUNNING && this.autoProtectRunning) {
          deprecatedIds.push(taskId);
        } else {
          safeRemoveIds.push(taskId);
        }
      }
      // Only remove non-running tasks
      if (safeRemoveIds.length > 0) {
        const removeSet = new Set(safeRemoveIds);
        planChanges.tasks = this.plan.tasks.filter(t => !removeSet.has(t.id));
      } else {
        planChanges.tasks = [...this.plan.tasks];
      }
      delete planChanges.tasks_remove;
    } else if (planChanges.tasks && Array.isArray(planChanges.tasks)) {
      // Complete replacement — check for running task deletions
      const currentTaskIds = new Set(this.plan.tasks.map(t => t.id));
      const newTaskIds = new Set(planChanges.tasks.map(t => t.id));

      for (const taskId of currentTaskIds) {
        if (!newTaskIds.has(taskId)) {
          const status = this.taskStatusMap.get(taskId);
          if (status === TASK_STATUS.RUNNING && this.autoProtectRunning) {
            // Mark as deprecated instead of removing
            const task = planChanges.tasks.find(t => t.id === taskId);
            if (task) {
              task.deprecated = true;
              task.deprecatedAt = Date.now();
              task.deprecatedReason = 'Plan revision — task superseded';
            }
          }
        }
      }
    }

    // Apply the revision
    const newPlan = revisePlan(this.plan, planChanges);
    newPlan.revisionReason = revision.reason;
    newPlan.revisionSource = revision.source;

    // Mark deprecated tasks in the new plan
    for (const taskId of deprecatedIds) {
      const task = newPlan.tasks.find(t => t.id === taskId);
      if (task) {
        task.deprecated = true;
        task.deprecatedAt = Date.now();
        task.deprecatedReason = 'Plan revision — task superseded';
      }
    }

    // Update plan
    this.plan = newPlan;
    revision.status = REVISION_STATUS.APPLIED;
    revision.appliedAt = Date.now();
    revision.compatibility = compat;

    if (this.emitter) {
      this.emitter.emit({
        runId: this.plan.runId,
        planId: this.plan.id,
        type: 'plan_revision_applied',
        data: {
          revisionId: revision.id,
          fromRevision: revision.parentRevision,
          toRevision: newPlan.revision,
          reason: revision.reason,
        },
      });
    }

    return { success: true, plan: newPlan, revision };
  }

  /**
   * V0.9.5: Reject a revision.
   */
  rejectRevision(revision, reason) {
    revision.status = REVISION_STATUS.REJECTED;
    revision.rejectedAt = Date.now();
    revision.conflictReason = reason;

    if (this.emitter) {
      this.emitter.emit({
        runId: this.plan.runId,
        planId: this.plan.id,
        type: 'plan_revision_rejected',
        data: {
          revisionId: revision.id,
          reason,
        },
      });
    }

    return { success: false, reason, revision };
  }

  /**
   * V0.9.5: Refresh scheduler after revision.
   * Recomputes ready tasks based on new plan state.
   *
   * @param {object} scheduler - TaskScheduler instance
   * @returns {object} { readyTasks, summary }
   */
  refreshScheduler(scheduler) {
    if (!scheduler) return { readyTasks: [], summary: null };

    // Update scheduler's plan reference
    scheduler.plan = this.plan;

    // Add new tasks to taskStatusMap with PENDING status
    for (const task of this.plan.tasks) {
      if (!scheduler.taskStatusMap.has(task.id)) {
        scheduler.taskStatusMap.set(task.id, TASK_STATUS.PENDING);
      }
    }

    // Recompute ready tasks
    const readyTasks = scheduler.getReadyTasks();
    const summary = scheduler.getSummary();

    if (this.emitter) {
      this.emitter.emit({
        runId: this.plan.runId,
        type: 'scheduler_refreshed',
        data: {
          readyTasks,
          summary,
        },
      });
    }

    return { readyTasks, summary };
  }

  /**
   * V0.9.5: Get current plan revision.
   */
  getCurrentRevision() {
    return this.plan.revision || 1;
  }

  /**
   * V0.9.5: Get revision history (from plan metadata).
   */
  getRevisionHistory() {
    return this.plan.revisionHistory || [];
  }
}

/**
 * V0.9.5: Create a RevisionEngine.
 */
function createRevisionEngine(options) {
  return new RevisionEngine(options);
}

/**
 * V0.9.5: Serialize a revision for snapshot.
 */
function serializeRevision(revision) {
  if (!revision) return null;
  return {
    id: revision.id,
    planId: revision.planId,
    runId: revision.runId,
    parentRevision: revision.parentRevision,
    changes: revision.changes,
    reason: revision.reason,
    status: revision.status,
    source: revision.source,
    requestedBy: revision.requestedBy,
    createdAt: revision.createdAt,
    appliedAt: revision.appliedAt,
    rejectedAt: revision.rejectedAt,
    conflictReason: revision.conflictReason,
    compatibility: revision.compatibility,
  };
}

/**
 * V0.9.5: Deserialize a revision from snapshot.
 */
function deserializeRevision(data) {
  if (!data) return null;
  return { ...data };
}

export {
  REVISION_STATUS,
  createRevisionRequest,
  RevisionEngine,
  createRevisionEngine,
  serializeRevision,
  deserializeRevision,
};