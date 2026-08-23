/**
 * agent/runtime/scheduler.js — Task Scheduler
 *
 * V0.9.4
 * - TaskScheduler: determines which Task to execute next
 * - Considers: Task lifecycle, Dependency graph, Approval status
 * - Does NOT execute tools — only schedules
 *
 * Design:
 *   Scheduler is a pure decision function.
 *   It does not call tools, does not manage state, does not depend on Planner.
 */

import { canTaskExecute } from './plan.js';
import { TASK_STATUS } from './task.js';

/**
 * V0.9.4: TaskScheduler — pure scheduling decisions.
 *
 * Input: Plan (tasks + dependencies) + Task status map + Approval status map
 * Output: Which tasks are ready to execute
 *
 * Scheduler does NOT:
 * - Execute tools
 * - Modify task state
 * - Call ApprovalGate directly
 * - Depend on Planner
 */
class TaskScheduler {
  constructor(plan, taskStatusMap, approvalStatusMap) {
    this.plan = plan;
    this.taskStatusMap = taskStatusMap; // taskId → TASK_STATUS
    this.approvalStatusMap = approvalStatusMap; // taskId → 'approved'|'rejected'|'pending'|null
    this.paused = false;
    this.scheduledCount = 0;
  }

  /**
   * V0.9.4: Get all tasks ready to execute.
   * A task is ready when:
   * - Status is PENDING (not RUNNING, COMPLETED, FAILED, etc.)
   * - All dependencies are COMPLETED
   * - Not paused
   *
   * @returns {string[]} Array of ready task IDs
   */
  getReadyTasks() {
    if (this.paused) return [];

    const ready = [];

    for (const task of this.plan.tasks) {
      if (this.isTaskReady(task.id)) {
        ready.push(task.id);
      }
    }

    return ready;
  }

  /**
   * V0.9.4: Check if a specific task is ready to execute.
   */
  isTaskReady(taskId) {
    if (this.paused) return false;

    const status = this.taskStatusMap.get(taskId);
    // Only PENDING tasks can be scheduled
    if (status !== TASK_STATUS.PENDING) return false;

    // Check dependencies
    const depCheck = canTaskExecute(this.plan, taskId, this.taskStatusMap);
    if (!depCheck.canExecute) return false;

    return true;
  }

  /**
   * V0.9.4: Select the next task to execute (first ready task).
   * Returns task ID or null if none ready.
   */
  selectNextTask() {
    const ready = this.getReadyTasks();
    return ready.length > 0 ? ready[0] : null;
  }

  /**
   * V0.9.4: Get ready tasks with their dependency status.
   */
  getReadyTasksWithDetails() {
    if (this.paused) return [];

    const result = [];
    for (const task of this.plan.tasks) {
      if (this.isTaskReady(task.id)) {
        const depCheck = canTaskExecute(this.plan, task.id, this.taskStatusMap);
        result.push({
          taskId: task.id,
          goal: task.goal,
          dependencies: depCheck.blockedBy,
        });
      }
    }
    return result;
  }

  /**
   * V0.9.4: Mark a task as scheduled (increment counter).
   */
  markScheduled(taskId) {
    this.scheduledCount++;
  }

  /**
   * V0.9.4: Pause the scheduler.
   */
  pause() {
    this.paused = true;
  }

  /**
   * V0.9.4: Resume the scheduler.
   */
  resume() {
    this.paused = false;
  }

  /**
   * V0.9.4: Check if scheduler is paused.
   */
  isPaused() {
    return this.paused;
  }

  /**
   * V0.9.4: Get scheduling summary.
   */
  getSummary() {
    const total = this.plan.tasks.length;
    const ready = this.getReadyTasks().length;
    const completed = Array.from(this.taskStatusMap.values())
      .filter(s => s === TASK_STATUS.COMPLETED).length;
    const running = Array.from(this.taskStatusMap.values())
      .filter(s => s === TASK_STATUS.RUNNING).length;
    const pending = Array.from(this.taskStatusMap.values())
      .filter(s => s === TASK_STATUS.PENDING).length;
    const failed = Array.from(this.taskStatusMap.values())
      .filter(s => s === TASK_STATUS.FAILED).length;

    return {
      total,
      ready,
      completed,
      running,
      pending,
      failed,
      paused: this.paused,
      scheduledCount: this.scheduledCount,
    };
  }

  /**
   * V0.9.4: Update task status map (called externally when task state changes).
   */
  updateTaskStatus(taskId, status) {
    this.taskStatusMap.set(taskId, status);
  }

  /**
   * V0.9.4: Update approval status map.
   */
  updateApprovalStatus(taskId, status) {
    this.approvalStatusMap.set(taskId, status);
  }
}

/**
 * V0.9.4: Create a TaskScheduler from a plan and task states.
 */
function createScheduler(plan, taskStatusMap, approvalStatusMap) {
  return new TaskScheduler(plan, taskStatusMap, approvalStatusMap);
}

export {
  TaskScheduler,
  createScheduler,
};