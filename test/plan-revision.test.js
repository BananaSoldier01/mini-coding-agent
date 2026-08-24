/**
 * test/plan-revision.test.js — Dynamic Plan Revision Runtime Tests
 *
 * V0.9.5
 * Tests for PlanRevision, RevisionEngine, Safe Update, Scheduler Refresh,
 * Running Task Protection.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  REVISION_STATUS,
  createRevisionRequest,
  RevisionEngine,
  createRevisionEngine,
  serializeRevision,
  deserializeRevision,
  createPlan,
  approvePlan,
  startPlan,
  addTaskDependency,
  createTask,
  startTask,
  completeTask,
  TASK_STATUS,
  PLAN_STATUS,
  TaskScheduler,
  createScheduler,
  RuntimeEventEmitter,
  RUNTIME_EVENT_TYPES,
} from '../agent/skill.js';

// ── Test 1: Plan Revision Model ───────────────────────────

test('Revision: createRevisionRequest sets initial status', () => {
  const plan = createPlan('run-1', 'Goal');
  const revision = createRevisionRequest(
    plan,
    { goal: 'Updated goal' },
    'Goal changed'
  );

  assert.strictEqual(revision.status, REVISION_STATUS.DRAFT);
  assert.ok(revision.id);
  assert.strictEqual(revision.planId, plan.id);
  assert.strictEqual(revision.parentRevision, 1);
  assert.strictEqual(revision.reason, 'Goal changed');
  assert.ok(revision.createdAt > 0);
});

test('Revision: createRevisionRequest tracks parent revision', () => {
  const plan = createPlan('run-1', 'Goal');
  const revised = { ...plan, revision: 3 };
  const revision = createRevisionRequest(revised, { goal: 'v4' }, 'Update');

  assert.strictEqual(revision.parentRevision, 3);
});

// ── Test 2: Compatibility Check ───────────────────────────

test('Revision: checkCompatibility allows adding tasks', () => {
  const plan = createPlan('run-1', 'Goal', {
    tasks: [{ id: 't1', goal: 'Task 1' }],
  });
  const taskStatus = new Map([['t1', TASK_STATUS.COMPLETED]]);
  const engine = createRevisionEngine({ plan, taskStatusMap: taskStatus });

  const revision = createRevisionRequest(
    plan,
    { tasks_add: [{ id: 't2', goal: 'New task' }] },
    'Add task'
  );

  const compat = engine.checkCompatibility(revision);
  assert.ok(compat.compatible);
  assert.strictEqual(compat.protectedTasks.length, 0);
});

test('Revision: checkCompatibility blocks deletion of running task', () => {
  const plan = createPlan('run-1', 'Goal', {
    tasks: [{ id: 't1', goal: 'Task 1' }, { id: 't2', goal: 'Task 2' }],
  });
  const taskStatus = new Map([['t1', TASK_STATUS.RUNNING]]);
  const engine = createRevisionEngine({ plan, taskStatusMap: taskStatus });

  const revision = createRevisionRequest(
    plan,
    { tasks_remove: ['t1'] },
    'Remove t1'
  );

  const compat = engine.checkCompatibility(revision);
  assert.ok(!compat.compatible);
  assert.strictEqual(compat.protectedTasks.length, 1);
  assert.strictEqual(compat.protectedTasks[0].taskId, 't1');
});

test('Revision: checkCompatibility warns on running task modification', () => {
  const plan = createPlan('run-1', 'Goal', {
    tasks: [{ id: 't1', goal: 'Task 1' }],
  });
  const taskStatus = new Map([['t1', TASK_STATUS.RUNNING]]);
  const engine = createRevisionEngine({ plan, taskStatusMap: taskStatus });

  const revision = createRevisionRequest(
    plan,
    { tasks: [{ id: 't1', goal: 'Modified task' }] },
    'Modify running task'
  );

  const compat = engine.checkCompatibility(revision);
  assert.ok(compat.compatible);
  assert.ok(compat.issues.some(i => i.type === 'running_task_modified'));
});

test('Revision: checkCompatibility allows deletion of completed task when protection disabled', () => {
  const plan = createPlan('run-1', 'Goal', {
    tasks: [{ id: 't1', goal: 'Done' }, { id: 't2', goal: 'Also done' }],
  });
  const taskStatus = new Map([
    ['t1', TASK_STATUS.COMPLETED],
    ['t2', TASK_STATUS.COMPLETED],
  ]);
  const engine = createRevisionEngine({
    plan,
    taskStatusMap: taskStatus,
    autoProtectCompleted: false,
  });

  const revision = createRevisionRequest(
    plan,
    { tasks_remove: ['t1'] },
    'Remove completed t1'
  );

  const compat = engine.checkCompatibility(revision);
  assert.ok(compat.compatible);
  assert.strictEqual(compat.protectedTasks.length, 0);
});

// ── Test 3: Apply Revision ────────────────────────────────

test('Revision: applyRevision applies changes to plan', () => {
  const plan = createPlan('run-1', 'Old goal');
  const taskStatus = new Map();
  const engine = createRevisionEngine({ plan, taskStatusMap: taskStatus });

  const revision = createRevisionRequest(
    plan,
    { goal: 'New goal' },
    'Goal update'
  );

  const result = engine.applyRevision(revision);
  assert.ok(result.success);
  assert.strictEqual(result.plan.goal, 'New goal');
  assert.strictEqual(result.plan.revision, 2);
  assert.strictEqual(revision.status, REVISION_STATUS.APPLIED);
  assert.ok(revision.appliedAt > 0);
});

test('Revision: applyRevision rejects incompatible revision', () => {
  const plan = createPlan('run-1', 'Goal', {
    tasks: [{ id: 't1', goal: 'Task 1' }, { id: 't2', goal: 'Task 2' }],
  });
  const taskStatus = new Map([['t1', TASK_STATUS.RUNNING]]);
  const engine = createRevisionEngine({ plan, taskStatusMap: taskStatus });

  const revision = createRevisionRequest(
    plan,
    { tasks_remove: ['t1'] },
    'Remove running t1'
  );

  const result = engine.applyRevision(revision);
  assert.ok(!result.success);
  assert.strictEqual(revision.status, REVISION_STATUS.CONFLICT);
  assert.ok(revision.conflictReason);
});

test('Revision: applyRevision marks deprecated running tasks', () => {
  const plan = createPlan('run-1', 'Goal', {
    tasks: [{ id: 't1', goal: 'Task 1' }, { id: 't2', goal: 'Task 2' }],
  });
  const taskStatus = new Map([['t1', TASK_STATUS.RUNNING], ['t2', TASK_STATUS.PENDING]]);
  const engine = createRevisionEngine({ plan, taskStatusMap: taskStatus });

  const revision = createRevisionRequest(
    plan,
    { tasks_remove: ['t1'] },
    'Remove t1'
  );

  const result = engine.applyRevision(revision);
  assert.ok(!result.success);
  assert.strictEqual(engine.checkCompatibility(revision).protectedTasks.length, 1);
});

test('Revision: rejectRevision sets rejected status', () => {
  const plan = createPlan('run-1', 'Goal');
  const engine = createRevisionEngine({ plan, taskStatusMap: new Map() });

  const revision = createRevisionRequest(plan, { goal: 'New' }, 'Test');
  const result = engine.rejectRevision(revision, 'Not approved');

  assert.ok(!result.success);
  assert.strictEqual(revision.status, REVISION_STATUS.REJECTED);
  assert.ok(revision.rejectedAt > 0);
});

test('Revision: applyRevision emits revision_applied event', () => {
  const plan = createPlan('run-1', 'Goal');
  const emitter = new RuntimeEventEmitter();
  const events = [];
  emitter.onAll((ev) => events.push(ev));

  const engine = createRevisionEngine({
    plan,
    taskStatusMap: new Map(),
    emitter,
  });

  const revision = createRevisionRequest(plan, { goal: 'New' }, 'Update');
  engine.applyRevision(revision);

  const types = events.map(e => e.type);
  assert.ok(types.includes('revision_applied'));
});

test('Revision: applyRevision emits conflict event on rejection', () => {
  const plan = createPlan('run-1', 'Goal', {
    tasks: [{ id: 't1', goal: 'Task' }, { id: 't2', goal: 'Task 2' }],
  });
  const taskStatus = new Map([['t1', TASK_STATUS.RUNNING]]);
  const emitter = new RuntimeEventEmitter();
  const events = [];
  emitter.onAll((ev) => events.push(ev));

  const engine = createRevisionEngine({
    plan,
    taskStatusMap: taskStatus,
    emitter,
  });

  const revision = createRevisionRequest(
    plan,
    { tasks_remove: ['t1'] },
    'Remove running t1'
  );

  engine.applyRevision(revision);

  const types = events.map(e => e.type);
  assert.ok(types.includes('revision_conflict'));
});

// ── Test 4: Scheduler Refresh ─────────────────────────────

test('Revision: refreshScheduler recomputes ready tasks', () => {
  const plan = createPlan('run-1', 'Goal', {
    tasks: [{ id: 't1', goal: 'Task 1' }],
  });
  const taskStatus = new Map([['t1', TASK_STATUS.PENDING]]);
  const scheduler = createScheduler(plan, taskStatus, new Map());
  const engine = createRevisionEngine({ plan, taskStatusMap: taskStatus });

  // Add a new task via revision
  const revision = createRevisionRequest(
    plan,
    { tasks_add: [{ id: 't2', goal: 'Task 2' }] },
    'Add task'
  );

  engine.applyRevision(revision);
  const result = engine.refreshScheduler(scheduler);

  assert.ok(result.readyTasks.includes('t1'));
  assert.ok(result.readyTasks.includes('t2'));
  assert.strictEqual(result.summary.total, 2);
});

test('Revision: refreshScheduler after dependency change', () => {
  const plan = createPlan('run-1', 'Goal', {
    tasks: [{ id: 'a' }, { id: 'b' }],
  });
  addTaskDependency(plan, 'a', 'b');
  const taskStatus = new Map([
    ['a', TASK_STATUS.PENDING],
    ['b', TASK_STATUS.PENDING],
  ]);
  const scheduler = createScheduler(plan, taskStatus, new Map());

  // Initially only 'a' is ready
  assert.strictEqual(scheduler.getReadyTasks().length, 1);

  // Complete 'a' → 'b' becomes ready
  scheduler.updateTaskStatus('a', TASK_STATUS.COMPLETED);
  assert.strictEqual(scheduler.getReadyTasks().length, 1);
  assert.strictEqual(scheduler.getReadyTasks()[0], 'b');
});

// ── Test 5: Running Task Protection ───────────────────────

test('Revision: autoProtectRunning=false allows deletion', () => {
  const plan = createPlan('run-1', 'Goal', {
    tasks: [{ id: 't1', goal: 'Task 1' }],
  });
  const taskStatus = new Map([['t1', TASK_STATUS.RUNNING]]);
  const engine = createRevisionEngine({
    plan,
    taskStatusMap: taskStatus,
    autoProtectRunning: false,
  });

  const revision = createRevisionRequest(
    plan,
    { tasks_remove: ['t1'] },
    'Remove running task'
  );

  const compat = engine.checkCompatibility(revision);
  assert.strictEqual(compat.protectedTasks.length, 0);
});

test('Revision: deprecated task preserved in plan', () => {
  const plan = createPlan('run-1', 'Goal', {
    tasks: [{ id: 't1', goal: 'Task 1' }, { id: 't2', goal: 'Task 2' }],
  });
  const taskStatus = new Map([['t1', TASK_STATUS.RUNNING]]);
  const engine = createRevisionEngine({ plan, taskStatusMap: taskStatus });

  const revision = createRevisionRequest(
    plan,
    { tasks_remove: ['t1'] },
    'Remove t1'
  );

  const result = engine.applyRevision(revision);
  assert.ok(!result.success);
  assert.strictEqual(engine.checkCompatibility(revision).protectedTasks.length, 1);
  assert.ok(engine.checkCompatibility(revision).protectedTasks[0].reason.includes('superseded'));
});

// ── Test 6: Serialization ─────────────────────────────────

test('Revision: serializeRevision captures all fields', () => {
  const plan = createPlan('run-1', 'Goal');
  const revision = createRevisionRequest(
    plan,
    { goal: 'New' },
    'Update',
    { source: 'planner', requestedBy: 'user-1' }
  );

  const serialized = serializeRevision(revision);
  assert.strictEqual(serialized.id, revision.id);
  assert.strictEqual(serialized.reason, 'Update');
  assert.strictEqual(serialized.source, 'planner');
  assert.strictEqual(serialized.requestedBy, 'user-1');
  assert.strictEqual(serialized.status, REVISION_STATUS.DRAFT);
});

test('Revision: deserializeRevision restores revision', () => {
  const data = {
    id: 'rev-1',
    planId: 'plan-1',
    runId: 'run-1',
    parentRevision: 2,
    changes: { goal: 'New' },
    reason: 'Test',
    status: REVISION_STATUS.DRAFT,
    source: 'planner',
    requestedBy: 'user',
    createdAt: Date.now(),
  };
  const revision = deserializeRevision(data);
  assert.strictEqual(revision.id, 'rev-1');
  assert.strictEqual(revision.reason, 'Test');
  assert.strictEqual(revision.parentRevision, 2);
});

// ── Test 7: Integration — Full Revision Flow ──────────────

test('Revision: full flow — Plan v1 → Revision → Plan v2 → Scheduler Refresh', () => {
  const emitter = new RuntimeEventEmitter();
  const events = [];
  emitter.onAll((ev) => events.push(ev));

  // 1. Create Plan v1
  const plan = createPlan('run-1', 'Goal v1', {
    tasks: [{ id: 't1', goal: 'Task 1' }, { id: 't2', goal: 'Task 2' }],
  });
  approvePlan(plan, emitter);
  startPlan(plan, emitter);

  const taskStatus = new Map([
    ['t1', TASK_STATUS.COMPLETED],
    ['t2', TASK_STATUS.PENDING],
  ]);
  const scheduler = createScheduler(plan, taskStatus, new Map());
  const engine = createRevisionEngine({ plan, taskStatusMap: taskStatus, emitter });

  // 2. Create Revision
  const revision = createRevisionRequest(
    plan,
    {
      goal: 'Goal v2',
      tasks_add: [{ id: 't3', goal: 'Task 3' }],
    },
    'Add task t3, update goal'
  );

  // 3. Check compatibility
  const compat = engine.checkCompatibility(revision);
  assert.ok(compat.compatible);

  // 4. Apply revision
  const result = engine.applyRevision(revision);
  assert.ok(result.success);
  assert.strictEqual(result.plan.goal, 'Goal v2');
  assert.strictEqual(result.plan.revision, 2);

  // 5. Refresh scheduler
  const refresh = engine.refreshScheduler(scheduler);
  assert.ok(refresh.readyTasks.includes('t2'));
  assert.ok(refresh.readyTasks.includes('t3'));
  assert.strictEqual(refresh.summary.total, 3);

  // 6. Verify events
  const types = events.map(e => e.type);
  assert.ok(types.includes('revision_applied'));
  assert.ok(types.includes('scheduler_refreshed'));
});

test('Revision: revision with running task protection blocks and emits conflict', () => {
  const emitter = new RuntimeEventEmitter();
  const events = [];
  emitter.onAll((ev) => events.push(ev));

  const plan = createPlan('run-1', 'Goal', {
    tasks: [{ id: 't1', goal: 'Task 1' }, { id: 't2', goal: 'Task 2' }],
  });
  const taskStatus = new Map([['t1', TASK_STATUS.RUNNING]]);
  const engine = createRevisionEngine({ plan, taskStatusMap: taskStatus, emitter });

  const revision = createRevisionRequest(
    plan,
    { tasks_remove: ['t1'] },
    'Remove running t1'
  );

  const result = engine.applyRevision(revision);
  assert.ok(!result.success);
  assert.strictEqual(revision.status, REVISION_STATUS.CONFLICT);

  const types = events.map(e => e.type);
  assert.ok(types.includes('revision_conflict'));
});

test('Revision: multiple revisions increment correctly', () => {
  const plan = createPlan('run-1', 'Goal v1');
  const engine = createRevisionEngine({ plan, taskStatusMap: new Map() });

  // v1 → v2
  const rev1 = createRevisionRequest(plan, { goal: 'Goal v2' }, 'Update 1');
  engine.applyRevision(rev1);
  assert.strictEqual(engine.getCurrentRevision(), 2);

  // v2 → v3
  const rev2 = createRevisionRequest(engine.plan, { goal: 'Goal v3' }, 'Update 2');
  engine.applyRevision(rev2);
  assert.strictEqual(engine.getCurrentRevision(), 3);

  // v3 → v4
  const rev3 = createRevisionRequest(engine.plan, { goal: 'Goal v4' }, 'Update 3');
  engine.applyRevision(rev3);
  assert.strictEqual(engine.getCurrentRevision(), 4);
});