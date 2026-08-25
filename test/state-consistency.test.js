/**
 * test/state-consistency.test.js — Runtime State Ownership & Consistency Tests
 *
 * V1.2.2
 * Tests for:
 * - State Source of Truth (Store vs Engine)
 * - State consistency verification
 * - Store serialization/restore
 * - No duplicate state
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ExecutionEngine,
  createExecutionEngine,
  RunStore,
  createRunStore,
  PlanStore,
  createPlanStore,
  TaskStore,
  createTaskStore,
  RuntimeEventEmitter,
  RuntimeEventStore,
  createEventStore,
  RUN_STATUS,
} from '../agent/skill.js';

// ═══════════════════════════════════════════════════════════
// Test 1: State Source of Truth
// ═══════════════════════════════════════════════════════════

test('State: ExecutionEngine does NOT duplicate Run state', () => {
  const engine = createExecutionEngine();

  // Engine should have a RunStore, not a runs Map
  assert.ok(engine.runStore, 'should have runStore');
  assert.ok(!(engine.runs instanceof Map), 'should NOT have runs Map');

  // Create a run
  const created = engine.createRun({ goal: 'test' });
  assert.ok(created.success);

  // State should be in RunStore only
  const fromStore = engine.runStore.get(created.run.id);
  assert.ok(fromStore);
  assert.strictEqual(fromStore.goal, 'test');

  // Engine.runs should not exist
  assert.strictEqual(engine.runs, undefined);
});

test('State: ExecutionEngine does NOT duplicate Task state', () => {
  const engine = createExecutionEngine();
  assert.ok(engine.taskStore, 'should have taskStore');
  assert.ok(!(engine.tasks instanceof Map), 'should NOT have tasks Map');

  const created = engine.createRun({ goal: 'test' });
  engine.addTask(created.run.id, { goal: 'task 1' });

  const fromStore = engine.taskStore.listByRun(created.run.id);
  assert.strictEqual(fromStore.length, 1);
  assert.strictEqual(engine.tasks, undefined);
});

test('State: ExecutionEngine does NOT duplicate Plan state', () => {
  const engine = createExecutionEngine();
  assert.ok(engine.planStore, 'should have planStore');
  assert.ok(!(engine.plans instanceof Map), 'should NOT have plans Map');

  assert.strictEqual(engine.plans, undefined);
});

// ═══════════════════════════════════════════════════════════
// Test 2: State Consistency Verification
// ═══════════════════════════════════════════════════════════

test('Consistency: verifyConsistency detects matching state', () => {
  const emitter = new RuntimeEventEmitter();
  const store = createEventStore();
  emitter.setStore(store);
  const engine = createExecutionEngine({ emitter, eventStore: store });

  const created = engine.createRun({ goal: 'test', runId: 'run-consist' });
  engine.startRun(created.run.id);
  engine.addTask(created.run.id, { goal: 'task 1' });
  engine.completeRun(created.run.id);

  const result = engine.verifyConsistency('run-consist');
  assert.ok(result.consistent);
  assert.strictEqual(result.issues.length, 0);
});

test('Consistency: verifyConsistency detects status mismatch', () => {
  const emitter = new RuntimeEventEmitter();
  const store = createEventStore();
  emitter.setStore(store);
  const engine = createExecutionEngine({ emitter, eventStore: store });

  const created = engine.createRun({ goal: 'test', runId: 'run-mismatch' });
  engine.startRun(created.run.id);

  // Manually corrupt store state
  engine.runStore.update(created.run.id, { status: 'completed' });

  const result = engine.verifyConsistency('run-mismatch');
  assert.ok(!result.consistent);
  assert.ok(result.issues.length > 0);
  assert.ok(result.issues.some(i => i.type === 'status_mismatch'));
});

// ═══════════════════════════════════════════════════════════
// Test 3: Store Serialization / Restore
// ═══════════════════════════════════════════════════════════

test('Store: RunStore serialize/restore round trip', () => {
  const store = createRunStore();
  store.create({ runId: 'run-1', goal: 'test 1' });
  store.create({ runId: 'run-2', goal: 'test 2' });

  const serialized = store.serialize();
  assert.ok(serialized['run-1']);
  assert.ok(serialized['run-2']);

  const store2 = createRunStore();
  const result = store2.restore(serialized);
  assert.ok(result.success);
  assert.strictEqual(result.restored, 2);
  assert.strictEqual(store2.get('run-1').goal, 'test 1');
  assert.strictEqual(store2.get('run-2').goal, 'test 2');
});

test('Store: TaskStore serialize/restore round trip', () => {
  const store = createTaskStore();
  store.create({
    id: 'task-1',
    runId: 'run-1',
    goal: 'task 1',
    status: 'pending',
  });

  const serialized = store.serialize();
  assert.ok(serialized['task-1']);

  const store2 = createTaskStore();
  store2.restore(serialized);
  const restored = store2.get('task-1');
  assert.ok(restored);
  assert.strictEqual(restored.goal, 'task 1');
});

test('Store: PlanStore serialize/restore round trip', () => {
  const store = createPlanStore();
  store.create({
    id: 'plan-1',
    runId: 'run-1',
    goal: 'test',
    status: 'draft',
    tasks: [],
  });

  const serialized = store.serialize();
  assert.ok(serialized['plan-1']);

  const store2 = createPlanStore();
  store2.restore(serialized);
  const restored = store2.get('plan-1');
  assert.ok(restored);
  assert.strictEqual(restored.goal, 'test');
});

// ═══════════════════════════════════════════════════════════
// Test 4: No Circular Dependencies
// ═══════════════════════════════════════════════════════════

test('Dependency: Managers do NOT receive engine:this', () => {
  const engine = createExecutionEngine();

  // Verify RunManager does not have engine reference
  assert.strictEqual(engine.runMgr.engine, undefined);

  // Verify RecoveryManager does not have engine reference
  assert.strictEqual(engine.recoveryMgr.engine, undefined);

  // Verify TaskExecutor does not have engine reference
  assert.strictEqual(engine.taskExecutor.engine, undefined);
});

test('Dependency: Managers receive explicit Store dependencies', () => {
  const engine = createExecutionEngine();

  assert.ok(engine.runMgr.runStore);
  assert.ok(engine.runMgr.workspaceStore);
  assert.ok(engine.taskExecutor.taskStore);
  assert.ok(engine.recoveryMgr.runStore);
  assert.ok(engine.recoveryMgr.taskStore);
  assert.ok(engine.recoveryMgr.workspaceStore);
});

// ═══════════════════════════════════════════════════════════
// Test 5: Full State Ownership Flow
// ═══════════════════════════════════════════════════════════

test('Ownership: full lifecycle state is in Store only', () => {
  const emitter = new RuntimeEventEmitter();
  const store = createEventStore();
  emitter.setStore(store);
  const engine = createExecutionEngine({ emitter, eventStore: store });

  // Create run
  const created = engine.createRun({ goal: 'test', runId: 'run-own' });
  assert.ok(engine.runStore.get(created.run.id));

  // Start run
  engine.startRun(created.run.id);
  assert.strictEqual(engine.runStore.get(created.run.id).status, RUN_STATUS.STARTED);

  // Add task
  engine.addTask(created.run.id, { goal: 'task 1' });
  assert.strictEqual(engine.taskStore.listByRun(created.run.id).length, 1);

  // Complete run
  engine.completeRun(created.run.id);
  assert.strictEqual(engine.runStore.get(created.run.id).status, RUN_STATUS.COMPLETED);

  // Verify no duplicate state in engine
  assert.strictEqual(engine.runs, undefined);
  assert.strictEqual(engine.tasks, undefined);
  assert.strictEqual(engine.plans, undefined);
});

// ═══════════════════════════════════════════════════════════
// Test 6: Relationship Integrity
// ═══════════════════════════════════════════════════════════

test('Integrity: detects Run references missing Plan', () => {
  const engine = createExecutionEngine();
  const created = engine.createRun({ goal: 'test', runId: 'run-rel1' });

  // Manually corrupt: set planId to non-existent plan
  engine.runStore.update(created.run.id, { planId: 'plan-nonexistent' });

  const result = engine.verifyConsistency('run-rel1');
  assert.ok(!result.consistent);
  assert.ok(result.issues.some(i => i.type === 'missing_plan'));
});

test('Integrity: detects Run references missing Task', () => {
  const engine = createExecutionEngine();
  const created = engine.createRun({ goal: 'test', runId: 'run-rel2' });

  // Manually corrupt: add non-existent task ID
  engine.runStore.update(created.run.id, { taskIds: ['task-nonexistent'] });

  const result = engine.verifyConsistency('run-rel2');
  assert.ok(!result.consistent);
  assert.ok(result.issues.some(i => i.type === 'missing_task'));
});

test('Integrity: detects Task references missing Run', () => {
  const engine = createExecutionEngine();
  const created = engine.createRun({ goal: 'test', runId: 'run-rel3' });

  // Create a task with wrong runId and add to run's taskIds
  engine.taskStore.create({
    id: 'task-orphan',
    runId: 'run-nonexistent',
    goal: 'orphan task',
    status: 'pending',
  });
  // Add to run so it gets checked
  engine.runStore.update(created.run.id, { taskIds: ['task-orphan'] });

  const result = engine.verifyConsistency('run-rel3');
  assert.ok(result.issues.some(i => i.type === 'missing_run' && i.entity === 'task'));
});

test('Integrity: detects Workspace references missing Run', () => {
  const engine = createExecutionEngine();
  const created = engine.createRun({ goal: 'test', runId: 'run-rel4' });

  // Manually corrupt workspace runIds
  engine.workspaceStore.update(created.run.workspaceId, {
    runIds: ['run-nonexistent'],
  });

  const result = engine.verifyConsistency('run-rel4');
  assert.ok(!result.consistent);
  assert.ok(result.issues.some(i => i.type === 'missing_run' && i.entity === 'workspace'));
});

test('Integrity: valid state passes consistency check', () => {
  const emitter = new RuntimeEventEmitter();
  const store = createEventStore();
  emitter.setStore(store);
  const engine = createExecutionEngine({ emitter, eventStore: store });

  const created = engine.createRun({ goal: 'test', runId: 'run-valid' });
  engine.startRun(created.run.id);
  engine.addTask(created.run.id, { goal: 'task 1' });
  engine.completeRun(created.run.id);

  const result = engine.verifyConsistency('run-valid');
  assert.ok(result.consistent);
  assert.strictEqual(result.issues.length, 0);
});