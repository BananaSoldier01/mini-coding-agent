/**
 * test/plan-runtime.test.js — Plan Runtime Foundation Tests
 *
 * V0.9.1
 * Tests for Plan Object, Plan Lifecycle, Task Dependency, Snapshot v2.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PLAN_STATUS,
  PLAN_TRANSITIONS,
  createPlan,
  approvePlan,
  startPlan,
  startPlanVerification,
  completePlan,
  failPlan,
  cancelPlan,
  getPlanStatus,
  canTransitionPlan,
  addTaskDependency,
  canTaskExecute,
  getExecutionOrder,
  createSnapshotV2,
  serializePlan,
  deserializePlan,
  createTask,
  startTask,
  startTaskVerification,
  completeTask,
  TASK_STATUS,
  AgentRuntimeContext,
  RuntimeEventEmitter,
  RuntimeEventLog,
  EvidenceRegistry,
  RUNTIME_EVENT_TYPES,
  createToolExecution,
  submitToolExecution,
  completePolicyCheck,
  startToolExecution,
  completeToolExecution,
  createPolicyContext,
} from '../agent/skill.js';

// ── Test 1: Plan Object ───────────────────────────────────

test('PlanRuntime: createPlan sets initial status', () => {
  const plan = createPlan('run-1', 'Test goal');
  assert.strictEqual(plan.status, PLAN_STATUS.DRAFT);
  assert.ok(plan.id);
  assert.strictEqual(plan.goal, 'Test goal');
  assert.deepStrictEqual(plan.tasks, []);
  assert.deepStrictEqual(plan.dependencies, []);
  assert.ok(plan.createdAt > 0);
});

test('PlanRuntime: createPlan accepts tasks and dependencies', () => {
  const tasks = [{ id: 't1', goal: 'Task 1' }, { id: 't2', goal: 'Task 2' }];
  const deps = [{ from: 't1', to: 't2' }];
  const plan = createPlan('run-1', 'Test', { tasks, dependencies: deps });
  assert.strictEqual(plan.tasks.length, 2);
  assert.strictEqual(plan.dependencies.length, 1);
});

// ── Test 2: Plan Lifecycle ────────────────────────────────

test('PlanRuntime: approvePlan transitions DRAFT → APPROVED', () => {
  const plan = createPlan('run-1', 'Test goal');
  const emitter = new RuntimeEventEmitter();

  assert.ok(approvePlan(plan, emitter));
  assert.strictEqual(plan.status, PLAN_STATUS.APPROVED);
  assert.ok(plan.approvedAt > 0);
});

test('PlanRuntime: startPlan transitions APPROVED → EXECUTING', () => {
  const plan = createPlan('run-1', 'Test goal');
  approvePlan(plan);

  const emitter = new RuntimeEventEmitter();
  assert.ok(startPlan(plan, emitter));
  assert.strictEqual(plan.status, PLAN_STATUS.EXECUTING);
});

test('PlanRuntime: startPlanVerification transitions EXECUTING → VERIFYING', () => {
  const plan = createPlan('run-1', 'Test goal');
  approvePlan(plan);
  startPlan(plan);

  const emitter = new RuntimeEventEmitter();
  assert.ok(startPlanVerification(plan, emitter));
  assert.strictEqual(plan.status, PLAN_STATUS.VERIFYING);
});

test('PlanRuntime: completePlan transitions VERIFYING → COMPLETED', () => {
  const plan = createPlan('run-1', 'Test goal');
  approvePlan(plan);
  startPlan(plan);
  startPlanVerification(plan);

  const emitter = new RuntimeEventEmitter();
  assert.ok(completePlan(plan, emitter));
  assert.strictEqual(plan.status, PLAN_STATUS.COMPLETED);
  assert.ok(plan.completedAt > 0);
});

test('PlanRuntime: failPlan transitions EXECUTING → FAILED', () => {
  const plan = createPlan('run-1', 'Test goal');
  approvePlan(plan);
  startPlan(plan);

  const emitter = new RuntimeEventEmitter();
  assert.ok(failPlan(plan, emitter, { reason: 'Tests failed' }));
  assert.strictEqual(plan.status, PLAN_STATUS.FAILED);
  assert.ok(plan.failedAt > 0);
  assert.strictEqual(plan.reason, 'Tests failed');
});

test('PlanRuntime: cancelPlan transitions DRAFT → CANCELLED', () => {
  const plan = createPlan('run-1', 'Test goal');
  const emitter = new RuntimeEventEmitter();

  assert.ok(cancelPlan(plan, emitter, { reason: 'user' }));
  assert.strictEqual(plan.status, PLAN_STATUS.CANCELLED);
  assert.ok(plan.cancelledAt > 0);
});

// ── Test 3: Plan Lifecycle Constraints ────────────────────

test('PlanRuntime: cannot complete plan from EXECUTING', () => {
  const plan = createPlan('run-1', 'Test goal');
  approvePlan(plan);
  startPlan(plan);

  // EXECUTING → COMPLETED should be rejected
  assert.ok(!completePlan(plan));
  assert.strictEqual(plan.status, PLAN_STATUS.EXECUTING);
});

test('PlanRuntime: cannot complete plan from DRAFT', () => {
  const plan = createPlan('run-1', 'Test goal');
  assert.ok(!completePlan(plan));
  assert.strictEqual(plan.status, PLAN_STATUS.DRAFT);
});

test('PlanRuntime: cannot fail plan from DRAFT', () => {
  const plan = createPlan('run-1', 'Test goal');
  assert.ok(!failPlan(plan));
  assert.strictEqual(plan.status, PLAN_STATUS.DRAFT);
});

test('PlanRuntime: cannot cancel completed plan', () => {
  const plan = createPlan('run-1', 'Test goal');
  approvePlan(plan);
  startPlan(plan);
  startPlanVerification(plan);
  completePlan(plan);

  assert.ok(!cancelPlan(plan));
  assert.strictEqual(plan.status, PLAN_STATUS.COMPLETED);
});

test('PlanRuntime: canTransitionPlan checks without modifying', () => {
  const plan = createPlan('run-1', 'Test goal');
  assert.ok(canTransitionPlan(plan, PLAN_STATUS.APPROVED));
  assert.ok(canTransitionPlan(plan, PLAN_STATUS.CANCELLED));
  assert.ok(!canTransitionPlan(plan, PLAN_STATUS.COMPLETED));
  assert.strictEqual(plan.status, PLAN_STATUS.DRAFT);
});

test('PlanRuntime: full lifecycle DRAFT → APPROVED → EXECUTING → VERIFYING → COMPLETED', () => {
  const plan = createPlan('run-1', 'Test goal');
  const emitter = new RuntimeEventEmitter();

  assert.ok(approvePlan(plan, emitter));
  assert.strictEqual(plan.status, PLAN_STATUS.APPROVED);

  assert.ok(startPlan(plan, emitter));
  assert.strictEqual(plan.status, PLAN_STATUS.EXECUTING);

  assert.ok(startPlanVerification(plan, emitter));
  assert.strictEqual(plan.status, PLAN_STATUS.VERIFYING);

  assert.ok(completePlan(plan, emitter));
  assert.strictEqual(plan.status, PLAN_STATUS.COMPLETED);
});

// ── Test 4: Task Dependency ───────────────────────────────

test('PlanRuntime: addTaskDependency creates dependency', () => {
  const plan = createPlan('run-1', 'Test');
  addTaskDependency(plan, 't1', 't2');
  assert.strictEqual(plan.dependencies.length, 1);
  assert.deepStrictEqual(plan.dependencies[0], { from: 't1', to: 't2' });
});

test('PlanRuntime: addTaskDependency avoids duplicates', () => {
  const plan = createPlan('run-1', 'Test');
  addTaskDependency(plan, 't1', 't2');
  addTaskDependency(plan, 't1', 't2');
  assert.strictEqual(plan.dependencies.length, 1);
});

test('PlanRuntime: canTaskExecute returns true when no dependencies', () => {
  const plan = createPlan('run-1', 'Test');
  const taskStatus = new Map();
  const result = canTaskExecute(plan, 't1', taskStatus);
  assert.ok(result.canExecute);
  assert.deepStrictEqual(result.blockedBy, []);
});

test('PlanRuntime: canTaskExecute returns false when dependency incomplete', () => {
  const plan = createPlan('run-1', 'Test');
  addTaskDependency(plan, 't1', 't2');

  const taskStatus = new Map([['t1', TASK_STATUS.RUNNING]]);
  const result = canTaskExecute(plan, 't2', taskStatus);
  assert.ok(!result.canExecute);
  assert.strictEqual(result.blockedBy.length, 1);
  assert.strictEqual(result.blockedBy[0].taskId, 't1');
});

test('PlanRuntime: canTaskExecute returns true when dependency complete', () => {
  const plan = createPlan('run-1', 'Test');
  addTaskDependency(plan, 't1', 't2');

  const taskStatus = new Map([['t1', TASK_STATUS.COMPLETED]]);
  const result = canTaskExecute(plan, 't2', taskStatus);
  assert.ok(result.canExecute);
  assert.deepStrictEqual(result.blockedBy, []);
});

test('PlanRuntime: getExecutionOrder respects dependencies', () => {
  const plan = createPlan('run-1', 'Test', {
    tasks: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
  });
  addTaskDependency(plan, 'a', 'b');
  addTaskDependency(plan, 'b', 'c');

  const order = getExecutionOrder(plan);
  assert.ok(order.indexOf('a') < order.indexOf('b'));
  assert.ok(order.indexOf('b') < order.indexOf('c'));
});

test('PlanRuntime: getExecutionOrder handles independent tasks', () => {
  const plan = createPlan('run-1', 'Test', {
    tasks: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
  });
  const order = getExecutionOrder(plan);
  assert.strictEqual(order.length, 3);
  assert.ok(order.includes('a'));
  assert.ok(order.includes('b'));
  assert.ok(order.includes('c'));
});

// ── Test 5: Snapshot v2 ───────────────────────────────────

test('PlanRuntime: createSnapshotV2 includes plan', () => {
  const plan = createPlan('run-1', 'Test goal');
  approvePlan(plan);
  startPlan(plan);

  const ctx = new AgentRuntimeContext('run-1');
  const evidence = new EvidenceRegistry();
  const eventLog = new RuntimeEventLog();

  const snapshot = createSnapshotV2('run-1', ctx, plan, evidence, eventLog, 'executing');
  assert.strictEqual(snapshot.version, '2');
  assert.strictEqual(snapshot.status, 'executing');
  assert.ok(snapshot.plan);
  assert.strictEqual(snapshot.plan.status, PLAN_STATUS.EXECUTING);
  assert.strictEqual(snapshot.plan.goal, 'Test goal');
});

test('PlanRuntime: serializePlan captures all fields', () => {
  const plan = createPlan('run-1', 'Test goal', {
    tasks: [{ id: 't1' }],
    dependencies: [{ from: 't1', to: 't2' }],
  });
  approvePlan(plan);

  const serialized = serializePlan(plan);
  assert.strictEqual(serialized.id, plan.id);
  assert.strictEqual(serialized.goal, 'Test goal');
  assert.strictEqual(serialized.status, PLAN_STATUS.APPROVED);
  assert.strictEqual(serialized.tasks.length, 1);
  assert.strictEqual(serialized.dependencies.length, 1);
  assert.ok(serialized.approvedAt > 0);
});

test('PlanRuntime: deserializePlan restores plan', () => {
  const data = {
    id: 'plan-1',
    runId: 'run-1',
    goal: 'Restored',
    status: 'executing',
    tasks: [{ id: 't1' }],
    dependencies: [],
    evidenceRefs: [],
    createdAt: Date.now() - 1000,
    updatedAt: Date.now(),
  };
  const plan = deserializePlan(data);
  assert.strictEqual(plan.id, 'plan-1');
  assert.strictEqual(plan.goal, 'Restored');
  assert.strictEqual(plan.status, PLAN_STATUS.EXECUTING);
  assert.strictEqual(plan.tasks.length, 1);
});

test('PlanRuntime: snapshot v2 round-trip preserves plan state', () => {
  const plan = createPlan('run-1', 'Test goal');
  approvePlan(plan);
  startPlan(plan);
  startPlanVerification(plan);

  const ctx = new AgentRuntimeContext('run-1');
  const evidence = new EvidenceRegistry();
  const eventLog = new RuntimeEventLog();

  const snapshot = createSnapshotV2('run-1', ctx, plan, evidence, eventLog, 'verifying');
  const restoredPlan = deserializePlan(snapshot.plan);

  assert.strictEqual(restoredPlan.status, PLAN_STATUS.VERIFYING);
  assert.strictEqual(restoredPlan.goal, 'Test goal');
  assert.ok(restoredPlan.updatedAt > 0);
});

// ── Test 6: Plan + Task + ToolExecution Integration ───────

test('PlanRuntime: full integration — Plan → Task → ToolExecution → Evidence → Complete', () => {
  const emitter = new RuntimeEventEmitter();
  const eventLog = new RuntimeEventLog();
  emitter.onAll((ev) => eventLog.record(ev));

  const evidence = new EvidenceRegistry();
  const ctx = new AgentRuntimeContext('run-1', { evidence });

  // 1. Create Plan
  const plan = createPlan('run-1', 'Read and verify file');
  ctx.addTask(createTask('run-1', 'Read file', { assignedSkills: ['s1'] }));

  // 2. Approve Plan
  approvePlan(plan, emitter);
  assert.strictEqual(plan.status, PLAN_STATUS.APPROVED);

  // 3. Start Plan
  startPlan(plan, emitter);
  assert.strictEqual(plan.status, PLAN_STATUS.EXECUTING);

  // 4. Execute Task
  const task = ctx.listTasks()[0];
  startTask(task, emitter);
  startTaskVerification(task, emitter);

  // 5. Execute Tool
  const te = createToolExecution('run-1', task.id, 'read_file', { path: '/test' }, { skillId: 's1' });
  ctx.addToolExecution(te);
  submitToolExecution(te, emitter);
  completePolicyCheck(te, emitter, {
    policyContext: createPolicyContext('development'),
    availableTools: ['read_file'],
    skillTools: ['read_file'],
  });
  startToolExecution(te, emitter);
  completeToolExecution(te, emitter, { result: 'contents', evidenceRegistry: evidence });

  // 6. Complete Task
  task.evidenceRefs.push(...te.evidenceRefs);
  completeTask(task, emitter);
  assert.strictEqual(task.status, TASK_STATUS.COMPLETED);

  // 7. Verify Plan
  startPlanVerification(plan, emitter);
  plan.evidenceRefs.push(...te.evidenceRefs);
  completePlan(plan, emitter);
  assert.strictEqual(plan.status, PLAN_STATUS.COMPLETED);

  // Verify event timeline
  const events = eventLog.getEvents('run-1');
  const types = events.map(e => e.type);
  assert.ok(types.includes('plan_approved'));
  assert.ok(types.includes('plan_executing'));
  assert.ok(types.includes(RUNTIME_EVENT_TYPES.TASK_STARTED));
  assert.ok(types.includes(RUNTIME_EVENT_TYPES.TOOL_COMPLETED));
  assert.ok(types.includes('plan_completed'));
});

test('PlanRuntime: plan with task dependencies respects execution order', () => {
  const plan = createPlan('run-1', 'Multi-step task', {
    tasks: [{ id: 't1', goal: 'Step 1' }, { id: 't2', goal: 'Step 2' }, { id: 't3', goal: 'Step 3' }],
  });
  addTaskDependency(plan, 't1', 't2');
  addTaskDependency(plan, 't2', 't3');

  const order = getExecutionOrder(plan);
  assert.strictEqual(order[0], 't1');
  assert.strictEqual(order[1], 't2');
  assert.strictEqual(order[2], 't3');

  // t2 cannot execute until t1 completes
  const taskStatus = new Map([['t1', TASK_STATUS.RUNNING]]);
  const result = canTaskExecute(plan, 't2', taskStatus);
  assert.ok(!result.canExecute);

  // After t1 completes, t2 can execute
  taskStatus.set('t1', TASK_STATUS.COMPLETED);
  const result2 = canTaskExecute(plan, 't2', taskStatus);
  assert.ok(result2.canExecute);
});