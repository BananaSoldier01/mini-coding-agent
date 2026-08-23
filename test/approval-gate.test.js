/**
 * test/approval-gate.test.js — Runtime Approval & Execution Gate Tests
 *
 * V0.9.3
 * Tests for ApprovalRequest, ExecutionGate, ApprovalPolicy.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
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
  RuntimeEventEmitter,
  RUNTIME_EVENT_TYPES,
} from '../agent/skill.js';

// ── Test 1: ApprovalRequest Object ────────────────────────

test('Approval: createApprovalRequest sets initial status', () => {
  const request = createApprovalRequest('run-1', { id: 'te-1', type: 'tool', name: 'delete_file' }, 'Destructive operation', { toolName: 'delete_file' });
  assert.strictEqual(request.status, APPROVAL_STATUS.PENDING);
  assert.ok(request.id);
  assert.strictEqual(request.target.id, 'te-1');
  assert.strictEqual(request.target.type, 'tool');
  assert.strictEqual(request.reason, 'Destructive operation');
  assert.ok(request.createdAt > 0);
  assert.strictEqual(request.resolvedAt, null);
});

test('Approval: createApprovalRequest with timeout sets expiresAt', () => {
  const request = createApprovalRequest('run-1', { id: 'te-1', type: 'tool' }, 'Test', {}, 5000);
  assert.ok(request.expiresAt > Date.now());
  assert.strictEqual(request.timeoutMs, 5000);
});

// ── Test 2: Approval Lifecycle ────────────────────────────

test('Approval: approveRequest transitions PENDING → APPROVED', () => {
  const request = createApprovalRequest('run-1', { id: 'te-1', type: 'tool' }, 'Test');
  const emitter = new RuntimeEventEmitter();

  assert.ok(approveRequest(request, 'user-1', 'OK', emitter));
  assert.strictEqual(request.status, APPROVAL_STATUS.APPROVED);
  assert.ok(request.resolvedAt > 0);
  assert.strictEqual(request.resolvedBy, 'user-1');
});

test('Approval: rejectRequest transitions PENDING → REJECTED', () => {
  const request = createApprovalRequest('run-1', { id: 'te-1', type: 'tool' }, 'Test');
  const emitter = new RuntimeEventEmitter();

  assert.ok(rejectRequest(request, 'user-1', 'No way', emitter));
  assert.strictEqual(request.status, APPROVAL_STATUS.REJECTED);
  assert.strictEqual(request.resolutionReason, 'No way');
});

test('Approval: cannot approve already approved request', () => {
  const request = createApprovalRequest('run-1', { id: 'te-1', type: 'tool' }, 'Test');
  approveRequest(request, 'user-1', 'OK');
  assert.ok(!approveRequest(request, 'user-2', 'Again'));
  assert.strictEqual(request.status, APPROVAL_STATUS.APPROVED);
});

test('Approval: cannot reject already rejected request', () => {
  const request = createApprovalRequest('run-1', { id: 'te-1', type: 'tool' }, 'Test');
  rejectRequest(request, 'user-1', 'No');
  assert.ok(!rejectRequest(request, 'user-2', 'Again'));
  assert.strictEqual(request.status, APPROVAL_STATUS.REJECTED);
});

test('Approval: expireRequest transitions PENDING → EXPIRED', () => {
  const request = createApprovalRequest('run-1', { id: 'te-1', type: 'tool' }, 'Test');
  const emitter = new RuntimeEventEmitter();

  assert.ok(expireRequest(request, emitter));
  assert.strictEqual(request.status, APPROVAL_STATUS.EXPIRED);
  assert.strictEqual(request.resolvedBy, 'system');
});

test('Approval: getApprovalStatus returns current status', () => {
  const request = createApprovalRequest('run-1', { id: 'te-1', type: 'tool' }, 'Test');
  assert.strictEqual(getApprovalStatus(request), APPROVAL_STATUS.PENDING);

  approveRequest(request, 'user-1', 'OK');
  assert.strictEqual(getApprovalStatus(request), APPROVAL_STATUS.APPROVED);
});

test('Approval: canTransitionApproval checks without modifying', () => {
  const request = createApprovalRequest('run-1', { id: 'te-1', type: 'tool' }, 'Test');
  assert.ok(canTransitionApproval(request, APPROVAL_STATUS.APPROVED));
  assert.ok(canTransitionApproval(request, APPROVAL_STATUS.REJECTED));
  assert.ok(!canTransitionApproval(request, APPROVAL_STATUS.COMPLETED));
  assert.strictEqual(request.status, APPROVAL_STATUS.PENDING);
});

// ── Test 3: Expiry ───────────────────────────────────────

test('Approval: isExpired returns false for non-expired request', () => {
  const request = createApprovalRequest('run-1', { id: 'te-1', type: 'tool' }, 'Test', {}, 5000);
  assert.ok(!isExpired(request));
});

test('Approval: isExpired returns false for resolved request', () => {
  const request = createApprovalRequest('run-1', { id: 'te-1', type: 'tool' }, 'Test', {}, 5000);
  approveRequest(request, 'user-1', 'OK');
  assert.ok(!isExpired(request));
});

test('Approval: isExpired returns true for expired pending request', () => {
  const request = createApprovalRequest('run-1', { id: 'te-1', type: 'tool' }, 'Test', {}, -100);
  // expiresAt is in the past
  assert.ok(isExpired(request));
});

// ── Test 4: ExecutionGate ─────────────────────────────────

test('Approval: ExecutionGate requestApproval creates pending request', () => {
  const gate = new ExecutionGate();
  const request = gate.requestApproval('run-1', { id: 'te-1', type: 'tool', name: 'delete_file' }, 'Destructive op', { toolName: 'delete_file' });
  assert.strictEqual(request.status, APPROVAL_STATUS.PENDING);
  assert.strictEqual(gate.getRequest(request.id).status, APPROVAL_STATUS.PENDING);
});

test('Approval: ExecutionGate canProceed returns false for pending', () => {
  const gate = new ExecutionGate();
  gate.requestApproval('run-1', { id: 'te-1', type: 'tool' }, 'Test');
  const result = gate.canProceed('te-1');
  assert.ok(!result.allowed);
  assert.strictEqual(result.reason, 'Awaiting approval');
});

test('Approval: ExecutionGate canProceed returns true after approve', () => {
  const gate = new ExecutionGate();
  const request = gate.requestApproval('run-1', { id: 'te-1', type: 'tool' }, 'Test');
  gate.approve(request.id, 'user-1', 'OK');
  const result = gate.canProceed('te-1');
  assert.ok(result.allowed);
  assert.strictEqual(result.reason, 'Approved');
});

test('Approval: ExecutionGate canProceed returns false after reject', () => {
  const gate = new ExecutionGate();
  const request = gate.requestApproval('run-1', { id: 'te-1', type: 'tool' }, 'Test');
  gate.reject(request.id, 'user-1', 'No');
  const result = gate.canProceed('te-1');
  assert.ok(!result.allowed);
  assert.strictEqual(result.reason, 'Rejected');
});

test('Approval: ExecutionGate canProceed returns true when no approval needed', () => {
  const gate = new ExecutionGate();
  const result = gate.canProceed('te-no-approval');
  assert.ok(result.allowed);
  assert.strictEqual(result.reason, 'No approval required');
});

test('Approval: ExecutionGate autoApprove bypasses gate', () => {
  const gate = new ExecutionGate();
  gate.setAutoApprove(true);
  const request = gate.requestApproval('run-1', { id: 'te-1', type: 'tool' }, 'Test');
  assert.strictEqual(request.status, APPROVAL_STATUS.APPROVED);
  const result = gate.canProceed('te-1');
  assert.ok(result.allowed);
});

test('Approval: ExecutionGate getPendingRequests returns only pending', () => {
  const gate = new ExecutionGate();
  const r1 = gate.requestApproval('run-1', { id: 'te-1', type: 'tool' }, 'Test 1');
  const r2 = gate.requestApproval('run-1', { id: 'te-2', type: 'tool' }, 'Test 2');
  gate.approve(r1.id, 'user-1', 'OK');

  const pending = gate.getPendingRequests('run-1');
  assert.strictEqual(pending.length, 1);
  assert.strictEqual(pending[0].id, r2.id);
});

// ── Test 5: ApprovalPolicy ────────────────────────────────

test('Approval: ApprovalPolicy requires approval for delete_file', () => {
  const policy = createApprovalPolicy();
  const result = policy.requiresApproval({ toolName: 'delete_file' });
  assert.ok(result.required);
  assert.strictEqual(result.riskLevel, 'high');
});

test('Approval: ApprovalPolicy requires approval for run_shell', () => {
  const policy = createApprovalPolicy();
  const result = policy.requiresApproval({ toolName: 'run_shell' });
  assert.ok(result.required);
});

test('Approval: ApprovalPolicy requires approval for production', () => {
  const policy = createApprovalPolicy();
  const result = policy.requiresApproval({ environment: 'production' });
  assert.ok(result.required);
});

test('Approval: ApprovalPolicy does not require approval for read_file in dev', () => {
  const policy = createApprovalPolicy();
  const result = policy.requiresApproval({ toolName: 'read_file', environment: 'development' });
  assert.ok(!result.required);
});

test('Approval: ApprovalPolicy custom rules can override', () => {
  const policy = createApprovalPolicy([
    {
      match: (ctx) => ctx.toolName === 'read_file',
      reason: 'Custom rule requires approval',
      riskLevel: 'medium',
    },
  ]);
  const result = policy.requiresApproval({ toolName: 'read_file' });
  assert.ok(result.required);
  assert.strictEqual(result.reason, 'Custom rule requires approval');
});

// ── Test 6: Integration — Approval Gate with ToolExecution ─

test('Approval: full flow — request → gate → approve → execute', () => {
  const gate = new ExecutionGate();
  const emitter = new RuntimeEventEmitter();

  // 1. Request approval for a tool
  const request = gate.requestApproval(
    'run-1',
    { id: 'te-1', type: 'tool', name: 'delete_file' },
    'Destructive operation',
    { toolName: 'delete_file', riskLevel: 'high' }
  );

  // 2. Check gate — blocked
  const blocked = gate.canProceed('te-1');
  assert.ok(!blocked.allowed);

  // 3. Approve
  gate.approve(request.id, 'user-1', 'Approved by human');

  // 4. Check gate — allowed
  const allowed = gate.canProceed('te-1');
  assert.ok(allowed.allowed);

  // 5. Execute (simulated)
  assert.strictEqual(request.status, APPROVAL_STATUS.APPROVED);
});

test('Approval: full flow — request → gate → reject → blocked', () => {
  const gate = new ExecutionGate();
  const request = gate.requestApproval(
    'run-1',
    { id: 'te-1', type: 'tool', name: 'delete_file' },
    'Destructive operation',
    { toolName: 'delete_file' }
  );

  // Reject
  gate.reject(request.id, 'user-1', 'Not allowed');

  // Gate should block
  const result = gate.canProceed('te-1');
  assert.ok(!result.allowed);
  assert.strictEqual(result.reason, 'Rejected');
});

test('Approval: approval events emitted on lifecycle', () => {
  const emitter = new RuntimeEventEmitter();
  const events = [];
  emitter.onAll((ev) => events.push(ev));

  const request1 = createApprovalRequest('run-1', { id: 'te-1', type: 'tool' }, 'Test');
  approveRequest(request1, 'user-1', 'OK', emitter);

  const request2 = createApprovalRequest('run-1', { id: 'te-2', type: 'tool' }, 'Test');
  rejectRequest(request2, 'user-2', 'No', emitter);

  const types = events.map(e => e.type);
  assert.ok(types.includes('approval_granted'));
  assert.ok(types.includes('approval_denied'));
});

test('Approval: ExecutionGate with external approver', async () => {
  const gate = new ExecutionGate();
  gate.setApprover(async (request) => {
    // Auto-approve high-risk in test mode
    return request.context.riskLevel === 'high';
  });

  const req = gate.requestApproval('run-1', { id: 'te-1', type: 'tool' }, 'Test', { riskLevel: 'high' });
  await gate.processPending('run-1');

  const request = gate.getRequest(req.id);
  assert.strictEqual(request.status, APPROVAL_STATUS.APPROVED);
});

test('Approval: ExecutionGate with rejecting approver', async () => {
  const gate = new ExecutionGate();
  gate.setApprover(async () => false);

  const req = gate.requestApproval('run-1', { id: 'te-1', type: 'tool' }, 'Test', { riskLevel: 'high' });
  await gate.processPending('run-1');

  const request = gate.getRequest(req.id);
  assert.strictEqual(request.status, APPROVAL_STATUS.REJECTED);
});