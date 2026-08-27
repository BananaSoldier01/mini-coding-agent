/**
 * agent/runtime/run-manager.js — Run Lifecycle Manager
 *
 * V1.2.1
 * - Run lifecycle: create/start/pause/resume/complete/fail/cancel
 * - Uses TransitionManager for state transitions
 * - Does NOT store Run state directly — delegates to ExecutionEngine
 *
 * Design:
 *   RunManager is responsible for Run lifecycle logic.
 *   State storage is owned by ExecutionEngine.
 *   All transitions go through TransitionManager.
 */

import { TransitionManager, createTransitionManager } from './transition-manager.js';
import { createPlan } from './plan.js';

const RUN_STATUS = {
  CREATED: 'created',
  STARTED: 'started',
  PAUSED: 'paused',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
};

class RunManager {
  constructor(options = {}) {
    this.emitter = options.emitter || null;
    this.eventStore = options.eventStore || null;
    this.transitionMgr = options.transitionManager || createTransitionManager({
      emitter: options.emitter,
      eventStore: options.eventStore,
      runStore: options.runStore,
      taskStore: options.taskStore,
      planStore: options.planStore,
      workspaceStore: options.workspaceStore,
    });
    // V1.2.2: Explicit Store dependencies — NOT engine:this
    this.runStore = options.runStore || null;
    this.workspaceStore = options.workspaceStore || null;
    this.contextMgr = options.contextMgr || null;
    // V1.2.3 fix: planStore was referenced in start() but never assigned,
    // so the plan-persistence block was silently dead. Wire it explicitly.
    this.planStore = options.planStore || null;
  }

  // ── Lifecycle ──────────────────────────────────────────

  /**
   * V1.2.3: Create a new Run.
   * Emits run_created (NOT run_started) — startRun() will emit run_started.
   * Returns { run, workspace, plan }
   */
  create(config = {}) {
    const runId = config.runId || `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const goal = config.goal || 'Untitled Run';

    // Create workspace via workspaceStore
    let workspace = null;
    if (this.workspaceStore) {
      const wsResult = this.workspaceStore.create({
        name: `run_${runId}`,
        runId,
      });
      if (wsResult.success) workspace = wsResult.workspace;
    }

    // Create context via contextMgr
    if (this.contextMgr && workspace) {
      this.contextMgr.createForRun(runId, workspace.id);
    }

    // Build run object
    const run = {
      id: runId,
      goal,
      status: RUN_STATUS.CREATED,
      workspaceId: workspace ? workspace.id : null,
      planId: null,
      taskIds: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      startedAt: null,
      completedAt: null,
      failedAt: null,
      error: null,
      metadata: config.metadata || {},
    };

    // V1.2.3: Emit run_created — distinct from run_started (emitted by startRun)
    if (this.emitter) {
      this.emitter.emit({
        runId,
        workspaceId: run.workspaceId,
        type: 'run_created',
        data: { runId, goal, workspaceId: run.workspaceId },
      });
    }

    // Persist to RunStore
    if (this.runStore) {
      this.runStore.create({
        runId: run.id,
        goal: run.goal,
        workspaceId: run.workspaceId,
        metadata: run.metadata,
      });
    }

    return { run, workspace };
  }

  /**
   * V1.2.1: Start a Run — transition CREATED → STARTED.
   */
  start(run, config = {}) {
    if (run.status !== RUN_STATUS.CREATED) {
      return { success: false, reason: `Cannot start run in status: ${run.status}` };
    }

    // Transition through TransitionManager — single event emission point
    const result = this.transitionMgr.transitionRun(
      run.id, RUN_STATUS.CREATED, RUN_STATUS.STARTED,
      { runId: run.id, workspaceId: run.workspaceId, ...config }
    );

    if (!result.success) {
      return result;
    }

    // V1.2.3: TransitionManager already mutated Store and emitted event.
    // Sync local run object from Store.
    const updatedRun = this.runStore.get(run.id);
    if (updatedRun) {
      run.status = updatedRun.status;
      run.startedAt = updatedRun.startedAt;
      run.updatedAt = updatedRun.updatedAt;
    }

    // Create plan
    const plan = createPlan(run.id, run.goal, {
      // V1.2.3 fix: getExecutionOrder() reads task.id, not task.taskId.
      tasks: run.taskIds.map(id => ({ id })),
    });
    run.planId = plan.id;

    // V1.2.3 fix: run is a clone from runStore.get(); without this writeback
    // the RunStore row keeps planId=null and executeRun() cannot find the plan.
    if (this.runStore) {
      this.runStore.update(run.id, { planId: plan.id });
    }

    // Persist the full plan to PlanStore (createPlan already populated
    // tasks/dependencies/evidenceRefs/revisions — don't drop them).
    if (this.planStore) {
      this.planStore.create(plan);
    }

    // Emit plan_created event
    if (this.emitter) {
      this.emitter.emit({
        runId: run.id,
        workspaceId: run.workspaceId,
        planId: plan.id,
        type: 'plan_created',
        data: { planId: plan.id, goal: run.goal },
      });
    }

    return { success: true, run, plan, event: result.event };
  }

  /**
   * V1.2.1: Pause a Run — STARTED → PAUSED.
   */
  pause(run, config = {}) {
    if (run.status !== RUN_STATUS.STARTED) {
      return { success: false, reason: `Cannot pause run in status: ${run.status}` };
    }

    const result = this.transitionMgr.transitionRun(
      run.id, RUN_STATUS.STARTED, RUN_STATUS.PAUSED,
      { runId: run.id, workspaceId: run.workspaceId, ...config }
    );

    if (!result.success) return result;

    // V1.2.3: Sync from Store (TransitionManager already mutated)
    const updated = this.runStore.get(run.id);
    if (updated) { run.status = updated.status; run.updatedAt = updated.updatedAt; }

    return { success: true, run, event: result.event };
  }

  /**
   * V1.2.1: Resume a Run — PAUSED → STARTED.
   */
  resume(run, config = {}) {
    if (run.status !== RUN_STATUS.PAUSED) {
      return { success: false, reason: `Cannot resume run in status: ${run.status}` };
    }

    const result = this.transitionMgr.transitionRun(
      run.id, RUN_STATUS.PAUSED, RUN_STATUS.STARTED,
      { runId: run.id, workspaceId: run.workspaceId, ...config }
    );

    if (!result.success) return result;

    // V1.2.3: Sync from Store
    const updated = this.runStore.get(run.id);
    if (updated) { run.status = updated.status; run.updatedAt = updated.updatedAt; }

    return { success: true, run, event: result.event };
  }

  /**
   * V1.2.1: Complete a Run — STARTED → COMPLETED.
   */
  complete(run, config = {}) {
    if (run.status !== RUN_STATUS.STARTED) {
      return { success: false, reason: `Cannot complete run in status: ${run.status}` };
    }

    const result = this.transitionMgr.transitionRun(
      run.id, RUN_STATUS.STARTED, RUN_STATUS.COMPLETED,
      { runId: run.id, workspaceId: run.workspaceId, ...config }
    );

    if (!result.success) return result;

    // V1.2.3: Sync from Store
    const updated = this.runStore.get(run.id);
    if (updated) {
      run.status = updated.status;
      run.completedAt = updated.completedAt;
      run.updatedAt = updated.updatedAt;
    }

    return { success: true, run, event: result.event };
  }

  /**
   * V1.2.1: Fail a Run — STARTED/PAUSED → FAILED.
   */
  fail(run, error, config = {}) {
    if (run.status === RUN_STATUS.COMPLETED || run.status === RUN_STATUS.CANCELLED) {
      return { success: false, reason: `Cannot fail run in status: ${run.status}` };
    }

    const result = this.transitionMgr.transitionRun(
      run.id, run.status, RUN_STATUS.FAILED,
      { runId: run.id, workspaceId: run.workspaceId, ...config, data: { error: error?.message } }
    );

    if (!result.success) return result;

    // V1.2.3: Sync from Store
    const updated = this.runStore.get(run.id);
    if (updated) {
      run.status = updated.status;
      run.error = updated.error;
      run.failedAt = updated.failedAt;
      run.updatedAt = updated.updatedAt;
    }

    return { success: true, run, event: result.event };
  }

  /**
   * V1.2.1: Cancel a Run — → CANCELLED.
   */
  cancel(run, config = {}) {
    if (run.status === RUN_STATUS.COMPLETED || run.status === RUN_STATUS.FAILED || run.status === RUN_STATUS.CANCELLED) {
      return { success: false, reason: `Cannot cancel run in status: ${run.status}` };
    }

    const result = this.transitionMgr.transitionRun(
      run.id, run.status, RUN_STATUS.CANCELLED,
      { runId: run.id, workspaceId: run.workspaceId, ...config }
    );

    if (!result.success) return result;

    // V1.2.3: Sync from Store
    const updated = this.runStore.get(run.id);
    if (updated) { run.status = updated.status; run.updatedAt = updated.updatedAt; }

    return { success: true, run, event: result.event };
  }

  // ── Query ──────────────────────────────────────────────

  /**
   * V1.2.1: Check if run can transition.
   */
  canTransition(run, toStatus) {
    return this.transitionMgr.canTransition('run', run.status, toStatus);
  }
}

// ── Factory ───────────────────────────────────────────────

function createRunManager(options) {
  return new RunManager(options);
}

export {
  RUN_STATUS,
  RunManager,
  createRunManager,
};