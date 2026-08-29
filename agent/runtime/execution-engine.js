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

import { RUNTIME_EVENT_TYPES, RuntimeEventEmitter } from './events.js';
import {
  PLAN_STATUS,
  getExecutionOrder,
  canTaskExecute,
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
    this.executionGate = options.executionGate || null;
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
    // V1.2.3 fix: when no emitter is supplied, auto-create one and wire it to
    // the event store. Without this the default ExecutionEngine has an empty
    // EventStore and recover() fails with "No events found".
    if (options.emitter) {
      this.emitter = options.emitter;
      // Wire a caller emitter to this engine's event store only if it has no
      // store of its own — a caller that already called setStore() owns it.
      if (!this.emitter.getStore()) {
        this.emitter.setStore(this.eventStore);
      }
    } else {
      this.emitter = new RuntimeEventEmitter();
      this.emitter.setStore(this.eventStore);
    }

    // V1.2.3: Shared TransitionManager — single entry for all state transitions
    // Receives Store dependencies for state mutation
    this.transitionMgr = options.transitionManager || createTransitionManager({
      emitter: this.emitter,
      eventStore: this.eventStore,
      runStore: this.runStore,
      taskStore: this.taskStore,
      planStore: this.planStore,
      workspaceStore: this.workspaceStore,
    });

    // V1.2.2: Sub-managers — pass explicit Store dependencies, NOT engine:this
    this.runMgr = options.runManager || createRunManager({
      emitter: this.emitter,
      eventStore: this.eventStore,
      transitionManager: this.transitionMgr,
      runStore: this.runStore,
      planStore: this.planStore,
      workspaceStore: this.workspaceStore,
      contextMgr: this.contextMgr,
      taskStore: this.taskStore,
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
      artifactStore: this.artifactStore,
      executionGate: this.executionGate,
      taskExecutor: this.taskExecutor,
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
    // V1.2.3-fix: RunManager is the single ownership point for run creation.
    // It persists to RunStore, inspects the result, and emits run_created
    // only after successful persistence. The Engine must NOT create the run
    // a second time — that duplicate create was silently ignored while the
    // caller was still told success: true.
    return this.runMgr.create(config);
  }

  /**
   * V1.2.2: Start a Run.
   */
  startRun(runId) {
    const run = this.runStore.get(runId);
    if (!run) return { success: false, reason: `Run ${runId} not found` };

    const result = this.runMgr.start(run);
    if (!result.success) return result;

    // V1.2.3: Plan persistence is now owned by RunManager.start() (which has
    // planStore wired). It also writes planId back to RunStore so that
    // executeRun() can resolve run.planId → PlanStore.get().
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

    // V1.2.3-fix: validate BOTH transitions before mutating EITHER. The old code
    // transitioned the Plan first, then the Run — if the Run transition failed
    // (e.g. Run was PAUSED), the Plan was already mutated into COMPLETED, leaving
    // Run=PAUSED / Plan=COMPLETED (a fork). Check both preconditions, then mutate.
    if (run.status !== RUN_STATUS.STARTED) {
      return { success: false, reason: `Cannot complete run in status: ${run.status}` };
    }

    let plan = null;
    if (run.planId) {
      plan = this.planStore.get(run.planId);
      if (plan && plan.status !== PLAN_STATUS.EXECUTING && plan.status !== PLAN_STATUS.VERIFYING) {
        return { success: false, reason: `Cannot complete plan in status: ${plan.status}` };
      }
    }

    // Both valid — mutate Plan first, then Run
    if (plan) {
      if (plan.status === PLAN_STATUS.EXECUTING) {
        this.transitionMgr.transitionPlan(
          run.planId, PLAN_STATUS.EXECUTING, PLAN_STATUS.VERIFYING,
          { runId, workspaceId: run.workspaceId }
        );
      }
      const afterVerify = this.planStore.get(run.planId);
      if (afterVerify && afterVerify.status === PLAN_STATUS.VERIFYING) {
        this.transitionMgr.transitionPlan(
          run.planId, PLAN_STATUS.VERIFYING, PLAN_STATUS.COMPLETED,
          { runId, workspaceId: run.workspaceId }
        );
      }
    }

    const result = this.runMgr.complete(run);
    if (!result.success) return result;

    return result;
  }

  /**
   * V1.2.2: Fail a Run.
   */
  failRun(runId, error) {
    const run = this.runStore.get(runId);
    if (!run) return { success: false, reason: `Run ${runId} not found` };

    // V1.2.3-fix: validate BOTH transitions before mutating EITHER. failRun() used
    // to fail the Plan first, then the Run — but the run transition table did
    // not allow paused → failed, so a PAUSED run could never be failed: the
    // Plan went to FAILED while the Run stayed PAUSED (a fork).
    if (run.status !== RUN_STATUS.STARTED && run.status !== RUN_STATUS.PAUSED) {
      return { success: false, reason: `Cannot fail run in status: ${run.status}` };
    }

    let plan = null;
    if (run.planId) {
      plan = this.planStore.get(run.planId);
      if (plan && (plan.status === PLAN_STATUS.COMPLETED || plan.status === PLAN_STATUS.FAILED || plan.status === PLAN_STATUS.CANCELLED)) {
        return { success: false, reason: `Cannot fail plan in terminal status: ${plan.status}` };
      }
    }

    // Both valid — mutate Plan first, then Run
    if (plan) {
      this.transitionMgr.transitionPlan(
        run.planId, plan.status, PLAN_STATUS.FAILED,
        { runId, workspaceId: run.workspaceId, data: { error: error?.message || String(error) } }
      );
    }

    const result = this.runMgr.fail(run, error);
    if (!result.success) return result;

    return result;
  }

  /**
   * V1.2.2: Cancel a Run.
   */
  cancelRun(runId) {
    const run = this.runStore.get(runId);
    if (!run) return { success: false, reason: `Run ${runId} not found` };

    // V1.2.3-fix: validate BOTH transitions before mutating EITHER. cancelRun() used
    // to cancel the Plan first, then the Run — if the Run was already terminal
    // the Plan was already mutated into CANCELLED (a fork).
    if (run.status === RUN_STATUS.COMPLETED || run.status === RUN_STATUS.FAILED || run.status === RUN_STATUS.CANCELLED) {
      return { success: false, reason: `Cannot cancel run in terminal status: ${run.status}` };
    }

    let plan = null;
    if (run.planId) {
      plan = this.planStore.get(run.planId);
      if (plan && (plan.status === PLAN_STATUS.COMPLETED || plan.status === PLAN_STATUS.FAILED || plan.status === PLAN_STATUS.CANCELLED)) {
        return { success: false, reason: `Cannot cancel plan in terminal status: ${plan.status}` };
      }
    }

    // Both valid — mutate Plan first, then Run
    if (plan) {
      this.transitionMgr.transitionPlan(
        run.planId, plan.status, PLAN_STATUS.CANCELLED,
        { runId, workspaceId: run.workspaceId }
      );
    }

    const result = this.runMgr.cancel(run);
    if (!result.success) return result;

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

    // V1.2.3-fix: keep the Plan in sync. startRun() bakes run.taskIds into
    // plan.tasks, so a task added AFTER the run started would be silently
    // ignored by getExecutionOrder() — the Run owns the task but the Plan
    // never schedules it. Mirror the new task into the Plan when one exists.
    if (run.planId) {
      const plan = this.planStore.get(run.planId);
      if (plan && !plan.tasks.some(t => t.id === task.id)) {
        plan.tasks.push({ id: task.id });
        // V1.2.3-fix: getExecutionOrder() reads plan.dependencies, not
        // task.dependencies. Sync the task's deps into the plan's dependency
        // graph so scheduling actually respects them.
        for (const depId of (task.dependencies || [])) {
          if (!plan.dependencies.some(d => d.from === depId && d.to === task.id)) {
            plan.dependencies.push({ from: depId, to: task.id });
          }
        }
        this.planStore.update(run.planId, { tasks: plan.tasks, dependencies: plan.dependencies });
      }
    }

    if (this.emitter) {
      this.emitter.emit({
        runId,
        workspaceId: run.workspaceId,
        taskId: task.id,
        type: 'task_created',
        // V1.2.3-fix: carry the immutable execution definition so crash
        // recovery can rebuild a task that still has its Skill binding.
        data: {
          taskId: task.id,
          goal: task.goal,
          assignedSkills: task.assignedSkills,
          dependencies: task.dependencies,
        },
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

      // V1.2.3-fix: topological order only guarantees A runs before B — it does
      // not guarantee A SUCCEEDED before B runs. Check dependency satisfaction
      // explicitly so a missing or failed dependency blocks execution instead of
      // letting B run against a half-baked predecessor.
      const taskStatusMap = new Map(
        this.taskStore.listByRun(runId).map(t => [t.id, t.status])
      );
      const { canExecute, blockedBy } = canTaskExecute(plan, taskId, taskStatusMap);
      if (!canExecute) {
        return {
          success: false,
          results,
          reason: `Task ${taskId} blocked by dependencies: ${blockedBy.map(b => `${b.taskId}=${b.status}`).join(', ')}`,
        };
      }

      const result = await this.executeTask(taskId, {});
      results.push({ taskId, ...result });

      if (!result.success) {
        return { success: false, results, reason: `Task ${taskId} failed` };
      }
    }

    // V1.2.3-fix: complete the run when every task is done, even if this call
    // executed nothing (e.g. resumeAfterCrash already completed them). The old
    // check required results.length > 0, so a run whose tasks were all finished
    // by recovery stayed STARTED forever.
    const allTasks = this.taskStore.listByRun(runId);
    const allComplete = allTasks.length > 0 && allTasks.every(t => t.status === TASK_STATUS.COMPLETED);
    if (allComplete) {
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
  recover(runId, options = {}) {
    return this.recoveryMgr.recover(runId, options);
  }

  /**
   * V1.2.3: Serialize the Stores for crash persistence.
   * Returns a snapshot that recover() can restore on a fresh Engine instance,
   * preserving the Plan, task Skill bindings, and task dependencies — the
   * fields that event-based reconstruction silently drops.
   */
  serializeStores() {
    const snapshot = {
      runs: this.runStore.serialize(),
      plans: this.planStore.serialize(),
      tasks: this.taskStore.serialize(),
    };
    // V1.2.3-fix: a real Coding Skill reads workspace.rootPath / active files
    // and context.variables during execution. Without restoring Workspace +
    // Context, a recovered Runtime can execute tasks in the dark — the
    // TaskExecutor gets null for both. WorkspaceStore and ContextManager already
    // have serialize()/restore(), so include them in the snapshot.
    if (this.workspaceStore) snapshot.workspaces = this.workspaceStore.serialize();
    if (this.contextMgr) snapshot.contexts = this.contextMgr.serialize();
    // V1.2.3-fix: TaskExecutor writes Skill output (patch / report / code) into
    // the ArtifactStore. Without restoring it, a task can report COMPLETED while
    // its actual output is gone — a downstream task or verification step that
    // depends on the artifact would see an empty store. ArtifactStore already
    // has serialize()/deserialize().
    if (this.artifactStore) snapshot.artifacts = this.artifactStore.serialize();
    // V1.2.3-fix: ExecutionGate holds the real ApprovalRequest objects
    // (id / target / reason / riskLevel / args / status / timeout). A
    // WAITING_APPROVAL task means nothing without its request — restoring only
    // the task status produces an orphan task that is "waiting" for an
    // approval nobody can find. ExecutionGate already has serialize() /
    // restoreRequests(), so include it.
    if (this.executionGate) snapshot.approvals = this.executionGate.serialize();
    return snapshot;
  }

  /**
   * V1.2.2: Get recovery plan.
   */
  getRecoveryPlan(runId, options = {}) {
    return this.recoveryMgr.getRecoveryPlan(runId, options);
  }

  /**
   * V1.2.2: Get recovery plan with execution resumption.
   */
  async resumeAfterCrash(runId, options = {}) {
    return this.recoveryMgr.resumeAfterCrash(runId, options);
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