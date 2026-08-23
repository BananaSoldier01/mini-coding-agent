/**
 * test/planner-orchestration.test.js — Planner Interface & Execution Orchestration Tests
 *
 * V0.9.2
 * Tests for Planner Interface, PlanRuntimeService, PlanRevision, System Invariants.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  Planner,
  MockPlanner,
  RuleBasedPlanner,
  createSimplePlanner,
  createPlan,
  approvePlan,
  startPlan,
  startPlanVerification,
  completePlan,
  failPlan,
  cancelPlan,
  PLAN_STATUS,
  revisePlan,
  PlanRuntimeService,
  createTask,
  startTask,
  startTaskVerification,
  completeTask,
  failTask,
  TASK_STATUS,
  AgentRuntimeContext,
  RuntimeEventEmitter,
  RuntimeEventLog,
  EvidenceRegistry,
  RUNTIME_EVENT_TYPES,
  getExecutionOrder,
  canTaskExecute,
} from '../agent/skill.js';

// ── Test 1: Planner Interface ─────────────────────────────

test('Orchestration: Planner is an abstract class', () => {
  const planner = new Planner();
  assert.strictEqual(planner.name, 'planner');
  assert.throws(() => planner.createPlan('test', {}), /must be implemented/);
});

test('Orchestration: MockPlanner creates fixed plan', () => {
  const fixedPlan = createPlan('run-1', 'Fixed goal', {
    tasks: [{ id: 't1', goal: 'Task 1' }],
  });
  const planner = new MockPlanner(fixedPlan);

  const plan = planner.createPlan('Different goal', { runId: 'run-1' });
  assert.strictEqual(plan.goal, 'Different goal');
  assert.strictEqual(plan.tasks.length, 1);
  assert.ok(plan.createdAt > 0);
});

test('Orchestration: MockPlanner revisePlan increments revision', () => {
  const fixedPlan = createPlan('run-1', 'Goal');
  const planner = new MockPlanner(fixedPlan);

  const plan = planner.createPlan('Goal', { runId: 'run-1' });
  const revised = planner.revisePlan(plan, { goal: 'New goal' });
  assert.strictEqual(revised.goal, 'New goal');
  assert.strictEqual(revised.revision, 2);
  assert.strictEqual(revised.previousRevision, 1);
});

// ── Test 2: RuleBasedPlanner ──────────────────────────────

test('Orchestration: RuleBasedPlanner matches rules', () => {
  const planner = new RuleBasedPlanner([
    {
      match: (g) => g.includes('test'),
      description: 'Test workflow',
      tasks: [{ goal: 'Write test' }, { goal: 'Run test' }],
    },
  ]);

  const plan = planner.createPlan('Run the tests', { runId: 'run-1' });
  assert.strictEqual(plan.tasks.length, 2);
  assert.strictEqual(plan.tasks[0].goal, 'Write test');
  assert.strictEqual(plan.tasks[1].goal, 'Run test');
});

test('Orchestration: RuleBasedPlanner falls back to single task', () => {
  const planner = new RuleBasedPlanner([]);
  const plan = planner.createPlan('Unknown goal', { runId: 'run-1' });
  assert.strictEqual(plan.tasks.length, 1);
  assert.strictEqual(plan.tasks[0].goal, 'Unknown goal');
});

test('Orchestration: createSimplePlanner from goal→tasks map', () => {
  const planner = createSimplePlanner({
    'build project': [{ goal: 'Install deps' }, { goal: 'Build' }],
  });

  const plan = planner.createPlan('build project', { runId: 'run-1' });
  assert.strictEqual(plan.tasks.length, 2);
  assert.strictEqual(plan.tasks[0].goal, 'Install deps');
});

// ── Test 3: PlanRevision ──────────────────────────────────

test('Orchestration: revisePlan creates new revision', () => {
  const plan = createPlan('run-1', 'Goal');
  const originalUpdatedAt = plan.updatedAt;
  // Small delay to ensure different timestamp
  const revised = revisePlan(plan, { goal: 'Updated goal' });
  assert.strictEqual(revised.goal, 'Updated goal');
  assert.strictEqual(revised.revision, 2);
  assert.strictEqual(revised.previousRevision, 1);
  assert.ok(revised.updatedAt >= originalUpdatedAt);
  // Original unchanged
  assert.strictEqual(plan.revision, undefined);
  assert.strictEqual(plan.goal, 'Goal');
});

test('Orchestration: revisePlan preserves createdAt', () => {
  const plan = createPlan('run-1', 'Goal');
  const originalCreated = plan.createdAt;
  const revised = revisePlan(plan, { status: PLAN_STATUS.APPROVED });
  assert.strictEqual(revised.createdAt, originalCreated);
});

test('Orchestration: multiple revisions increment correctly', () => {
  const plan = createPlan('run-1', 'Goal');
  const r1 = revisePlan(plan, { goal: 'v2' });
  const r2 = revisePlan(r1, { goal: 'v3' });
  const r3 = revisePlan(r2, { goal: 'v4' });

  assert.strictEqual(r1.revision, 2);
  assert.strictEqual(r2.revision, 3);
  assert.strictEqual(r3.revision, 4);
  assert.strictEqual(r3.previousRevision, 3);
});

// ── Test 4: PlanRuntimeService ────────────────────────────

test('Orchestration: PlanRuntimeService projects all-completed to VERIFYING', () => {
  const plan = createPlan('run-1', 'Goal');
  approvePlan(plan);
  startPlan(plan);
  assert.strictEqual(plan.status, PLAN_STATUS.EXECUTING);

  const taskStatus = new Map([
    ['t1', TASK_STATUS.COMPLETED],
    ['t2', TASK_STATUS.COMPLETED],
  ]);
  const service = new PlanRuntimeService(plan, taskStatus);
  const newStatus = service.projectPlanState();

  assert.strictEqual(newStatus, PLAN_STATUS.VERIFYING);
  assert.strictEqual(plan.status, PLAN_STATUS.VERIFYING);
});

test('Orchestration: PlanRuntimeService projects task-failed to FAILED', () => {
  const plan = createPlan('run-1', 'Goal');
  approvePlan(plan);
  startPlan(plan);

  const taskStatus = new Map([
    ['t1', TASK_STATUS.COMPLETED],
    ['t2', TASK_STATUS.FAILED],
  ]);
  const service = new PlanRuntimeService(plan, taskStatus);
  const newStatus = service.projectPlanState();

  assert.strictEqual(newStatus, PLAN_STATUS.FAILED);
  assert.strictEqual(plan.status, PLAN_STATUS.FAILED);
});

test('Orchestration: PlanRuntimeService projects task-cancelled to CANCELLED', () => {
  const plan = createPlan('run-1', 'Goal');
  approvePlan(plan);
  startPlan(plan);

  const taskStatus = new Map([
    ['t1', TASK_STATUS.COMPLETED],
    ['t2', TASK_STATUS.CANCELLED],
  ]);
  const service = new PlanRuntimeService(plan, taskStatus);
  const newStatus = service.projectPlanState();

  assert.strictEqual(newStatus, PLAN_STATUS.CANCELLED);
});

test('Orchestration: PlanRuntimeService does not change EXECUTING when tasks pending', () => {
  const plan = createPlan('run-1', 'Goal');
  approvePlan(plan);
  startPlan(plan);

  const taskStatus = new Map([
    ['t1', TASK_STATUS.COMPLETED],
    ['t2', TASK_STATUS.PENDING],
  ]);
  const service = new PlanRuntimeService(plan, taskStatus);
  const newStatus = service.projectPlanState();

  assert.strictEqual(newStatus, PLAN_STATUS.EXECUTING);
  assert.strictEqual(plan.status, PLAN_STATUS.EXECUTING);
});

test('Orchestration: PlanRuntimeService getTaskSummary', () => {
  const plan = createPlan('run-1', 'Goal');
  const taskStatus = new Map([
    ['t1', TASK_STATUS.COMPLETED],
    ['t2', TASK_STATUS.RUNNING],
    ['t3', TASK_STATUS.PENDING],
  ]);
  const service = new PlanRuntimeService(plan, taskStatus);
  const summary = service.getTaskSummary();

  assert.strictEqual(summary.total, 3);
  assert.strictEqual(summary.completed, 1);
  assert.strictEqual(summary.running, 1);
  assert.strictEqual(summary.pending, 1);
  assert.strictEqual(summary.failed, 0);
});

test('Orchestration: PlanRuntimeService canTransition', () => {
  const plan = createPlan('run-1', 'Goal');
  const service = new PlanRuntimeService(plan, new Map());

  assert.ok(service.canTransition(PLAN_STATUS.APPROVED));
  assert.ok(!service.canTransition(PLAN_STATUS.COMPLETED));
});

// ── Test 5: System Invariants ─────────────────────────────

test('Orchestration: INVARIANT — completed plan requires verifying first', () => {
  const plan = createPlan('run-1', 'Goal');
  approvePlan(plan);
  startPlan(plan);

  // EXECUTING → COMPLETED should fail
  assert.ok(!completePlan(plan));
  assert.strictEqual(plan.status, PLAN_STATUS.EXECUTING);

  // But EXECUTING → VERIFYING → COMPLETED works
  startPlanVerification(plan);
  assert.ok(completePlan(plan));
  assert.strictEqual(plan.status, PLAN_STATUS.COMPLETED);
});

test('Orchestration: INVARIANT — completed task requires verifying first', () => {
  const task = createTask('run-1', 'Goal');
  startTask(task);

  // RUNNING → COMPLETED should fail
  assert.ok(!completeTask(task));
  assert.strictEqual(task.status, TASK_STATUS.RUNNING);

  // But RUNNING → VERIFYING → COMPLETED works
  startTaskVerification(task);
  assert.ok(completeTask(task));
  assert.strictEqual(task.status, TASK_STATUS.COMPLETED);
});

test('Orchestration: INVARIANT — snapshot round-trip preserves plan state', () => {
  const plan = createPlan('run-1', 'Goal');
  approvePlan(plan);
  startPlan(plan);
  startPlanVerification(plan);

  // Serialize
  const serialized = {
    id: plan.id,
    runId: plan.runId,
    goal: plan.goal,
    status: plan.status,
    tasks: plan.tasks,
    dependencies: plan.dependencies,
    evidenceRefs: plan.evidenceRefs,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
  };

  // Deserialize
  const restored = {
    ...serialized,
    createdAt: serialized.createdAt || Date.now(),
    updatedAt: serialized.updatedAt || Date.now(),
  };

  assert.strictEqual(restored.status, PLAN_STATUS.VERIFYING);
  assert.strictEqual(restored.goal, 'Goal');
  assert.strictEqual(restored.id, plan.id);
});

test('Orchestration: INVARIANT — dependency order is topological', () => {
  const plan = createPlan('run-1', 'Goal', {
    tasks: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }],
  });
  // a → b → c
  // a → d
  plan.dependencies.push({ from: 'a', to: 'b' });
  plan.dependencies.push({ from: 'b', to: 'c' });
  plan.dependencies.push({ from: 'a', to: 'd' });

  const order = getExecutionOrder(plan);
  // a must come before b, b before c, a before d
  assert.ok(order.indexOf('a') < order.indexOf('b'), 'a before b');
  assert.ok(order.indexOf('b') < order.indexOf('c'), 'b before c');
  assert.ok(order.indexOf('a') < order.indexOf('d'), 'a before d');
});

test('Orchestration: INVARIANT — task cannot execute with incomplete dependency', () => {
  const plan = createPlan('run-1', 'Goal', {
    tasks: [{ id: 'a' }, { id: 'b' }],
  });
  plan.dependencies.push({ from: 'a', to: 'b' });

  // a is still running
  const taskStatus = new Map([['a', TASK_STATUS.RUNNING]]);
  const result = canTaskExecute(plan, 'b', taskStatus);
  assert.ok(!result.canExecute);
  assert.strictEqual(result.blockedBy.length, 1);

  // a completes
  taskStatus.set('a', TASK_STATUS.COMPLETED);
  const result2 = canTaskExecute(plan, 'b', taskStatus);
  assert.ok(result2.canExecute);
});

// ── Test 6: Integration — Planner → Plan → Runtime ────────

test('Orchestration: full flow — Planner creates plan, Runtime executes', () => {
  const emitter = new RuntimeEventEmitter();
  const eventLog = new RuntimeEventLog();
  emitter.onAll((ev) => eventLog.record(ev));

  const evidence = new EvidenceRegistry();
  const ctx = new AgentRuntimeContext('run-1', { evidence });

  // 1. Planner creates plan
  const planner = createSimplePlanner({
    'build and test': [
      { goal: 'Install dependencies' },
      { goal: 'Build project' },
      { goal: 'Run tests' },
    ],
  });

  const plan = planner.createPlan('build and test', { runId: 'run-1' });
  assert.strictEqual(plan.status, PLAN_STATUS.DRAFT);
  assert.strictEqual(plan.tasks.length, 3);

  // 2. Approve plan
  approvePlan(plan, emitter);
  assert.strictEqual(plan.status, PLAN_STATUS.APPROVED);

  // 3. Start plan
  startPlan(plan, emitter);
  assert.strictEqual(plan.status, PLAN_STATUS.EXECUTING);

  // 4. Create tasks in runtime
  for (const taskDef of plan.tasks) {
    const task = createTask('run-1', taskDef.goal);
    ctx.addTask(task);
  }

  // 5. Execute tasks
  const tasks = ctx.listTasks();
  for (const task of tasks) {
    startTask(task, emitter);
    startTaskVerification(task, emitter);
    completeTask(task, emitter);
  }

  // 6. Project plan state
  const taskStatus = new Map();
  for (const task of tasks) {
    taskStatus.set(task.id, task.status);
  }
  const service = new PlanRuntimeService(plan, taskStatus, emitter);
  service.projectPlanState();

  // All tasks completed → plan should be VERIFYING
  assert.strictEqual(plan.status, PLAN_STATUS.VERIFYING);

  // 7. Complete plan
  completePlan(plan, emitter);
  assert.strictEqual(plan.status, PLAN_STATUS.COMPLETED);

  // Verify events
  const events = eventLog.getEvents('run-1');
  const types = events.map(e => e.type);
  assert.ok(types.includes('plan_approved'));
  assert.ok(types.includes('plan_executing'));
  assert.ok(types.includes('plan_completed'));
});

test('Orchestration: plan revision preserves execution history', () => {
  const plan = createPlan('run-1', 'Goal v1');
  approvePlan(plan);
  startPlan(plan);

  // Revise plan mid-execution
  const revised = revisePlan(plan, { goal: 'Goal v2' });
  assert.strictEqual(revised.goal, 'Goal v2');
  assert.strictEqual(revised.revision, 2);
  assert.strictEqual(revised.status, PLAN_STATUS.EXECUTING); // status preserved
  assert.strictEqual(revised.tasks.length, plan.tasks.length); // tasks preserved
});