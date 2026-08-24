/**
 * agent/runtime/recovery-manager.js — Execution Recovery Manager
 *
 * V1.2.1
 * - Runtime crash recovery: restore Run, Workspace, Context, Tasks
 * - Task state validation after recovery
 * - Failed task retry strategy
 * - Completed task skip
 *
 * Design:
 *   RecoveryManager handles the full recovery flow:
 *   Crash → Restore Run → Load Workspace → Restore Context
 *        → Find unfinished Tasks → Validate State → Continue Execution
 */

import { TransitionManager, createTransitionManager } from './transition-manager.js';
import {
  TASK_STATUS,
} from './task.js';

class RecoveryManager {
  constructor(options = {}) {
    this.emitter = options.emitter || null;
    this.eventStore = options.eventStore || null;
    this.transitionMgr = options.transitionManager || createTransitionManager({
      emitter: options.emitter,
      eventStore: options.eventStore,
    });
    // V1.2.1: References to engine components (set by ExecutionEngine)
    this.engine = options.engine || null;
  }

  // ── Full Recovery ──────────────────────────────────────

  /**
   * V1.2.1: Full recovery after runtime crash.
   * Restores Run, Workspace, Context, and validates Task states.
   */
  recover(runId) {
    if (!this.eventStore) {
      return { success: false, reason: 'No event store for recovery' };
    }

    const events = this.eventStore.getEventsByRun(runId);
    if (events.length === 0) {
      return { success: false, reason: `No events found for run ${runId}` };
    }

    // Step 1: Reconstruct Run state from events
    const run = this._reconstructRun(runId, events);
    if (!run) {
      return { success: false, reason: 'Could not reconstruct run' };
    }

    // Step 2: Restore Workspace
    let workspace = null;
    if (this.engine) {
      const ws = this.engine.workspaceStore.get(run.workspaceId);
      if (ws) {
        workspace = ws;
      }
    }

    // Step 3: Restore Context
    let context = null;
    if (this.engine) {
      context = this.engine.contextMgr.getByRun(runId);
    }

    // Step 4: Find and validate unfinished tasks
    const unfinishedTasks = this._findUnfinishedTasks(runId, events);

    // Step 5: Categorize tasks
    const taskPlan = this._categorizeTasks(unfinishedTasks);

    return {
      success: true,
      restored: true,
      run,
      workspace,
      context,
      taskPlan,
      recoveredAt: Date.now(),
    };
  }

  // ── Run Reconstruction ─────────────────────────────────

  /**
   * V1.2.1: Reconstruct Run state from event sequence.
   */
  _reconstructRun(runId, events) {
    const createdEvent = events.find(e => e.type === 'run_started');
    if (!createdEvent) return null;

    const run = {
      id: runId,
      goal: createdEvent.data?.goal || 'Restored Run',
      status: 'created',
      workspaceId: createdEvent.data?.workspaceId,
      planId: null,
      taskIds: [],
      createdAt: createdEvent.timestamp,
      updatedAt: Date.now(),
      startedAt: null,
      completedAt: null,
      failedAt: null,
      error: null,
      metadata: {},
    };

    for (const event of events) {
      switch (event.type) {
        case 'run_started':
          run.status = 'started';
          run.startedAt = event.timestamp;
          break;
        case 'run_completed':
          run.status = 'completed';
          run.completedAt = event.timestamp;
          break;
        case 'run_failed':
          run.status = 'failed';
          run.failedAt = event.timestamp;
          run.error = event.data?.error;
          break;
        case 'run_paused':
          run.status = 'paused';
          break;
        case 'run_resumed':
          run.status = 'started';
          break;
        case 'task_created':
          if (event.data?.taskId && !run.taskIds.includes(event.data.taskId)) {
            run.taskIds.push(event.data.taskId);
          }
          break;
      }
    }

    return run;
  }

  // ── Task Analysis ──────────────────────────────────────

  /**
   * V1.2.1: Find unfinished tasks from event sequence.
   */
  _findUnfinishedTasks(runId, events) {
    const taskEvents = events.filter(e =>
      ['task_created', 'task_started', 'task_completed', 'task_failed', 'task_cancelled'].includes(e.type)
    );

    const taskMap = new Map();

    for (const event of taskEvents) {
      const taskId = event.data?.taskId || event.taskId;
      if (!taskId) continue;

      if (!taskMap.has(taskId)) {
        taskMap.set(taskId, {
          id: taskId,
          status: 'pending',
          events: [],
        });
      }

      taskMap.get(taskId).events.push(event);

      // Update status based on latest event
      switch (event.type) {
        case 'task_created':
          taskMap.get(taskId).status = 'pending';
          taskMap.get(taskId).goal = event.data?.goal;
          break;
        case 'task_started':
          taskMap.get(taskId).status = 'running';
          break;
        case 'task_completed':
          taskMap.get(taskId).status = 'completed';
          break;
        case 'task_failed':
          taskMap.get(taskId).status = 'failed';
          taskMap.get(taskId).error = event.data?.error;
          break;
        case 'task_cancelled':
          taskMap.get(taskId).status = 'cancelled';
          break;
      }
    }

    return Array.from(taskMap.values());
  }

  /**
   * V1.2.1: Categorize tasks for recovery.
   */
  _categorizeTasks(tasks) {
    const categories = {
      completed: [],    // Skip
      failed: [],       // Retry
      running: [],      // Resume
      pending: [],      // Execute
      cancelled: [],    // Skip
    };

    for (const task of tasks) {
      const status = task.status;
      if (status === 'completed' || status === 'cancelled') {
        categories[status].push(task);
      } else if (status === 'failed') {
        categories.failed.push(task);
      } else if (status === 'running') {
        categories.running.push(task);
      } else {
        categories.pending.push(task);
      }
    }

    return categories;
  }

  /**
   * V1.2.1: Get recovery plan — ordered list of actions.
   */
  getRecoveryPlan(runId) {
    const recovery = this.recover(runId);
    if (!recovery.success) return recovery;

    const plan = [];

    // 1. Restore workspace
    if (recovery.workspace) {
      plan.push({ action: 'restore_workspace', workspaceId: recovery.workspace.id });
    }

    // 2. Restore context
    if (recovery.context) {
      plan.push({ action: 'restore_context', contextId: recovery.context.id });
    }

    // 3. Resume running tasks
    for (const task of recovery.taskPlan.running) {
      plan.push({ action: 'resume_task', taskId: task.id, status: task.status });
    }

    // 4. Retry failed tasks
    for (const task of recovery.taskPlan.failed) {
      plan.push({ action: 'retry_task', taskId: task.id, status: task.status });
    }

    // 5. Execute pending tasks
    for (const task of recovery.taskPlan.pending) {
      plan.push({ action: 'execute_task', taskId: task.id, status: task.status });
    }

    // 6. Skip completed/cancelled
    for (const task of recovery.taskPlan.completed) {
      plan.push({ action: 'skip_task', taskId: task.id, reason: 'already completed' });
    }
    for (const task of recovery.taskPlan.cancelled) {
      plan.push({ action: 'skip_task', taskId: task.id, reason: 'was cancelled' });
    }

    return { success: true, plan, recovery };
  }
}

// ── Factory ───────────────────────────────────────────────

function createRecoveryManager(options) {
  return new RecoveryManager(options);
}

export {
  RecoveryManager,
  createRecoveryManager,
};