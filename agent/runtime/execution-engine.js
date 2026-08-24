/**
 * agent/runtime/execution-engine.js — Runtime Execution Engine
 *
 * V1.2.1
 * - Unified entry point for Agent execution
 * - Orchestrates: Run → Workspace → Context → Plan → Task → Skill → Tool → Artifact
 * - Delegates to: RunManager, TaskExecutor, RecoveryManager, TransitionManager
 * - No new Runtime concepts introduced
 *
 * Design:
 *   ExecutionEngine is the ORCHESTRATOR only.
 *   State storage is owned by the engine (runs/plans/tasks Maps).
 *   Lifecycle logic is delegated to RunManager/TaskExecutor.
 *   Transitions are validated by TransitionManager.
 *   Recovery is handled by RecoveryManager.
 */

import { RUNTIME_EVENT_TYPES } from './events.js';
import {
  createPlan,
  approvePlan,
  startPlan,
  completePlan,
  failPlan,
  cancelPlan,
  PLAN_STATUS,
  getExecutionOrder,
} from './plan.js';
import {
  createTask,
  startTask,
  completeTask,
  failTask,
  cancelTask,
  supersedeTask,
  startTaskVerification,
  TASK_STATUS,
  TASK_TRANSITIONS,
  canTransitionTask,
} from './task.js';
import {
  TaskScheduler,
  createScheduler,
} from './scheduler.js';
import {
  SkillRuntime,
  createSkillRuntime,
} from './skill-runtime.js';
import {
  WorkspaceStore,
  createWorkspaceStore,
} from './workspace-store.js';
import {
  ContextManager,
  createContextManager,
} from './context-manager.js';
import {
  ArtifactStore,
  createArtifactStore,
} from './artifact-store.js';
import {
  CapabilityRegistry,
  createCapabilityRegistry,
} from './capability.js';
import {
  ToolRegistry,
  createToolRegistry,
} from './tool-registry.js';
import {
  RuntimeSandbox,
  createDefaultSandbox,
} from './sandbox.js';
import {
  GovernanceManager,
  createGovernanceManager,
  createPolicy,
} from './governance.js';
import {
  RuntimeEventStore,
  createEventStore,
} from './event-store.js';
import {
  TransitionManager,
  createTransitionManager,
} from './transition-manager.js';
import {
  RunManager,
  createRunManager,
  RUN_STATUS,
} from './run-manager.js';
import {
  TaskExecutor,
  createTaskExecutor,
} from './task-executor.js';
import {
  RecoveryManager,
  createRecoveryManager,
} from './recovery-manager.js';

// ── Execution Engine ──────────────────────────────────────

class ExecutionEngine {
  constructor(options = {}) {
    // Core components
    this.workspaceStore = options.workspaceStore || createWorkspaceStore(options);
    this.contextMgr = options.contextMgr || createContextManager({
      emitter: options.emitter,
      workspaceRegistry: this.workspaceStore,
    });
    this.artifactStore = options.artifactStore || createArtifactStore({
      emitter: options.emitter,
      workspaceRegistry: this.workspaceStore,
    });
    this.capabilityRegistry = options.capabilityRegistry || createCapabilityRegistry(options);
    this.toolRegistry = options.toolRegistry || createToolRegistry({
      capabilityRegistry: this.capabilityRegistry,
      emitter: options.emitter,
    });
    this.skillRuntime = options.skillRuntime || createSkillRuntime({
      capabilityRegistry: this.capabilityRegistry,
      toolRegistry: this.toolRegistry,
      emitter: options.emitter,
      sandbox: options.sandbox || createDefaultSandbox('/workspace'),
    });
    this.scheduler = options.scheduler || createScheduler({
      planRuntime: options.planRuntime,
      taskRuntime: options.taskRuntime,
    });
    this.governance = options.governance || createGovernanceManager(options);
    this.eventStore = options.eventStore || createEventStore(options);
    this.emitter = options.emitter || null;

    // V1.2.1: Shared TransitionManager
    this.transitionMgr = options.transitionManager || createTransitionManager({
      emitter: this.emitter,
      eventStore: this.eventStore,
    });

    // V1.2.1: Sub-managers (delegate lifecycle logic)
    this.runMgr = options.runManager || createRunManager({
      emitter: this.emitter,
      eventStore: this.eventStore,
      transitionManager: this.transitionMgr,
      engine: this,
    });
    this.taskExecutor = options.taskExecutor || createTaskExecutor({
      emitter: this.emitter,
      eventStore: this.eventStore,
      transitionManager: this.transitionMgr,
      skillRuntime: this.skillRuntime,
      artifactStore: this.artifactStore,
      workspaceStore: this.workspaceStore,
      contextMgr: this.contextMgr,
    });
    this.recoveryMgr = options.recoveryManager || createRecoveryManager({
      emitter: this.emitter,
      eventStore: this.eventStore,
      transitionManager: this.transitionMgr,
      engine: this,
    });

    // V1.2.1: State storage (owned by engine, not duplicated)
    this.runs = new Map();
    this.plans = new Map();
    this.tasks = new Map();
    this.activeRunId = null;
  }

  // ═══════════════════════════════════════════════════════════
  // Run Lifecycle (delegated to RunManager)
  // ═══════════════════════════════════════════════════════════

  /**
   * V1.2.1: Create a new Run.
   */
  createRun(config = {}) {
    const result = this.runMgr.create(config);
    if (!result.run) return result;

    this.runs.set(result.run.id, result.run);

    return { success: true, run: result.run, workspace: result.workspace };
  }

  /**
   * V1.2.1: Start a Run.
   */
  startRun(runId) {
    const run = this.runs.get(runId);
    if (!run) return { success: false, reason: `Run ${runId} not found` };

    const result = this.runMgr.start(run);
    if (!result.success) return result;

    this.plans.set(result.plan.id, result.plan);
    this.activeRunId = runId;

    return { success: true, run: result.run, plan: result.plan };
  }

  /**
   * V1.2.1: Pause a Run.
   */
  pauseRun(runId) {
    const run = this.runs.get(runId);
    if (!run) return { success: false, reason: `Run ${runId} not found` };

    return this.runMgr.pause(run);
  }

  /**
   * V1.2.1: Resume a Run.
   */
  resumeRun(runId) {
    const run = this.runs.get(runId);
    if (!run) return { success: false, reason: `Run ${runId} not found` };

    const result = this.runMgr.resume(run);
    if (result.success) this.activeRunId = runId;
    return result;
  }

  /**
   * V1.2.1: Complete a Run.
   */
  completeRun(runId) {
    const run = this.runs.get(runId);
    if (!run) return { success: false, reason: `Run ${runId} not found` };

    const result = this.runMgr.complete(run);
    if (!result.success) return result;

    // Complete plan
    if (run.planId) {
      const plan = this.plans.get(run.planId);
      if (plan && plan.status === PLAN_STATUS.EXECUTING) {
        completePlan(plan, this.emitter, { runId });
      }
    }

    return result;
  }

  /**
   * V1.2.1: Fail a Run.
   */
  failRun(runId, error) {
    const run = this.runs.get(runId);
    if (!run) return { success: false, reason: `Run ${runId} not found` };

    const result = this.runMgr.fail(run, error);
    if (!result.success) return result;

    // Fail plan
    if (run.planId) {
      const plan = this.plans.get(run.planId);
      if (plan) {
        failPlan(plan, this.emitter, { runId, error });
      }
    }

    return result;
  }

  /**
   * V1.2.1: Cancel a Run.
   */
  cancelRun(runId) {
    const run = this.runs.get(runId);
    if (!run) return { success: false, reason: `Run ${runId} not found` };

    const result = this.runMgr.cancel(run);
    if (!result.success) return result;

    // Cancel plan
    if (run.planId) {
      const plan = this.plans.get(run.planId);
      if (plan) {
        cancelPlan(plan, this.emitter, { runId });
      }
    }

    return result;
  }

  // ═══════════════════════════════════════════════════════════
  // Task Management
  // ═══════════════════════════════════════════════════════════

  /**
   * V1.2.1: Add a task to a run.
   */
  addTask(runId, taskConfig) {
    const run = this.runs.get(runId);
    if (!run) return { success: false, reason: `Run ${runId} not found` };

    const task = createTask(runId, taskConfig.goal, {
      id: taskConfig.id,
      assignedSkills: taskConfig.assignedSkills || (taskConfig.skillId ? [taskConfig.skillId] : []),
      dependencies: taskConfig.dependencies || [],
    });
    this.tasks.set(task.id, task);
    run.taskIds.push(task.id);

    if (this.emitter) {
      this.emitter.emit({
        runId,
        workspaceId: run.workspaceId,
        taskId: task.id,
        type: 'task_created',
        data: { taskId: task.id, goal: task.goal },
      });
    }

    return { success: true, task };
  }

  /**
   * V1.2.1: Execute a single task.
   */
  async executeTask(taskId, context = {}) {
    const task = this.tasks.get(taskId);
    if (!task) return { success: false, reason: `Task ${taskId} not found` };

    const run = this.runs.get(task.runId);
    if (!run) return { success: false, reason: `Run ${task.runId} not found` };

    // Delegate to TaskExecutor
    const result = await this.taskExecutor.execute(task, {
      ...context,
      workspaceId: run.workspaceId,
    });

    return result;
  }

  /**
   * V1.2.1: Execute all ready tasks in a run.
   */
  async executeRun(runId) {
    const run = this.runs.get(runId);
    if (!run) return { success: false, reason: `Run ${runId} not found` };
    if (run.status !== RUN_STATUS.STARTED) {
      return { success: false, reason: `Run must be started: ${run.status}` };
    }

    const plan = this.plans.get(run.planId);
    if (!plan) return { success: false, reason: `Plan not found` };

    const order = getExecutionOrder(plan);
    const results = [];

    for (const taskId of order) {
      const task = this.tasks.get(taskId);
      if (!task) continue;
      if (task.status !== TASK_STATUS.PENDING) continue;

      const result = await this.executeTask(taskId, {});
      results.push({ taskId, ...result });

      if (!result.success) {
        return { success: false, results, reason: `Task ${taskId} failed` };
      }
    }

    const allComplete = results.every(r => r.success);
    if (allComplete && results.length > 0) {
      this.completeRun(runId);
    }

    return { success: allComplete, results };
  }

  // ═══════════════════════════════════════════════════════════
  // Recovery (delegated to RecoveryManager)
  // ═══════════════════════════════════════════════════════════

  /**
   * V1.2.1: Full recovery after crash.
   */
  recover(runId) {
    return this.recoveryMgr.recover(runId);
  }

  /**
   * V1.2.1: Get recovery plan.
   */
  getRecoveryPlan(runId) {
    return this.recoveryMgr.getRecoveryPlan(runId);
  }

  /**
   * V1.2.1: Resume after failure.
   */
  async resumeAfterFailure(runId) {
    const run = this.runs.get(runId);
    if (!run) return { success: false, reason: `Run ${runId} not found` };
    if (run.status !== RUN_STATUS.FAILED) {
      return { success: false, reason: `Run must be failed: ${run.status}` };
    }

    // Reset run to started
    run.status = RUN_STATUS.STARTED;
    run.error = null;
    run.failedAt = null;
    run.updatedAt = Date.now();

    // Reset failed tasks
    const failedTasks = Array.from(this.tasks.values())
      .filter(t => t.runId === runId && t.status === TASK_STATUS.FAILED);
    for (const task of failedTasks) {
      task.status = TASK_STATUS.PENDING;
      task.error = null;
      task.failedAt = null;
    }

    if (this.emitter) {
      this.emitter.emit({
        runId,
        workspaceId: run.workspaceId,
        type: 'run_resumed',
        data: { runId, reason: 'failure_recovery' },
      });
    }

    return this.executeRun(runId);
  }

  // ═══════════════════════════════════════════════════════════
  // Query
  // ═══════════════════════════════════════════════════════════

  getRun(runId) { return this.runs.get(runId) || null; }
  getTask(taskId) { return this.tasks.get(taskId) || null; }
  getPlan(planId) { return this.plans.get(planId) || null; }
  listRuns() { return Array.from(this.runs.values()); }

  getActiveRun() {
    if (!this.activeRunId) return null;
    return this.runs.get(this.activeRunId) || null;
  }

  getRunSummary(runId) {
    const run = this.runs.get(runId);
    if (!run) return null;
    const tasks = Array.from(this.tasks.values()).filter(t => t.runId === runId);
    const plan = run.planId ? this.plans.get(run.planId) : null;
    return {
      run,
      taskCount: tasks.length,
      completedTasks: tasks.filter(t => t.status === 'completed').length,
      failedTasks: tasks.filter(t => t.status === 'failed').length,
      plan,
    };
  }
}

// ── Factory ───────────────────────────────────────────────

function createExecutionEngine(options) {
  return new ExecutionEngine(options);
}

export {
  RUN_STATUS,
  ExecutionEngine,
  createExecutionEngine,
};