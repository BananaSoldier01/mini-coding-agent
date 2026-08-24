/**
 * test/governance.test.js — Runtime Governance & Human Approval Workflow Tests
 *
 * V0.9.8
 * Tests for Human Approval Gate, Runtime Pause/Resume,
 * Human Intervention Events, Runtime Policy Control,
 * Governance State Persistence.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  RuntimePolicy,
  createPolicy,
  DEFAULT_GOVERNANCE_POLICY,
  RISK_LEVELS,
  GovernanceManager,
  createGovernanceManager,
  RuntimeEventEmitter,
  RuntimeEventStore,
  createEventStore,
  createPlan,
  approvePlan,
  startPlan,
  startPlanVerification,
  completePlan,
  createTask,
  startTask,
  startTaskVerification,
  completeTask,
  TASK_STATUS,
  PLAN_STATUS,
  requestApproval,
  approveTask,
  rejectTask,
  pauseTask,
  resumeTask,
  humanOverride,
  RUNTIME_EVENT_TYPES,
} from '../agent/skill.js';

// ── Test 1: Approval Gate ─────────────────────────────────

test('Governance: requestApproval transitions RUNNING → WAITING_APPROVAL', () => {
  const task = createTask('run-1', 'Test');
  startTask(task);
  assert.strictEqual(task.status, TASK_STATUS.RUNNING);

  assert.ok(requestApproval(task, null, { reason: 'Dangerous op', riskLevel: 'high' }));
  assert.strictEqual(task.status, TASK_STATUS.WAITING_APPROVAL);
  assert.ok(task.approvalRequestedAt > 0);
  assert.strictEqual(task.approvalRiskLevel, 'high');
});

test('Governance: approveTask transitions WAITING_APPROVAL → RUNNING', () => {
  const task = createTask('run-1', 'Test');
  startTask(task);
  requestApproval(task, null, { reason: 'Test' });

  assert.ok(approveTask(task, null, { operator: 'user', reason: 'OK' }));
  assert.strictEqual(task.status, TASK_STATUS.RUNNING);
  assert.ok(task.approvedAt > 0);
  assert.strictEqual(task.approvedBy, 'user');
});

test('Governance: rejectTask transitions WAITING_APPROVAL → FAILED', () => {
  const task = createTask('run-1', 'Test');
  startTask(task);
  requestApproval(task, null, { reason: 'Test' });

  assert.ok(rejectTask(task, null, { operator: 'user', reason: 'Not safe' }));
  assert.strictEqual(task.status, TASK_STATUS.FAILED);
  assert.ok(task.rejectedAt > 0);
  assert.strictEqual(task.rejectedBy, 'user');
});

test('Governance: cannot request approval from non-RUNNING task', () => {
  const task = createTask('run-1', 'Test');
  // Task is PENDING
  assert.ok(!requestApproval(task, null, { reason: 'Test' }));
  assert.strictEqual(task.status, TASK_STATUS.PENDING);
});

test('Governance: cannot approve non-WAITING_APPROVAL task', () => {
  const task = createTask('run-1', 'Test');
  startTask(task);
  assert.ok(!approveTask(task, null, { operator: 'user' }));
  assert.strictEqual(task.status, TASK_STATUS.RUNNING);
});

// ── Test 2: Pause / Resume ───────────────────────────────

test('Governance: pauseTask transitions RUNNING → WAITING_APPROVAL', () => {
  const task = createTask('run-1', 'Test');
  startTask(task);

  assert.ok(pauseTask(task, null, { reason: 'User pause' }));
  assert.strictEqual(task.status, TASK_STATUS.WAITING_APPROVAL);
  assert.ok(task.pausedAt > 0);
});

test('Governance: resumeTask transitions WAITING_APPROVAL → RUNNING', () => {
  const task = createTask('run-1', 'Test');
  startTask(task);
  pauseTask(task, null, { reason: 'Pause' });

  assert.ok(resumeTask(task, null, { operator: 'user' }));
  assert.strictEqual(task.status, TASK_STATUS.RUNNING);
  assert.ok(task.resumedAt > 0);
});

test('Governance: humanOverride forces task state', () => {
  const task = createTask('run-1', 'Test');
  startTask(task);

  assert.ok(humanOverride(task, null, {
    operator: 'admin',
    targetStatus: TASK_STATUS.CANCELLED,
    reason: 'Emergency stop',
  }));
  assert.strictEqual(task.status, TASK_STATUS.CANCELLED);
  assert.strictEqual(task.overriddenBy, 'admin');
});

// ── Test 3: Runtime Policy ────────────────────────────────

test('Policy: requiresApproval checks explicit tool list', () => {
  const policy = createPolicy({
    requireApproval: ['file_delete', 'shell_execute'],
  });
  assert.ok(policy.requiresApproval('file_delete'));
  assert.ok(policy.requiresApproval('shell_execute'));
  assert.ok(!policy.requiresApproval('file_read'));
});

test('Policy: requiresApproval checks risk level', () => {
  const policy = createPolicy({
    maxRiskLevel: RISK_LEVELS.MEDIUM,
  });
  assert.ok(policy.requiresApproval('any_tool', RISK_LEVELS.HIGH));
  assert.ok(!policy.requiresApproval('any_tool', RISK_LEVELS.MEDIUM));
  assert.ok(!policy.requiresApproval('any_tool', RISK_LEVELS.LOW));
});

test('Policy: canAutoRevise and canAutoTool', () => {
  const policy = createPolicy({ allowAutoRevision: true, allowAutoTool: false });
  assert.ok(policy.canAutoRevise());
  assert.ok(!policy.canAutoTool());
});

test('Policy: serialize/deserialize round trip', () => {
  const policy = createPolicy({
    requireApproval: ['file_delete'],
    maxRiskLevel: RISK_LEVELS.HIGH,
    allowAutoRevision: false,
  });
  const serialized = policy.serialize();
  const restored = RuntimePolicy.deserialize(serialized);
  assert.deepStrictEqual(restored.requireApproval, ['file_delete']);
  assert.strictEqual(restored.maxRiskLevel, RISK_LEVELS.HIGH);
  assert.ok(!restored.canAutoRevise());
});

test('Policy: DEFAULT_GOVERNANCE_POLICY has required tools', () => {
  assert.ok(DEFAULT_GOVERNANCE_POLICY.requireApproval.includes('file_delete'));
  assert.ok(DEFAULT_GOVERNANCE_POLICY.requireApproval.includes('shell_execute'));
  assert.ok(DEFAULT_GOVERNANCE_POLICY.requireApproval.includes('git_push'));
});

// ── Test 4: Governance Manager ────────────────────────────

test('GovernanceManager: pauseRun sets run status', () => {
  const manager = createGovernanceManager();
  const result = manager.pauseRun('run-1', { reason: 'Test' });
  assert.ok(result.success);
  assert.strictEqual(manager.getRunStatus('run-1'), 'paused');
  assert.ok(manager.isRunPaused('run-1'));
});

test('GovernanceManager: resumeRun clears paused status', () => {
  const manager = createGovernanceManager();
  manager.pauseRun('run-1');
  const result = manager.resumeRun('run-1');
  assert.ok(result.success);
  assert.strictEqual(manager.getRunStatus('run-1'), 'running');
  assert.ok(!manager.isRunPaused('run-1'));
});

test('GovernanceManager: cannot pause already paused run', () => {
  const manager = createGovernanceManager();
  manager.pauseRun('run-1');
  const result = manager.pauseRun('run-1');
  assert.ok(!result.success);
});

test('GovernanceManager: cannot resume non-paused run', () => {
  const manager = createGovernanceManager();
  const result = manager.resumeRun('run-1');
  assert.ok(!result.success);
});

test('GovernanceManager: createApprovalRequest stores request', () => {
  const manager = createGovernanceManager();
  const request = manager.createApprovalRequest('task-1', 'run-1', {
    reason: 'Dangerous op',
    riskLevel: 'high',
    toolName: 'file_delete',
  });
  assert.ok(request.id);
  assert.strictEqual(request.taskId, 'task-1');
  assert.strictEqual(request.status, 'pending');
  assert.strictEqual(manager.getApprovalRequest('task-1'), request);
});

test('GovernanceManager: approveRequest changes status', () => {
  const manager = createGovernanceManager();
  manager.createApprovalRequest('task-1', 'run-1', { reason: 'Test' });
  const result = manager.approveRequest('task-1', { operator: 'user' });
  assert.ok(result.success);
  assert.strictEqual(result.request.status, 'approved');
});

test('GovernanceManager: rejectRequest changes status', () => {
  const manager = createGovernanceManager();
  manager.createApprovalRequest('task-1', 'run-1', { reason: 'Test' });
  const result = manager.rejectRequest('task-1', { operator: 'user', reason: 'No' });
  assert.ok(result.success);
  assert.strictEqual(result.request.status, 'rejected');
});

test('GovernanceManager: getPendingApprovals returns only pending', () => {
  const manager = createGovernanceManager();
  manager.createApprovalRequest('task-1', 'run-1', { reason: 'Test 1' });
  manager.createApprovalRequest('task-2', 'run-1', { reason: 'Test 2' });
  manager.approveRequest('task-1', { operator: 'user' });

  const pending = manager.getPendingApprovals('run-1');
  assert.strictEqual(pending.length, 1);
  assert.strictEqual(pending[0].taskId, 'task-2');
});

test('GovernanceManager: hasPendingApprovals returns boolean', () => {
  const manager = createGovernanceManager();
  assert.ok(!manager.hasPendingApprovals('run-1'));
  manager.createApprovalRequest('task-1', 'run-1', { reason: 'Test' });
  assert.ok(manager.hasPendingApprovals('run-1'));
});

// ── Test 5: Event Integration ─────────────────────────────

test('Governance: approval events emitted through emitter', () => {
  const store = createEventStore();
  const emitter = new RuntimeEventEmitter();
  emitter.setStore(store);

  const task = createTask('run-1', 'Test');
  startTask(task, emitter);
  requestApproval(task, emitter, { reason: 'Dangerous', riskLevel: 'high', operator: 'user' });

  const events = store.getEventsByTask(task.id);
  const types = events.map(e => e.type);
  assert.ok(types.includes('task_waiting_approval'));
  assert.ok(types.includes('approval_requested'));
});

test('Governance: approve emits approval_granted event', () => {
  const store = createEventStore();
  const emitter = new RuntimeEventEmitter();
  emitter.setStore(store);

  const task = createTask('run-1', 'Test');
  startTask(task, emitter);
  requestApproval(task, emitter, { reason: 'Test' });
  approveTask(task, emitter, { operator: 'user', reason: 'OK' });

  const events = store.getEventsByTask(task.id);
  const types = events.map(e => e.type);
  assert.ok(types.includes('approval_granted'));
  assert.ok(types.includes('task_resumend'));
});

test('Governance: reject emits approval_rejected event', () => {
  const store = createEventStore();
  const emitter = new RuntimeEventEmitter();
  emitter.setStore(store);

  const task = createTask('run-1', 'Test');
  startTask(task, emitter);
  requestApproval(task, emitter, { reason: 'Test' });
  rejectTask(task, emitter, { operator: 'user', reason: 'No' });

  const events = store.getEventsByTask(task.id);
  const types = events.map(e => e.type);
  assert.ok(types.includes('approval_rejected'));
});

test('Governance: pause emits task_paused event', () => {
  const store = createEventStore();
  const emitter = new RuntimeEventEmitter();
  emitter.setStore(store);

  const task = createTask('run-1', 'Test');
  startTask(task, emitter);
  pauseTask(task, emitter, { reason: 'User pause', operator: 'user' });

  const events = store.getEventsByTask(task.id);
  assert.ok(events.some(e => e.type === 'task_paused'));
});

test('Governance: resume emits task_resumend event', () => {
  const store = createEventStore();
  const emitter = new RuntimeEventEmitter();
  emitter.setStore(store);

  const task = createTask('run-1', 'Test');
  startTask(task, emitter);
  pauseTask(task, emitter, { reason: 'Pause' });
  resumeTask(task, emitter, { operator: 'user' });

  const events = store.getEventsByTask(task.id);
  assert.ok(events.some(e => e.type === 'task_resumend'));
});

test('Governance: humanOverride emits human_override event', () => {
  const store = createEventStore();
  const emitter = new RuntimeEventEmitter();
  emitter.setStore(store);

  const task = createTask('run-1', 'Test');
  startTask(task, emitter);
  humanOverride(task, emitter, {
    operator: 'admin',
    targetStatus: TASK_STATUS.CANCELLED,
    reason: 'Emergency',
  });

  const events = store.getEventsByTask(task.id);
  assert.ok(events.some(e => e.type === 'human_override'));
  assert.strictEqual(events.find(e => e.type === 'human_override').data.targetStatus, 'cancelled');
});

test('Governance: pauseRun emits run_paused event', () => {
  const store = createEventStore();
  const emitter = new RuntimeEventEmitter();
  emitter.setStore(store);
  const manager = createGovernanceManager({ emitter });

  manager.pauseRun('run-1', { reason: 'Test', operator: 'user' });

  const events = store.getEventsByRun('run-1');
  assert.ok(events.some(e => e.type === 'run_paused'));
});

test('Governance: resumeRun emits run_resumend event', () => {
  const store = createEventStore();
  const emitter = new RuntimeEventEmitter();
  emitter.setStore(store);
  const manager = createGovernanceManager({ emitter });

  manager.pauseRun('run-1');
  manager.resumeRun('run-1', { operator: 'user' });

  const events = store.getEventsByRun('run-1');
  assert.ok(events.some(e => e.type === 'run_resumend'));
});

// ── Test 6: Governance + Replay Integration ───────────────

test('Integration: replay reconstructs approval history', () => {
  const store = createEventStore();
  const emitter = new RuntimeEventEmitter();
  emitter.setStore(store);

  const task = createTask('run-1', 'Test');
  startTask(task, emitter);
  requestApproval(task, emitter, { reason: 'Dangerous', riskLevel: 'high' });
  approveTask(task, emitter, { operator: 'user', reason: 'OK' });
  startTaskVerification(task, emitter);
  completeTask(task, emitter);

  // Replay
  const result = store.replayRun('run-1');
  assert.strictEqual(result.taskStates.get(task.id).status, TASK_STATUS.COMPLETED);

  // Verify approval events are in the timeline
  const events = store.getEventsByTask(task.id);
  assert.ok(events.some(e => e.type === 'approval_requested'));
  assert.ok(events.some(e => e.type === 'approval_granted'));
});

test('Integration: governance state persists through snapshot', () => {
  const manager = createGovernanceManager();
  manager.pauseRun('run-1', { reason: 'Test' });
  manager.createApprovalRequest('task-1', 'run-1', { reason: 'Test' });

  const serialized = manager.serialize();
  assert.strictEqual(serialized.runStatus['run-1'], 'paused');
  assert.ok(serialized.approvals['task-1']);

  // Deserialize
  const manager2 = createGovernanceManager();
  manager2.deserialize(serialized);
  assert.strictEqual(manager2.getRunStatus('run-1'), 'paused');
  assert.ok(manager2.getApprovalRequest('task-1'));
});

test('Integration: full governance flow with policy check', () => {
  const emitter = new RuntimeEventEmitter();
  const store = createEventStore();
  emitter.setStore(store);

  const policy = createPolicy({
    requireApproval: ['file_delete'],
    maxRiskLevel: RISK_LEVELS.HIGH,
  });
  const manager = createGovernanceManager({ emitter, policy });

  // Policy check
  assert.ok(manager.checkPolicy('file_delete'));
  assert.ok(manager.checkPolicy('shell_execute', RISK_LEVELS.CRITICAL));
  assert.ok(!manager.checkPolicy('file_read'));

  // Create approval request
  manager.createApprovalRequest('task-1', 'run-1', {
    reason: 'Delete file',
    riskLevel: 'high',
    toolName: 'file_delete',
  });

  // Approve
  manager.approveRequest('task-1', { operator: 'user' });
  const request = manager.getApprovalRequest('task-1');
  assert.strictEqual(request.status, 'approved');
});