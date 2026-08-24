/**
 * test/event-store.test.js — Runtime Event Store & Replay Tests
 *
 * V0.9.7
 * Tests for RuntimeEventStore, Unified Event Schema, Runtime Replay,
 * Debug Query API, Snapshot + Event Integration.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  RuntimeEventStore,
  createEventStore,
  RUNTIME_EVENT_TYPES,
  RuntimeEventEmitter,
  createPlan,
  approvePlan,
  startPlan,
  startPlanVerification,
  completePlan,
  failPlan,
  cancelPlan,
  createTask,
  startTask,
  startTaskVerification,
  completeTask,
  failTask,
  supersedeTask,
  TASK_STATUS,
  PLAN_STATUS,
  createRevisionRequest,
  RevisionEngine,
  createRevisionEngine,
  TaskScheduler,
  createScheduler,
} from '../agent/skill.js';

// ── Test 1: Event Store Append & Query ───────────────────

test('EventStore: append stores event with unified schema', () => {
  const store = createEventStore();
  const ev = store.append({
    runId: 'run-1',
    planId: 'plan-1',
    taskId: 'task-1',
    type: 'task_started',
    data: { goal: 'Test' },
  });

  assert.ok(ev.id);
  assert.strictEqual(ev.runId, 'run-1');
  assert.strictEqual(ev.planId, 'plan-1');
  assert.strictEqual(ev.taskId, 'task-1');
  assert.strictEqual(ev.type, 'task_started');
  assert.ok(ev.timestamp > 0);
  assert.strictEqual(ev.source, 'runtime');
});

test('EventStore: getEventsByRun returns run events', () => {
  const store = createEventStore();
  store.append({ runId: 'run-1', type: 'task_started', taskId: 't1' });
  store.append({ runId: 'run-1', type: 'task_completed', taskId: 't1' });
  store.append({ runId: 'run-2', type: 'task_started', taskId: 't2' });

  const events = store.getEventsByRun('run-1');
  assert.strictEqual(events.length, 2);
  assert.ok(events.every(e => e.runId === 'run-1'));
});

test('EventStore: getEventsByTask returns task events', () => {
  const store = createEventStore();
  store.append({ runId: 'run-1', taskId: 't1', type: 'task_started' });
  store.append({ runId: 'run-1', taskId: 't1', type: 'task_completed' });
  store.append({ runId: 'run-1', taskId: 't2', type: 'task_started' });

  const events = store.getEventsByTask('t1');
  assert.strictEqual(events.length, 2);
  assert.ok(events.every(e => e.taskId === 't1'));
});

test('EventStore: getEventsByPlan returns plan events', () => {
  const store = createEventStore();
  store.append({ runId: 'run-1', planId: 'plan-1', type: 'plan_started' });
  store.append({ runId: 'run-1', planId: 'plan-1', type: 'plan_completed' });
  store.append({ runId: 'run-1', planId: 'plan-2', type: 'plan_started' });

  const events = store.getEventsByPlan('plan-1');
  assert.strictEqual(events.length, 2);
});

test('EventStore: getEventsByType returns type events', () => {
  const store = createEventStore();
  store.append({ runId: 'run-1', type: 'task_started', taskId: 't1' });
  store.append({ runId: 'run-1', type: 'task_started', taskId: 't2' });
  store.append({ runId: 'run-1', type: 'task_completed', taskId: 't1' });

  const events = store.getEventsByType('task_started');
  assert.strictEqual(events.length, 2);
});

test('EventStore: events ordered by timestamp', () => {
  const store = createEventStore();
  store.append({ runId: 'run-1', type: 'task_started', taskId: 't1', timestamp: 300 });
  store.append({ runId: 'run-1', type: 'task_completed', taskId: 't1', timestamp: 100 });
  store.append({ runId: 'run-1', type: 'task_started', taskId: 't2', timestamp: 200 });

  const events = store.getEventsByRun('run-1');
  assert.strictEqual(events[0].timestamp, 100);
  assert.strictEqual(events[1].timestamp, 200);
  assert.strictEqual(events[2].timestamp, 300);
});

// ── Test 2: Revision Timeline ─────────────────────────────

test('EventStore: getRevisionTimeline returns ordered revision events', () => {
  const store = createEventStore();
  store.append({
    runId: 'run-1', planId: 'plan-1',
    type: 'revision_requested', timestamp: 100,
    data: { revisionId: 'rev-1', reason: 'Add task' },
  });
  store.append({
    runId: 'run-1', planId: 'plan-1',
    type: 'revision_validated', timestamp: 200,
    data: { revisionId: 'rev-1', compatible: true },
  });
  store.append({
    runId: 'run-1', planId: 'plan-1',
    type: 'revision_applied', timestamp: 300,
    data: { revisionId: 'rev-1', toRevision: 2, status: 'applied' },
  });

  const timeline = store.getRevisionTimeline('plan-1');
  assert.strictEqual(timeline.length, 3);
  assert.strictEqual(timeline[0].type, 'revision_requested');
  assert.strictEqual(timeline[2].type, 'revision_applied');
});

test('EventStore: getTaskTimeline returns task lifecycle', () => {
  const store = createEventStore();
  store.append({ runId: 'run-1', taskId: 't1', type: 'task_created', timestamp: 100, data: { status: 'pending' } });
  store.append({ runId: 'run-1', taskId: 't1', type: 'task_started', timestamp: 200, data: { status: 'running' } });
  store.append({ runId: 'run-1', taskId: 't1', type: 'task_completed', timestamp: 300, data: { status: 'completed' } });

  const timeline = store.getTaskTimeline('t1');
  assert.strictEqual(timeline.length, 3);
  assert.strictEqual(timeline[0].type, 'task_created');
  assert.strictEqual(timeline[2].type, 'task_completed');
});

// ── Test 3: Runtime Replay ───────────────────────────────

test('Replay: reconstructs plan state from events', () => {
  const events = [
    { id: 'e1', runId: 'run-1', planId: 'plan-1', type: 'plan_created', timestamp: 100,
      data: { goal: 'Test', tasks: [{ id: 't1', goal: 'Task 1' }] } },
    { id: 'e2', runId: 'run-1', planId: 'plan-1', type: 'plan_approved', timestamp: 200, data: {} },
    { id: 'e3', runId: 'run-1', planId: 'plan-1', type: 'plan_started', timestamp: 300, data: {} },
  ];

  const result = RuntimeEventStore.replay(events);
  assert.ok(result.plan);
  assert.strictEqual(result.plan.goal, 'Test');
  assert.strictEqual(result.plan.status, PLAN_STATUS.EXECUTING);
  assert.strictEqual(result.summary.planEvents, 3);
});

test('Replay: reconstructs task states from events', () => {
  const events = [
    { id: 'e1', runId: 'run-1', taskId: 't1', type: 'task_created', timestamp: 100, data: { status: 'pending', goal: 'Task 1' } },
    { id: 'e2', runId: 'run-1', taskId: 't1', type: 'task_started', timestamp: 200, data: { status: 'running' } },
    { id: 'e3', runId: 'run-1', taskId: 't1', type: 'task_completed', timestamp: 300, data: { status: 'completed' } },
  ];

  const result = RuntimeEventStore.replay(events);
  assert.strictEqual(result.taskStates.get('t1').status, TASK_STATUS.COMPLETED);
  assert.strictEqual(result.summary.taskEvents, 3);
});

test('Replay: reconstructs revision history from events', () => {
  const events = [
    { id: 'e0', runId: 'run-1', planId: 'plan-1', type: 'plan_created', timestamp: 50,
      data: { goal: 'Test', tasks: [] } },
    { id: 'e1', runId: 'run-1', planId: 'plan-1', type: 'revision_applied', timestamp: 100,
      data: { revisionId: 'rev-1', toRevision: 2, status: 'applied', reason: 'Update' } },
    { id: 'e2', runId: 'run-1', planId: 'plan-1', type: 'revision_applied', timestamp: 200,
      data: { revisionId: 'rev-2', toRevision: 3, status: 'applied', reason: 'Update 2' } },
  ];

  const result = RuntimeEventStore.replay(events);
  assert.strictEqual(result.revisions.length, 2);
  assert.strictEqual(result.plan.revision, 3);
  assert.strictEqual(result.summary.revisionEvents, 2);
});

test('Replay: empty events returns empty state', () => {
  const result = RuntimeEventStore.replay([]);
  assert.strictEqual(result.plan, null);
  assert.strictEqual(result.taskStates.size, 0);
  assert.strictEqual(result.revisions.length, 0);
  assert.strictEqual(result.summary.totalEvents, 0);
});

test('Replay: handles plan_failed and plan_cancelled', () => {
  const events = [
    { id: 'e1', runId: 'run-1', planId: 'plan-1', type: 'plan_created', timestamp: 100, data: { goal: 'Test' } },
    { id: 'e2', runId: 'run-1', planId: 'plan-1', type: 'plan_failed', timestamp: 200, data: { reason: 'Timeout' } },
  ];

  const result = RuntimeEventStore.replay(events);
  assert.strictEqual(result.plan.status, PLAN_STATUS.FAILED);
  assert.strictEqual(result.plan.reason, 'Timeout');
});

test('Replay: handles task_superseded', () => {
  const events = [
    { id: 'e1', runId: 'run-1', taskId: 't1', type: 'task_created', timestamp: 100, data: { status: 'pending', goal: 'Task 1' } },
    { id: 'e2', runId: 'run-1', taskId: 't1', type: 'task_started', timestamp: 200, data: { status: 'running' } },
    { id: 'e3', runId: 'run-1', taskId: 't1', type: 'task_superseded', timestamp: 300,
      data: { status: 'superseded', reason: 'Replaced', previousStatus: 'running' } },
  ];

  const result = RuntimeEventStore.replay(events);
  assert.strictEqual(result.taskStates.get('t1').status, TASK_STATUS.SUPERSEDED);
  assert.strictEqual(result.taskStates.get('t1').supersededReason, 'Replaced');
});

// ── Test 4: Snapshot + Event Integration ──────────────────

test('EventStore: serialize/deserialize round trip', () => {
  const store = createEventStore();
  store.append({ runId: 'run-1', type: 'task_started', taskId: 't1' });
  store.append({ runId: 'run-1', type: 'task_completed', taskId: 't1' });

  const serialized = store.serialize();
  assert.strictEqual(serialized.count, 2);
  assert.ok(Array.isArray(serialized.events));

  const store2 = createEventStore();
  store2.deserialize(serialized);
  assert.strictEqual(store2.count(), 2);
  assert.strictEqual(store2.getEventsByRun('run-1').length, 2);
});

test('EventStore: clear removes all events', () => {
  const store = createEventStore();
  store.append({ runId: 'run-1', type: 'task_started', taskId: 't1' });
  store.append({ runId: 'run-2', type: 'task_started', taskId: 't2' });

  store.clear();
  assert.strictEqual(store.count(), 0);
});

test('EventStore: clearRun removes only run events', () => {
  const store = createEventStore();
  store.append({ runId: 'run-1', type: 'task_started', taskId: 't1' });
  store.append({ runId: 'run-2', type: 'task_started', taskId: 't2' });

  store.clearRun('run-1');
  assert.strictEqual(store.count(), 1);
  assert.strictEqual(store.getEventsByRun('run-1').length, 0);
  assert.strictEqual(store.getEventsByRun('run-2').length, 1);
});

// ── Test 5: Emitter + Store Integration ───────────────────

test('Emitter: routes events to store when setStore is called', () => {
  const store = createEventStore();
  const emitter = new RuntimeEventEmitter();
  emitter.setStore(store);

  emitter.emit({
    runId: 'run-1',
    planId: 'plan-1',
    taskId: 't1',
    type: 'task_started',
    data: { goal: 'Test' },
  });

  assert.strictEqual(store.count(), 1);
  const events = store.getEventsByRun('run-1');
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].type, 'task_started');
});

test('Emitter: does not route to store when store not set', () => {
  const emitter = new RuntimeEventEmitter();
  // No store set — should not throw
  emitter.emit({ runId: 'run-1', type: 'task_started', taskId: 't1' });
  assert.strictEqual(emitter.getStore(), null);
});

// ── Test 6: Full Integration ──────────────────────────────

test('Integration: full lifecycle produces events in store', () => {
  const store = createEventStore();
  const emitter = new RuntimeEventEmitter();
  emitter.setStore(store);

  // Plan lifecycle
  const plan = createPlan('run-1', 'Test Goal', {
    tasks: [{ id: 't1', goal: 'Task 1' }],
    emitter,
  });
  approvePlan(plan, emitter);
  startPlan(plan, emitter);

  // Task lifecycle
  const task = createTask('run-1', 'Task 1');
  startTask(task, emitter);
  startTaskVerification(task, emitter);
  completeTask(task, emitter);

  // Plan complete
  startPlanVerification(plan, emitter);
  completePlan(plan, emitter);

  // Verify events
  const runEvents = store.getEventsByRun('run-1');
  assert.ok(runEvents.length >= 6);

  const types = runEvents.map(e => e.type);
  assert.ok(types.includes('plan_created'));
  assert.ok(types.includes('plan_approved'));
  assert.ok(types.includes('plan_started'));
  assert.ok(types.includes('task_started'));
  assert.ok(types.includes('task_verifying'));
  assert.ok(types.includes('task_completed'));
  assert.ok(types.includes('plan_completed'));
});

test('Integration: replay from store reconstructs state', () => {
  const store = createEventStore();
  const emitter = new RuntimeEventEmitter();
  emitter.setStore(store);

  const plan = createPlan('run-1', 'Test', {
    tasks: [{ id: 't1', goal: 'Task 1' }],
    emitter,
  });
  approvePlan(plan, emitter);
  startPlan(plan, emitter);
  startPlanVerification(plan, emitter);

  const task = createTask('run-1', 'Task 1');
  startTask(task, emitter);
  startTaskVerification(task, emitter);
  completeTask(task, emitter);
  completePlan(plan, emitter);

  // Replay from store
  const result = store.replayRun('run-1');
  assert.ok(result.plan);
  assert.strictEqual(result.plan.status, PLAN_STATUS.COMPLETED);
  assert.strictEqual(result.taskStates.get(task.id).status, TASK_STATUS.COMPLETED);
});

test('Integration: revision lifecycle produces events', () => {
  const store = createEventStore();
  const emitter = new RuntimeEventEmitter();
  emitter.setStore(store);

  const plan = createPlan('run-1', 'Goal v1', {
    tasks: [{ id: 't1', goal: 'Task 1' }],
    emitter,
  });
  const taskStatus = new Map([['t1', TASK_STATUS.PENDING]]);
  const engine = createRevisionEngine({ plan, taskStatusMap: taskStatus, emitter });

  const revision = createRevisionRequest(plan, { goal: 'Goal v2' }, 'Update');
  engine.executeRevision(revision);

  // Verify revision events
  const timeline = store.getRevisionTimeline(plan.id);
  assert.ok(timeline.length >= 3); // requested, validated, applied
  assert.ok(timeline.some(t => t.type === 'revision_requested'));
  assert.ok(timeline.some(t => t.type === 'revision_validated'));
  assert.ok(timeline.some(t => t.type === 'revision_applied'));
});

test('Integration: supersede task produces event', () => {
  const store = createEventStore();
  const emitter = new RuntimeEventEmitter();
  emitter.setStore(store);

  const task = createTask('run-1', 'Test');
  startTask(task, emitter);
  supersedeTask(task, emitter, { reason: 'Replaced' });

  const events = store.getEventsByTask(task.id);
  assert.ok(events.some(e => e.type === 'task_superseded'));
  assert.strictEqual(events.find(e => e.type === 'task_superseded').data.previousStatus, 'running');
});

test('Integration: scheduler refresh produces event', () => {
  const store = createEventStore();
  const emitter = new RuntimeEventEmitter();
  emitter.setStore(store);

  const plan = createPlan('run-1', 'Goal', {
    tasks: [{ id: 't1', goal: 'Task 1' }],
  });
  const taskStatus = new Map([['t1', TASK_STATUS.PENDING]]);
  const scheduler = createScheduler(plan, taskStatus, new Map(), emitter);

  // Trigger scheduler refresh
  scheduler.getReadyTasks();

  // TASK_READY events should be emitted
  const readyEvents = store.getEventsByType('task_ready');
  assert.ok(readyEvents.length >= 1);
});