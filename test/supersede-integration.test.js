/**
 * test/supersede-integration.test.js — Task Superseded Integration Tests
 *
 * V0.9.6.1
 * Verifies SUPERSEDED replaces deprecated across revision, scheduler, and lifecycle.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createPlan,
  createRevisionRequest,
  RevisionEngine,
  createRevisionEngine,
  createTask,
  startTask,
  supersedeTask,
  TASK_STATUS,
  PLAN_STATUS,
  TaskScheduler,
  createScheduler,
  RuntimeEventEmitter,
  RUNTIME_EVENT_TYPES,
} from '../agent/skill.js';

test('Supersede: revision sets SUPERSEDED status (not deprecated flag)', () => {
  const plan = createPlan('run-1', 'Goal', {
    tasks: [{ id: 't1', goal: 'Task 1' }, { id: 't2', goal: 'Task 2' }],
  });
  // t1 is RUNNING, t2 is PENDING
  const taskStatus = new Map([['t1', TASK_STATUS.RUNNING], ['t2', TASK_STATUS.PENDING]]);
  const engine = createRevisionEngine({ plan, taskStatusMap: taskStatus });

  // This revision tries to remove t1 (running) — will conflict
  const revision = createRevisionRequest(
    plan,
    { tasks_remove: ['t1'] },
    'Remove running t1'
  );

  // Cannot apply — conflict
  const result = engine.applyRevision(revision);
  assert.ok(!result.success);

  // But the protected task should be identified
  const compat = engine.checkCompatibility(revision);
  assert.ok(compat.protectedTasks.some(p => p.taskId === 't1'));
});

test('Supersede: supersedeTask sets status not deprecated flag', () => {
  const task = createTask('run-1', 'Test');
  startTask(task);

  supersedeTask(task, null, { reason: 'Replaced' });

  // Status is SUPERSEDED
  assert.strictEqual(task.status, TASK_STATUS.SUPERSEDED);
  // No deprecated flag
  assert.ok(!task.deprecated);
  // Has superseded metadata
  assert.ok(task.supersededAt > 0);
  assert.strictEqual(task.previousStatus, TASK_STATUS.RUNNING);
});

test('Supersede: SUPERSEDED task cannot be scheduled', () => {
  const plan = createPlan('run-1', 'Goal', {
    tasks: [{ id: 't1', goal: 'Task 1' }],
  });
  const taskStatus = new Map([['t1', TASK_STATUS.SUPERSEDED]]);
  const scheduler = createScheduler(plan, taskStatus, new Map());

  assert.strictEqual(scheduler.getReadyTasks().length, 0);
  assert.strictEqual(scheduler.selectNextTask(), null);
});

test('Supersede: SUPERSEDED task preserves evidence', () => {
  const task = createTask('run-1', 'Test');
  startTask(task);
  task.evidenceRefs.push('ev-1', 'ev-2', 'ev-3');

  supersedeTask(task, null, { reason: 'Replaced' });

  assert.deepStrictEqual(task.evidenceRefs, ['ev-1', 'ev-2', 'ev-3']);
  assert.strictEqual(task.status, TASK_STATUS.SUPERSEDED);
});

test('Supersede: SUPERSEDED is terminal (no transitions out)', () => {
  const task = createTask('run-1', 'Test');
  startTask(task);
  supersedeTask(task, null, { reason: 'Replaced' });

  // Cannot transition from SUPERSEDED
  assert.notStrictEqual(task.status, TASK_STATUS.COMPLETED);
  assert.strictEqual(task.status, TASK_STATUS.SUPERSEDED);
});

test('Supersede: full lifecycle — RUNNING → SUPERSEDED via revision', () => {
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
  });

  // Try to remove running t1
  const revision = createRevisionRequest(
    plan,
    { tasks_remove: ['t1'] },
    'Remove running t1'
  );

  const result = engine.executeRevision(revision, scheduler);
  assert.ok(!result.success);

  // t1 should still be in plan (protected)
  const t1InPlan = engine.plan.tasks.some(t => t.id === 't1');
  assert.ok(t1InPlan);

  // Verify conflict event
  const types = events.map(e => e.type);
  assert.ok(types.includes('revision_conflict'));
});

test('Supersede: SUPERSEDED task in taskStatusMap blocks scheduler', () => {
  const plan = createPlan('run-1', 'Goal', {
    tasks: [{ id: 't1', goal: 'Task 1' }, { id: 't2', goal: 'Task 2' }],
  });
  // t1 is SUPERSEDED, t2 is PENDING
  const taskStatus = new Map([
    ['t1', TASK_STATUS.SUPERSEDED],
    ['t2', TASK_STATUS.PENDING],
  ]);
  const scheduler = createScheduler(plan, taskStatus, new Map());

  // Only t2 should be ready
  const ready = scheduler.getReadyTasks();
  assert.deepStrictEqual(ready, ['t2']);
});

test('Supersede: supersedeTask cannot be called on already SUPERSEDED task', () => {
  const task = createTask('run-1', 'Test');
  startTask(task);
  supersedeTask(task, null, { reason: 'First' });
  assert.strictEqual(task.status, TASK_STATUS.SUPERSEDED);

  // Second supersede should fail
  assert.ok(!supersedeTask(task, null, { reason: 'Second' }));
  assert.strictEqual(task.status, TASK_STATUS.SUPERSEDED);
});

test('Supersede: revision history records superseded task IDs', () => {
  const plan = createPlan('run-1', 'Goal', {
    tasks: [{ id: 't1', goal: 'Task 1' }],
  });
  const taskStatus = new Map([['t1', TASK_STATUS.PENDING]]);
  const engine = createRevisionEngine({ plan, taskStatusMap: taskStatus });

  // Add a new task (safe revision)
  const revision = createRevisionRequest(
    plan,
    { tasks_add: [{ id: 't2', goal: 'Task 2' }] },
    'Add task'
  );

  engine.applyRevision(revision);

  const history = engine.getRevisionHistory();
  assert.strictEqual(history.length, 1);
  assert.strictEqual(history[0].reason, 'Add task');
  // No superseded tasks in this revision
  assert.ok(!history[0].supersededIds);
});