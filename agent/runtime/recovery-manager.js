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
import { TASK_STATUS } from './task.js';
import { getExecutionOrder, canTaskExecute } from './plan.js';

class RecoveryManager {
  constructor(options = {}) {
    this.emitter = options.emitter || null;
    this.eventStore = options.eventStore || null;
    this.transitionMgr = options.transitionManager || createTransitionManager({
      emitter: options.emitter,
      eventStore: options.eventStore,
    });
    // V1.2.2: Explicit Store dependencies — NOT engine:this
    this.runStore = options.runStore || null;
    this.planStore = options.planStore || null;
    this.taskStore = options.taskStore || null;
    this.workspaceStore = options.workspaceStore || null;
    this.contextMgr = options.contextMgr || null;
    this.taskExecutor = options.taskExecutor || null;
  }

  // ── Full Recovery ──────────────────────────────────────

  /**
   * V1.2.1: Full recovery after runtime crash.
   * Restores Run, Workspace, Context, and validates Task states.
   */
  recover(runId, options = {}) {
    if (!this.eventStore) {
      return { success: false, reason: 'No event store for recovery' };
    }

    // V1.2.3-fix: restore the actual Stores from a crash snapshot when one is
    // supplied. The snapshot IS the crash point — it carries the full Store
    // state, so events are optional (used only for finer crash-point detection
    // when the original EventStore is available). The previous code
    // reconstructed Run + Task entities from sparse events and never restored
    // the Plan — so executeRun() could not find the plan and the Plan lifecycle
    // could not complete.
    if (options.snapshot) {
      const events = this.eventStore.getEventsByRun(runId);
      return this._recoverFromSnapshot(runId, events, options.snapshot);
    }

    const events = this.eventStore.getEventsByRun(runId);
    if (events.length === 0) {
      return { success: false, reason: `No events found for run ${runId}` };
    }

    // Fallback: event-based reconstruction (legacy path, no snapshot available)
    return this._recoverFromEvents(runId, events);
  }

  /**
   * V1.2.3: Restore the full Stores from a crash snapshot.
   *
   * The snapshot carries the serialized RunStore / PlanStore / TaskStore, so
   * every field that event reconstruction would silently drop — the Plan, task
   * Skill bindings, task dependencies, plan dependencies — survives the crash.
   * EventStore is used ONLY to find the crash point (which tasks were RUNNING
   * or FAILED), never to rebuild entities.
   */
  _recoverFromSnapshot(runId, events, snapshot) {
    if (this.runStore && snapshot.runs) this.runStore.restore(snapshot.runs);
    if (this.planStore && snapshot.plans) this.planStore.restore(snapshot.plans);
    if (this.taskStore && snapshot.tasks) this.taskStore.restore(snapshot.tasks);
    // V1.2.3-fix: restore Workspace + Context too. A real Coding Skill reads
    // workspace.rootPath / active files and context.variables during execution;
    // without them the TaskExecutor gets null for both and the recovered
    // Runtime can execute tasks in the dark.
    let workspace = null;
    if (this.workspaceStore && snapshot.workspaces) {
      this.workspaceStore.restore(snapshot.workspaces);
      workspace = this.workspaceStore.get(this.runStore.get(runId)?.workspaceId);
    }
    let context = null;
    if (this.contextMgr && snapshot.contexts) {
      this.contextMgr.deserialize(snapshot.contexts);
      context = this.contextMgr.getByRun(runId);
    }

    const run = this.runStore.get(runId);
    if (!run) {
      return { success: false, reason: `Run ${runId} not in snapshot` };
    }

    // Crash-point detection. EventStore is the primary source (it records the
    // exact moment of the crash), but a fresh Engine instance may not share the
    // original EventStore — in that case the restored TaskStore IS the crash
    // point: any task still RUNNING or FAILED was mid-execution.
    let unfinishedTasks;
    if (events && events.length > 0) {
      unfinishedTasks = this._findUnfinishedTasks(runId, events);
    } else {
      unfinishedTasks = this.taskStore.listByRun(runId).filter(t =>
        t.status === 'running' || t.status === 'failed' || t.status === 'pending'
      );
    }
    const taskPlan = this._categorizeTasks(unfinishedTasks);

    return {
      success: true,
      restored: true,
      run,
      plan: run.planId ? this.planStore.get(run.planId) : null,
      workspace,
      context,
      taskPlan,
      recoveredAt: Date.now(),
    };
  }

  /**
   * V1.2.3: Event-based reconstruction (legacy fallback when no snapshot).
   * Kept for backward compatibility; prefer _recoverFromSnapshot.
   */
  _recoverFromEvents(runId, events) {
    // Step 1: Reconstruct Run state from events
    const run = this._reconstructRun(runId, events);
    if (!run) {
      return { success: false, reason: 'Could not reconstruct run' };
    }

    // Step 2: Restore Workspace
    let workspace = null;
    if (this.workspaceStore) {
      const ws = this.workspaceStore.get(run.workspaceId);
      if (ws) {
        workspace = ws;
      }
    }

    // Step 3: Restore Context
    let context = null;
    if (this.contextMgr) {
      context = this.contextMgr.getByRun(runId);
    }

    // Step 4: Find and validate unfinished tasks
    const unfinishedTasks = this._findUnfinishedTasks(runId, events);

    // Step 5: Categorize tasks
    const taskPlan = this._categorizeTasks(unfinishedTasks);

    // V1.2.3 fix: Persist reconstructed entities back to Stores.
    // The old code called create({ id: ... }) — but RunStore.create expects
    // config.runId, so the run was stored under a random id — and then
    // Object.assign()'d a clone from get(), which never reached the Store.
    // Write reconstructed state through update() so status/planId/taskIds
    // actually land on the entity the caller asked to recover.
    if (this.runStore) {
      if (!this.runStore.has(run.id)) {
        this.runStore.create({
          runId: run.id,
          goal: run.goal,
          workspaceId: run.workspaceId,
          metadata: run.metadata,
        });
      }
      this.runStore.update(run.id, {
        status: run.status,
        planId: run.planId,
        taskIds: run.taskIds,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        failedAt: run.failedAt,
        error: run.error,
        metadata: run.metadata,
        updatedAt: Date.now(),
      });
    }

    // Persist reconstructed tasks back to TaskStore
    if (this.taskStore) {
      for (const task of unfinishedTasks) {
        const assignedSkills = Array.isArray(task.assignedSkills) ? task.assignedSkills : [];
        const dependencies = Array.isArray(task.dependencies) ? task.dependencies : [];
        if (!this.taskStore.has(task.id)) {
          this.taskStore.create({
            id: task.id,
            runId: run.id,
            goal: task.goal || 'Restored Task',
            status: task.status,
            assignedSkills,
            dependencies,
          });
        }
        this.taskStore.update(task.id, {
          status: task.status,
          goal: task.goal || 'Restored Task',
          assignedSkills,
          dependencies,
          error: task.error || null,
          failedAt: task.failedAt || null,
          completedAt: task.completedAt || null,
          updatedAt: Date.now(),
        });
      }
    }

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
   * V1.2.3: Reconstruct Run state from event sequence.
   * Uses run_created for creation, run_started for start.
   */
  _reconstructRun(runId, events) {
    const createdEvent = events.find(e => e.type === 'run_created');
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
          // V1.2.3-fix: task_created now carries the immutable execution
          // definition. Without it a recovered task has no Skill binding and
          // TaskExecutor skips real execution, marking the task COMPLETED
          // without ever running the coding Skill — a dangerous false positive.
          taskMap.get(taskId).assignedSkills = Array.isArray(event.data?.assignedSkills)
            ? event.data.assignedSkills
            : [];
          taskMap.get(taskId).dependencies = Array.isArray(event.data?.dependencies)
            ? event.data.dependencies
            : [];
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
   * V1.2.3: Resume execution after crash recovery.
   * Uses TaskExecutor directly — no dependency on entire ExecutionEngine.
   * Mutates Store state before resuming execution.
   */
  async resumeAfterCrash(runId, options = {}) {
    const recovery = this.recover(runId, options);
    if (!recovery.success) return recovery;

    const actions = [];

    // ── V1.2.3: Mutate Store state before resuming ──

    // 1. RUNNING tasks → requeue to PENDING in TaskStore
    for (const task of recovery.taskPlan.running) {
      this.taskStore.update(task.id, {
        status: 'pending',
        error: null,
        failedAt: null,
        updatedAt: Date.now(),
      });
      actions.push({ action: 'requeue_task', taskId: task.id, from: 'running', to: 'pending' });
    }

    // 2. FAILED tasks → reset to PENDING in TaskStore (for retry)
    for (const task of recovery.taskPlan.failed) {
      this.taskStore.update(task.id, {
        status: 'pending',
        error: null,
        failedAt: null,
        updatedAt: Date.now(),
      });
      actions.push({ action: 'retry_task', taskId: task.id, from: 'failed', to: 'pending' });
    }

    // 3. PENDING tasks — already correct, just execute
    for (const task of recovery.taskPlan.pending) {
      actions.push({ action: 'execute_task', taskId: task.id, status: 'pending' });
    }

    // 4. COMPLETED / CANCELLED — skip
    for (const task of recovery.taskPlan.completed) {
      actions.push({ action: 'skip_task', taskId: task.id, reason: 'already completed' });
    }
    for (const task of recovery.taskPlan.cancelled) {
      actions.push({ action: 'skip_task', taskId: task.id, reason: 'was cancelled' });
    }

    // ── V1.2.3: Execute through TaskExecutor if available ──
    if (this.taskExecutor) {
      const allTasks = [
        ...recovery.taskPlan.running,
        ...recovery.taskPlan.failed,
        ...recovery.taskPlan.pending,
      ];

      // V1.2.3-fix: order execution by the restored Plan's dependency graph.
      // The old code iterated the categorised arrays in fixed order (running,
      // failed, pending) and ignored task dependencies entirely — a task whose
      // dependency had not yet completed could be executed out of order.
      // If the legacy event path produced no Plan, build a minimal one so the
      // dependency check still runs (with no edges → nothing is blocked).
      const plan = recovery.plan || {
        tasks: allTasks.map(t => ({ id: t.id })),
        dependencies: [],
      };
      const order = getExecutionOrder(plan);
      const orderIndex = new Map(order.map((id, i) => [id, i]));
      allTasks.sort((a, b) => (orderIndex.get(a.id) ?? Infinity) - (orderIndex.get(b.id) ?? Infinity));

      for (const task of allTasks) {
        // Re-read from Store to get updated state
        const storedTask = this.taskStore.get(task.id);
        if (!storedTask || storedTask.status !== 'pending') continue;

        // V1.2.3-fix: topological order only guarantees A runs before B — it does
        // not guarantee A SUCCEEDED before B runs. Check dependency satisfaction
        // explicitly so a missing or failed dependency blocks execution instead of
        // letting B run against a half-baked predecessor.
        const taskStatusMap = new Map(
          this.taskStore.listByRun(runId).map(t => [t.id, t.status])
        );
        const { canExecute, blockedBy } = canTaskExecute(
          plan, task.id, taskStatusMap
        );
        if (!canExecute) {
          actions.push({
            action: 'blocked_task',
            taskId: task.id,
            blockedBy: blockedBy.map(b => `${b.taskId}=${b.status}`),
          });
          continue;
        }

        const result = await this.taskExecutor.execute(storedTask, {
          runId,
          workspaceId: recovery.run?.workspaceId,
        });
        actions.push({
          action: 'executed_task',
          taskId: task.id,
          success: result.success,
          status: result.task?.status,
        });
      }
    }

    return {
      success: true,
      recovery,
      actions,
      resumedAt: Date.now(),
    };
  }

  /**
   * V1.2.1: Get recovery plan — ordered list of actions.
   * V1.2.3-fix: accept the same options as recover() so the snapshot path is
   * reachable from here too. The old signature called recover(runId) with no
   * options, so getRecoveryPlan() always fell back to the degraded legacy path.
   */
  getRecoveryPlan(runId, options = {}) {
    const recovery = this.recover(runId, options);
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