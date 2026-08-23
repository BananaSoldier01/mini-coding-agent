/**
 * test/runtime-consistency.test.js — Runtime Consistency Patch Tests
 *
 * V0.9.0.1
 * Tests for Task lifecycle constraint, PolicyContext skillId,
 * and RuntimeContext service boundary.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createTask,
  startTask,
  completeTask,
  failTask,
  cancelTask,
  startTaskVerification,
  getTaskStatus,
  canTransitionTask,
  TASK_STATUS,
  createToolExecution,
  RuntimePolicyContext,
  createPolicyContext,
  RuntimeEventEmitter,
  RUNTIME_EVENT_TYPES,
} from '../agent/skill.js';

// ── Test 1: Task Lifecycle Constraint ─────────────────────

test('Consistency: Task RUNNING cannot directly complete', () => {
  const task = createTask('run-1', 'Test goal');
  startTask(task);

  // RUNNING → COMPLETED should be rejected
  assert.ok(!completeTask(task));
  assert.strictEqual(task.status, TASK_STATUS.RUNNING);
  assert.strictEqual(getTaskStatus(task), TASK_STATUS.RUNNING);
});

test('Consistency: Task must go through VERIFYING before COMPLETED', () => {
  const task = createTask('run-1', 'Test goal');
  startTask(task);
  startTaskVerification(task);

  // VERIFYING → COMPLETED should work
  assert.ok(completeTask(task));
  assert.strictEqual(task.status, TASK_STATUS.COMPLETED);
});

test('Consistency: canTransitionTask rejects RUNNING → COMPLETED', () => {
  const task = createTask('run-1', 'Test goal');
  startTask(task);

  assert.ok(!canTransitionTask(task, TASK_STATUS.COMPLETED));
  assert.ok(canTransitionTask(task, TASK_STATUS.VERIFYING));
  assert.ok(canTransitionTask(task, TASK_STATUS.FAILED));
  assert.ok(canTransitionTask(task, TASK_STATUS.CANCELLED));
});

test('Consistency: Task PENDING → RUNNING → VERIFYING → COMPLETED full flow', () => {
  const task = createTask('run-1', 'Test goal');
  const emitter = new RuntimeEventEmitter();

  assert.ok(startTask(task, emitter));
  assert.strictEqual(task.status, TASK_STATUS.RUNNING);

  assert.ok(startTaskVerification(task, emitter));
  assert.strictEqual(task.status, TASK_STATUS.VERIFYING);

  assert.ok(completeTask(task, emitter));
  assert.strictEqual(task.status, TASK_STATUS.COMPLETED);
});

test('Consistency: Task RUNNING → FAILED works', () => {
  const task = createTask('run-1', 'Test goal');
  startTask(task);

  assert.ok(failTask(task, null, { reason: 'error' }));
  assert.strictEqual(task.status, TASK_STATUS.FAILED);
});

test('Consistency: Task RUNNING → CANCELLED works', () => {
  const task = createTask('run-1', 'Test goal');
  startTask(task);

  assert.ok(cancelTask(task, null, { reason: 'user' }));
  assert.strictEqual(task.status, TASK_STATUS.CANCELLED);
});

// ── Test 2: PolicyContext skillId ──────────────────────────

test('Consistency: PolicyContext stores skillId not skill object', () => {
  const ctx = new RuntimePolicyContext({ skillId: 's1' });
  assert.strictEqual(ctx.skillId, 's1');
  assert.strictEqual(ctx.skill, undefined);
});

test('Consistency: PolicyContext forSkill sets skillId', () => {
  const parent = new RuntimePolicyContext();
  const skill = { id: 's1', name: 'Test', tools: ['read_file'] };
  const child = parent.forSkill(skill);

  assert.strictEqual(child.skillId, 's1');
  assert.strictEqual(child.skill, undefined);
});

test('Consistency: PolicyContext serialize uses skillId', () => {
  const ctx = new RuntimePolicyContext({ skillId: 's1' });
  const serialized = ctx.serialize();
  assert.strictEqual(serialized.skillId, 's1');
  assert.ok(!serialized.skill);
});

test('Consistency: PolicyContext deserialize restores skillId', () => {
  const data = {
    skillId: 's2',
    environment: 'production',
  };
  const ctx = RuntimePolicyContext.deserialize(data);
  assert.strictEqual(ctx.skillId, 's2');
});

test('Consistency: PolicyContext serialize/deserialize round-trip preserves skillId', () => {
  const ctx = new RuntimePolicyContext({
    environment: 'production',
    skillId: 's3',
    restrictions: [{ type: 'deny', tools: ['run_shell'] }],
  });

  const serialized = ctx.serialize();
  assert.strictEqual(serialized.skillId, 's3');

  const restored = RuntimePolicyContext.deserialize(serialized);
  assert.strictEqual(restored.skillId, 's3');
  assert.strictEqual(restored.environment, 'production');
});

// ── Test 3: PolicyContext skillTools parameter ────────────

test('Consistency: isToolAllowed accepts skillTools parameter', () => {
  const ctx = new RuntimePolicyContext({ skillId: 's1' });
  const skillTools = ['read_file', 'git_status'];

  assert.ok(ctx.isToolAllowed('read_file', ['read_file', 'write_file'], skillTools));
  assert.ok(!ctx.isToolAllowed('write_file', ['read_file', 'write_file'], skillTools));
  assert.ok(!ctx.isToolAllowed('run_shell', ['read_file', 'write_file', 'run_shell'], skillTools));
});

test('Consistency: isToolAllowed without skillTools still works', () => {
  const ctx = new RuntimePolicyContext();
  assert.ok(ctx.isToolAllowed('read_file', ['read_file', 'write_file']));
  assert.ok(!ctx.isToolAllowed('write_file', ['read_file']));
});

// ── Test 4: RuntimeContext Service Boundary ────────────────

test('Consistency: AgentRuntimeContext does not expose completeTask directly', async () => {
  const { AgentRuntimeContext } = await import('../agent/skill.js');
  const ctx = new AgentRuntimeContext('run-1');

  // AgentRuntimeContext should manage tasks but not expose business logic
  assert.ok(typeof ctx.addTask === 'function');
  assert.ok(typeof ctx.getTask === 'function');
  assert.ok(typeof ctx.listTasks === 'function');

  // But it should NOT have completeTask (that's task service responsibility)
  assert.ok(typeof ctx.completeTask !== 'function');
});

test('Consistency: Task lifecycle is enforced by task module not context', async () => {
  const { AgentRuntimeContext, createTask, startTask } = await import('../agent/skill.js');
  const ctx = new AgentRuntimeContext('run-1');
  const task = createTask('run-1', 'Test');
  ctx.addTask(task);

  // Start via task module, not context
  startTask(task);
  assert.strictEqual(task.status, TASK_STATUS.RUNNING);

  // Verify context reflects the change
  assert.strictEqual(ctx.getTask(task.id).status, TASK_STATUS.RUNNING);
});

// ── Test 5: Integration — Task + Policy + ToolExecution ────

test('Consistency: full flow with strict task lifecycle', async () => {
  const { AgentRuntimeContext, createTask, startTask, startTaskVerification,
          completeTask, createToolExecution, submitToolExecution,
          completePolicyCheck, startToolExecution, completeToolExecution,
          createPolicyContext, RuntimeEventEmitter, EvidenceRegistry,
          RUNTIME_EVENT_TYPES } = await import('../agent/skill.js');

  const emitter = new RuntimeEventEmitter();
  const policy = createPolicyContext('development');
  const evidence = new EvidenceRegistry();
  const ctx = new AgentRuntimeContext('run-1', { policy, evidence });

  // Task lifecycle
  const task = createTask('run-1', 'Read file', { assignedSkills: ['s1'] });
  ctx.addTask(task);
  startTask(task, emitter);
  startTaskVerification(task, emitter);

  // Tool execution with policy check
  const te = createToolExecution('run-1', task.id, 'read_file', { path: '/test' }, { skillId: 's1' });
  ctx.addToolExecution(te);
  submitToolExecution(te, emitter);

  const policyResult = completePolicyCheck(te, emitter, {
    policyContext: policy,
    availableTools: ['read_file', 'write_file'],
    skillTools: ['read_file'],
  });
  assert.ok(policyResult.allowed);

  startToolExecution(te, emitter);
  completeToolExecution(te, emitter, {
    result: 'contents',
    evidenceRegistry: evidence,
  });

  // Now task can complete (it's in VERIFYING state)
  task.evidenceRefs.push(...te.evidenceRefs);
  assert.ok(completeTask(task, emitter));
  assert.strictEqual(task.status, TASK_STATUS.COMPLETED);
});

test('Consistency: task cannot complete without verification even with evidence', async () => {
  const { createTask, startTask, completeTask } = await import('../agent/skill.js');
  const task = createTask('run-1', 'Test');
  startTask(task);

  // Has evidence refs but still in RUNNING — cannot complete
  task.evidenceRefs.push('ev-1');
  assert.ok(!completeTask(task));
  assert.strictEqual(task.status, TASK_STATUS.RUNNING);
});