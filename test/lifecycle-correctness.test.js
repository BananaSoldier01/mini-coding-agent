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

  // Leave the task in RUNNING state — simulates a crash mid-execution.
  // (The previous version completed the task before the crash, which only
  // proved a COMPLETED task stays completed — not that a RUNNING task re-runs.)
  const tasks = engine.taskStore.listByRun('run-crash2');
  engine.transitionMgr.transitionTask(
    tasks[0].id, 'pending', 'running',
    { runId: 'run-crash2', workspaceId: tasks[0].runId, taskId: tasks[0].id }
  );

  // Simulate crash
  engine.runStore.clear();
  engine.taskStore.clear();
  engine.planStore.clear();

  // Recover and resume — RUNNING task should be requeued to PENDING and then
  // executed through the full RUNNING→VERIFYING→COMPLETED chain.
  await engine.resumeAfterCrash('run-crash2');

  // Verify task was actually executed
  const recoveredTasks = engine.taskStore.listByRun('run-crash2');
  assert.ok(recoveredTasks.length > 0);
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

  // Transition task to FAILED via the normal lifecycle (PENDING→RUNNING→FAILED)
  const tasks = engine.taskStore.listByRun('run-retry1');
  engine.transitionMgr.transitionTask(
    tasks[0].id, 'pending', 'running',
    { runId: 'run-retry1', workspaceId: tasks[0].runId, taskId: tasks[0].id }
  );
  engine.transitionMgr.transitionTask(
    tasks[0].id, 'running', 'failed',
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

  // Transition task to COMPLETED via the normal lifecycle
  // (PENDING→RUNNING→VERIFYING→COMPLETED)
  const tasks = engine.taskStore.listByRun('run-skip1');
  engine.transitionMgr.transitionTask(
    tasks[0].id, 'pending', 'running',
    { runId: 'run-skip1', workspaceId: tasks[0].runId, taskId: tasks[0].id }
  );
  engine.transitionMgr.transitionTask(
    tasks[0].id, 'running', 'verifying',
    { runId: 'run-skip1', workspaceId: tasks[0].runId, taskId: tasks[0].id }
  );
  engine.transitionMgr.transitionTask(
    tasks[0].id, 'verifying', 'completed',
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
  // V1.2.3: planId is now correctly written back to RunStore, so cancelling
  // the run also cancels its plan (previously planId was null and this block
  // was dead). plan_cancelled is therefore expected.
  assert.ok(events.some(e => e.type === 'plan_cancelled'), 'cancelling the run should also cancel its plan');
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

// ═══════════════════════════════════════════════════════════
// Test 8: Full Execution Loop (executeRun E2E)
// ═══════════════════════════════════════════════════════════

test('E2E: executeRun resolves planId, executes tasks, and completes the run', async () => {
  const emitter = new RuntimeEventEmitter();
  const store = createEventStore();
  emitter.setStore(store);
  const engine = createExecutionEngine({ emitter, eventStore: store });

  const created = engine.createRun({ goal: 'e2e loop', runId: 'run-e2e' });
  // Tasks must be added BEFORE startRun, because the plan is built from
  // run.taskIds at start time.
  engine.addTask('run-e2e', { goal: 'task 1' });
  engine.addTask('run-e2e', { goal: 'task 2' });
  engine.startRun('run-e2e');

  // P0-1: planId must be written back to RunStore so executeRun can find the plan
  const runBefore = engine.runStore.get('run-e2e');
  assert.ok(runBefore.planId, 'RunStore.planId should be set after startRun');
  assert.ok(engine.planStore.has(runBefore.planId), 'Plan should exist in PlanStore');

  const result = await engine.executeRun('run-e2e');
  assert.ok(result.success, `executeRun should succeed: ${JSON.stringify(result)}`);

  // All tasks executed and completed
  const tasks = engine.taskStore.listByRun('run-e2e');
  assert.strictEqual(tasks.length, 2);
  assert.ok(tasks.every(t => t.status === 'completed'), 'all tasks should be completed');

  // Run should be auto-completed after all tasks finish
  const runAfter = engine.runStore.get('run-e2e');
  assert.strictEqual(runAfter.status, RUN_STATUS.COMPLETED);

  // Each task transition must be emitted exactly once (no duplicates)
  const types = store.getEventsByRun('run-e2e').map(e => e.type);
  assert.strictEqual(types.filter(t => t === 'task_started').length, 2, 'exactly one task_started per task');
  assert.strictEqual(types.filter(t => t === 'task_completed').length, 2, 'exactly one task_completed per task');
  assert.strictEqual(types.filter(t => t === 'task_failed').length, 0, 'no task_failed expected');
});

// ═══════════════════════════════════════════════════════════
// Test 9: Real crash recovery on a FRESH ExecutionEngine instance
// ═══════════════════════════════════════════════════════════

test('E2E: recovery on a fresh ExecutionEngine instance restores Run + Tasks by original id', () => {
  // Phase 1: engine A produces an event trail. Its stores are NOT shared with B.
  const emitterA = new RuntimeEventEmitter();
  const storeA = createEventStore();
  emitterA.setStore(storeA);
  const engineA = createExecutionEngine({ emitter: emitterA, eventStore: storeA });
  engineA.createRun({ goal: 'crash recovery', runId: 'run-fresh' });
  engineA.startRun('run-fresh');
  engineA.addTask('run-fresh', { goal: 'task 1' });
  // Leave the task RUNNING to simulate a crash mid-execution
  const tasksA = engineA.taskStore.listByRun('run-fresh');
  engineA.transitionMgr.transitionTask(
    tasksA[0].id, 'pending', 'running',
    { runId: 'run-fresh', workspaceId: tasksA[0].runId, taskId: tasksA[0].id }
  );

  // Phase 2: FRESH engine — empty stores, but the event trail persists via storeA
  const engineB = createExecutionEngine({ emitter: emitterA, eventStore: storeA });
  const recovery = engineB.recover('run-fresh');
  assert.ok(recovery.success, `recovery should succeed: ${JSON.stringify(recovery)}`);

  // P0-2: the run must be findable in RunStore by its ORIGINAL id, with the
  // reconstructed status — not stored under a random id as the old code did.
  const recoveredRun = engineB.runStore.get('run-fresh');
  assert.ok(recoveredRun, 'recovered run should exist in RunStore by original id');
  assert.strictEqual(recoveredRun.status, RUN_STATUS.STARTED);
  assert.strictEqual(recoveredRun.taskIds.length, 1);

  // The task must be restored to TaskStore by its original id with RUNNING status
  const recoveredTasks = engineB.taskStore.listByRun('run-fresh');
  assert.strictEqual(recoveredTasks.length, 1);
  assert.strictEqual(recoveredTasks[0].status, 'running');
  assert.strictEqual(recoveredTasks[0].id, tasksA[0].id, 'task id must be preserved');

  // resumeAfterCrash on the fresh engine must requeue RUNNING → PENDING and execute
  return engineB.resumeAfterCrash('run-fresh').then(result => {
    assert.ok(result.success);
    const after = engineB.taskStore.listByRun('run-fresh')[0];
    assert.strictEqual(after.status, 'completed', 'RUNNING task should re-execute to completed');
  });
});

// ═══════════════════════════════════════════════════════════
// Test 10: Run creation ownership — duplicate runId must fail
// ═══════════════════════════════════════════════════════════

test('E2E: duplicate runId is reported as failure, not silent success', () => {
  const engine = createExecutionEngine();
  const first = engine.createRun({ goal: 'first', runId: 'run-dup' });
  assert.ok(first.success, 'first create should succeed');
  assert.strictEqual(engine.runStore.get('run-dup').goal, 'first');

  const second = engine.createRun({ goal: 'second', runId: 'run-dup' });
  assert.ok(!second.success, 'duplicate runId must be reported as failure');
  assert.ok(second.reason?.includes('already exists'), `unexpected reason: ${second.reason}`);

  // Store must still hold the ORIGINAL run — not a swapped-in duplicate
  assert.strictEqual(engine.runStore.get('run-dup').goal, 'first');
  assert.strictEqual(engine.runStore.count(), 1, 'only one run should exist');

  // Exactly one run_created event — the failed duplicate must not emit
  const events = engine.eventStore.getEventsByRun('run-dup');
  assert.strictEqual(
    events.filter(e => e.type === 'run_created').length, 1,
    'failed duplicate create must not emit run_created'
  );
});

// ═══════════════════════════════════════════════════════════
// Test 11: Plan lifecycle is driven by the Run execution
// ═══════════════════════════════════════════════════════════

test('E2E: Plan follows DRAFT→APPROVED→EXECUTING→VERIFYING→COMPLETED with the Run', async () => {
  const emitter = new RuntimeEventEmitter();
  const store = createEventStore();
  emitter.setStore(store);
  const engine = createExecutionEngine({ emitter, eventStore: store });

  engine.createRun({ goal: 'plan lifecycle', runId: 'run-pl' });
  engine.addTask('run-pl', { goal: 'task 1' });
  engine.startRun('run-pl');

  const run = engine.runStore.get('run-pl');
  const planAfterStart = engine.planStore.get(run.planId);
  assert.strictEqual(planAfterStart.status, 'executing', 'plan should advance to EXECUTING when the run starts');

  const startEvents = store.getEventsByRun('run-pl').map(e => e.type);
  assert.ok(startEvents.includes('plan_approved'), 'plan_approved should fire on start');
  assert.ok(startEvents.includes('plan_started'), 'plan_started should fire on start');

  await engine.executeRun('run-pl');

  const planAfterExec = engine.planStore.get(run.planId);
  assert.strictEqual(planAfterExec.status, 'completed', 'plan should reach COMPLETED after tasks finish');

  const execEvents = store.getEventsByRun('run-pl').map(e => e.type);
  assert.ok(execEvents.includes('plan_verifying'), 'plan_verifying should fire during completion');
  assert.ok(execEvents.includes('plan_completed'), 'plan_completed should fire during completion');
  assert.strictEqual(engine.runStore.get('run-pl').status, RUN_STATUS.COMPLETED);
});

// ═══════════════════════════════════════════════════════════
// Test 12: addTask after startRun syncs the Plan
// ═══════════════════════════════════════════════════════════

test('E2E: addTask after startRun keeps the Plan in sync so the task is scheduled', async () => {
  const engine = createExecutionEngine();
  engine.createRun({ goal: 'late add', runId: 'run-late' });
  engine.addTask('run-late', { goal: 'task 1' });
  engine.startRun('run-late');

  const run = engine.runStore.get('run-late');
  const planBefore = engine.planStore.get(run.planId);
  assert.strictEqual(planBefore.tasks.length, 1, 'plan should have 1 task before the late add');

  // Adding a task AFTER the run has started must still be scheduled
  engine.addTask('run-late', { goal: 'task 2' });
  const planAfter = engine.planStore.get(run.planId);
  assert.strictEqual(planAfter.tasks.length, 2, 'plan must sync to 2 tasks after the late add');
  assert.strictEqual(engine.taskStore.listByRun('run-late').length, 2, 'run should own 2 tasks');

  const result = await engine.executeRun('run-late');
  assert.ok(result.success, `late-added task must be scheduled and completed: ${JSON.stringify(result)}`);
  const tasks = engine.taskStore.listByRun('run-late');
  assert.ok(tasks.every(t => t.status === 'completed'), 'both tasks should complete');
});

// ═══════════════════════════════════════════════════════════
// Test 13: Real crash recovery preserves the Skill binding and re-executes
// ═══════════════════════════════════════════════════════════

test('E2E: crash recovery preserves the task Skill binding and actually executes it', async () => {
  // Phase 1: engine A creates a run with a Skill-bound task and leaves it RUNNING
  const emitterA = new RuntimeEventEmitter();
  const storeA = createEventStore();
  emitterA.setStore(storeA);
  const engineA = createExecutionEngine({ emitter: emitterA, eventStore: storeA });
  engineA.createRun({ goal: 'skill recovery', runId: 'run-skill' });
  engineA.addTask('run-skill', { goal: 'read file', skillId: 'code-review' });
  engineA.startRun('run-skill');
  const taskA = engineA.taskStore.listByRun('run-skill')[0];
  engineA.transitionMgr.transitionTask(
    taskA.id, 'pending', 'running',
    { runId: 'run-skill', workspaceId: taskA.runId, taskId: taskA.id }
  );

  // Phase 2: FRESH engine B. Its skill runtime is mocked to record the real call.
  const engineB = createExecutionEngine({ emitter: emitterA, eventStore: storeA });
  const executed = [];
  engineB.skillRuntime.executeSkill = async (skillId, ctx) => {
    executed.push({ skillId, taskId: ctx.taskId });
    return { success: true, result: { toolResults: [{ tool: 'read_file', success: true }] } };
  };

  const recovery = engineB.recover('run-skill');
  assert.ok(recovery.success, `recovery should succeed: ${JSON.stringify(recovery)}`);

  // The recovered task must carry its Skill binding — this is the whole point:
  // without it TaskExecutor skips real execution and marks the task COMPLETED
  // without ever running the coding Skill (a dangerous false positive).
  const recovered = engineB.taskStore.listByRun('run-skill')[0];
  assert.strictEqual(recovered.id, taskA.id, 'task id must be preserved');
  assert.deepStrictEqual(recovered.assignedSkills, ['code-review'], 'Skill binding must survive recovery');

  await engineB.resumeAfterCrash('run-skill');

  assert.strictEqual(
    executed.length, 1,
    'the recovered task must actually invoke its Skill, not skip to COMPLETED'
  );
  assert.strictEqual(executed[0].skillId, 'code-review');
  assert.strictEqual(executed[0].taskId, taskA.id);

  const after = engineB.taskStore.listByRun('run-skill')[0];
  assert.strictEqual(after.status, 'completed', 'recovered task should complete after real skill execution');
});

// ═══════════════════════════════════════════════════════════
// Test 14: duplicate runId must NOT pollute the existing Run's
//          Workspace / Context (P0-1 second review)
// ═══════════════════════════════════════════════════════════

test('E2E: duplicate runId returns failure without corrupting Workspace/Context', () => {
  const engine = createExecutionEngine();
  const first = engine.createRun({ goal: 'first', runId: 'run-dup' });
  assert.ok(first.success, 'first create should succeed');
  const wsId = first.workspace?.id;
  const ctxId = engine.contextMgr.getByRun('run-dup')?.id;
  assert.ok(wsId, 'first create should produce a workspace');
  assert.ok(ctxId, 'first create should produce a context');

  // A second create with the same runId must fail BEFORE creating any side
  // effect — no orphan workspace, no overwritten context mapping.
  const second = engine.createRun({ goal: 'second', runId: 'run-dup' });
  assert.ok(!second.success, 'duplicate runId must be reported as failure');
  assert.strictEqual(second.workspace, null, 'duplicate must not create an orphan workspace');
  assert.strictEqual(
    engine.contextMgr.getByRun('run-dup')?.id, ctxId,
    'duplicate must not overwrite the existing context mapping'
  );
  assert.strictEqual(
    engine.runStore.get('run-dup').workspaceId, wsId,
    'the existing run must still point to its original workspace'
  );
  assert.strictEqual(
    engine.eventStore.getEventsByRun('run-dup').filter(e => e.type === 'run_created').length, 1,
    'the failed duplicate must not emit run_created'
  );
});

// ═══════════════════════════════════════════════════════════
// Test 15: crash recovery restores the Plan and the full Runtime
//          can return to normal execution (P0-2 second review)
// ═══════════════════════════════════════════════════════════

test('E2E: recovery restores the Plan and executeRun completes the run afterwards', async () => {
  // Phase 1: engine A produces a crash-point state
  const emitterA = new RuntimeEventEmitter();
  const storeA = createEventStore();
  emitterA.setStore(storeA);
  const engineA = createExecutionEngine({ emitter: emitterA, eventStore: storeA });
  engineA.createRun({ goal: 'plan recovery', runId: 'run-pr' });
  engineA.addTask('run-pr', { goal: 't1' });
  engineA.startRun('run-pr');
  const taskA = engineA.taskStore.listByRun('run-pr')[0];
  engineA.transitionMgr.transitionTask(
    taskA.id, 'pending', 'running',
    { runId: 'run-pr', workspaceId: taskA.runId, taskId: taskA.id }
  );

  // Persist the full Stores as a crash snapshot
  const snapshot = engineA.serializeStores();
  assert.ok(Object.keys(snapshot.plans).length === 1, 'snapshot must carry the Plan');

  // Phase 2: FRESH engine B restores from the snapshot
  const engineB = createExecutionEngine({ emitter: emitterA, eventStore: storeA });
  const recovery = engineB.recover('run-pr', { snapshot });
  assert.ok(recovery.success, `recovery should succeed: ${JSON.stringify(recovery)}`);
  assert.ok(recovery.plan, 'recovery must restore the Plan');
  assert.strictEqual(
    recovery.plan.id, engineA.runStore.get('run-pr').planId,
    'restored plan id must match the original'
  );
  assert.strictEqual(
    engineB.runStore.get('run-pr').planId, engineA.runStore.get('run-pr').planId,
    'the run must point at the restored plan'
  );
  assert.ok(
    engineB.planStore.get(engineB.runStore.get('run-pr').planId),
    'executeRun() must be able to resolve the plan'
  );

  // Resume execution, then drive the normal executeRun path
  await engineB.resumeAfterCrash('run-pr', { snapshot });
  assert.strictEqual(
    engineB.taskStore.listByRun('run-pr')[0].status, 'completed',
    'recovered task should complete after resume'
  );
  await engineB.executeRun('run-pr');
  assert.strictEqual(
    engineB.runStore.get('run-pr').status, RUN_STATUS.COMPLETED,
    'the run must complete after executeRun'
  );
  assert.strictEqual(
    engineB.planStore.get(engineB.runStore.get('run-pr').planId).status, 'completed',
    'the plan must complete after executeRun'
  );
});

// ═══════════════════════════════════════════════════════════
// Test 16: Run/Plan compound lifecycle must be atomic — a failed
//          Run transition must NOT leave the Plan mutated (P1-1)
// ═══════════════════════════════════════════════════════════

test('E2E: completeRun on a PAUSED run fails without forking the Plan', () => {
  const engine = createExecutionEngine();
  engine.createRun({ goal: 'pa', runId: 'run-pa' });
  engine.addTask('run-pa', { goal: 't' });
  engine.startRun('run-pa');
  engine.pauseRun('run-pa');
  assert.strictEqual(engine.runStore.get('run-pa').status, RUN_STATUS.PAUSED);

  const planId = engine.runStore.get('run-pa').planId;
  const planStatusBefore = engine.planStore.get(planId).status;

  const result = engine.completeRun('run-pa');
  assert.ok(!result.success, 'completeRun on a PAUSED run must fail');
  assert.strictEqual(
    engine.planStore.get(planId).status, planStatusBefore,
    'the Plan must NOT be mutated when the Run transition fails (no fork)'
  );
  assert.strictEqual(engine.runStore.get('run-pa').status, RUN_STATUS.PAUSED, 'the run must stay PAUSED');
});

test('E2E: failRun on a PAUSED run now succeeds (paused→failed added to the table)', () => {
  const engine = createExecutionEngine();
  engine.createRun({ goal: 'fp', runId: 'run-fp' });
  engine.addTask('run-fp', { goal: 't' });
  engine.startRun('run-fp');
  engine.pauseRun('run-fp');
  assert.strictEqual(engine.runStore.get('run-fp').status, RUN_STATUS.PAUSED);

  const planId = engine.runStore.get('run-fp').planId;

  const result = engine.failRun('run-fp', new Error('boom'));
  assert.ok(result.success, 'failRun on a PAUSED run must succeed');
  assert.strictEqual(engine.runStore.get('run-fp').status, RUN_STATUS.FAILED, 'the run must be FAILED');
  assert.strictEqual(engine.planStore.get(planId).status, 'failed', 'the plan must also be FAILED');
});

// ═══════════════════════════════════════════════════════════
// Test 17: task dependencies must drive scheduling order (P1-2)
// ═══════════════════════════════════════════════════════════

test('E2E: task dependencies are synced into the Plan and drive scheduling', async () => {
  const engine = createExecutionEngine();
  engine.createRun({ goal: 'deps', runId: 'run-deps' });
  engine.addTask('run-deps', { id: 'A', goal: 'task A' });
  engine.addTask('run-deps', { id: 'B', goal: 'task B', dependencies: ['A'] });
  engine.startRun('run-deps');

  const plan = engine.planStore.get(engine.runStore.get('run-deps').planId);
  assert.ok(
    plan.dependencies.some(d => d.from === 'A' && d.to === 'B'),
    'the Plan must carry the task dependency A→B so getExecutionOrder() can respect it'
  );

  await engine.executeRun('run-deps');
  const tasks = engine.taskStore.listByRun('run-deps');
  assert.ok(tasks.every(t => t.status === 'completed'), 'both tasks must complete');
  assert.strictEqual(engine.runStore.get('run-deps').status, RUN_STATUS.COMPLETED, 'the run must complete');
});