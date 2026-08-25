/**
 * agent/runtime/execution-engine.js — Runtime Execution Engine
 *
 * V1.2.2
 * - Unified entry point for Agent execution
 * - Orchestrates: Run → Workspace → Context → Plan → Task → Skill → Tool → Artifact
 * - State is owned by Store layer (RunStore/PlanStore/TaskStore), NOT duplicated here
 * - Delegates to: RunManager, TaskExecutor, RecoveryManager, TransitionManager
 *
 * Design:
 *   ExecutionEngine is the ORCHESTRATOR only.
 *   It does NOT store entity state — that's the Store layer's job.
 *   It holds references to Stores and Managers.
 *   All state transitions go through TransitionManager.
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
  TASK_STATUS,
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
import {
  RunStore,
  createRunStore,
} from './run-store.js';
import {
  PlanStore,
  createPlanStore,
} from './plan-store.js';
import {
  TaskStore,
  createTaskStore,
} from './task-store.js';

// ── Execution Engine ──────────────────────────────────────

class ExecutionEngine {
  constructor(options = {}) {
    // V1.2.2: Store layer — Source of Truth for entity state
    this.runStore = options.runStore || createRunStore({
      emitter: options.emitter,
      eventStore: options.eventStore,
    });
    this.planStore = options.planStore || createPlanStore({
      emitter: options.emitter,
      eventStore: options.eventStore,
    });
    this.taskStore = options.taskStore || createTaskStore({
      emitter: options.emitter,
      eventStore: options.eventStore,
    });

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

    // V1.2.2: Shared TransitionManager — single entry for all state transitions
    this.transitionMgr = options.transitionManager || createTransitionManager({
      emitter: this.emitter,
      eventStore: this.eventStore,
    });

    // V1.2.2: Sub-managers — pass explicit Store dependencies, NOT engine:this
    this.runMgr = options.runManager || createRunManager({
      emitter: this.emitter,
      eventStore: this.eventStore,
      transitionManager: this.transitionMgr,
      runStore: this.runStore,
      workspaceStore: this.workspaceStore,
      contextMgr: this.contextMgr,
    });
    this.taskExecutor = options.taskExecutor || createTaskExecutor({
      emitter: this.emitter,
      eventStore: this.eventStore,
      transitionManager: this.transitionMgr,
      skillRuntime: this.skillRuntime,
      artifactStore: this.artifactStore,
      workspaceStore: this.workspaceStore,
      contextMgr: this.contextMgr,
      taskStore: this.taskStore,
    });
    this.recoveryMgr = options.recoveryManager || createRecoveryManager({
      emitter: this.emitter,
      eventStore: this.eventStore,
      transitionManager: this.transitionMgr,
      runStore: this.runStore,
      planStore: this.planStore,
      taskStore: this.taskStore,
      workspaceStore: this.workspaceStore,
      contextMgr: this.contextMgr,
    });

    // V1.2.2: Active run tracking (reference only, not state storage)
    this.activeRunId = null;
  }

  // ═══════════════════════════════════════════════════════════
  // Run Lifecycle (delegated to RunManager, state in RunStore)
  // ═══════════════════════════════════════════════════════════

  /**
   * V1.2.2: Create a new Run.
   */
  createRun(config = {}) {
    const result = this.runMgr.create(config);
    if (!result.run) return result;

    // Persist to RunStore
    this.runStore.create({
      runId: result.run.id,
      goal: result.run.goal,
      workspaceId: result.run.workspaceId,
      metadata: result.run.metadata,
    });

    return { success: true, run: result.run, workspace: result.workspace };
  }

  /**
   * V1.2.2: Start a Run.
   */
  startRun(runId) {
    const run = this.runStore.get(runId);
    if (!run) return { success: false, reason: `Run ${runId} not found` };

    const result = this.runMgr.start(run);
    if (!result.success) return result;

    // Store plan in PlanStore
    this.planStore.create(result.plan);
    this.activeRunId = runId;

    return { success: true, run: result.run, plan: result.plan };
  }

  /**
   * V1.2.2: Pause a Run.
   */
  pauseRun(runId) {
    const run = this.runStore.get(runId);
    if (!run) return { success: false, reason: `Run ${runId} not found` };
    return this.runMgr.pause(run);
  }

  /**
   * V1.2.2: Resume a Run.
   */
  resumeRun(runId) {
    const run = this.runStore.get(runId);
    if (!run) return { success: false, reason: `Run ${runId} not found` };
    const result = this.runMgr.resume(run);
    if (result.success) this.activeRunId = runId;
    return result;
  }

  /**
   * V1.2.2: Complete a Run.
   */
  completeRun(runId) {
    const run = this.runStore.get(runId);
    if (!run) return { success: false, reason: `Run ${runId} not found` };

    const result = this.runMgr.complete(run);
    if (!result.success) return result;

    // Complete plan in PlanStore
    if (run.planId) {
      const plan = this.planStore.get(run.planId);
      if (plan && plan.status === PLAN_STATUS.EXECUTING) {
        completePlan(plan, this.emitter, { runId });
        this.planStore.update(run.planId, plan);
      }
    }

    return result;
  }

  /**
   * V1.2.2: Fail a Run.
   */
  failRun(runId, error) {
    const run = this.runStore.get(runId);
    if (!run) return { success: false, reason: `Run ${runId} not found` };

    const result = this.runMgr.fail(run, error);
    if (!result.success) return result;

    if (run.planId) {
      const plan = this.planStore.get(run.planId);
      if (plan) {
        failPlan(plan, this.emitter, { runId, error });
        this.planStore.update(run.planId, plan);
      }
    }

    return result;
  }

  /**
   * V1.2.2: Cancel a Run.
   */
  cancelRun(runId) {
    const run = this.runStore.get(runId);
    if (!run) return { success: false, reason: `Run ${runId} not found` };

    const result = this.runMgr.cancel(run);
    if (!result.success) return result;

    if (run.planId) {
      const plan = this.planStore.get(run.planId);
      if (plan) {
        cancelPlan(plan, this.emitter, { runId });
        this.planStore.update(run.planId, plan);
      }
    }

    return result;
  }

  // ═══════════════════════════════════════════════════════════
  // Task Management (state in TaskStore)
  // ═══════════════════════════════════════════════════════════

  /**
   * V1.2.2: Add a task to a run.
   */
  addTask(runId, taskConfig) {
    const run = this.runStore.get(runId);
    if (!run) return { success: false, reason: `Run ${runId} not found` };

    const task = createTask(runId, taskConfig.goal, {
      id: taskConfig.id,
      assignedSkills: taskConfig.assignedSkills || (taskConfig.skillId ? [taskConfig.skillId] : []),
      dependencies: taskConfig.dependencies || [],
    });

    const result = this.taskStore.create(task);
    if (!result.success) return result;

    // Add to run's task list
    run.taskIds.push(task.id);
    this.runStore.update(runId, run);

    if (this.emitter) {
      this.emitter.emit({
        runId,
        workspaceId: run.workspaceId,
        taskId: task.id,
        type: 'task_created',
        data: { taskId: task.id, goal: task.goal },
      });
    }

    return { success: true, task: result.task };
  }

  /**
   * V1.2.2: Execute a single task.
   */
  async executeTask(taskId, context = {}) {
    const task = this.taskStore.get(taskId);
    if (!task) return { success: false, reason: `Task ${taskId} not found` };

    const run = this.runStore.get(task.runId);
    if (!run) return { success: false, reason: `Run ${task.runId} not found` };

    const result = await this.taskExecutor.execute(task, {
      ...context,
      workspaceId: run.workspaceId,
    });

    // Update task in store
    if (result.task) {
      this.taskStore.update(taskId, result.task);
    }

    return result;
  }

  /**
   * V1.2.2: Execute all ready tasks in a run.
   */
  async executeRun(runId) {
    const run = this.runStore.get(runId);
    if (!run) return { success: false, reason: `Run ${runId} not found` };
    if (run.status !== RUN_STATUS.STARTED) {
      return { success: false, reason: `Run must be started: ${run.status}` };
    }

    const plan = this.planStore.get(run.planId);
    if (!plan) return { success: false, reason: `Plan not found` };

    const order = getExecutionOrder(plan);
    const results = [];

    for (const taskId of order) {
      const task = this.taskStore.get(taskId);
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
  // Recovery (delegated to RecoveryManager, uses Stores)
  // ═══════════════════════════════════════════════════════════

  /**
   * V1.2.2: Full recovery after crash.
   */
  recover(runId) {
    return this.recoveryMgr.recover(runId);
  }

  /**
   * V1.2.2: Get recovery plan.
   */
  getRecoveryPlan(runId) {
    return this.recoveryMgr.getRecoveryPlan(runId);
  }

  /**
   * V1.2.2: Get recovery plan with execution resumption.
   */
  async resumeAfterCrash(runId) {
    const result = await this.recoveryMgr.resumeAfterCrash(runId, this);
    return result;
  }

  // ═══════════════════════════════════════════════════════════
  // Query (all from Store layer)
  // ═══════════════════════════════════════════════════════════

  getRun(runId) { return this.runStore.get(runId); }
  getTask(taskId) { return this.taskStore.get(taskId); }
  getPlan(planId) { return this.planStore.get(planId); }
  listRuns() { return this.runStore.list(); }

  getActiveRun() {
    if (!this.activeRunId) return null;
    return this.runStore.get(this.activeRunId);
  }

  getRunSummary(runId) {
    const run = this.runStore.get(runId);
    if (!run) return null;
    const tasks = this.taskStore.listByRun(runId);
    const plan = run.planId ? this.planStore.get(run.planId) : null;
    return {
      run,
      taskCount: tasks.length,
      completedTasks: tasks.filter(t => t.status === 'completed').length,
      failedTasks: tasks.filter(t => t.status === 'failed').length,
      plan,
    };
  }

  // ═══════════════════════════════════════════════════════════
  // State Consistency
  // ═══════════════════════════════════════════════════════════

  /**
   * V1.2.2: Verify Store state consistency — status + relationship integrity.
   */
  verifyConsistency(runId) {
    const issues = [];

    // ── Check Run exists ──
    const run = this.runStore.get(runId);
    if (!run) {
      issues.push({ type: 'missing_run', runId });
      return { consistent: false, issues };
    }

    // ── Relationship: Run.planId → Plan must exist ──
    if (run.planId) {
      const plan = this.planStore.get(run.planId);
      if (!plan) {
        issues.push({
          type: 'missing_plan',
          entity: 'run',
          runId,
          missingId: run.planId,
          detail: `Run ${runId} references missing Plan ${run.planId}`,
        });
      }
    }

    // ── Relationship: Run.taskIds → Tasks must exist ──
    // (checked together with Task.runId validation below)

    // ── Relationship: Task.runId → Run must exist ──
    for (const taskId of run.taskIds) {
      const task = this.taskStore.get(taskId);
      if (!task) {
        issues.push({
          type: 'missing_task',
          entity: 'run',
          runId,
          missingId: taskId,
          detail: `Run ${runId} references missing Task ${taskId}`,
        });
        continue;
      }

      const taskRun = this.runStore.get(task.runId);
      if (!taskRun) {
        issues.push({
          type: 'missing_run',
          entity: 'task',
          taskId: task.id,
          missingId: task.runId,
          detail: `Task ${task.id} references missing Run ${task.runId}`,
        });
      }

      // ── Relationship: Task.planId → Plan must exist ──
      if (task.planId) {
        const taskPlan = this.planStore.get(task.planId);
        if (!taskPlan) {
          issues.push({
            type: 'missing_plan',
            entity: 'task',
            taskId: task.id,
            missingId: task.planId,
            detail: `Task ${task.id} references missing Plan ${task.planId}`,
          });
        }
      }
    }

    // ── Relationship: Workspace.runIds → Run must exist ──
    if (run.workspaceId) {
      const ws = this.workspaceStore.get(run.workspaceId);
      if (ws) {
        for (const wsRunId of ws.runIds) {
          const wsRun = this.runStore.get(wsRunId);
          if (!wsRun) {
            issues.push({
              type: 'missing_run',
              entity: 'workspace',
              workspaceId: ws.id,
              missingId: wsRunId,
              detail: `Workspace ${ws.id} references missing Run ${wsRunId}`,
            });
          }
        }
      }
    }

    // ── Status consistency with Event Store ──
    const events = this.eventStore.getEventsByRun(runId);
    const runEvents = events.filter(e =>
      ['run_started', 'run_completed', 'run_failed', 'run_paused', 'run_resumed'].includes(e.type)
    );

    const lastRunEvent = runEvents[runEvents.length - 1];
    if (lastRunEvent) {
      const expectedStatus = {
        'run_started': RUN_STATUS.STARTED,
        'run_completed': RUN_STATUS.COMPLETED,
        'run_failed': RUN_STATUS.FAILED,
        'run_paused': RUN_STATUS.PAUSED,
        'run_resumed': RUN_STATUS.STARTED,
      }[lastRunEvent.type];

      if (expectedStatus && run.status !== expectedStatus) {
        issues.push({
          type: 'status_mismatch',
          entity: 'run',
          runId,
          storeStatus: run.status,
          eventStatus: expectedStatus,
          lastEventType: lastRunEvent.type,
        });
      }
    }

    // Check Task status consistency
    const tasks = this.taskStore.listByRun(runId);
    for (const task of tasks) {
      const taskEvents = events.filter(e =>
        e.data?.taskId === task.id &&
        ['task_created', 'task_started', 'task_completed', 'task_failed'].includes(e.type)
      );
      const lastTaskEvent = taskEvents[taskEvents.length - 1];
      if (lastTaskEvent) {
        const expectedTaskStatus = {
          'task_created': 'pending',
          'task_started': 'running',
          'task_completed': 'completed',
          'task_failed': 'failed',
        }[lastTaskEvent.type];

        if (expectedTaskStatus && task.status !== expectedTaskStatus) {
          issues.push({
            type: 'task_status_mismatch',
            taskId: task.id,
            storeStatus: task.status,
            eventStatus: expectedTaskStatus,
          });
        }
      }
    }

    return {
      consistent: issues.length === 0,
      issues,
      checkedAt: Date.now(),
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