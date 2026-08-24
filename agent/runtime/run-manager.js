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
    });
    // V1.2.1: Run state is owned by ExecutionEngine, not duplicated here
    this.engine = options.engine || null;
  }

  // ── Lifecycle ──────────────────────────────────────────

  /**
   * V1.2.1: Create a new Run.
   * Returns { run, workspace, plan }
   */
  create(config = {}) {
    const runId = config.runId || `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const goal = config.goal || 'Untitled Run';

    // Create workspace via engine
    let workspace = null;
    if (this.engine) {
      const wsResult = this.engine.workspaceStore.create({
        name: `run_${runId}`,
        runId,
      });
      if (wsResult.success) workspace = wsResult.workspace;
    }

    // Create context via engine
    if (this.engine && workspace) {
      this.engine.contextMgr.createForRun(runId, workspace.id);
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

    // Emit creation event
    if (this.emitter) {
      this.emitter.emit({
        runId,
        workspaceId: run.workspaceId,
        type: 'run_started',
        data: { runId, goal, workspaceId: run.workspaceId },
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

    // Transition through TransitionManager
    const result = this.transitionMgr.transitionRun(
      run.id, RUN_STATUS.CREATED, RUN_STATUS.STARTED,
      { runId: run.id, workspaceId: run.workspaceId, ...config }
    );

    if (!result.success) {
      return result;
    }

    // Update run state
    run.status = RUN_STATUS.STARTED;
    run.startedAt = Date.now();
    run.updatedAt = Date.now();

    // Create plan
    const plan = createPlan(run.id, run.goal, {
      tasks: run.taskIds.map(id => ({ taskId: id })),
    });
    run.planId = plan.id;

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

    run.status = RUN_STATUS.PAUSED;
    run.updatedAt = Date.now();

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

    run.status = RUN_STATUS.STARTED;
    run.updatedAt = Date.now();

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

    run.status = RUN_STATUS.COMPLETED;
    run.completedAt = Date.now();
    run.updatedAt = Date.now();

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

    run.status = RUN_STATUS.FAILED;
    run.error = error;
    run.failedAt = Date.now();
    run.updatedAt = Date.now();

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

    run.status = RUN_STATUS.CANCELLED;
    run.updatedAt = Date.now();

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