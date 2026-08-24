/**
 * agent/runtime/governance.js — Runtime Governance & Human Approval Workflow
 *
 * V0.9.8
 * - RuntimePolicy: requireApproval, maxRiskLevel, allowAutoRevision
 * - GovernanceManager: pause/resume runs, check policy, manage approvals
 * - Integration with Task, Scheduler, EventStore, Snapshot
 *
 * Design:
 *   Runtime Governance ensures human control over autonomous execution.
 *   Policy defines what requires approval.
 *   Runtime can be paused and resumed.
 *   All human actions produce Events.
 */

import { RUNTIME_EVENT_TYPES } from './events.js';
import { TASK_STATUS } from './task.js';

// ── Governance Policy ─────────────────────────────────────

const RISK_LEVELS = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical',
};

const RISK_ORDER = {
  [RISK_LEVELS.LOW]: 1,
  [RISK_LEVELS.MEDIUM]: 2,
  [RISK_LEVELS.HIGH]: 3,
  [RISK_LEVELS.CRITICAL]: 4,
};

/**
 * V0.9.8: RuntimePolicy — defines what requires human approval.
 */
class RuntimePolicy {
  constructor(options = {}) {
    this.requireApproval = options.requireApproval || [];
    this.maxRiskLevel = options.maxRiskLevel || RISK_LEVELS.HIGH;
    this.allowAutoRevision = options.allowAutoRevision !== false;
    this.allowAutoTool = options.allowAutoTool !== false;
    this.operator = options.operator || 'user';
  }

  /**
   * Check if a tool/action requires approval.
   */
  requiresApproval(toolName, riskLevel) {
    // Check explicit tool list
    if (this.requireApproval.includes(toolName)) {
      return true;
    }
    // Check risk level
    if (riskLevel && RISK_ORDER[riskLevel] > RISK_ORDER[this.maxRiskLevel]) {
      return true;
    }
    return false;
  }

  /**
   * Check if auto revision is allowed.
   */
  canAutoRevise() {
    return this.allowAutoRevision;
  }

  /**
   * Check if auto tool execution is allowed.
   */
  canAutoTool() {
    return this.allowAutoTool;
  }

  /**
   * Serialize policy for snapshot.
   */
  serialize() {
    return {
      requireApproval: [...this.requireApproval],
      maxRiskLevel: this.maxRiskLevel,
      allowAutoRevision: this.allowAutoRevision,
      allowAutoTool: this.allowAutoTool,
      operator: this.operator,
    };
  }

  /**
   * Deserialize policy from snapshot.
   */
  static deserialize(data) {
    if (!data) return new RuntimePolicy();
    return new RuntimePolicy(data);
  }
}

/**
 * V0.9.8: Create a RuntimePolicy from options.
 */
function createPolicy(options) {
  return new RuntimePolicy(options);
}

/**
 * V0.9.8: Default policy — minimal approval requirements.
 */
const DEFAULT_GOVERNANCE_POLICY = {
  requireApproval: ['file_delete', 'shell_execute', 'git_push', 'git_force_push'],
  maxRiskLevel: RISK_LEVELS.HIGH,
  allowAutoRevision: true,
  allowAutoTool: true,
};

// ── Governance Manager ────────────────────────────────────

/**
 * V0.9.8: GovernanceManager — manages human approval workflow.
 */
class GovernanceManager {
  constructor(options = {}) {
    this.policy = options.policy || new RuntimePolicy(DEFAULT_GOVERNANCE_POLICY);
    this.emitter = options.emitter || null;
    this.runStatusMap = options.runStatusMap || new Map(); // runId → 'running' | 'paused'
    this.approvalRequests = options.approvalRequests || new Map(); // taskId → approval request
    this.eventStore = options.eventStore || null;
  }

  // ── Policy Check ──────────────────────────────────────

  /**
   * V0.9.8: Check if an action requires approval.
   */
  checkPolicy(toolName, riskLevel) {
    return this.policy.requiresApproval(toolName, riskLevel);
  }

  /**
   * V0.9.8: Get the current policy.
   */
  getPolicy() {
    return this.policy;
  }

  /**
   * V0.9.8: Update policy.
   */
  updatePolicy(updates) {
    this.policy = new RuntimePolicy({ ...this.policy.serialize(), ...updates });
    return this.policy;
  }

  // ── Pause / Resume ────────────────────────────────────

  /**
   * V0.9.8: Pause a run.
   * - Sets run status to 'paused'
   * - Scheduler stops dispatching new tasks
   * - Emits RUN_PAUSED event
   */
  pauseRun(runId, context = {}) {
    if (this.runStatusMap.get(runId) === 'paused') {
      return { success: false, reason: 'Run already paused', runId };
    }

    this.runStatusMap.set(runId, 'paused');

    if (this.emitter) {
      this.emitter.emit({
        runId,
        type: RUNTIME_EVENT_TYPES.RUN_PAUSED,
        data: {
          reason: context.reason || 'Human pause',
          operator: context.operator || 'user',
        },
      });
    }

    return { success: true, runId, status: 'paused' };
  }

  /**
   * V0.9.8: Resume a run.
   * - Sets run status to 'running'
   * - Scheduler resumes dispatching
   * - Emits RUN_RESUMED event
   */
  resumeRun(runId, context = {}) {
    if (this.runStatusMap.get(runId) !== 'paused') {
      return { success: false, reason: 'Run not paused', runId };
    }

    this.runStatusMap.set(runId, 'running');

    if (this.emitter) {
      this.emitter.emit({
        runId,
        type: RUNTIME_EVENT_TYPES.RUN_RESUMED,
        data: {
          reason: context.reason || 'Human resume',
          operator: context.operator || 'user',
        },
      });
    }

    return { success: true, runId, status: 'running' };
  }

  /**
   * V0.9.8: Check if a run is paused.
   */
  isRunPaused(runId) {
    return this.runStatusMap.get(runId) === 'paused';
  }

  /**
   * V0.9.8: Get run status.
   */
  getRunStatus(runId) {
    return this.runStatusMap.get(runId) || 'running';
  }

  // ── Approval Management ───────────────────────────────

  /**
   * V0.9.8: Create an approval request for a task.
   */
  createApprovalRequest(taskId, runId, context = {}) {
    const request = {
      id: `apr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      taskId,
      runId,
      reason: context.reason || 'Human approval required',
      riskLevel: context.riskLevel || 'medium',
      toolName: context.toolName || null,
      status: 'pending',
      requestedAt: Date.now(),
      approvedAt: null,
      rejectedAt: null,
      expiredAt: null,
      operator: context.operator || 'user',
    };

    this.approvalRequests.set(taskId, request);

    if (this.emitter) {
      this.emitter.emit({
        runId,
        taskId,
        type: RUNTIME_EVENT_TYPES.APPROVAL_REQUESTED,
        data: {
          approvalId: request.id,
          reason: request.reason,
          riskLevel: request.riskLevel,
          toolName: request.toolName,
        },
      });
    }

    return request;
  }

  /**
   * V0.9.8: Approve a pending approval request.
   */
  approveRequest(taskId, context = {}) {
    const request = this.approvalRequests.get(taskId);
    if (!request) {
      return { success: false, reason: 'No approval request found', taskId };
    }
    if (request.status !== 'pending') {
      return { success: false, reason: `Request already ${request.status}`, taskId };
    }

    request.status = 'approved';
    request.approvedAt = Date.now();
    request.approvedBy = context.operator || 'user';
    request.approvalReason = context.reason || 'Approved';

    if (this.emitter) {
      this.emitter.emit({
        runId: request.runId,
        taskId,
        type: RUNTIME_EVENT_TYPES.APPROVAL_GRANTED,
        data: {
          approvalId: request.id,
          operator: request.approvedBy,
          reason: request.approvalReason,
        },
      });
    }

    return { success: true, request };
  }

  /**
   * V0.9.8: Reject a pending approval request.
   */
  rejectRequest(taskId, context = {}) {
    const request = this.approvalRequests.get(taskId);
    if (!request) {
      return { success: false, reason: 'No approval request found', taskId };
    }
    if (request.status !== 'pending') {
      return { success: false, reason: `Request already ${request.status}`, taskId };
    }

    request.status = 'rejected';
    request.rejectedAt = Date.now();
    request.rejectedBy = context.operator || 'user';
    request.rejectionReason = context.reason || 'Rejected';

    if (this.emitter) {
      this.emitter.emit({
        runId: request.runId,
        taskId,
        type: RUNTIME_EVENT_TYPES.APPROVAL_REJECTED,
        data: {
          approvalId: request.id,
          operator: request.rejectedBy,
          reason: request.rejectionReason,
        },
      });
    }

    return { success: true, request };
  }

  /**
   * V0.9.8: Get approval request for a task.
   */
  getApprovalRequest(taskId) {
    return this.approvalRequests.get(taskId) || null;
  }

  /**
   * V0.9.8: Get all pending approval requests for a run.
   */
  getPendingApprovals(runId) {
    const pending = [];
    for (const request of this.approvalRequests.values()) {
      if (request.runId === runId && request.status === 'pending') {
        pending.push(request);
      }
    }
    return pending;
  }

  /**
   * V0.9.8: Check if a run has pending approvals.
   */
  hasPendingApprovals(runId) {
    return this.getPendingApprovals(runId).length > 0;
  }

  // ── Serialization ─────────────────────────────────────

  /**
   * V0.9.8: Serialize governance state for snapshot.
   */
  serialize() {
    return {
      policy: this.policy.serialize(),
      runStatus: Object.fromEntries(this.runStatusMap),
      approvals: Object.fromEntries(this.approvalRequests),
    };
  }

  /**
   * V0.9.8: Deserialize governance state from snapshot.
   */
  deserialize(data) {
    if (!data) return;
    if (data.policy) {
      this.policy = RuntimePolicy.deserialize(data.policy);
    }
    if (data.runStatus) {
      this.runStatusMap = new Map(Object.entries(data.runStatus));
    }
    if (data.approvals) {
      this.approvalRequests = new Map(Object.entries(data.approvals));
    }
  }
}

/**
 * V0.9.8: Create a GovernanceManager.
 */
function createGovernanceManager(options) {
  return new GovernanceManager(options);
}

export {
  RISK_LEVELS,
  RuntimePolicy,
  createPolicy,
  DEFAULT_GOVERNANCE_POLICY,
  GovernanceManager,
  createGovernanceManager,
};