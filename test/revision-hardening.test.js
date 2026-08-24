/**
 * test/revision-hardening.test.js — Runtime Consistency & Revision Hardening Tests
 *
 * V0.9.6
 * Tests for Task Superseded Lifecycle, Revision Transaction,
 * Dependency Conflict Detection, Completed Task Protection,
 * Revision History Persistence.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  REVISION_STATUS,
  createRevisionRequest,
  RevisionEngine,
  createRevisionEngine,
  createPlan,
  approvePlan,
  startPlan,
  addTaskDependency,
  createTask,
  startTask,
  startTaskVerification,
  completeTask,
  TASK_STATUS,
  supersedeTask,
  PLAN_STATUS,
  TaskScheduler,
  createScheduler,
  RuntimeEventEmitter,
  RUNTIME_EVENT_TYPES,
  serializePlan,
  deserializePlan,
} from '../agent/skill.js';

// ── Test 1: Task Superseded Lifecycle ─────────────────────

test('Hardening: supersedeTask transitions RUNNING → SUPERSEDED', () => {
  const task = createTask('run-1', 'Test');
  startTask(task);
  assert.strictEqual(task.status, TASK_STATUS.RUNNING);

  assert.ok(supersedeTask(task, null, { reason: 'Replaced by revision' }));
  assert.strictEqual(task.status, TASK_STATUS.SUPERSEDED);
  assert.ok(task.supersededAt > 0);
  assert.strictEqual(task.previousStatus, TASK_STATUS.RUNNING);
});

test('Hardening: supersedeTask preserves evidence', () => {
  const task = createTask('run-1', 'Test');
  startTask(task);
  task.evidenceRefs.push('ev-1', 'ev-2');

  supersedeTask(task, null, { reason: 'Replaced' });
  assert.deepStrictEqual(task.evidenceRefs, ['ev-1', 'ev-2']);
});

test('Hardening: cannot supersede COMPLETED task', () => {
  const task = createTask('run-1', 'Test');
  startTask(task);
  startTaskVerification(task);
  completeTask(task);
  assert.strictEqual(task.status, TASK_STATUS.COMPLETED);

  assert.ok(!supersedeTask(task, null, { reason: 'Try' }));
  assert.strictEqual(task.status, TASK_STATUS.COMPLETED);
});

test('Hardening: SUPERSEDED task cannot be scheduled', () => {
  const plan = createPlan('run-1', 'Goal', {
    tasks: [{ id: 't1', goal: 'Task 1' }],
  });
  const taskStatus = new Map([['t1', TASK_STATUS.SUPERSEDED]]);
  const scheduler = createScheduler(plan, taskStatus, new Map());

  assert.strictEqual(scheduler.getReadyTasks().length, 0);
});

test('Hardening: supersedeTask emits event', () => {
  const task = createTask('run-1', 'Test');
  startTask(task);
  const emitter = new RuntimeEventEmitter();
  const events = [];
  emitter.onAll((ev) => events.push(ev));

  supersedeTask(task, emitter, { reason: 'Test' });

  const types = events.map(e => e.type);
  assert.ok(types.includes('task_superseded'));
});

// ── Test 2: Revision Transaction ──────────────────────────

test('Hardening: executeRevision full flow succeeds', () => {
  const plan = createPlan('run-1', 'Goal v1', {
    tasks: [{ id: 't1', goal: 'Task 1' }],
  });
  const taskStatus = new Map([['t1', TASK_STATUS.PENDING]]);
  const scheduler = createScheduler(plan, taskStatus, new Map());
  const engine = createRevisionEngine({ plan, taskStatusMap: taskStatus });

  const revision = createRevisionRequest(
    plan,
    { goal: 'Goal v2', tasks_add: [{ id: 't2', goal: 'Task 2' }] },
    'Add task t2'
  );

  const result = engine.executeRevision(revision, scheduler);
  assert.ok(result.success);
  assert.strictEqual(result.plan.goal, 'Goal v2');
  assert.strictEqual(result.plan.revision, 2);
  assert.ok(result.readyTasks.includes('t1'));
  assert.ok(result.readyTasks.includes('t2'));
});

test('Hardening: executeRevision rolls back on conflict', () => {
  const plan = createPlan('run-1', 'Goal', {
    tasks: [{ id: 't1', goal: 'Task 1' }, { id: 't2', goal: 'Task 2' }],
  });
  const taskStatus = new Map([['t1', TASK_STATUS.RUNNING]]);
  const engine = createRevisionEngine({ plan, taskStatusMap: taskStatus });

  const originalRevision = plan.revision;
  const originalGoal = plan.goal;

  const revision = createRevisionRequest(
    plan,
    { tasks_remove: ['t1'] },
    'Remove running t1'
  );

  const result = engine.executeRevision(revision);
  assert.ok(!result.success);
  assert.strictEqual(revision.status, REVISION_STATUS.CONFLICT);

  // Verify rollback: plan should be restored
  assert.strictEqual(engine.plan.revision, originalRevision);
  assert.strictEqual(engine.plan.goal, originalGoal);
});

test('Hardening: prepare creates snapshot for rollback', () => {
  const plan = createPlan('run-1', 'Goal');
  const engine = createRevisionEngine({ plan, taskStatusMap: new Map() });

  const revision = createRevisionRequest(plan, { goal: 'New' }, 'Test');
  engine.prepare(revision);

  assert.ok(revision._snapshot);
  assert.ok(revision._snapshot.plan);
  assert.strictEqual(revision._snapshot.revision, plan.revision);
});

test('Hardening: rollback restores previous state', () => {
  const plan = createPlan('run-1', 'Goal v1', {
    tasks: [{ id: 't1', goal: 'Task 1' }],
  });
  const taskStatus = new Map([['t1', TASK_STATUS.PENDING]]);
  const engine = createRevisionEngine({ plan, taskStatusMap: taskStatus });

  // Apply a revision
  const revision = createRevisionRequest(plan, { goal: 'Goal v2' }, 'Update');
  engine.prepare(revision);
  engine.apply(revision);

  // Verify applied
  assert.strictEqual(engine.plan.goal, 'Goal v2');

  // Rollback
  const result = engine.rollback(revision);
  assert.ok(result.success);
  assert.strictEqual(revision.status, REVISION_STATUS.ROLLED_BACK);

  // Verify restored
  assert.strictEqual(engine.plan.goal, 'Goal v1');
  assert.strictEqual(engine.plan.revision, revision._snapshot.revision);
});

test('Hardening: commit finalizes transaction', () => {
  const plan = createPlan('run-1', 'Goal');
  const engine = createRevisionEngine({ plan, taskStatusMap: new Map() });

  const revision = createRevisionRequest(plan, { goal: 'New' }, 'Test');
  engine.prepare(revision);
  engine.apply(revision);
  const result = engine.commit(revision);

  assert.ok(result.success);
  assert.ok(revision.committedAt > 0);
});

// ── Test 3: Dependency Conflict Detection ─────────────────

test('Hardening: rejects revision breaking dependency', () => {
  const plan = createPlan('run-1', 'Goal', {
    tasks: [{ id: 'a', goal: 'A' }, { id: 'b', goal: 'B' }],
  });
  addTaskDependency(plan, 'a', 'b');
  const taskStatus = new Map([
    ['a', TASK_STATUS.COMPLETED],
    ['b', TASK_STATUS.PENDING],
  ]);
  const engine = createRevisionEngine({ plan, taskStatusMap: taskStatus });

  // Try to remove 'a' which 'b' depends on
  const revision = createRevisionRequest(
    plan,
    { tasks_remove: ['a'] },
    'Remove dependency source'
  );

  const compat = engine.checkCompatibility(revision);
  assert.ok(!compat.compatible);
  assert.ok(compat.conflicts.some(c => c.type === 'broken_dependency_from'));
});

test('Hardening: rejects revision with invalid dependency', () => {
  const plan = createPlan('run-1', 'Goal', {
    tasks: [{ id: 'a', goal: 'A' }],
  });
  const engine = createRevisionEngine({ plan, taskStatusMap: new Map() });

  const revision = createRevisionRequest(
    plan,
    { dependencies: [{ from: 'nonexistent', to: 'a' }] },
    'Invalid dependency'
  );

  const compat = engine.checkCompatibility(revision);
  assert.ok(!compat.compatible);
  assert.ok(compat.conflicts.some(c => c.type === 'invalid_dependency_from'));
});

test('Hardening: allows revision with valid new dependencies', () => {
  const plan = createPlan('run-1', 'Goal', {
    tasks: [{ id: 'a', goal: 'A' }, { id: 'b', goal: 'B' }],
  });
  const engine = createRevisionEngine({ plan, taskStatusMap: new Map() });

  const revision = createRevisionRequest(
    plan,
    { dependencies: [{ from: 'a', to: 'b' }] },
    'Add valid dependency'
  );

  const compat = engine.checkCompatibility(revision);
  assert.ok(compat.compatible);
});

// ── Test 4: Completed Task Protection ─────────────────────

test('Hardening: rejects deletion of completed task', () => {
  const plan = createPlan('run-1', 'Goal', {
    tasks: [{ id: 't1', goal: 'Done' }, { id: 't2', goal: 'Also done' }],
  });
  const taskStatus = new Map([
    ['t1', TASK_STATUS.COMPLETED],
    ['t2', TASK_STATUS.COMPLETED],
  ]);
  const engine = createRevisionEngine({ plan, taskStatusMap: taskStatus });

  const revision = createRevisionRequest(
    plan,
    { tasks_remove: ['t1'] },
    'Remove completed task'
  );

  const compat = engine.checkCompatibility(revision);
  assert.ok(!compat.compatible);
  assert.ok(compat.protectedTasks.some(p => p.type === 'completed'));
});

test('Hardening: rejects modification of completed task goal', () => {
  const plan = createPlan('run-1', 'Goal', {
    tasks: [{ id: 't1', goal: 'Original' }],
  });
  const taskStatus = new Map([['t1', TASK_STATUS.COMPLETED]]);
  const engine = createRevisionEngine({ plan, taskStatusMap: taskStatus });

  const revision = createRevisionRequest(
    plan,
    { tasks: [{ id: 't1', goal: 'Modified' }] },
    'Modify completed task'
  );

  const compat = engine.checkCompatibility(revision);
  assert.ok(!compat.compatible);
  assert.ok(compat.issues.some(i => i.type === 'completed_task_modified'));
});

test('Hardening: allows deletion when completed protection disabled', () => {
  const plan = createPlan('run-1', 'Goal', {
    tasks: [{ id: 't1', goal: 'Done' }],
  });
  const taskStatus = new Map([['t1', TASK_STATUS.COMPLETED]]);
  const engine = createRevisionEngine({
    plan,
    taskStatusMap: taskStatus,
    autoProtectCompleted: false,
  });

  const revision = createRevisionRequest(
    plan,
    { tasks_remove: ['t1'] },
    'Remove completed'
  );

  const compat = engine.checkCompatibility(revision);
  assert.ok(compat.compatible);
});

// ── Test 5: Revision History Persistence ──────────────────

test('Hardening: plan stores revision history', () => {
  const plan = createPlan('run-1', 'Goal v1');
  const engine = createRevisionEngine({ plan, taskStatusMap: new Map() });

  const rev1 = createRevisionRequest(plan, { goal: 'Goal v2' }, 'Update 1');
  engine.applyRevision(rev1);

  assert.ok(engine.plan.revisions);
  assert.strictEqual(engine.plan.revisions.length, 1);
  assert.strictEqual(engine.plan.revisions[0].fromRevision, 1);
  assert.strictEqual(engine.plan.revisions[0].toRevision, 2);
  assert.strictEqual(engine.plan.revisions[0].reason, 'Update 1');
});

test('Hardening: multiple revisions build history chain', () => {
  const plan = createPlan('run-1', 'Goal v1');
  const engine = createRevisionEngine({ plan, taskStatusMap: new Map() });

  // v1 → v2
  const rev1 = createRevisionRequest(plan, { goal: 'Goal v2' }, 'Update 1');
  engine.applyRevision(rev1);

  // v2 → v3
  const rev2 = createRevisionRequest(engine.plan, { goal: 'Goal v3' }, 'Update 2');
  engine.applyRevision(rev2);

  // v3 → v4
  const rev3 = createRevisionRequest(engine.plan, { goal: 'Goal v4' }, 'Update 3');
  engine.applyRevision(rev3);

  const history = engine.getRevisionHistory();
  assert.strictEqual(history.length, 3);
  assert.strictEqual(history[0].fromRevision, 1);
  assert.strictEqual(history[0].toRevision, 2);
  assert.strictEqual(history[1].fromRevision, 2);
  assert.strictEqual(history[1].toRevision, 3);
  assert.strictEqual(history[2].fromRevision, 3);
  assert.strictEqual(history[2].toRevision, 4);
});

test('Hardening: serializePlan includes revisions', () => {
  const plan = createPlan('run-1', 'Goal');
  const engine = createRevisionEngine({ plan, taskStatusMap: new Map() });

  const rev = createRevisionRequest(plan, { goal: 'New' }, 'Test');
  engine.applyRevision(rev);

  const serialized = serializePlan(engine.plan);
  assert.ok(serialized.revisions);
  assert.strictEqual(serialized.revisions.length, 1);
  assert.strictEqual(serialized.revision, 2);
});

test('Hardening: deserializePlan restores revisions', () => {
  const data = {
    id: 'plan-1',
    runId: 'run-1',
    goal: 'Goal',
    status: 'executing',
    tasks: [],
    dependencies: [],
    evidenceRefs: [],
    revisions: [
      { id: 'rev-1', fromRevision: 1, toRevision: 2, reason: 'Test', timestamp: Date.now() },
    ],
    revision: 2,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  const plan = deserializePlan(data);
  assert.ok(plan.revisions);
  assert.strictEqual(plan.revisions.length, 1);
  assert.strictEqual(plan.revision, 2);
});

// ── Test 6: Integration ───────────────────────────────────

test('Hardening: full transaction — supersede running task via revision', () => {
  const emitter = new RuntimeEventEmitter();
  const events = [];
  emitter.onAll((ev) => events.push(ev));

  const plan = createPlan('run-1', 'Goal', {
    tasks: [{ id: 't1', goal: 'Task 1' }, { id: 't2', goal: 'Task 2' }],
  });
  const taskStatus = new Map([['t1', TASK_STATUS.RUNNING], ['t2', TASK_STATUS.PENDING]]);
  const scheduler = createScheduler(plan, taskStatus, new Map());
  const engine = createRevisionEngine({
    plan,
    taskStatusMap: taskStatus,
    emitter,
    scheduler,
  });

  // Try to remove running task t1 — should be blocked
  const revision = createRevisionRequest(
    plan,
    { tasks_remove: ['t1'] },
    'Remove running t1'
  );

  const result = engine.executeRevision(revision, scheduler);
  assert.ok(!result.success);
  assert.strictEqual(revision.status, REVISION_STATUS.CONFLICT);

  // t1 should still be in plan (protected)
  assert.ok(engine.plan.tasks.some(t => t.id === 't1'));

  const types = events.map(e => e.type);
  assert.ok(types.includes('plan_revision_conflict'));
});

test('Hardening: full transaction — add task and refresh scheduler', () => {
  const plan = createPlan('run-1', 'Goal', {
    tasks: [{ id: 't1', goal: 'Task 1' }],
  });
  const taskStatus = new Map([['t1', TASK_STATUS.PENDING]]);
  const scheduler = createScheduler(plan, taskStatus, new Map());
  const engine = createRevisionEngine({ plan, taskStatusMap: taskStatus });

  const revision = createRevisionRequest(
    plan,
    { tasks_add: [{ id: 't2', goal: 'Task 2' }] },
    'Add task'
  );

  const result = engine.executeRevision(revision, scheduler);
  assert.ok(result.success);
  assert.strictEqual(result.plan.tasks.length, 2);
  assert.ok(result.readyTasks.includes('t2'));
  assert.strictEqual(result.summary.total, 2);
});

test('Hardening: revision history with superseded tasks', () => {
  const plan = createPlan('run-1', 'Goal', {
    tasks: [{ id: 't1', goal: 'Task 1' }, { id: 't2', goal: 'Task 2' }],
  });
  const taskStatus = new Map([['t1', TASK_STATUS.RUNNING], ['t2', TASK_STATUS.PENDING]]);
  const engine = createRevisionEngine({ plan, taskStatusMap: taskStatus });

  // This revision tries to remove t1 (running) — will conflict
  const revision = createRevisionRequest(
    plan,
    { tasks_remove: ['t1'] },
    'Remove running t1'
  );

  engine.prepare(revision);
  const compat = engine.validate(revision);
  assert.ok(!compat.compatible);
  assert.ok(compat.protectedTasks.some(p => p.taskId === 't1'));
});