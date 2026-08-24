/**
 * agent/runtime/execution-engine.js — Runtime Execution Engine
 *
 * V1.2.0
 * - Unified entry point for Agent execution
 * - Run lifecycle management
 * - Task execution loop
 * - Scheduler → Executor integration
 * - Failure recovery
 * - Event integration
 *
 * Design:
 *   Execution Engine is the "brain" of the Runtime.
 *   It orchestrates: Run → Workspace → Context → Plan → Task → Skill → Tool → Artifact
 *   No new Runtime concepts introduced.
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
  PLAN_TRANSITIONS,
  canTransitionPlan,
  getExecutionOrder,
  addTaskDependency,
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
  requestApproval,
  approveTask,
  rejectTask,
  pauseTask,
  resumeTask,
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

// ── Run Status ────────────────────────────────────────────

const RUN_STATUS = {
  CREATED: 'created',
  STARTED: 'started',
  PAUSED: 'paused',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
};

const RUN_TRANSITIONS = {
  [RUN_STATUS.CREATED]: [RUN_STATUS.STARTED, RUN_STATUS.CANCELLED],
  [RUN_STATUS.STARTED]: [RUN_STATUS.PAUSED, RUN_STATUS.COMPLETED, RUN_STATUS.FAILED, RUN_STATUS.CANCELLED],
  [RUN_STATUS.PAUSED]: [RUN_STATUS.STARTED, RUN_STATUS.CANCELLED],
  [RUN_STATUS.COMPLETED]: [],
  [RUN_STATUS.FAILED]: [],
  [RUN_STATUS.CANCELLED]: [],
};

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

    // V1.2.0: Run registry
    this.runs = new Map(); // runId → run state
    this.plans = new Map(); // planId → plan
    this.tasks = new Map(); // taskId → task

    // V1.2.0: Execution state
    this.activeRunId = null;
  }

  // ═══════════════════════════════════════════════════════════
  // Run Lifecycle
  // ═══════════════════════════════════════════════════════════

  /**
   * V1.2.0: Create a new Run.
   */
  createRun(config = {}) {
    const runId = config.runId || `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const goal = config.goal || 'Untitled Run';

    // Create workspace for this run
    const wsResult = this.workspaceStore.create({
      name: `run_${runId}`,
      runId,
    });
    if (!wsResult.success) {
      return { success: false, reason: wsResult.reason, run: null };
    }

    // Create context for this run
    this.contextMgr.createForRun(runId, wsResult.workspace.id);

    // Create run state
    const run = {
      id: runId,
      goal,
      status: RUN_STATUS.CREATED,
      workspaceId: wsResult.workspace.id,
      planId: null,
      taskIds: [],
      createdAt: Date.now,
      updatedAt: Date.now,
      startedAt: null,
      completedAt: null,
      failedAt: null,
      error: null,
      metadata: config.metadata || {},
    };

    this.runs.set(runId, run);

    if (this.emitter) {
      this.emitter.emit({
        runId,
        workspaceId: run.workspaceId,
        type: 'run_started',
        data: { runId, goal, workspaceId: run.workspaceId },
      });
    }

    return { success: true, run, workspace: wsResult.workspace };
  }

  /**
   * V1.2.0: Start a Run — create plan, schedule tasks, begin execution.
   */
  startRun(runId) {
    const run = this.runs.get(runId);
    if (!run) {
      return { success: false, reason: `Run ${runId} not found` };
    }
    if (run.status !== RUN_STATUS.CREATED) {
      return { success: false, reason: `Cannot start run in status: ${run.status}` };
    }

    // Transition: CREATED → STARTED
    run.status = RUN_STATUS.STARTED;
    run.startedAt = Date.now();
    run.updatedAt = Date.now();
    this.activeRunId = runId;

    // Create plan
    const plan = createPlan({
      runId,
      goal: run.goal,
      tasks: run.taskIds.map(id => ({ taskId: id })),
    });
    this.plans.set(plan.id, plan);
    run.planId = plan.id;

    // Emit events
    if (this.emitter) {
      this.emitter.emit({
        runId,
        workspaceId: run.workspaceId,
        planId: plan.id,
        type: 'plan_created',
        data: { planId: plan.id, goal: run.goal },
      });
    }

    return { success: true, run, plan };
  }

  /**
   * V1.2.0: Pause a Run.
   */
  pauseRun(runId) {
    const run = this.runs.get(runId);
    if (!run) {
      return { success: false, reason: `Run ${runId} not found` };
    }
    if (run.status !== RUN_STATUS.STARTED) {
      return { success: false, reason: `Cannot pause run in status: ${run.status}` };
    }

    run.status = RUN_STATUS.PAUSED;
    run.updatedAt = Date.now();

    if (this.emitter) {
      this.emitter.emit({
        runId,
        workspaceId: run.workspaceId,
        type: 'run_paused',
        data: { runId },
      });
    }

    return { success: true, run };
  }

  /**
   * V1.2.0: Resume a Run.
   */
  resumeRun(runId) {
    const run = this.runs.get(runId);
    if (!run) {
      return { success: false, reason: `Run ${runId} not found` };
    }
    if (run.status !== RUN_STATUS.PAUSED) {
      return { success: false, reason: `Cannot resume run in status: ${run.status}` };
    }

    run.status = RUN_STATUS.STARTED;
    run.updatedAt = Date.now();
    this.activeRunId = runId;

    if (this.emitter) {
      this.emitter.emit({
        runId,
        workspaceId: run.workspaceId,
        type: 'run_resumed',
        data: { runId },
      });
    }

    return { success: true, run };
  }

  /**
   * V1.2.0: Complete a Run.
   */
  completeRun(runId) {
    const run = this.runs.get(runId);
    if (!run) {
      return { success: false, reason: `Run ${runId} not found` };
    }
    if (run.status !== RUN_STATUS.STARTED) {
      return { success: false, reason: `Cannot complete run in status: ${run.status}` };
    }

    run.status = RUN_STATUS.COMPLETED;
    run.completedAt = Date.now();
    run.updatedAt = Date.now();

    // Complete plan
    if (run.planId) {
      const plan = this.plans.get(run.planId);
      if (plan && plan.status === PLAN_STATUS.EXECUTING) {
        completePlan(plan, this.emitter, { runId });
      }
    }

    if (this.emitter) {
      this.emitter.emit({
        runId,
        workspaceId: run.workspaceId,
        type: 'run_completed',
        data: { runId, completedAt: run.completedAt },
      });
    }

    return { success: true, run };
  }

  /**
   * V1.2.0: Fail a Run.
   */
  failRun(runId, error) {
    const run = this.runs.get(runId);
    if (!run) {
      return { success: false, reason: `Run ${runId} not found` };
    }
    if (run.status === RUN_STATUS.COMPLETED || run.status === RUN_STATUS.CANCELLED) {
      return { success: false, reason: `Cannot fail run in status: ${run.status}` };
    }

    run.status = RUN_STATUS.FAILED;
    run.error = error;
    run.failedAt = Date.now();
    run.updatedAt = Date.now();

    // Fail plan
    if (run.planId) {
      const plan = this.plans.get(run.planId);
      if (plan) {
        failPlan(plan, this.emitter, { runId, error });
      }
    }

    if (this.emitter) {
      this.emitter.emit({
        runId,
        workspaceId: run.workspaceId,
        type: 'run_failed',
        data: { runId, error: error?.message || String(error) },
      });
    }

    return { success: true, run };
  }

  /**
   * V1.2.0: Cancel a Run.
   */
  cancelRun(runId) {
    const run = this.runs.get(runId);
    if (!run) {
      return { success: false, reason: `Run ${runId} not found` };
    }
    if (run.status === RUN_STATUS.COMPLETED || run.status === RUN_STATUS.FAILED || run.status === RUN_STATUS.CANCELLED) {
      return { success: false, reason: `Cannot cancel run in status: ${run.status}` };
    }

    run.status = RUN_STATUS.CANCELLED;
    run.updatedAt = Date.now();

    // Cancel plan
    if (run.planId) {
      const plan = this.plans.get(run.planId);
      if (plan) {
        cancelPlan(plan, this.emitter, { runId });
      }
    }

    if (this.emitter) {
      this.emitter.emit({
        runId,
        workspaceId: run.workspaceId,
        type: 'plan_cancelled',
        data: { runId },
      });
    }

    return { success: true, run };
  }

  // ═══════════════════════════════════════════════════════════
  // Task Execution Loop
  // ═══════════════════════════════════════════════════════════

  /**
   * V1.2.0: Add a task to a run.
   */
  addTask(runId, taskConfig) {
    const run = this.runs.get(runId);
    if (!run) {
      return { success: false, reason: `Run ${runId} not found` };
    }

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
   * V1.2.0: Execute a single task through the full pipeline.
   */
  async executeTask(taskId, context = {}) {
    const task = this.tasks.get(taskId);
    if (!task) {
      return { success: false, reason: `Task ${taskId} not found` };
    }

    const run = this.runs.get(task.runId);
    if (!run) {
      return { success: false, reason: `Run ${task.runId} not found` };
    }

    // Check task can transition
    if (!canTransitionTask(task, TASK_STATUS.RUNNING)) {
      return { success: false, reason: `Task ${taskId} cannot start from status: ${task.status}` };
    }

    // Start task
    startTask(task, this.emitter, { runId: task.runId });

    // Get workspace context
    const workspace = this.workspaceStore.get(run.workspaceId);
    const ctx = this.contextMgr.getByRun(task.runId);

    // Build execution context
    const execContext = {
      runId: task.runId,
      workspaceId: run.workspaceId,
      taskId: task.id,
      workspace,
      context: ctx,
      params: context.params || {},
    };

    try {
      // Execute skill if task has a skill binding
      const skillId = task.assignedSkills && task.assignedSkills.length > 0 ? task.assignedSkills[0] : null;
      if (skillId) {
        const skillResult = await this.skillRuntime.executeSkill(skillId, execContext);

        if (!skillResult.success) {
          // Handle failure
          failTask(task, this.emitter, {
            runId: task.runId,
            error: skillResult.reason || 'Skill execution failed',
          });

          // Emit failure event
          if (this.emitter) {
            this.emitter.emit({
              runId: task.runId,
              workspaceId: run.workspaceId,
              taskId: task.id,
              type: 'task_failed',
              data: { taskId: task.id, error: skillResult.reason },
            });
          }

          return { success: false, task, error: skillResult.reason };
        }

        // Collect artifacts from skill execution
        if (skillResult.result?.toolResults) {
          for (const tr of skillResult.result.toolResults) {
            if (tr.success && tr.artifact) {
              this.artifactStore.create({
                name: tr.artifact.name || `artifact_${task.id}`,
                type: tr.artifact.type || 'code',
                workspaceId: run.workspaceId,
                runId: task.runId,
                taskId: task.id,
                skillId: skillId,
                content: tr.artifact.content,
              });
            }
          }
        }
      }

      // Complete task — must go through VERIFYING first
      startTaskVerification(task, this.emitter, { runId: task.runId });
      completeTask(task, this.emitter, { runId: task.runId });

      if (this.emitter) {
        this.emitter.emit({
          runId: task.runId,
          workspaceId: run.workspaceId,
          taskId: task.id,
          type: 'task_completed',
          data: { taskId: task.id },
        });
      }

      return { success: true, task };

    } catch (error) {
      failTask(task, this.emitter, {
        runId: task.runId,
        error: error.message,
      });

      if (this.emitter) {
        this.emitter.emit({
          runId: task.runId,
          workspaceId: run.workspaceId,
          taskId: task.id,
          type: 'task_failed',
          data: { taskId: task.id, error: error.message },
        });
      }

      return { success: false, task, error: error.message };
    }
  }

  /**
   * V1.2.0: Execute all ready tasks in a run.
   */
  async executeRun(runId) {
    const run = this.runs.get(runId);
    if (!run) {
      return { success: false, reason: `Run ${runId} not found` };
    }

    if (run.status !== RUN_STATUS.STARTED) {
      return { success: false, reason: `Run must be started before execution: ${run.status}` };
    }

    // Get execution order from scheduler
    const plan = this.plans.get(run.planId);
    if (!plan) {
      return { success: false, reason: `Plan not found for run ${runId}` };
    }

    const order = getExecutionOrder(plan);
    const results = [];

    for (const taskId of order) {
      const task = this.tasks.get(taskId);
      if (!task) continue;

      // Check if task is ready (dependencies satisfied)
      if (task.status !== TASK_STATUS.PENDING) continue;

      const result = await this.executeTask(taskId, {});
      results.push({ taskId, ...result });

      // If task failed, stop execution
      if (!result.success) {
        return { success: false, results, reason: `Task ${taskId} failed` };
      }
    }

    // All tasks complete — complete the run
    const allComplete = results.every(r => r.success);
    if (allComplete && results.length > 0) {
      this.completeRun(runId);
    }

    return { success: allComplete, results };
  }

  // ═══════════════════════════════════════════════════════════
  // Failure Recovery
  // ═══════════════════════════════════════════════════════════

  /**
   * V1.2.0: Resume a run after failure — retry failed tasks.
   */
  async resumeAfterFailure(runId) {
    const run = this.runs.get(runId);
    if (!run) {
      return { success: false, reason: `Run ${runId} not found` };
    }

    if (run.status !== RUN_STATUS.FAILED) {
      return { success: false, reason: `Run must be failed to resume: ${run.status}` };
    }

    // Reset run to started
    run.status = RUN_STATUS.STARTED;
    run.error = null;
    run.failedAt = null;
    run.updatedAt = Date.now();

    // Retry failed tasks
    const failedTasks = Array.from(this.tasks.values())
      .filter(t => t.runId === runId && t.status === TASK_STATUS.FAILED);

    for (const task of failedTasks) {
      // Reset task to pending
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

    // Re-execute
    return this.executeRun(runId);
  }

  /**
   * V1.2.0: Restore run state from event store (after crash).
   */
  restoreRun(runId) {
    const run = this.runs.get(runId);
    if (run) {
      return { success: true, run, restored: false };
    }

    // Try to reconstruct from event store
    if (!this.eventStore) {
      return { success: false, reason: 'No event store for recovery' };
    }

    const events = this.eventStore.getEventsByRun(runId);
    if (events.length === 0) {
      return { success: false, reason: `No events found for run ${runId}` };
    }

    // Find run_created event
    const createdEvent = events.find(e => e.type === 'run_started');
    if (!createdEvent) {
      return { success: false, reason: 'No run_created event found' };
    }

    // Reconstruct run state from events
    const reconstructed = {
      id: runId,
      goal: createdEvent.data?.goal || 'Restored Run',
      status: RUN_STATUS.CREATED,
      workspaceId: createdEvent.data?.workspaceId,
      planId: null,
      taskIds: [],
      createdAt: createdEvent.timestamp,
      updatedAt: Date.now,
      startedAt: null,
      completedAt: null,
      failedAt: null,
      error: null,
      metadata: {},
    };

    // Apply events to reconstruct state
    for (const event of events) {
      switch (event.type) {
        case 'run_started':
          reconstructed.status = RUN_STATUS.STARTED;
          reconstructed.startedAt = event.timestamp;
          break;
        case 'run_completed':
          reconstructed.status = RUN_STATUS.COMPLETED;
          reconstructed.completedAt = event.timestamp;
          break;
        case 'run_failed':
          reconstructed.status = RUN_STATUS.FAILED;
          reconstructed.failedAt = event.timestamp;
          reconstructed.error = event.data?.error;
          break;
        case 'run_paused':
          reconstructed.status = RUN_STATUS.PAUSED;
          break;
        case 'task_created':
          if (event.data?.taskId) reconstructed.taskIds.push(event.data.taskId);
          break;
      }
    }

    this.runs.set(runId, reconstructed);
    return { success: true, run: reconstructed, restored: true };
  }

  // ═══════════════════════════════════════════════════════════
  // Query
  // ═══════════════════════════════════════════════════════════

  /**
   * V1.2.0: Get run by ID.
   */
  getRun(runId) {
    return this.runs.get(runId) || null;
  }

  /**
   * V1.2.0: Get task by ID.
   */
  getTask(taskId) {
    return this.tasks.get(taskId) || null;
  }

  /**
   * V1.2.0: Get plan by ID.
   */
  getPlan(planId) {
    return this.plans.get(planId) || null;
  }

  /**
   * V1.2.0: List all runs.
   */
  listRuns() {
    return Array.from(this.runs.values());
  }

  /**
   * V1.2.0: Get active run.
   */
  getActiveRun() {
    if (!this.activeRunId) return null;
    return this.runs.get(this.activeRunId) || null;
  }

  /**
   * V1.2.0: Get run summary.
   */
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
  RUN_TRANSITIONS,
  ExecutionEngine,
  createExecutionEngine,
};