/**
 * agent/runtime/execution-coordinator.js — Execution Coordinator
 *
 * V0.9.4
 * - ExecutionCoordinator: connects Scheduler → ExecutionGate → ToolExecution
 * - Does NOT execute tools directly — delegates to ToolExecution lifecycle
 *
 * Design:
 *   Scheduler decides WHAT to execute next.
 *   ExecutionCoordinator decides HOW (approval, gate, execution).
 *   ToolExecution does the actual work.
 */

import { TaskScheduler, createScheduler } from './scheduler.js';
import { ExecutionGate, APPROVAL_STATUS } from './approval.js';
import { createToolExecution, submitToolExecution, completePolicyCheck, startToolExecution, completeToolExecution, failToolExecution } from './tool-execution.js';
import { createPolicyContext } from './policy.js';
import { TASK_STATUS } from './task.js';
import { RUNTIME_EVENT_TYPES } from './events.js';

/**
 * V0.9.4: ExecutionCoordinator — orchestrates execution flow.
 *
 * Flow:
 *   Scheduler.getReadyTasks()
 *     → ExecutionCoordinator.checkApproval()
 *       → ExecutionGate.canProceed()
 *         → create ToolExecution
 *           → execute
 */
class ExecutionCoordinator {
  constructor(options = {}) {
    this.plan = options.plan;
    this.taskStatusMap = options.taskStatusMap || new Map();
    this.approvalStatusMap = options.approvalStatusMap || new Map();
    this.approvalPolicy = options.approvalPolicy || null;
    this.executionGate = options.executionGate || new ExecutionGate();
    this.emitter = options.emitter || null;
    this.runtimeContext = options.runtimeContext || null;
    this.evidenceRegistry = options.evidenceRegistry || null;
    this.autoApprove = options.autoApprove || false;

    this.scheduler = options.scheduler || createScheduler(
      this.plan,
      this.taskStatusMap,
      this.approvalStatusMap
    );
  }

  /**
   * V0.9.4: Coordinate execution of the next ready task.
   * Returns the created ToolExecution or null if nothing ready.
   */
  async executeNext(context = {}) {
    // 1. Get next ready task
    const taskId = this.scheduler.selectNextTask();
    if (!taskId) return null;

    const task = this.plan.tasks.find(t => t.id === taskId);
    if (!task) return null;

    // 2. Check approval requirement
    const approvalCheck = await this.checkApproval(task, context);
    if (!approvalCheck.canProceed) {
      return {
        taskId,
        blocked: true,
        reason: approvalCheck.reason,
        approvalRequest: approvalCheck.request,
      };
    }

    // 3. Create and execute ToolExecution
    return this.executeTask(task, context);
  }

  /**
   * V0.9.4: Check if a task requires approval.
   */
  async checkApproval(task, context) {
    // If no approval policy, no approval needed
    if (!this.approvalPolicy) {
      return { canProceed: true, reason: 'No approval policy' };
    }

    const approvalContext = {
      toolName: context.toolName || 'unknown',
      args: context.args || {},
      environment: context.environment || 'development',
      riskLevel: context.riskLevel || 'medium',
      taskId: task.id,
      planId: this.plan.id,
    };

    const policyResult = this.approvalPolicy.requiresApproval(approvalContext);

    if (!policyResult.required) {
      return { canProceed: true, reason: 'No approval required' };
    }

    // Check if already has an approved request
    const existingRequest = this.executionGate.getRequest(task.id);
    if (existingRequest && existingRequest.status === APPROVAL_STATUS.APPROVED) {
      return { canProceed: true, reason: 'Already approved' };
    }

    // Check if already rejected
    if (existingRequest && existingRequest.status === APPROVAL_STATUS.REJECTED) {
      return { canProceed: false, reason: 'Previously rejected', request: existingRequest };
    }

    // Request approval (creates new pending request if none exists)
    const request = this.executionGate.requestApproval(
      this.plan.runId,
      { id: task.id, type: 'task', name: task.goal },
      policyResult.reason,
      approvalContext
    );

    return {
      canProceed: false,
      reason: 'Awaiting approval',
      request,
      policyResult,
    };
  }

  /**
   * V0.9.4: Execute a task — create ToolExecution and run it.
   */
  executeTask(task, context) {
    if (!this.runtimeContext) {
      console.warn('[ExecutionCoordinator] No runtime context — cannot create tool execution');
      return null;
    }

    // Mark task as scheduled
    this.scheduler.markScheduled(task.id);

    // Create ToolExecution
    const te = createToolExecution(
      this.plan.runId,
      task.id,
      context.toolName || 'unknown',
      context.args || {},
      { skillId: context.skillId }
    );

    // Add to runtime context
    if (this.runtimeContext.addToolExecution) {
      this.runtimeContext.addToolExecution(te);
    }

    // Submit for policy check
    submitToolExecution(te, this.emitter);

    // Policy check
    const policyResult = completePolicyCheck(te, this.emitter, {
      policyContext: context.policyContext || createPolicyContext('development'),
      availableTools: context.availableTools || [],
      skillTools: context.skillTools || [],
    });

    if (!policyResult.allowed) {
      failToolExecution(te, this.emitter, { reason: policyResult.reason });
      return { taskId: task.id, te, blocked: true, reason: policyResult.reason };
    }

    // Start execution
    startToolExecution(te, this.emitter);

    // Execute (simulated — actual tool call would happen here)
    const result = context.execute ? context.execute(task, te) : { success: true, result: 'executed' };

    if (result.success) {
      completeToolExecution(te, this.emitter, {
        result: result.result,
        evidenceRegistry: this.evidenceRegistry,
      });
    } else {
      failToolExecution(te, this.emitter, { reason: result.error || 'Execution failed' });
    }

    return { taskId: task.id, te, result };
  }

  /**
   * V0.9.4: Get scheduling summary.
   */
  getSummary() {
    return this.scheduler.getSummary();
  }

  /**
   * V0.9.4: Get ready tasks.
   */
  getReadyTasks() {
    return this.scheduler.getReadyTasks();
  }

  /**
   * V0.9.4: Pause execution.
   */
  pause() {
    this.scheduler.pause();
  }

  /**
   * V0.9.4: Resume execution.
   */
  resume() {
    this.scheduler.resume();
  }
}

/**
 * V0.9.4: Create an ExecutionCoordinator.
 */
function createExecutionCoordinator(options) {
  return new ExecutionCoordinator(options);
}

export {
  ExecutionCoordinator,
  createExecutionCoordinator,
};