/**
 * test/runtime-control-plane.test.js — Runtime Control Plane Foundation Tests
 *
 * V0.9.0
 * Tests for AgentRuntimeContext, Task Runtime, ToolExecution Runtime, Policy Enforcement.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AgentRuntimeContext,
  SkillRuntimeContext,
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
  checkToolPermission,
  submitToolExecution,
  completePolicyCheck,
  startToolExecution,
  completeToolExecution,
  failToolExecution,
  getToolExecutionStatus,
  TOOL_EXECUTION_STATUS,
  RuntimeEventEmitter,
  RuntimeEventLog,
  RUNTIME_EVENT_TYPES,
  RuntimePolicyContext,
  POLICY_PRESETS,
  createPolicyContext,
  SkillRegistry,
  EvidenceRegistry,
} from '../agent/skill.js';

// ── Test 1: AgentRuntimeContext ───────────────────────────

test('ControlPlane: AgentRuntimeContext creates with sub-contexts', () => {
  const ctx = new AgentRuntimeContext('run-1');
  assert.strictEqual(ctx.runId, 'run-1');
  assert.ok(ctx.skill instanceof SkillRuntimeContext);
  assert.ok(ctx.tasks instanceof Map);
  assert.ok(ctx.toolExecutions instanceof Map);
  assert.ok(ctx.events instanceof RuntimeEventLog);
  assert.ok(ctx.createdAt > 0);
});

test('ControlPlane: AgentRuntimeContext serialize/deserialize', () => {
  const ctx = new AgentRuntimeContext('run-1', { sessionId: 'sess-1' });
  const serialized = ctx.serialize();
  assert.strictEqual(serialized.runId, 'run-1');
  assert.strictEqual(serialized.sessionId, 'sess-1');
  assert.ok(serialized.skill);
  assert.ok(serialized.events);

  const registry = new SkillRegistry(['run_command']);
  const restored = AgentRuntimeContext.deserialize(serialized, registry);
  assert.strictEqual(restored.runId, 'run-1');
  assert.strictEqual(restored.sessionId, 'sess-1');
  assert.ok(restored.skill instanceof SkillRuntimeContext);
});

test('ControlPlane: AgentRuntimeContext manages tasks', () => {
  const ctx = new AgentRuntimeContext('run-1');
  const task = createTask('run-1', 'Test goal');
  ctx.addTask(task);

  assert.strictEqual(ctx.getTask(task.id).goal, 'Test goal');
  assert.strictEqual(ctx.listTasks().length, 1);
  assert.strictEqual(ctx.getTasksByStatus(TASK_STATUS.PENDING).length, 1);
});

test('ControlPlane: AgentRuntimeContext manages tool executions', () => {
  const ctx = new AgentRuntimeContext('run-1');
  const te = createToolExecution('run-1', 'task-1', 'read_file', { path: '/test' });
  ctx.addToolExecution(te);

  assert.strictEqual(ctx.getToolExecution(te.id).toolName, 'read_file');
  assert.strictEqual(ctx.listToolExecutions().length, 1);
  assert.strictEqual(ctx.getToolExecutionsByTask('task-1').length, 1);
});

// ── Test 2: Task Runtime ──────────────────────────────────

test('ControlPlane: createTask sets initial status', () => {
  const task = createTask('run-1', 'Test goal');
  assert.strictEqual(task.status, TASK_STATUS.PENDING);
  assert.ok(task.id);
  assert.strictEqual(task.goal, 'Test goal');
  assert.deepStrictEqual(task.assignedSkills, []);
  assert.ok(task.createdAt > 0);
});

test('ControlPlane: startTask transitions PENDING → RUNNING', () => {
  const task = createTask('run-1', 'Test goal');
  const emitter = new RuntimeEventEmitter();
  const received = [];
  emitter.on(RUNTIME_EVENT_TYPES.TASK_STARTED, (ev) => received.push(ev));

  assert.ok(startTask(task, emitter));
  assert.strictEqual(task.status, TASK_STATUS.RUNNING);
  assert.strictEqual(received.length, 1);
  assert.strictEqual(received[0].type, RUNTIME_EVENT_TYPES.TASK_STARTED);
});

test('ControlPlane: completeTask transitions VERIFYING → COMPLETED', () => {
  const task = createTask('run-1', 'Test goal');
  startTask(task);
  task.status = TASK_STATUS.VERIFYING;

  const emitter = new RuntimeEventEmitter();
  const received = [];
  emitter.on(RUNTIME_EVENT_TYPES.TASK_COMPLETED, (ev) => received.push(ev));

  assert.ok(completeTask(task, emitter));
  assert.strictEqual(task.status, TASK_STATUS.COMPLETED);
  assert.ok(task.completedAt > 0);
  assert.strictEqual(received.length, 1);
});

test('ControlPlane: failTask transitions RUNNING → FAILED', () => {
  const task = createTask('run-1', 'Test goal');
  startTask(task);

  const emitter = new RuntimeEventEmitter();
  const received = [];
  emitter.on(RUNTIME_EVENT_TYPES.TASK_FAILED, (ev) => received.push(ev));

  assert.ok(failTask(task, emitter, { reason: 'Tests failed' }));
  assert.strictEqual(task.status, TASK_STATUS.FAILED);
  assert.ok(task.failedAt > 0);
  assert.strictEqual(task.reason, 'Tests failed');
  assert.strictEqual(received[0].data.reason, 'Tests failed');
});

test('ControlPlane: cancelTask transitions PENDING → CANCELLED', () => {
  const task = createTask('run-1', 'Test goal');
  const emitter = new RuntimeEventEmitter();
  const received = [];
  emitter.on(RUNTIME_EVENT_TYPES.TASK_CANCELLED, (ev) => received.push(ev));

  assert.ok(cancelTask(task, emitter, { reason: 'User cancelled' }));
  assert.strictEqual(task.status, TASK_STATUS.CANCELLED);
  assert.ok(task.cancelledAt > 0);
  assert.strictEqual(received.length, 1);
});

test('ControlPlane: cannot complete task from PENDING', () => {
  const task = createTask('run-1', 'Test goal');
  assert.ok(!completeTask(task));
  assert.strictEqual(task.status, TASK_STATUS.PENDING);
});

test('ControlPlane: cannot fail task from PENDING', () => {
  const task = createTask('run-1', 'Test goal');
  assert.ok(!failTask(task));
  assert.strictEqual(task.status, TASK_STATUS.PENDING);
});

test('ControlPlane: cannot cancel completed task', () => {
  const task = createTask('run-1', 'Test goal');
  startTask(task);
  task.status = TASK_STATUS.VERIFYING;
  completeTask(task);

  assert.ok(!cancelTask(task));
  assert.strictEqual(task.status, TASK_STATUS.COMPLETED);
});

test('ControlPlane: startTaskVerification transitions RUNNING → VERIFYING', () => {
  const task = createTask('run-1', 'Test goal');
  startTask(task);

  const emitter = new RuntimeEventEmitter();
  assert.ok(startTaskVerification(task, emitter));
  assert.strictEqual(task.status, TASK_STATUS.VERIFYING);
});

test('ControlPlane: getTaskStatus returns current status', () => {
  const task = createTask('run-1', 'Test goal');
  assert.strictEqual(getTaskStatus(task), TASK_STATUS.PENDING);

  startTask(task);
  assert.strictEqual(getTaskStatus(task), TASK_STATUS.RUNNING);
});

test('ControlPlane: canTransitionTask checks without modifying', () => {
  const task = createTask('run-1', 'Test goal');
  assert.ok(canTransitionTask(task, TASK_STATUS.RUNNING));
  assert.ok(canTransitionTask(task, TASK_STATUS.CANCELLED));
  assert.ok(!canTransitionTask(task, TASK_STATUS.COMPLETED));
  assert.strictEqual(task.status, TASK_STATUS.PENDING); // unchanged
});

// ── Test 3: ToolExecution Runtime ─────────────────────────

test('ControlPlane: createToolExecution sets initial status', () => {
  const te = createToolExecution('run-1', 'task-1', 'read_file', { path: '/test' });
  assert.strictEqual(te.status, TOOL_EXECUTION_STATUS.REQUESTED);
  assert.strictEqual(te.toolName, 'read_file');
  assert.deepStrictEqual(te.args, { path: '/test' });
  assert.deepStrictEqual(te.evidenceRefs, []);
  assert.ok(te.createdAt > 0);
});

test('ControlPlane: submitToolExecution transitions REQUESTED → POLICY_CHECKING', () => {
  const te = createToolExecution('run-1', 'task-1', 'read_file', {});
  const emitter = new RuntimeEventEmitter();
  const received = [];
  emitter.on(RUNTIME_EVENT_TYPES.TOOL_REQUESTED, (ev) => received.push(ev));

  assert.ok(submitToolExecution(te, emitter));
  assert.strictEqual(te.status, TOOL_EXECUTION_STATUS.POLICY_CHECKING);
  assert.strictEqual(received[0].type, RUNTIME_EVENT_TYPES.TOOL_REQUESTED);
});

test('ControlPlane: completePolicyCheck approves allowed tool', () => {
  const te = createToolExecution('run-1', 'task-1', 'read_file', {});
  submitToolExecution(te);

  const policy = createPolicyContext('development');
  const emitter = new RuntimeEventEmitter();
  const received = [];
  emitter.on(RUNTIME_EVENT_TYPES.TOOL_POLICY_CHECKED, (ev) => received.push(ev));

  const result = completePolicyCheck(te, emitter, {
    policyContext: policy,
    availableTools: ['read_file', 'write_file'],
  });

  assert.ok(result.allowed);
  assert.strictEqual(te.status, TOOL_EXECUTION_STATUS.APPROVED);
  assert.ok(te.policyCheck);
  assert.strictEqual(received[0].data.allowed, true);
});

test('ControlPlane: completePolicyCheck denies restricted tool', () => {
  const te = createToolExecution('run-1', 'task-1', 'run_shell', {});
  submitToolExecution(te);

  const policy = createPolicyContext('production');
  const emitter = new RuntimeEventEmitter();

  const result = completePolicyCheck(te, emitter, {
    policyContext: policy,
    availableTools: ['read_file', 'run_shell'],
  });

  assert.ok(!result.allowed);
  assert.strictEqual(te.status, TOOL_EXECUTION_STATUS.DENIED);
  assert.ok(te.error);
});

test('ControlPlane: startToolExecution transitions APPROVED → EXECUTING', () => {
  const te = createToolExecution('run-1', 'task-1', 'read_file', {});
  submitToolExecution(te);
  completePolicyCheck(te, null, {
    policyContext: createPolicyContext('development'),
    availableTools: ['read_file'],
  });

  const emitter = new RuntimeEventEmitter();
  const received = [];
  emitter.on(RUNTIME_EVENT_TYPES.TOOL_EXECUTING, (ev) => received.push(ev));

  assert.ok(startToolExecution(te, emitter));
  assert.strictEqual(te.status, TOOL_EXECUTION_STATUS.EXECUTING);
  assert.ok(te.executedAt > 0);
  assert.strictEqual(received[0].type, RUNTIME_EVENT_TYPES.TOOL_EXECUTING);
});

test('ControlPlane: completeToolExecution transitions EXECUTING → COMPLETED with evidence', () => {
  const te = createToolExecution('run-1', 'task-1', 'read_file', {}, { skillId: 's1' });
  submitToolExecution(te);
  completePolicyCheck(te, null, {
    policyContext: createPolicyContext('development'),
    availableTools: ['read_file'],
  });
  startToolExecution(te);

  const evidence = new EvidenceRegistry();
  const emitter = new RuntimeEventEmitter();
  const received = [];
  emitter.on(RUNTIME_EVENT_TYPES.TOOL_COMPLETED, (ev) => received.push(ev));

  assert.ok(completeToolExecution(te, emitter, {
    result: 'file contents',
    evidenceRegistry: evidence,
  }));
  assert.strictEqual(te.status, TOOL_EXECUTION_STATUS.COMPLETED);
  assert.strictEqual(te.result, 'file contents');
  assert.ok(te.completedAt > 0);
  assert.ok(te.evidenceRefs.length > 0, 'Should auto-bind evidence');
  assert.strictEqual(received[0].data.evidenceRefs.length, te.evidenceRefs.length);
});

test('ControlPlane: failToolExecution transitions EXECUTING → FAILED', () => {
  const te = createToolExecution('run-1', 'task-1', 'read_file', {});
  submitToolExecution(te);
  completePolicyCheck(te, null, {
    policyContext: createPolicyContext('development'),
    availableTools: ['read_file'],
  });
  startToolExecution(te);

  const emitter = new RuntimeEventEmitter();
  const received = [];
  emitter.on(RUNTIME_EVENT_TYPES.TOOL_FAILED, (ev) => received.push(ev));

  assert.ok(failToolExecution(te, emitter, { error: 'File not found' }));
  assert.strictEqual(te.status, TOOL_EXECUTION_STATUS.FAILED);
  assert.strictEqual(te.error, 'File not found');
  assert.strictEqual(received[0].data.error, 'File not found');
});

test('ControlPlane: cannot execute denied tool', () => {
  const te = createToolExecution('run-1', 'task-1', 'run_shell', {});
  submitToolExecution(te);
  completePolicyCheck(te, null, {
    policyContext: createPolicyContext('production'),
    availableTools: ['run_shell'],
  });

  assert.strictEqual(te.status, TOOL_EXECUTION_STATUS.DENIED);
  assert.ok(!startToolExecution(te));
  assert.strictEqual(te.status, TOOL_EXECUTION_STATUS.DENIED);
});

test('ControlPlane: getToolExecutionStatus returns current status', () => {
  const te = createToolExecution('run-1', 'task-1', 'read_file', {});
  assert.strictEqual(getToolExecutionStatus(te), TOOL_EXECUTION_STATUS.REQUESTED);

  submitToolExecution(te);
  assert.strictEqual(getToolExecutionStatus(te), TOOL_EXECUTION_STATUS.POLICY_CHECKING);
});

// ── Test 4: Policy Enforcement Integration ────────────────

test('ControlPlane: checkToolPermission returns allowed for permitted tool', () => {
  const policy = createPolicyContext('development');
  const te = createToolExecution('run-1', 'task-1', 'read_file', {});
  const result = checkToolPermission(te, policy, ['read_file', 'write_file']);
  assert.ok(result.allowed);
  assert.ok(result.policySource);
});

test('ControlPlane: checkToolPermission returns denied for restricted tool', () => {
  const policy = createPolicyContext('production');
  const te = createToolExecution('run-1', 'task-1', 'run_shell', {});
  const result = checkToolPermission(te, policy, ['read_file', 'run_shell']);
  assert.ok(!result.allowed);
  assert.ok(result.reason);
});

test('ControlPlane: checkToolPermission without policy context allows', () => {
  const te = createToolExecution('run-1', 'task-1', 'read_file', {});
  const result = checkToolPermission(te, null, ['read_file']);
  assert.ok(result.allowed);
  assert.strictEqual(result.policySource, 'none');
});

// ── Test 5: Integration Flow ──────────────────────────────

test('ControlPlane: full integration flow — Task → Tool → Evidence → Complete', () => {
  const emitter = new RuntimeEventEmitter();
  const eventLog = new RuntimeEventLog();
  emitter.onAll((ev) => eventLog.record(ev));

  const registry = new SkillRegistry(['read_file', 'write_file']);
  registry.register({ id: 's1', name: 'Test', description: 'd', version: '1.0.0', tools: ['read_file'] });
  registry.load('s1');

  const policy = createPolicyContext('development');
  const evidence = new EvidenceRegistry();
  const ctx = new AgentRuntimeContext('run-1', { policy, evidence });

  // 1. Create Task
  const task = createTask('run-1', 'Read a file', { assignedSkills: ['s1'] });
  ctx.addTask(task);

  // 2. Start Task
  startTask(task, emitter);
  assert.strictEqual(task.status, TASK_STATUS.RUNNING);

  // 3. Create ToolExecution
  const te = createToolExecution('run-1', task.id, 'read_file', { path: '/test.txt' }, { skillId: 's1' });
  ctx.addToolExecution(te);

  // 4. Submit ToolExecution
  submitToolExecution(te, emitter);
  assert.strictEqual(te.status, TOOL_EXECUTION_STATUS.POLICY_CHECKING);

  // 5. Policy Check
  completePolicyCheck(te, emitter, {
    policyContext: policy,
    availableTools: ['read_file', 'write_file'],
  });
  assert.strictEqual(te.status, TOOL_EXECUTION_STATUS.APPROVED);

  // 6. Start Execution
  startToolExecution(te, emitter);
  assert.strictEqual(te.status, TOOL_EXECUTION_STATUS.EXECUTING);

  // 7. Complete with Evidence
  completeToolExecution(te, emitter, {
    result: 'file contents',
    evidenceRegistry: evidence,
  });
  assert.strictEqual(te.status, TOOL_EXECUTION_STATUS.COMPLETED);
  assert.ok(te.evidenceRefs.length > 0);

  // 8. Start Task Verification
  startTaskVerification(task, emitter);
  assert.strictEqual(task.status, TASK_STATUS.VERIFYING);

  // 9. Complete Task
  task.evidenceRefs.push(...te.evidenceRefs);
  completeTask(task, emitter);
  assert.strictEqual(task.status, TASK_STATUS.COMPLETED);

  // Verify event timeline
  const events = eventLog.getEvents('run-1');
  const types = events.map(e => e.type);
  assert.ok(types.includes(RUNTIME_EVENT_TYPES.TASK_STARTED));
  assert.ok(types.includes(RUNTIME_EVENT_TYPES.TOOL_REQUESTED));
  assert.ok(types.includes(RUNTIME_EVENT_TYPES.TOOL_POLICY_CHECKED));
  assert.ok(types.includes(RUNTIME_EVENT_TYPES.TOOL_EXECUTING));
  assert.ok(types.includes(RUNTIME_EVENT_TYPES.TOOL_COMPLETED));
  assert.ok(types.includes(RUNTIME_EVENT_TYPES.TASK_VERIFYING));
  assert.ok(types.includes(RUNTIME_EVENT_TYPES.TASK_COMPLETED));

  // Verify evidence was created
  assert.strictEqual(evidence.countSkillEvidence('s1'), 1);
});

test('ControlPlane: denied tool execution does not block task flow', () => {
  const emitter = new RuntimeEventEmitter();
  const registry = new SkillRegistry(['read_file']);
  registry.register({ id: 's1', name: 'Test', description: 'd', version: '1.0.0', tools: ['read_file'] });
  registry.load('s1');

  const policy = createPolicyContext('production'); // production denies run_shell
  const ctx = new AgentRuntimeContext('run-1', { policy });

  const task = createTask('run-1', 'Test');
  ctx.addTask(task);
  startTask(task, emitter);

  const te = createToolExecution('run-1', task.id, 'run_shell', {}, { skillId: 's1' });
  ctx.addToolExecution(te);
  submitToolExecution(te, emitter);

  const denied = completePolicyCheck(te, emitter, {
    policyContext: policy,
    availableTools: ['read_file', 'run_shell'],
  });

  assert.ok(!denied.allowed);
  assert.strictEqual(te.status, TOOL_EXECUTION_STATUS.DENIED);

  // Task can still fail
  failTask(task, emitter, { reason: 'Required tool denied' });
  assert.strictEqual(task.status, TASK_STATUS.FAILED);
});

test('ControlPlane: AgentRuntimeContext snapshot compatible', () => {
  const ctx = new AgentRuntimeContext('run-1');
  const task = createTask('run-1', 'Test');
  ctx.addTask(task);
  startTask(task);

  const serialized = ctx.serialize();
  assert.ok(serialized.tasks);
  assert.strictEqual(Object.keys(serialized.tasks).length, 1);

  const registry = new SkillRegistry([]);
  const restored = AgentRuntimeContext.deserialize(serialized, registry);
  assert.strictEqual(restored.listTasks().length, 1);
  assert.strictEqual(restored.getTask(task.id).status, TASK_STATUS.RUNNING);
});