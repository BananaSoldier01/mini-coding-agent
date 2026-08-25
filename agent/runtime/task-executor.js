/**
 * agent/runtime/task-executor.js — Task Execution
 *
 * V1.2.1
 * - Executes tasks through Skill Runtime
 * - Uses TransitionManager for state transitions
 * - Collects artifacts
 * - Handles failures
 *
 * Design:
 *   TaskExecutor is responsible for executing individual tasks.
 *   It does NOT manage task storage — that's owned by ExecutionEngine.
 */

import { TransitionManager, createTransitionManager } from './transition-manager.js';
import {
  TASK_STATUS,
  startTask,
  startTaskVerification,
  completeTask,
  failTask,
} from './task.js';

class TaskExecutor {
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
    this.skillRuntime = options.skillRuntime || null;
    this.artifactStore = options.artifactStore || null;
    this.workspaceStore = options.workspaceStore || null;
    this.contextMgr = options.contextMgr || null;
    this.taskStore = options.taskStore || null;
  }

  // ── Execution ──────────────────────────────────────────

  /**
   * V1.2.1: Execute a single task.
   */
  async execute(task, context = {}) {
    const runId = task.runId;
    const workspaceId = context.workspaceId || (this.workspaceStore?.getWorkspaceForRun(runId)?.id);

    // Validate transition
    if (!this.transitionMgr.canTransition('task', task.status, TASK_STATUS.RUNNING)) {
      return {
        success: false,
        reason: `Task ${task.id} cannot start from status: ${task.status}`,
        task,
      };
    }

    // Transition: PENDING → RUNNING
    const startResult = this.transitionMgr.transitionTask(
      task.id, task.status, TASK_STATUS.RUNNING,
      { runId, workspaceId, taskId: task.id, data: { skillId: task.assignedSkills?.[0] } }
    );

    if (!startResult.success) {
      return { success: false, reason: startResult.reason, task };
    }

    // Update task state
    task.status = TASK_STATUS.RUNNING;
    task.updatedAt = Date.now();

    // Emit task_started event
    if (this.emitter) {
      this.emitter.emit({
        runId,
        workspaceId,
        taskId: task.id,
        type: 'task_started',
        data: { taskId: task.id },
      });
    }

    try {
      // Execute skill if task has a skill binding
      const skillId = task.assignedSkills && task.assignedSkills.length > 0 ? task.assignedSkills[0] : null;

      if (skillId && this.skillRuntime) {
        const execContext = {
          runId,
          workspaceId,
          taskId: task.id,
          workspace: this.workspaceStore?.get(workspaceId),
          context: this.contextMgr?.getByRun(runId),
          params: context.params || {},
        };

        const skillResult = await this.skillRuntime.executeSkill(skillId, execContext);

        if (!skillResult.success) {
          return this._handleFailure(task, skillResult.reason || 'Skill execution failed', {
            runId, workspaceId, context,
          });
        }

        // Collect artifacts
        if (skillResult.result?.toolResults && this.artifactStore) {
          for (const tr of skillResult.result.toolResults) {
            if (tr.success && tr.artifact) {
              this.artifactStore.create({
                name: tr.artifact.name || `artifact_${task.id}`,
                type: tr.artifact.type || 'code',
                workspaceId,
                runId,
                taskId: task.id,
                skillId,
                content: tr.artifact.content,
              });
            }
          }
        }
      }

      // Transition: RUNNING → VERIFYING → COMPLETED
      return this._completeTask(task, { runId, workspaceId, context });

    } catch (error) {
      return this._handleFailure(task, error.message, { runId, workspaceId, context });
    }
  }

  // ── Task Completion ────────────────────────────────────

  /**
   * V1.2.1: Complete a task through VERIFYING.
   */
  _completeTask(task, context) {
    const { runId, workspaceId } = context;

    // RUNNING → VERIFYING
    const verifyResult = this.transitionMgr.transitionTask(
      task.id, TASK_STATUS.RUNNING, TASK_STATUS.VERIFYING,
      { runId, workspaceId, taskId: task.id }
    );

    if (!verifyResult.success) {
      return { success: false, reason: verifyResult.reason, task };
    }

    task.status = TASK_STATUS.VERIFYING;
    task.updatedAt = Date.now();

    // VERIFYING → COMPLETED
    const completeResult = this.transitionMgr.transitionTask(
      task.id, TASK_STATUS.VERIFYING, TASK_STATUS.COMPLETED,
      { runId, workspaceId, taskId: task.id }
    );

    if (!completeResult.success) {
      return { success: false, reason: completeResult.reason, task };
    }

    task.status = TASK_STATUS.COMPLETED;
    task.completedAt = Date.now();
    task.updatedAt = Date.now();

    // Emit task_completed event
    if (this.emitter) {
      this.emitter.emit({
        runId,
        workspaceId,
        taskId: task.id,
        type: 'task_completed',
        data: { taskId: task.id },
      });
    }

    return { success: true, task };
  }

  // ── Failure Handling ───────────────────────────────────

  /**
   * V1.2.1: Handle task failure.
   */
  _handleFailure(task, error, context) {
    const { runId, workspaceId } = context;

    // RUNNING → FAILED
    const failResult = this.transitionMgr.transitionTask(
      task.id, TASK_STATUS.RUNNING, TASK_STATUS.FAILED,
      { runId, workspaceId, taskId: task.id, data: { error } }
    );

    if (!failResult.success) {
      return { success: false, reason: failResult.reason, task };
    }

    task.status = TASK_STATUS.FAILED;
    task.error = error;
    task.failedAt = Date.now();
    task.updatedAt = Date.now();

    // Emit task_failed event
    if (this.emitter) {
      this.emitter.emit({
        runId,
        workspaceId,
        taskId: task.id,
        type: 'task_failed',
        data: { taskId: task.id, error },
      });
    }

    return { success: false, task, error };
  }

  // ── Retry ──────────────────────────────────────────────

  /**
   * V1.2.1: Retry a failed task — FAILED → PENDING → RUNNING.
   */
  async retry(task, context = {}) {
    if (task.status !== TASK_STATUS.FAILED) {
      return { success: false, reason: `Can only retry failed tasks, got: ${task.status}` };
    }

    // Reset to pending
    task.status = TASK_STATUS.PENDING;
    task.error = null;
    task.failedAt = null;
    task.updatedAt = Date.now();

    // Execute
    return this.execute(task, context);
  }
}

// ── Factory ───────────────────────────────────────────────

function createTaskExecutor(options) {
  return new TaskExecutor(options);
}

export {
  TaskExecutor,
  createTaskExecutor,
};