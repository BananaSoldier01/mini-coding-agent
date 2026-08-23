/**
 * agent/runtime/approval.js — Runtime Approval & Execution Gate
 *
 * V0.9.3
 * - ApprovalRequest: approval lifecycle (PENDING → APPROVED/REJECTED/EXPIRED)
 * - ExecutionGate: gate that blocks execution until approval
 * - Integration with ToolExecution and Plan
 *
 * Design:
 *   Execution Request → Approval Required → Approved/Rejected → Continue
 *
 *   "Planner proposes. Runtime decides. Approval gates."
 */

import { RUNTIME_EVENT_TYPES } from './events.js';

// ── Approval Status ───────────────────────────────────────

const APPROVAL_STATUS = {
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  EXPIRED: 'expired',
};

const APPROVAL_TRANSITIONS = {
  [APPROVAL_STATUS.PENDING]: [APPROVAL_STATUS.APPROVED, APPROVAL_STATUS.REJECTED, APPROVAL_STATUS.EXPIRED],
  [APPROVAL_STATUS.APPROVED]: [],
  [APPROVAL_STATUS.REJECTED]: [],
  [APPROVAL_STATUS.EXPIRED]: [],
};

// ── Approval Request ──────────────────────────────────────

/**
 * V0.9.3: Create an ApprovalRequest.
 *
 * @param {string} runId - Run ID
 * @param {object} target - What needs approval { type: 'tool'|'plan'|'task', id, name }
 * @param {string} reason - Why approval is needed
 * @param {object} context - Additional context { policySource, riskLevel, toolName, args }
 * @param {number} [timeoutMs] - Auto-expire after this many ms
 * @returns {object} ApprovalRequest
 */
function createApprovalRequest(runId, target, reason, context = {}, timeoutMs = null) {
  return {
    id: `appr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    runId,
    target: {
      type: target.type || 'tool',
      id: target.id,
      name: target.name || target.id,
    },
    reason,
    context: {
      policySource: context.policySource || 'runtime',
      riskLevel: context.riskLevel || 'medium',
      toolName: context.toolName || null,
      args: context.args || null,
      ...context,
    },
    status: APPROVAL_STATUS.PENDING,
    createdAt: Date.now(),
    resolvedAt: null,
    resolvedBy: null,
    resolutionReason: null,
    timeoutMs,
    expiresAt: timeoutMs ? Date.now() + timeoutMs : null,
  };
}

// ── Approval Lifecycle ────────────────────────────────────

/**
 * V0.9.3: Approve a request — PENDING → APPROVED.
 */
function approveRequest(request, resolvedBy, reason, emitter) {
  if (!request) return false;
  if (request.status !== APPROVAL_STATUS.PENDING) {
    console.warn(`[Approval] Cannot approve request in status: ${request.status}`);
    return false;
  }

  // Check expiry
  if (request.expiresAt && Date.now() > request.expiresAt) {
    request.status = APPROVAL_STATUS.EXPIRED;
    return false;
  }

  request.status = APPROVAL_STATUS.APPROVED;
  request.resolvedAt = Date.now();
  request.resolvedBy = resolvedBy || 'system';
  request.resolutionReason = reason || 'Approved';

  if (emitter) {
    emitter.emit({
      runId: request.runId,
      approvalId: request.id,
      type: 'approval_granted',
      data: {
        target: request.target,
        resolvedBy: request.resolvedBy,
        reason: request.resolutionReason,
      },
    });
  }

  return true;
}

/**
 * V0.9.3: Reject a request — PENDING → REJECTED.
 */
function rejectRequest(request, resolvedBy, reason, emitter) {
  if (!request) return false;
  if (request.status !== APPROVAL_STATUS.PENDING) {
    console.warn(`[Approval] Cannot reject request in status: ${request.status}`);
    return false;
  }

  request.status = APPROVAL_STATUS.REJECTED;
  request.resolvedAt = Date.now();
  request.resolvedBy = resolvedBy || 'system';
  request.resolutionReason = reason || 'Rejected';

  if (emitter) {
    emitter.emit({
      runId: request.runId,
      approvalId: request.id,
      type: 'approval_denied',
      data: {
        target: request.target,
        resolvedBy: request.resolvedBy,
        reason: request.resolutionReason,
      },
    });
  }

  return true;
}

/**
 * V0.9.3: Expire a request — PENDING → EXPIRED.
 */
function expireRequest(request, emitter) {
  if (!request) return false;
  if (request.status !== APPROVAL_STATUS.PENDING) {
    return false;
  }

  request.status = APPROVAL_STATUS.EXPIRED;
  request.resolvedAt = Date.now();
  request.resolvedBy = 'system';
  request.resolutionReason = 'Approval timeout';

  if (emitter) {
    emitter.emit({
      runId: request.runId,
      approvalId: request.id,
      type: 'approval_expired',
      data: { target: request.target },
    });
  }

  return true;
}

/**
 * V0.9.3: Check if request is expired.
 */
function isExpired(request) {
  if (!request) return false;
  if (request.status !== APPROVAL_STATUS.PENDING) return false;
  return request.expiresAt ? Date.now() > request.expiresAt : false;
}

/**
 * V0.9.3: Get approval status.
 */
function getApprovalStatus(request) {
  return request ? request.status : null;
}

/**
 * V0.9.3: Check if transition is valid.
 */
function canTransitionApproval(request, newStatus) {
  if (!request) return false;
  return (APPROVAL_TRANSITIONS[request.status] || []).includes(newStatus);
}

// ── Execution Gate ────────────────────────────────────────

/**
 * V0.9.3: ExecutionGate — gates execution until approval.
 *
 * Usage:
 *   const gate = new ExecutionGate();
 *   const request = gate.requestApproval(runId, target, reason, context);
 *   // ... wait for approval ...
 *   if (gate.isApproved(request.id)) { execute() }
 */
class ExecutionGate {
  constructor() {
    this.requests = new Map(); // id → ApprovalRequest
    this.autoApprove = false; // Set true to bypass (for testing)
    this.approver = null; // External approver function
  }

  /**
   * V0.9.3: Request approval for an execution target.
   */
  requestApproval(runId, target, reason, context = {}, timeoutMs = null) {
    const request = createApprovalRequest(runId, target, reason, context, timeoutMs);
    this.requests.set(request.id, request);

    if (this.autoApprove) {
      approveRequest(request, 'auto', 'Auto-approved (gate in bypass mode)');
    }

    return request;
  }

  /**
   * V0.9.3: Check if an execution target can proceed.
   * Returns { allowed, reason, request }.
   */
  canProceed(targetId) {
    // Find any request for this target (not just pending)
    const request = Array.from(this.requests.values())
      .find(r => r.target.id === targetId);

    if (!request) {
      return { allowed: true, reason: 'No approval required', request: null };
    }

    // Check expiry for pending requests
    if (request.status === APPROVAL_STATUS.PENDING && isExpired(request)) {
      expireRequest(request);
      return { allowed: false, reason: 'Approval expired', request };
    }

    if (request.status === APPROVAL_STATUS.APPROVED) {
      return { allowed: true, reason: 'Approved', request };
    }

    if (request.status === APPROVAL_STATUS.REJECTED) {
      return { allowed: false, reason: 'Rejected', request };
    }

    if (request.status === APPROVAL_STATUS.EXPIRED) {
      return { allowed: false, reason: 'Approval expired', request };
    }

    return { allowed: false, reason: 'Awaiting approval', request };
  }

  /**
   * V0.9.3: Approve a pending request.
   */
  approve(requestId, resolvedBy, reason) {
    const request = this.requests.get(requestId);
    if (!request) return false;
    return approveRequest(request, resolvedBy, reason);
  }

  /**
   * V0.9.3: Reject a pending request.
   */
  reject(requestId, resolvedBy, reason) {
    const request = this.requests.get(requestId);
    if (!request) return false;
    return rejectRequest(request, resolvedBy, reason);
  }

  /**
   * V0.9.3: Get a request by ID.
   */
  getRequest(requestId) {
    return this.requests.get(requestId) || null;
  }

  /**
   * V0.9.3: Get all pending requests for a run.
   */
  getPendingRequests(runId) {
    return Array.from(this.requests.values())
      .filter(r => r.runId === runId && r.status === APPROVAL_STATUS.PENDING);
  }

  /**
   * V0.9.3: Enable auto-approve mode (for testing).
   */
  setAutoApprove(enabled) {
    this.autoApprove = enabled;
  }

  /**
   V0.9.3: Set external approver function.
   * Called when a request needs approval.
   */
  setApprover(fn) {
    this.approver = fn;
  }

  /**
   * V0.9.3: Process pending requests through the approver.
   */
  async processPending(runId) {
    const pending = this.getPendingRequests(runId);
    for (const request of pending) {
      if (this.approver) {
        const result = await this.approver(request);
        if (result === true) {
          approveRequest(request, 'approver', 'Auto-approved by approver');
        } else if (result === false) {
          rejectRequest(request, 'approver', 'Auto-rejected by approver');
        }
      }
      // Check expiry
      if (isExpired(request)) {
        expireRequest(request);
      }
    }
  }
}

// ── Approval Policy ───────────────────────────────────────

/**
 * V0.9.3: ApprovalPolicy — determines when approval is required.
 *
 * Rules:
 * - High-risk tools always require approval
 * - Destructive operations always require approval
 * - Production environment always requires approval
 * - Custom rules can be added
 */
class ApprovalPolicy {
  constructor(rules = []) {
    this.rules = rules;
  }

  /**
   * V0.9.3: Check if an action requires approval.
   * @param {object} context - { toolName, args, environment, riskLevel, planId, taskId }
   * @returns {object} { required, reason, riskLevel }
   */
  requiresApproval(context) {
    // Default: no approval required
    let required = false;
    let reason = '';
    let riskLevel = context.riskLevel || 'low';

    // Check each rule
    for (const rule of this.rules) {
      if (rule.match(context)) {
        required = true;
        reason = rule.reason || 'Requires approval';
        riskLevel = rule.riskLevel || 'high';
        break;
      }
    }

    return { required, reason, riskLevel };
  }
}

/**
 * V0.9.3: Default approval policy rules.
 */
const DEFAULT_APPROVAL_RULES = [
  {
    match: (ctx) => ctx.toolName === 'delete_file' || ctx.toolName === 'run_shell' || ctx.toolName === 'git_push',
    reason: 'Destructive operation requires approval',
    riskLevel: 'high',
  },
  {
    match: (ctx) => ctx.environment === 'production',
    reason: 'Production environment requires approval',
    riskLevel: 'high',
  },
  {
    match: (ctx) => ctx.riskLevel === 'high',
    reason: 'High-risk operation requires approval',
    riskLevel: 'high',
  },
];

/**
 * V0.9.3: Create an ApprovalPolicy with default rules.
 */
function createApprovalPolicy(rules = []) {
  return new ApprovalPolicy([...DEFAULT_APPROVAL_RULES, ...rules]);
}

export {
  APPROVAL_STATUS,
  APPROVAL_TRANSITIONS,
  createApprovalRequest,
  approveRequest,
  rejectRequest,
  expireRequest,
  isExpired,
  getApprovalStatus,
  canTransitionApproval,
  ExecutionGate,
  ApprovalPolicy,
  DEFAULT_APPROVAL_RULES,
  createApprovalPolicy,
};