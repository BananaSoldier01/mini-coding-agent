/**
 * test/lifecycle-correctness.test.js — Runtime Lifecycle & Recovery Correctness
 *
 * V1.2.3
 * Tests for:
 * - Run Event Exactness (run_created vs run_started)
 * - Create Does Not Mean Start
 * - RUNNING Task Crash Recovery
 * - FAILED Task Crash Retry
 * - Completed Task No Re-execution
 * - Store Mutation Boundary
 * - Transition/Event Consistency
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ExecutionEngine,
  createExecutionEngine,
  RuntimeEventEmitter,
  RuntimeEventStore,
  createEventStore,
  RUN_STATUS,
} from '../agent/skill.js';

// ═══════════════════════════════════════════════════════════
// Test 1: Run Lifecycle Event Exactness
// ═══════════════════════════════════════════════════════════

test('Lifecycle: Run event sequence is exact', () => {
  const emitter = new RuntimeEventEmitter();
  const store = createEventStore();
  emitter.setStore(store);
  const engine = createExecutionEngine({ emitter, eventStore: store });

  engine.createRun({ goal: 'test', runId: 'run-lc1' });
  engine.startRun('run-lc1');
  engine.pauseRun('run-lc1');
  engine.resumeRun('run-lc1');
  engine.completeRun('run-lc1');

  const events = store.getEventsByRun('run-lc1');
  // Filter only run lifecycle events (exclude workspace/context events)
  const runEvents = events.filter(e =>
    ['run_created', 'run_started', 'run_paused', 'run_resumed', 'run_completed'].includes(e.type)
  );
  const types = runEvents.map(e => e.type);

  // Exact sequence
  assert.deepStrictEqual(types, [
    'run_created',
    'run_started',
    'run_paused',
    'run_resumed',
    'run_completed',
  ]);
});

test('Lifecycle: No duplicate lifecycle events', () => {
  const emitter = new RuntimeEventEmitter();
  const store = createEventStore();
  emitter.setStore(store);
  const engine = createExecutionEngine({ emitter, eventStore: store });

  engine.createRun({ goal: 'test', runId: 'run-lc2' });
  engine.startRun('run-lc2');
  engine.startRun('run-lc2'); // should fail silently

  const events = store.getEventsByRun('run-lc2');
  const runStartedCount = events.filter(e => e.type === 'run_started').length;
  const runCreatedCount = events.filter(e => e.type === 'run_created').length;

  assert.strictEqual(runCreatedCount, 1, 'should have exactly 1 run_created');
  assert.strictEqual(runStartedCount, 1, 'should have exactly 1 run_started');
});

// ═══════════════════════════════════════════════════════════
// Test 2: Create Does Not Mean Start
// ═══════════════════════════════════════════════════════════

test('Lifecycle: createRun produces CREATED, not STARTED', () => {
  const emitter = new RuntimeEventEmitter();
  const store = createEventStore();
  emitter.setStore(store);
  const engine = createExecutionEngine({ emitter, eventStore: store });

  const created = engine.createRun({ goal: 'test', runId: 'run-lc3' });
  assert.strictEqual(created.run.status, RUN_STATUS.CREATED);

  const events = store.getEventsByRun('run-lc3');
  assert.ok(events.some(e => e.type === 'run_created'));
  assert.ok(!events.some(e => e.type === 'run_started'));
});

test('Lifecycle: startRun produces STARTED and run_started', () => {
  const emitter = new RuntimeEventEmitter();
  const store = createEventStore();
  emitter.setStore(store);
  const engine = createExecutionEngine({ emitter, eventStore: store });

  const created = engine.createRun({ goal: 'test', runId: 'run-lc4' });
  engine.startRun('run-lc4');

  const run = engine.runStore.get('run-lc4');
  assert.strictEqual(run.status, RUN_STATUS.STARTED);

  const events = store.getEventsByRun('run-lc4');
  assert.ok(events.some(e => e.type === 'run_created'));
  assert.ok(events.some(e => e.type === 'run_started'));
});

// ═══════════════════════════════════════════════════════════
// Test 3: RUNNING Task Crash Recovery
// ═══════════════════════════════════════════════════════════

test('Recovery: RUNNING task requeues to PENDING after crash', async () => {
  const emitter = new RuntimeEventEmitter();
  const store = createEventStore();
  emitter.setStore(store);
  const engine = createExecutionEngine({ emitter, eventStore: store });

  // Create run with task
  const created = engine.createRun({ goal: 'crash test', runId: 'run-crash1' });
  engine.startRun('run-crash1');
  engine.addTask('run-crash1', { goal: 'task 1' });

  // Transition task to RUNNING via TransitionManager (emits task_started)
  const tasks = engine.taskStore.listByRun('run-crash1');
  engine.transitionMgr.transitionTask(
    tasks[0].id, 'pending', 'running',
    { runId: 'run-crash1', workspaceId: tasks[0].runId, taskId: tasks[0].id }
  );

  // Simulate crash — clear stores
  engine.runStore.clear();
  engine.taskStore.clear();
  engine.planStore.clear();

  // Recover
  const recovery = engine.recover('run-crash1');
  assert.ok(recovery.success);

  // Resume after crash
  const result = await engine.resumeAfterCrash('run-crash1');
  assert.ok(result.success);

  // Verify actions include requeue
  const requeueActions = result.actions.filter(a => a.action === 'requeue_task');
  assert.ok(requeueActions.length > 0, 'should have requeue actions');
});

test('Recovery: RUNNING task actually executes after crash resume', async () => {
  const emitter = new RuntimeEventEmitter();
  const store = createEventStore();
  emitter.setStore(store);
  const engine = createExecutionEngine({ emitter, eventStore: store });

  const created = engine.createRun({ goal: 'exec after crash', runId: 'run-crash2' });
  engine.startRun('run-crash2');
  engine.addTask('run-crash2', { goal: 'task 1' });

  // Start the task (emits task_started event)
  const tasks = engine.taskStore.listByRun('run-crash2');
  await engine.executeTask(tasks[0].id);

  // Simulate crash
  engine.runStore.clear();
  engine.taskStore.clear();
  engine.planStore.clear();

  // Recover and resume
  await engine.resumeAfterCrash('run-crash2');

  // Verify task was actually executed
  const recoveredTasks = engine.taskStore.listByRun('run-crash2');
  assert.ok(recoveredTasks.length > 0);
  // Task should have been requeued to pending and then executed to completed
  const task = recoveredTasks[0];
  assert.strictEqual(task.status, 'completed');
});

// ═══════════════════════════════════════════════════════════
// Test 4: FAILED Task Crash Retry
// ═══════════════════════════════════════════════════════════

test('Recovery: FAILED task resets error and failedAt before retry', async () => {
  const emitter = new RuntimeEventEmitter();
  const store = createEventStore();
  emitter.setStore(store);
  const engine = createExecutionEngine({ emitter, eventStore: store });

  const created = engine.createRun({ goal: 'retry test', runId: 'run-retry1' });
  engine.startRun('run-retry1');
  engine.addTask('run-retry1', { goal: 'task 1' });

  // Transition task to FAILED via TransitionManager (emits task_failed)
  const tasks = engine.taskStore.listByRun('run-retry1');
  engine.transitionMgr.transitionTask(
    tasks[0].id, 'pending', 'failed',
    { runId: 'run-retry1', workspaceId: tasks[0].runId, taskId: tasks[0].id, data: { error: 'previous error' } }
  );

  // Simulate crash
  engine.runStore.clear();
  engine.taskStore.clear();
  engine.planStore.clear();

  // Recover and resume
  await engine.resumeAfterCrash('run-retry1');

  // Verify task was retried
  const recoveredTasks = engine.taskStore.listByRun('run-retry1');
  assert.ok(recoveredTasks.length > 0);
  const task = recoveredTasks[0];
  assert.strictEqual(task.status, 'completed');
  assert.strictEqual(task.error, null, 'error should be cleared');
  assert.strictEqual(task.failedAt, null, 'failedAt should be cleared');
});

// ═══════════════════════════════════════════════════════════
// Test 5: Completed Task Must Not Re-run
// ═══════════════════════════════════════════════════════════

test('Recovery: COMPLETED task is skipped, not re-executed', async () => {
  const emitter = new RuntimeEventEmitter();
  const store = createEventStore();
  emitter.setStore(store);
  const engine = createExecutionEngine({ emitter, eventStore: store });

  const created = engine.createRun({ goal: 'skip test', runId: 'run-skip1' });
  engine.startRun('run-skip1');
  engine.addTask('run-skip1', { goal: 'task 1' });

  // Transition task to COMPLETED via TransitionManager (emits task_completed)
  const tasks = engine.taskStore.listByRun('run-skip1');
  engine.transitionMgr.transitionTask(
    tasks[0].id, 'pending', 'completed',
    { runId: 'run-skip1', workspaceId: tasks[0].runId, taskId: tasks[0].id }
  );

  // Simulate crash
  engine.runStore.clear();
  engine.taskStore.clear();
  engine.planStore.clear();

  // Recover and resume
  const result = await engine.resumeAfterCrash('run-skip1');

  // Verify skip action
  const skipActions = result.actions.filter(a => a.action === 'skip_task');
  assert.ok(skipActions.length > 0, 'should have skip actions');
  assert.ok(skipActions.some(a => a.reason === 'already completed'));
});

// ═══════════════════════════════════════════════════════════
// Test 6: Store Mutation Boundary
// ═══════════════════════════════════════════════════════════

test('Store: get() returns clone, not live reference', () => {
  const engine = createExecutionEngine();
  const created = engine.createRun({ goal: 'test', runId: 'run-clone1' });

  const run1 = engine.runStore.get('run-clone1');
  const run2 = engine.runStore.get('run-clone1');

  // Modify the clone
  run1.status = 'completed';

  // Re-read from store
  const run3 = engine.runStore.get('run-clone1');
  assert.strictEqual(run3.status, RUN_STATUS.CREATED, 'store should not be affected by clone mutation');
  assert.notStrictEqual(run1, run2, 'each get should return a new clone');
});

test('Store: list() returns clones, not live references', () => {
  const engine = createExecutionEngine();
  engine.createRun({ goal: 'test', runId: 'run-clone2' });

  const runs = engine.runStore.list();
  assert.strictEqual(runs.length, 1);

  // Modify clone
  runs[0].status = 'completed';

  // Re-read from store
  const runs2 = engine.runStore.list();
  assert.strictEqual(runs2[0].status, RUN_STATUS.CREATED, 'store should not be affected');
});

test('Store: update() is the only way to modify state', () => {
  const engine = createExecutionEngine();
  const created = engine.createRun({ goal: 'test', runId: 'run-update1' });

  // Direct mutation via clone should not affect store
  const clone = engine.runStore.get('run-update1');
  clone.status = 'failed';

  // Use update API
  engine.runStore.update('run-update1', { status: 'completed' });

  const fromStore = engine.runStore.get('run-update1');
  assert.strictEqual(fromStore.status, 'completed');
});

// ═══════════════════════════════════════════════════════════
// Test 7: Transition/Event Consistency
// ═══════════════════════════════════════════════════════════

test('Transition: CREATED→STARTED produces run_started', () => {
  const emitter = new RuntimeEventEmitter();
  const store = createEventStore();
  emitter.setStore(store);
  const engine = createExecutionEngine({ emitter, eventStore: store });

  engine.createRun({ goal: 'test', runId: 'run-tc1' });
  engine.startRun('run-tc1');

  const events = store.getEventsByRun('run-tc1');
  const startedEvents = events.filter(e => e.type === 'run_started');
  assert.strictEqual(startedEvents.length, 1);
  assert.strictEqual(startedEvents[0].data.fromStatus, 'created');
  assert.strictEqual(startedEvents[0].data.toStatus, 'started');
});

test('Transition: PAUSED→STARTED produces run_resumed, not run_started', () => {
  const emitter = new RuntimeEventEmitter();
  const store = createEventStore();
  emitter.setStore(store);
  const engine = createExecutionEngine({ emitter, eventStore: store });

  engine.createRun({ goal: 'test', runId: 'run-tc2' });
  engine.startRun('run-tc2');
  engine.pauseRun('run-tc2');
  engine.resumeRun('run-tc2');

  const events = store.getEventsByRun('run-tc2');
  const startedCount = events.filter(e => e.type === 'run_started').length;
  const resumedCount = events.filter(e => e.type === 'run_resumed').length;

  assert.strictEqual(startedCount, 1, 'should have exactly 1 run_started');
  assert.strictEqual(resumedCount, 1, 'should have exactly 1 run_resumed');
});

test('Transition: STARTED→CANCELLED produces run_cancelled', () => {
  const emitter = new RuntimeEventEmitter();
  const store = createEventStore();
  emitter.setStore(store);
  const engine = createExecutionEngine({ emitter, eventStore: store });

  engine.createRun({ goal: 'test', runId: 'run-tc3' });
  engine.startRun('run-tc3');
  engine.cancelRun('run-tc3');

  const events = store.getEventsByRun('run-tc3');
  const cancelledEvents = events.filter(e => e.type === 'run_cancelled');
  assert.strictEqual(cancelledEvents.length, 1, 'should have run_cancelled');
  assert.ok(!events.some(e => e.type === 'plan_cancelled'), 'should NOT have plan_cancelled for run');
});

test('Transition: all lifecycle transitions are consistent', () => {
  const emitter = new RuntimeEventEmitter();
  const store = createEventStore();
  emitter.setStore(store);
  const engine = createExecutionEngine({ emitter, eventStore: store });

  // Full lifecycle
  engine.createRun({ goal: 'test', runId: 'run-tc4' });
  engine.startRun('run-tc4');
  engine.pauseRun('run-tc4');
  engine.resumeRun('run-tc4');
  engine.completeRun('run-tc4');

  // Verify Store state
  const run = engine.runStore.get('run-tc4');
  assert.strictEqual(run.status, RUN_STATUS.COMPLETED);

  // Verify events match
  const events = store.getEventsByRun('run-tc4');
  const types = events.map(e => e.type);

  assert.ok(types.includes('run_created'));
  assert.ok(types.includes('run_started'));
  assert.ok(types.includes('run_paused'));
  assert.ok(types.includes('run_resumed'));
  assert.ok(types.includes('run_completed'));

  // Verify no extra events
  assert.strictEqual(types.filter(t => t === 'run_started').length, 1);
  assert.strictEqual(types.filter(t => t === 'run_resumed').length, 1);
});