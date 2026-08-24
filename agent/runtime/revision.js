/**
 * agent/runtime/revision.js — Dynamic Plan Revision Runtime
 *
 * V0.9.6
 * - PlanRevision: versioned plan changes
 * - RevisionEngine: transactional revision with rollback
 * - Dependency Conflict Detection
 * - Completed Task Protection
 * - Revision History Persistence
 * - Task Superseded Lifecycle
 *
 * Design:
 *   Revision is Runtime Change Management.
 *   Runtime safely accepts plan changes, validates compatibility,
 *   protects running/completed tasks, refreshes scheduling, and persists history.
 */

import { revisePlan, deserializePlan, serializePlan } from './plan.js';
import { TASK_STATUS } from './task.js';
import { RUNTIME_EVENT_TYPES } from './events.js';

// ── Revision Status ───────────────────────────────────────

const REVISION_STATUS = {
  DRAFT: 'draft',
  APPLIED: 'applied',
  REJECTED: 'rejected',
  CONFLICT: 'conflict',
  ROLLED_BACK: 'rolled_back',
};

// ── Plan Revision ─────────────────────────────────────────

/**
 * V0.9.5: Create a Revision Request.
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
    rolledBackAt: null,
    conflictReason: null,
    compatibility: null,
    _snapshot: null,
  };
}

// ── Revision Engine ───────────────────────────────────────

/**
 * V0.9.6: RevisionEngine — transactional revision with rollback.
 */
class RevisionEngine {
  constructor(options = {}) {
    this.plan = options.plan;
    this.taskStatusMap = options.taskStatusMap || new Map();
    this.emitter = options.emitter || null;
    this.autoProtectRunning = options.autoProtectRunning !== false;
    this.autoProtectCompleted = options.autoProtectCompleted !== false;
    this.revisionHistory = options.revisionHistory || [];
  }

  // ── Compatibility Check ───────────────────────────────

  /**
   * V0.9.6: Check if a revision is compatible with current Runtime state.
   */
  checkCompatibility(revision) {
    const issues = [];
    const protectedTasks = [];
    const conflicts = [];
    const changes = revision.changes || {};

    // 1. Check for explicitly removed tasks
    if (changes.tasks_remove && Array.isArray(changes.tasks_remove)) {
      for (const taskId of changes.tasks_remove) {
        const status = this.taskStatusMap.get(taskId);

        if (status === TASK_STATUS.RUNNING && this.autoProtectRunning) {
          protectedTasks.push({
            taskId, status, type: 'running',
            reason: 'Cannot delete RUNNING task — mark superseded instead',
          });
          issues.push({
            severity: 'error', type: 'running_task_deletion',
            message: `Task ${taskId} is RUNNING and cannot be deleted`, taskId,
          });
        }

        if (status === TASK_STATUS.COMPLETED && this.autoProtectCompleted) {
          protectedTasks.push({
            taskId, status, type: 'completed',
            reason: 'Cannot delete COMPLETED task — create replacement instead',
          });
          issues.push({
            severity: 'error', type: 'completed_task_deletion',
            message: `Task ${taskId} is COMPLETED and cannot be deleted`, taskId,
          });
        }
      }
    }

    // 2. Check for complete task replacement
    if (changes.tasks && Array.isArray(changes.tasks)) {
      const currentTaskIds = new Set(this.plan.tasks.map(t => t.id));
      const newTaskIds = new Set(changes.tasks.map(t => t.id));

      for (const taskId of currentTaskIds) {
        if (!newTaskIds.has(taskId)) {
          const status = this.taskStatusMap.get(taskId);
          if (status === TASK_STATUS.RUNNING && this.autoProtectRunning) {
            protectedTasks.push({
              taskId, status, type: 'running',
              reason: 'Cannot delete RUNNING task — mark superseded instead',
            });
            issues.push({
              severity: 'error', type: 'running_task_deletion',
              message: `Task ${taskId} is RUNNING and cannot be deleted`, taskId,
            });
          }
          if (status === TASK_STATUS.COMPLETED && this.autoProtectCompleted) {
            protectedTasks.push({
              taskId, status, type: 'completed',
              reason: 'Cannot delete COMPLETED task — create replacement instead',
            });
            issues.push({
              severity: 'error', type: 'completed_task_deletion',
              message: `Task ${taskId} is COMPLETED and cannot be deleted`, taskId,
            });
          }
        }
      }

      // Check for modified task goals on completed tasks
      for (const change of changes.tasks) {
        if (change.id) {
          const status = this.taskStatusMap.get(change.id);
          if (status === TASK_STATUS.COMPLETED && change.goal && this.autoProtectCompleted) {
            issues.push({
              severity: 'error', type: 'completed_task_modified',
              message: `Task ${change.id} is COMPLETED and its goal cannot be modified`,
              taskId: change.id,
            });
          }
          if (status === TASK_STATUS.RUNNING && change.goal) {
            issues.push({
              severity: 'warning', type: 'running_task_modified',
              message: `Task ${change.id} goal modified while RUNNING`,
              taskId: change.id,
            });
          }
        }
      }
    }

    // 3. Dependency Conflict Detection
    const depConflicts = this.checkDependencyConflicts(changes);
    conflicts.push(...depConflicts.conflicts);
    issues.push(...depConflicts.issues);

    const compatible = issues.filter(i => i.severity === 'error').length === 0;

    return { compatible, issues, protectedTasks, conflicts, canApply: compatible };
  }

  /**
   * V0.9.6: Check for dependency conflicts in a revision.
   */
  checkDependencyConflicts(changes) {
    const conflicts = [];
    const issues = [];

    // Check if removed tasks are referenced by dependencies
    if (changes.tasks_remove && Array.isArray(changes.tasks_remove)) {
      const removeSet = new Set(changes.tasks_remove);

      for (const dep of this.plan.dependencies) {
        if (removeSet.has(dep.from)) {
          conflicts.push({
            type: 'broken_dependency_from', dependency: dep,
            removedTask: dep.from, affectedTask: dep.to,
            message: `Dependency ${dep.from} → ${dep.to} broken: ${dep.from} is being removed`,
          });
          issues.push({
            severity: 'error', type: 'broken_dependency',
            message: `Dependency ${dep.from} → ${dep.to} broken: ${dep.from} is being removed`,
            dependency: dep,
          });
        }
        if (removeSet.has(dep.to)) {
          conflicts.push({
            type: 'orphaned_dependency', dependency: dep,
            removedTask: dep.to,
            message: `Dependency ${dep.from} → ${dep.to} orphaned: ${dep.to} is being removed`,
          });
        }
      }
    }

    // Check for complete task replacement
    if (changes.tasks && Array.isArray(changes.tasks)) {
      const currentTaskIds = new Set(this.plan.tasks.map(t => t.id));
      const newTaskIds = new Set(changes.tasks.map(t => t.id));

      for (const dep of this.plan.dependencies) {
        const fromRemoved = !newTaskIds.has(dep.from) && currentTaskIds.has(dep.from);
        const toRemoved = !newTaskIds.has(dep.to) && currentTaskIds.has(dep.to);

        if (fromRemoved) {
          conflicts.push({
            type: 'broken_dependency_from', dependency: dep,
            removedTask: dep.from, affectedTask: dep.to,
            message: `Dependency ${dep.from} → ${dep.to} broken: ${dep.from} is being removed`,
          });
          issues.push({
            severity: 'error', type: 'broken_dependency',
            message: `Dependency ${dep.from} → ${dep.to} broken: ${dep.from} is being removed`,
            dependency: dep,
          });
        }
        if (toRemoved) {
          conflicts.push({
            type: 'orphaned_dependency', dependency: dep,
            removedTask: dep.to,
            message: `Dependency ${dep.from} → ${dep.to} orphaned: ${dep.to} is being removed`,
          });
        }
      }
    }

    // Check for new dependency graph validity
    if (changes.dependencies) {
      const allTaskIds = new Set(this.plan.tasks.map(t => t.id));
      if (changes.tasks_add) {
        for (const t of changes.tasks_add) allTaskIds.add(t.id);
      }
      if (changes.tasks) {
        for (const t of changes.tasks) allTaskIds.add(t.id);
      }

      for (const dep of changes.dependencies) {
        if (!allTaskIds.has(dep.from)) {
          conflicts.push({
            type: 'invalid_dependency_from', dependency: dep,
            message: `Dependency ${dep.from} → ${dep.to}: task ${dep.from} does not exist`,
          });
          issues.push({
            severity: 'error', type: 'invalid_dependency',
            message: `Dependency ${dep.from} → ${dep.to}: task ${dep.from} does not exist`,
            dependency: dep,
          });
        }
        if (!allTaskIds.has(dep.to)) {
          conflicts.push({
            type: 'invalid_dependency_to', dependency: dep,
            message: `Dependency ${dep.from} → ${dep.to}: task ${dep.to} does not exist`,
          });
          issues.push({
            severity: 'error', type: 'invalid_dependency',
            message: `Dependency ${dep.from} → ${dep.to}: task ${dep.to} does not exist`,
            dependency: dep,
          });
        }
      }
    }

    return { conflicts, issues };
  }

  // ── Transaction Flow ──────────────────────────────────

  /**
   * V0.9.6: Prepare — snapshot current state for rollback.
   */
  prepare(revision) {
    revision._snapshot = {
      plan: serializePlan(this.plan),
      taskStatusMap: new Map(this.taskStatusMap),
      revision: this.plan.revision || 1,
      timestamp: Date.now(),
    };
    return revision;
  }

  /**
   * V0.9.6: Validate — check compatibility.
   */
  validate(revision) {
    const compat = this.checkCompatibility(revision);
    revision.compatibility = compat;
    return compat;
  }

  /**
   * V0.9.6: Apply — apply the revision to the plan.
   * Alias: applyRevision (backward compatible with V0.9.5 tests)
   */
  apply(revision) {
    return this.applyRevision(revision);
  }

  applyRevision(revision) {
    const compat = revision.compatibility || this.validate(revision);
    if (!compat.compatible) {
      revision.status = REVISION_STATUS.CONFLICT;
      revision.conflictReason = compat.issues
        .filter(i => i.severity === 'error')
        .map(i => i.message)
        .join('; ');

      if (this.emitter) {
        this.emitter.emit({
          runId: this.plan.runId,
          type: 'plan_revision_conflict',
          data: { revisionId: revision.id, reason: revision.conflictReason },
        });
      }

      return { success: false, reason: revision.conflictReason, revision };
    }

    const planChanges = { ...revision.changes };

    // Merge tasks_add into tasks
    if (planChanges.tasks_add && Array.isArray(planChanges.tasks_add)) {
      const existingIds = new Set(this.plan.tasks.map(t => t.id));
      const newTasks = planChanges.tasks_add.filter(t => !existingIds.has(t.id));
      planChanges.tasks = [...this.plan.tasks, ...newTasks];
      delete planChanges.tasks_add;
    }

    // Handle tasks_remove — supersede running, reject completed
    const supersededIds = [];
    const completedIds = [];
    if (planChanges.tasks_remove && Array.isArray(planChanges.tasks_remove)) {
      const safeRemoveIds = [];
      for (const taskId of planChanges.tasks_remove) {
        const status = this.taskStatusMap.get(taskId);
        if (status === TASK_STATUS.RUNNING && this.autoProtectRunning) {
          supersededIds.push(taskId);
        } else if (status === TASK_STATUS.COMPLETED && this.autoProtectCompleted) {
          completedIds.push(taskId);
        } else {
          safeRemoveIds.push(taskId);
        }
      }

      if (safeRemoveIds.length > 0) {
        const removeSet = new Set(safeRemoveIds);
        planChanges.tasks = this.plan.tasks.filter(t => !removeSet.has(t.id));
      } else {
        planChanges.tasks = [...this.plan.tasks];
      }
      delete planChanges.tasks_remove;
    } else if (planChanges.tasks && Array.isArray(planChanges.tasks)) {
      const currentTaskIds = new Set(this.plan.tasks.map(t => t.id));
      const newTaskIds = new Set(planChanges.tasks.map(t => t.id));

      for (const taskId of currentTaskIds) {
        if (!newTaskIds.has(taskId)) {
          const status = this.taskStatusMap.get(taskId);
          if (status === TASK_STATUS.RUNNING && this.autoProtectRunning) {
            const task = planChanges.tasks.find(t => t.id === taskId);
            if (task) {
              // V0.9.6.1: Use SUPERSEDED status instead of deprecated flag
              task.status = TASK_STATUS.SUPERSEDED;
              task.supersededAt = Date.now();
              task.supersededReason = 'Plan revision — task superseded';
            }
          }
        }
      }
    }

    const newPlan = revisePlan(this.plan, planChanges);
    newPlan.revisionReason = revision.reason;
    newPlan.revisionSource = revision.source;

    // V0.9.6.1: Mark superseded tasks with SUPERSEDED status
    for (const taskId of supersededIds) {
      const task = newPlan.tasks.find(t => t.id === taskId);
      if (task) {
        task.status = TASK_STATUS.SUPERSEDED;
        task.supersededAt = Date.now();
        task.supersededReason = 'Plan revision — task superseded';
        // Update taskStatusMap for scheduler
        this.taskStatusMap.set(taskId, TASK_STATUS.SUPERSEDED);
      }
    }

    // V0.9.6: Persist revision history
    const historyEntry = {
      id: revision.id,
      fromRevision: revision.parentRevision,
      toRevision: newPlan.revision,
      reason: revision.reason,
      changes: { ...revision.changes },
      supersededIds: supersededIds.length > 0 ? supersededIds : undefined,
      completedProtected: completedIds.length > 0 ? completedIds : undefined,
      timestamp: Date.now(),
      status: REVISION_STATUS.APPLIED,
    };

    if (!newPlan.revisions) newPlan.revisions = [];
    newPlan.revisions.push(historyEntry);
    this.revisionHistory.push(historyEntry);

    this.plan = newPlan;
    revision.status = REVISION_STATUS.APPLIED;
    revision.appliedAt = Date.now();
    revision.compatibility = compat;
    revision.supersededIds = supersededIds;
    revision.completedProtected = completedIds;

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
          supersededCount: supersededIds.length,
        },
      });
    }

    return { success: true, plan: newPlan, revision, supersededIds, completedProtected: completedIds };
  }

  /**
   * V0.9.6: Refresh — update scheduler after revision.
   */
  refresh(scheduler) {
    if (!scheduler) return { readyTasks: [], summary: null };

    scheduler.plan = this.plan;

    for (const task of this.plan.tasks) {
      if (!scheduler.taskStatusMap.has(task.id)) {
        scheduler.taskStatusMap.set(task.id, TASK_STATUS.PENDING);
      }
    }

    const readyTasks = scheduler.getReadyTasks();
    const summary = scheduler.getSummary();

    if (this.emitter) {
      this.emitter.emit({
        runId: this.plan.runId,
        type: 'scheduler_refreshed',
        data: { readyTasks, summary },
      });
    }

    return { readyTasks, summary };
  }

  /**
   * V0.9.6: Commit — finalize the transaction.
   */
  commit(revision) {
    revision.committedAt = Date.now();
    return { success: true, revision };
  }

  /**
   * V0.9.6: Rollback — restore previous state on failure.
   */
  rollback(revision) {
    if (!revision._snapshot) {
      return { success: false, reason: 'No snapshot for rollback', revision };
    }

    const snapshot = revision._snapshot;
    this.plan = deserializePlan(snapshot.plan);
    this.plan.revision = snapshot.revision;
    this.taskStatusMap = new Map(snapshot.taskStatusMap);

    revision.status = REVISION_STATUS.ROLLED_BACK;
    revision.rolledBackAt = Date.now();

    if (this.emitter) {
      this.emitter.emit({
        runId: this.plan.runId,
        planId: this.plan.id,
        type: 'plan_revision_rolled_back',
        data: {
          revisionId: revision.id,
          fromRevision: revision.parentRevision,
          toRevision: snapshot.revision,
        },
      });
    }

    return { success: true, revision };
  }

  /**
   * V0.9.6: Full transactional revision flow.
   */
  executeRevision(revision, scheduler) {
    this.prepare(revision);

    const compat = this.validate(revision);
    if (!compat.compatible) {
      revision.status = REVISION_STATUS.CONFLICT;
      revision.conflictReason = compat.issues
        .filter(i => i.severity === 'error')
        .map(i => i.message)
        .join('; ');

      if (this.emitter) {
        this.emitter.emit({
          runId: this.plan.runId,
          type: 'plan_revision_conflict',
          data: { revisionId: revision.id, reason: revision.conflictReason },
        });
      }

      return { success: false, reason: revision.conflictReason, revision };
    }

    const applyResult = this.apply(revision);
    if (!applyResult.success) {
      this.rollback(revision);
      return { success: false, reason: applyResult.reason, revision };
    }

    const refreshResult = this.refresh(scheduler);
    this.commit(revision);

    return {
      success: true,
      plan: applyResult.plan,
      revision,
      readyTasks: refreshResult.readyTasks,
      summary: refreshResult.summary,
      supersededIds: applyResult.supersededIds,
    };
  }

  /**
   * V0.9.6: Reject a revision.
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
        data: { revisionId: revision.id, reason },
      });
    }

    return { success: false, reason, revision };
  }

  /** V0.9.5: Refresh scheduler after revision. */
  refreshScheduler(scheduler) {
    return this.refresh(scheduler);
  }

  /** V0.9.5: Get current plan revision. */
  getCurrentRevision() {
    return this.plan.revision || 1;
  }

  /** V0.9.6: Get revision history from plan. */
  getRevisionHistory() {
    return this.plan.revisions || this.revisionHistory || [];
  }
}

/** V0.9.5: Create a RevisionEngine. */
function createRevisionEngine(options) {
  return new RevisionEngine(options);
}

/** V0.9.5: Serialize a revision for snapshot. */
function serializeRevision(revision) {
  if (!revision) return null;
  return {
    id: revision.id, planId: revision.planId, runId: revision.runId,
    parentRevision: revision.parentRevision, changes: revision.changes,
    reason: revision.reason, status: revision.status,
    source: revision.source, requestedBy: revision.requestedBy,
    createdAt: revision.createdAt, appliedAt: revision.appliedAt,
    rejectedAt: revision.rejectedAt, rolledBackAt: revision.rolledBackAt,
    conflictReason: revision.conflictReason, compatibility: revision.compatibility,
  };
}

/** V0.9.5: Deserialize a revision from snapshot. */
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