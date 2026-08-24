/**
 * test/recovery-integrity.test.js — Recovery Integrity Tests
 *
 * V0.9.4.1
 * Tests for Approval Recovery Integration and canAutoContinue() fix.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ExecutionGate,
  APPROVAL_STATUS,
  createApprovalRequest,
  approveRequest,
  rejectRequest,
  RuntimeRecoveryManager,
  createRuntimeRecoveryManager,
  createPlan,
  approvePlan,
  startPlan,
  addTaskDependency,
  createTask,
  startTask,
  completeTask,
  TASK_STATUS,
  PLAN_STATUS,
  createSnapshotV2,
  AgentRuntimeContext,
  RuntimeEventEmitter,
  RuntimeEventLog,
  EvidenceRegistry,
  RUNTIME_EVENT_TYPES,
} from '../agent/skill.js';

// ── Test 1: Approval Recovery Integration ─────────────────

test('Recovery: pending approval restored to ExecutionGate', () => {
  const gate = new ExecutionGate();
  const recovery = createRuntimeRecoveryManager();

  // Create a pending approval request
  const request = gate.requestApproval('run-1', { id: 't1', type: 'task', name: 'Delete file' }, 'Destructive op', { toolName: 'delete_file' });
  assert.strictEqual(request.status, APPROVAL_STATUS.PENDING);

  // Create snapshot with approvals
  const plan = createPlan('run-1', 'Goal', { tasks: [{ id: 't1', goal: 'Delete file' }] });
  const snapshot = createSnapshotV2('run-1', null, plan, null, null, 'executing', gate);

  // Verify snapshot has approvals
  assert.ok(snapshot.approvals);
  assert.strictEqual(snapshot.approvals.length, 1);
  assert.strictEqual(snapshot.approvals[0].status, APPROVAL_STATUS.PENDING);

  // Restore into a new gate
  const newGate = new ExecutionGate();
  const result = recovery.restore(snapshot, newGate);

  // Verify approval was restored
  assert.ok(result.approvalRequests.length > 0);
  assert.strictEqual(result.approvalRequests[0].status, APPROVAL_STATUS.PENDING);
  assert.strictEqual(result.approvalRequests[0].target.id, 't1');

  // Verify gate now has the request
  const restoredRequest = newGate.getRequest(result.approvalRequests[0].id);
  assert.ok(restoredRequest);
  assert.strictEqual(restoredRequest.status, APPROVAL_STATUS.PENDING);

  // Verify gate blocks execution
  const gateResult = newGate.canProceed('t1');
  assert.ok(!gateResult.allowed);
  assert.strictEqual(gateResult.reason, 'Awaiting approval');
});

test('Recovery: approved approval restored to ExecutionGate', () => {
  const gate = new ExecutionGate();
  const recovery = createRuntimeRecoveryManager();

  // Create and approve a request
  const request = gate.requestApproval('run-1', { id: 't1', type: 'task', name: 'Read file' }, 'Test', { toolName: 'read_file' });
  gate.approve(request.id, 'user-1', 'OK');

  // Create snapshot
  const plan = createPlan('run-1', 'Goal', { tasks: [{ id: 't1', goal: 'Read file' }] });
  const snapshot = createSnapshotV2('run-1', null, plan, null, null, 'executing', gate);

  // Restore into a new gate
  const newGate = new ExecutionGate();
  const result = recovery.restore(snapshot, newGate);

  // Verify approval was restored as APPROVED
  assert.strictEqual(result.approvalRequests[0].status, APPROVAL_STATUS.APPROVED);

  // Verify gate allows execution
  const gateResult = newGate.canProceed('t1');
  assert.ok(gateResult.allowed);
  assert.strictEqual(gateResult.reason, 'Approved');
});

test('Recovery: rejected approval restored to ExecutionGate', () => {
  const gate = new ExecutionGate();
  const recovery = createRuntimeRecoveryManager();

  // Create and reject a request
  const request = gate.requestApproval('run-1', { id: 't1', type: 'task', name: 'Delete file' }, 'Test', { toolName: 'delete_file' });
  gate.reject(request.id, 'user-1', 'No way');

  // Create snapshot
  const plan = createPlan('run-1', 'Goal', { tasks: [{ id: 't1', goal: 'Delete file' }] });
  const snapshot = createSnapshotV2('run-1', null, plan, null, null, 'executing', gate);

  // Restore into a new gate
  const newGate = new ExecutionGate();
  const result = recovery.restore(snapshot, newGate);

  // Verify approval was restored as REJECTED
  assert.strictEqual(result.approvalRequests[0].status, APPROVAL_STATUS.REJECTED);

  // Verify gate blocks execution
  const gateResult = newGate.canProceed('t1');
  assert.ok(!gateResult.allowed);
  assert.strictEqual(gateResult.reason, 'Rejected');
});

test('Recovery: no duplicate approval request after restore', () => {
  const gate = new ExecutionGate();
  const recovery = createRuntimeRecoveryManager();

  // Create a pending approval
  const request = gate.requestApproval('run-1', { id: 't1', type: 'task', name: 'Delete file' }, 'Test', { toolName: 'delete_file' });
  const originalId = request.id;

  // Create snapshot
  const plan = createPlan('run-1', 'Goal', { tasks: [{ id: 't1', goal: 'Delete file' }] });
  const snapshot = createSnapshotV2('run-1', null, plan, null, null, 'executing', gate);

  // Restore into a new gate
  const newGate = new ExecutionGate();
  recovery.restore(snapshot, newGate);

  // Verify only one request exists (no duplicate)
  const allRequests = newGate.getRequestsByRun('run-1');
  assert.strictEqual(allRequests.length, 1);
  assert.strictEqual(allRequests[0].id, originalId);

  // Verify requestApproval doesn't create a duplicate
  const newRequest = newGate.requestApproval('run-1', { id: 't1', type: 'task' }, 'New request', {});
  assert.notStrictEqual(newRequest.id, originalId);
  // Now there should be 2 requests (original + new)
  assert.strictEqual(newGate.getRequestsByRun('run-1').length, 2);
});

test('Recovery: restore without executionGate still captures approval data', () => {
  const gate = new ExecutionGate();
  const recovery = createRuntimeRecoveryManager();

  gate.requestApproval('run-1', { id: 't1', type: 'task', name: 'Test' }, 'Test', {});

  const plan = createPlan('run-1', 'Goal', { tasks: [{ id: 't1', goal: 'Test' }] });
  const snapshot = createSnapshotV2('run-1', null, plan, null, null, 'executing', gate);

  // Restore without passing executionGate
  const result = recovery.restore(snapshot);

  assert.ok(result.approvalRequests.length > 0);
  assert.strictEqual(result.approvalRequests[0].status, APPROVAL_STATUS.PENDING);
  assert.strictEqual(result.approvalStatusMap.get('t1'), APPROVAL_STATUS.PENDING);
});

// ── Test 2: canAutoContinue() Fix ──────────────────────────

test('canAutoContinue: returns false when pending approvals exist', () => {
  const recovery = createRuntimeRecoveryManager();

  const recoveryResult = {
    restored: true,
    plan: { status: PLAN_STATUS.EXECUTING },
    taskStatusMap: new Map([['t1', TASK_STATUS.COMPLETED]]),
    approvalStatusMap: new Map([['t1', APPROVAL_STATUS.PENDING]]),
    approvalRequests: [
      { id: 'appr-1', status: APPROVAL_STATUS.PENDING, target: { id: 't1' } },
    ],
    issues: [],
  };

  assert.ok(!recovery.canAutoContinue(recoveryResult));
});

test('canAutoContinue: returns false when plan is failed', () => {
  const recovery = createRuntimeRecoveryManager();

  const recoveryResult = {
    restored: true,
    plan: { status: 'failed' },
    taskStatusMap: new Map(),
    approvalStatusMap: new Map(),
    approvalRequests: [],
    issues: [],
  };

  assert.ok(!recovery.canAutoContinue(recoveryResult));
});

test('canAutoContinue: returns false when plan is cancelled', () => {
  const recovery = createRuntimeRecoveryManager();

  const recoveryResult = {
    restored: true,
    plan: { status: 'cancelled' },
    taskStatusMap: new Map(),
    approvalStatusMap: new Map(),
    approvalRequests: [],
    issues: [],
  };

  assert.ok(!recovery.canAutoContinue(recoveryResult));
});

test('canAutoContinue: returns true for clean recovery', () => {
  const recovery = createRuntimeRecoveryManager();

  const recoveryResult = {
    restored: true,
    plan: { status: PLAN_STATUS.EXECUTING },
    taskStatusMap: new Map([['t1', TASK_STATUS.COMPLETED]]),
    approvalStatusMap: new Map(),
    approvalRequests: [],
    issues: [],
  };

  assert.ok(recovery.canAutoContinue(recoveryResult));
});

test('canAutoContinue: returns false when critical issues exist', () => {
  const recovery = createRuntimeRecoveryManager();

  const recoveryResult = {
    restored: true,
    plan: { status: PLAN_STATUS.EXECUTING },
    taskStatusMap: new Map(),
    approvalStatusMap: new Map(),
    approvalRequests: [],
    issues: [
      { severity: 'error', type: 'corruption', message: 'State corrupted' },
    ],
  };

  assert.ok(!recovery.canAutoContinue(recoveryResult));
});

test('canAutoContinue: returns false when approval expired', () => {
  const recovery = createRuntimeRecoveryManager();

  const recoveryResult = {
    restored: true,
    plan: { status: PLAN_STATUS.EXECUTING },
    taskStatusMap: new Map(),
    approvalStatusMap: new Map([['t1', APPROVAL_STATUS.PENDING]]),
    approvalRequests: [
      {
        id: 'appr-1',
        status: APPROVAL_STATUS.PENDING,
        target: { id: 't1' },
        expiresAt: Date.now() - 1000, // Expired
      },
    ],
    issues: [],
  };

  assert.ok(!recovery.canAutoContinue(recoveryResult));
});

test('canAutoContinue: returns false when no recovery provided', () => {
  const recovery = createRuntimeRecoveryManager();
  assert.ok(!recovery.canAutoContinue(null));
});

// ── Test 3: Snapshot Round Trip ────────────────────────────

test('Recovery: snapshot round trip preserves approval state', () => {
  const gate = new ExecutionGate();
  const recovery = createRuntimeRecoveryManager();

  // Create and approve a request
  const request = gate.requestApproval('run-1', { id: 't1', type: 'task', name: 'Test' }, 'Test', {});
  gate.approve(request.id, 'user-1', 'OK');

  // Create snapshot
  const plan = createPlan('run-1', 'Goal', { tasks: [{ id: 't1', goal: 'Test' }] });
  const snapshot = createSnapshotV2('run-1', null, plan, null, null, 'executing', gate);

  // Restore into new gate
  const newGate = new ExecutionGate();
  const result = recovery.restore(snapshot, newGate);

  // Verify round trip
  assert.strictEqual(result.approvalRequests[0].status, APPROVAL_STATUS.APPROVED);
  assert.strictEqual(result.approvalRequests[0].id, request.id);
  assert.strictEqual(result.approvalRequests[0].target.id, 't1');
  assert.strictEqual(result.approvalRequests[0].resolvedBy, 'user-1');
  assert.strictEqual(result.approvalRequests[0].resolutionReason, 'OK');
});

test('Recovery: snapshot round trip preserves task state', () => {
  const recovery = createRuntimeRecoveryManager();

  const plan = createPlan('run-1', 'Goal', {
    tasks: [
      { id: 't1', status: TASK_STATUS.COMPLETED, goal: 'Done' },
      { id: 't2', status: TASK_STATUS.RUNNING, goal: 'Running' },
    ],
  });
  // Set plan status to executing for the test
  plan.status = PLAN_STATUS.EXECUTING;

  const snapshot = createSnapshotV2('run-1', null, plan, null, null, 'executing');
  const result = recovery.restore(snapshot);

  assert.strictEqual(result.taskStatusMap.get('t1'), TASK_STATUS.COMPLETED);
  assert.strictEqual(result.taskStatusMap.get('t2'), TASK_STATUS.RUNNING);
  assert.strictEqual(result.plan.status, PLAN_STATUS.EXECUTING);
});

// ── Test 4: Safety Rules ──────────────────────────────────

test('Recovery: does not auto-approve after restore', () => {
  const gate = new ExecutionGate();
  const recovery = createRuntimeRecoveryManager();

  // Create pending approval
  gate.requestApproval('run-1', { id: 't1', type: 'task', name: 'Delete file' }, 'Test', { toolName: 'delete_file' });

  const plan = createPlan('run-1', 'Goal', { tasks: [{ id: 't1', goal: 'Delete file' }] });
  const snapshot = createSnapshotV2('run-1', null, plan, null, null, 'executing', gate);

  // Restore into new gate
  const newGate = new ExecutionGate();
  const result = recovery.restore(snapshot, newGate);

  // Verify still pending — NOT auto-approved
  assert.strictEqual(result.approvalRequests[0].status, APPROVAL_STATUS.PENDING);
  assert.strictEqual(result.approvalStatusMap.get('t1'), APPROVAL_STATUS.PENDING);

  // Verify gate still blocks
  const gateResult = newGate.canProceed('t1');
  assert.ok(!gateResult.allowed);
});

test('Recovery: does not auto-execute dangerous operations after restore', () => {
  const gate = new ExecutionGate();
  const recovery = createRuntimeRecoveryManager();

  // Create pending approval for dangerous op
  gate.requestApproval('run-1', { id: 't1', type: 'task', name: 'Delete file' }, 'Test', { toolName: 'delete_file' });

  const plan = createPlan('run-1', 'Goal', { tasks: [{ id: 't1', goal: 'Delete file' }] });
  const snapshot = createSnapshotV2('run-1', null, plan, null, null, 'executing', gate);

  const newGate = new ExecutionGate();
  const result = recovery.restore(snapshot, newGate);

  // Verify canAutoContinue returns false
  assert.ok(!recovery.canAutoContinue(result));

  // Verify no duplicate ToolExecution was created
  // (Recovery should not trigger execution)
  assert.strictEqual(result.actions.filter(a => a.type === 'approval_restored').length, 1);
});

test('Recovery: hasPendingApprovals detects pending after restore', () => {
  const gate = new ExecutionGate();
  const recovery = createRuntimeRecoveryManager();

  gate.requestApproval('run-1', { id: 't1', type: 'task', name: 'Test' }, 'Test', {});

  const plan = createPlan('run-1', 'Goal', { tasks: [{ id: 't1', goal: 'Test' }] });
  const snapshot = createSnapshotV2('run-1', null, plan, null, null, 'executing', gate);

  const newGate = new ExecutionGate();
  const result = recovery.restore(snapshot, newGate);

  assert.ok(recovery.hasPendingApprovals(result));
});

test('Recovery: hasPendingApprovals returns false when no pending', () => {
  const recovery = createRuntimeRecoveryManager();

  const recoveryResult = {
    restored: true,
    approvalStatusMap: new Map(),
    approvalRequests: [],
  };

  assert.ok(!recovery.hasPendingApprovals(recoveryResult));
});

// ── Test 5: Approval Chain ────────────────────────────────

test('Recovery: full approval chain — Policy→Approval→Snapshot→Recovery→Human→Continue', () => {
  const gate = new ExecutionGate();
  const recovery = createRuntimeRecoveryManager();
  const emitter = new RuntimeEventEmitter();

  // 1. Policy Decision → Approval Request
  const request = gate.requestApproval(
    'run-1',
    { id: 't1', type: 'task', name: 'Delete file' },
    'Destructive operation requires approval',
    { toolName: 'delete_file', riskLevel: 'high' }
  );
  assert.strictEqual(request.status, APPROVAL_STATUS.PENDING);

  // 2. Snapshot
  const plan = createPlan('run-1', 'Goal', { tasks: [{ id: 't1', goal: 'Delete file' }] });
  const snapshot = createSnapshotV2('run-1', null, plan, null, null, 'executing', gate);

  // 3. Recovery
  const newGate = new ExecutionGate();
  const result = recovery.restore(snapshot, newGate);
  assert.ok(result.restored);
  assert.strictEqual(result.approvalRequests[0].status, APPROVAL_STATUS.PENDING);

  // 4. Human Approval (after recovery)
  const restoredRequest = newGate.getRequest(result.approvalRequests[0].id);
  assert.ok(newGate.approve(restoredRequest.id, 'human-1', 'Approved after recovery'));

  // 5. Continue — gate now allows
  const gateResult = newGate.canProceed('t1');
  assert.ok(gateResult.allowed);
  assert.strictEqual(gateResult.reason, 'Approved');
});

test('Recovery: recovery event includes approval count', () => {
  const gate = new ExecutionGate();
  const emitter = new RuntimeEventEmitter();
  const events = [];
  emitter.onAll((ev) => events.push(ev));

  const recovery = createRuntimeRecoveryManager({ emitter });

  gate.requestApproval('run-1', { id: 't1', type: 'task', name: 'Test' }, 'Test', {});

  const plan = createPlan('run-1', 'Goal', { tasks: [{ id: 't1', goal: 'Test' }] });
  const snapshot = createSnapshotV2('run-1', null, plan, null, null, 'executing', gate);

  const newGate = new ExecutionGate();
  recovery.restore(snapshot, newGate);

  const restoredEvents = events.filter(e => e.type === RUNTIME_EVENT_TYPES.RUNTIME_RESTORED);
  assert.ok(restoredEvents.length > 0);
  assert.ok(restoredEvents[0].data.approvalsRestored > 0);
});