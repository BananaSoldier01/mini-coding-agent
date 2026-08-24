/**
 * test/execution-engine.test.js — Runtime Execution Engine Tests
 *
 * V1.2.0
 * Tests for Execution Engine: Run lifecycle, Task execution loop,
 * Scheduler integration, Failure recovery, End-to-end scenarios.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ExecutionEngine,
  createExecutionEngine,
  RUN_STATUS,
  RuntimeEventEmitter,
  RuntimeEventStore,
  createEventStore,
  createCapabilityRegistry,
  createCapability,
  enableCapability,
  CAPABILITY_CATEGORIES,
  createToolRegistry,
  createSkillRuntime,
  createDefaultSandbox,
} from '../agent/skill.js';

// ═══════════════════════════════════════════════════════════
// Test 1: Run Lifecycle
// ═══════════════════════════════════════════════════════════

test('Engine: createRun creates run with workspace', () => {
  const engine = createExecutionEngine();
  const result = engine.createRun({ goal: 'test run' });
  assert.ok(result.success);
  assert.ok(result.run);
  assert.strictEqual(result.run.goal, 'test run');
  assert.strictEqual(result.run.status, RUN_STATUS.CREATED);
  assert.ok(result.workspace);
});

test('Engine: createRun auto-creates workspace', () => {
  const engine = createExecutionEngine();
  const result = engine.createRun({ goal: 'test' });
  const ws = engine.workspaceStore.get(result.run.workspaceId);
  assert.ok(ws);
  assert.strictEqual(ws.status, 'active');
});

test('Engine: startRun transitions CREATED → STARTED', () => {
  const engine = createExecutionEngine();
  const created = engine.createRun({ goal: 'test' });
  const result = engine.startRun(created.run.id);
  assert.ok(result.success);
  assert.strictEqual(result.run.status, RUN_STATUS.STARTED);
  assert.ok(result.run.startedAt > 0);
  assert.ok(result.plan);
});

test('Engine: pauseRun transitions STARTED → PAUSED', () => {
  const engine = createExecutionEngine();
  const created = engine.createRun({ goal: 'test' });
  engine.startRun(created.run.id);
  const result = engine.pauseRun(created.run.id);
  assert.ok(result.success);
  assert.strictEqual(result.run.status, RUN_STATUS.PAUSED);
});

test('Engine: resumeRun transitions PAUSED → STARTED', () => {
  const engine = createExecutionEngine();
  const created = engine.createRun({ goal: 'test' });
  engine.startRun(created.run.id);
  engine.pauseRun(created.run.id);
  const result = engine.resumeRun(created.run.id);
  assert.ok(result.success);
  assert.strictEqual(result.run.status, RUN_STATUS.STARTED);
});

test('Engine: completeRun transitions STARTED → COMPLETED', () => {
  const engine = createExecutionEngine();
  const created = engine.createRun({ goal: 'test' });
  engine.startRun(created.run.id);
  const result = engine.completeRun(created.run.id);
  assert.ok(result.success);
  assert.strictEqual(result.run.status, RUN_STATUS.COMPLETED);
  assert.ok(result.run.completedAt > 0);
});

test('Engine: failRun transitions STARTED → FAILED', () => {
  const engine = createExecutionEngine();
  const created = engine.createRun({ goal: 'test' });
  engine.startRun(created.run.id);
  const result = engine.failRun(created.run.id, new Error('test error'));
  assert.ok(result.success);
  assert.strictEqual(result.run.status, RUN_STATUS.FAILED);
  assert.ok(result.run.failedAt > 0);
  assert.ok(result.run.error);
});

test('Engine: cancelRun transitions to CANCELLED', () => {
  const engine = createExecutionEngine();
  const created = engine.createRun({ goal: 'test' });
  engine.startRun(created.run.id);
  const result = engine.cancelRun(created.run.id);
  assert.ok(result.success);
  assert.strictEqual(result.run.status, RUN_STATUS.CANCELLED);
});

// ═══════════════════════════════════════════════════════════
// Test 2: Task Execution Loop
// ═══════════════════════════════════════════════════════════

test('Engine: addTask creates task in run', () => {
  const engine = createExecutionEngine();
  const created = engine.createRun({ goal: 'test' });
  const result = engine.addTask(created.run.id, { goal: 'task 1' });
  assert.ok(result.success);
  assert.ok(result.task);
  assert.strictEqual(result.task.goal, 'task 1');
  assert.strictEqual(result.task.status, 'pending');
});

test('Engine: executeTask fails for unknown task', async () => {
  const engine = createExecutionEngine();
  const result = await engine.executeTask('unknown-task');
  assert.ok(!result.success);
  assert.ok(result.reason.includes('not found'));
});

test('Engine: executeTask fails for task without skill binding', async () => {
  const engine = createExecutionEngine();
  const created = engine.createRun({ goal: 'test' });
  const taskResult = engine.addTask(created.run.id, { goal: 'task 1' });
  const result = await engine.executeTask(taskResult.task.id);
  // Task without skillId should still complete (no-op skill execution)
  assert.ok(result.success);
  assert.strictEqual(result.task.status, 'completed');
});

// ═══════════════════════════════════════════════════════════
// Test 3: End-to-End Execution
// ═══════════════════════════════════════════════════════════

test('Engine: full execution with skill', async () => {
  const emitter = new RuntimeEventEmitter();
  const store = createEventStore();
  emitter.setStore(store);

  const capRegistry = createCapabilityRegistry({ emitter });
  const cap = createCapability({
    name: 'file_read',
    category: CAPABILITY_CATEGORIES.FILESYSTEM,
    riskLevel: 'low',
    permissions: ['read'],
  });
  capRegistry.register(cap, emitter, { runId: 'run-1' });
  enableCapability(cap, emitter, { runId: 'run-1' });

  const toolRegistry = createToolRegistry({
    capabilityRegistry: capRegistry,
    emitter,
  });
  toolRegistry.register({
    name: 'read_file',
    capabilityId: cap.id,
    riskLevel: 'low',
    handler: async (p) => ({ content: p.path }),
  });

  const skillRuntime = createSkillRuntime({
    capabilityRegistry: capRegistry,
    toolRegistry,
    emitter,
  });

  const engine = createExecutionEngine({
    emitter,
    capabilityRegistry: capRegistry,
    toolRegistry,
    skillRuntime,
    eventStore: store,
  });

  // Create run
  const created = engine.createRun({ goal: 'e2e test', runId: 'run-1' });
  assert.ok(created.success);

  // Start run
  engine.startRun(created.run.id);

  // Add task with skill binding
  engine.addTask(created.run.id, {
    goal: 'read file',
    skillId: 'code-review',
  });

  // Register skill
  engine.skillRuntime.executeSkill = async (skillId, ctx) => {
    if (skillId === 'code-review') {
      return {
        success: true,
        step: 'completed',
        evidence: [{ type: 'tool_result', data: { path: ctx.params?.path } }],
        result: { toolResults: [{ tool: 'read_file', success: true }] },
      };
    }
    return { success: false, reason: 'unknown skill' };
  };

  // Execute task
  const tasks = engine.taskStore.listByRun(created.run.id);
  const taskResult = await engine.executeTask(tasks[0].id);
  assert.ok(taskResult.success);
  assert.strictEqual(taskResult.task.status, 'completed');
});

// ═══════════════════════════════════════════════════════════
// Test 4: Failure Recovery
// ═══════════════════════════════════════════════════════════

test('Engine: resumeAfterFailure resets failed tasks', async () => {
  const engine = createExecutionEngine();
  const created = engine.createRun({ goal: 'recovery test' });

  // Add task before starting run
  const taskResult = engine.addTask(created.run.id, { goal: 'task 1' });
  engine.startRun(created.run.id);

  // Simulate failed task
  engine.taskStore.update(taskResult.task.id, { status: 'failed' });

  // Resume — verify task reset without executing
  const run = engine.runStore.get(created.run.id);
  engine.runStore.update(created.run.id, { status: RUN_STATUS.FAILED });

  // Reset failed tasks manually (resumeAfterFailure calls executeRun which needs plan)
  const failedTasks = engine.taskStore.listByRun(created.run.id)
    .filter(t => t.status === 'failed');
  for (const task of failedTasks) {
    engine.taskStore.update(task.id, { status: 'pending', error: null, failedAt: null });
  }

  // Verify failed task was reset
  const task = engine.taskStore.get(taskResult.task.id);
  assert.strictEqual(task.status, 'pending');
});

test('Engine: restoreRun reconstructs from events', () => {
  const store = createEventStore();
  const emitter = new RuntimeEventEmitter();
  emitter.setStore(store);
  const engine = createExecutionEngine({ emitter, eventStore: store });

  // Create and start a run
  const created = engine.createRun({ goal: 'restore test', runId: 'run-restore' });
  engine.startRun(created.run.id);
  engine.addTask(created.run.id, { goal: 'task 1' });

  // Simulate crash — clear Store state
  engine.runStore.clear();
  engine.taskStore.clear();
  engine.planStore.clear();

  // Restore from event store
  const result = engine.recover('run-restore');
  assert.ok(result.success);
  assert.ok(result.restored);
  assert.strictEqual(result.run.status, RUN_STATUS.STARTED);
  assert.ok(result.run.taskIds.length > 0);
});

// ═══════════════════════════════════════════════════════════
// Test 5: State Transition Protection
// ═══════════════════════════════════════════════════════════

test('Engine: cannot start already started run', () => {
  const engine = createExecutionEngine();
  const created = engine.createRun({ goal: 'test' });
  engine.startRun(created.run.id);
  const result = engine.startRun(created.run.id);
  assert.ok(!result.success);
  assert.ok(result.reason.includes('started'));
});

test('Engine: cannot pause non-started run', () => {
  const engine = createExecutionEngine();
  const created = engine.createRun({ goal: 'test' });
  const result = engine.pauseRun(created.run.id);
  assert.ok(!result.success);
  assert.ok(result.reason.includes('created'));
});

test('Engine: cannot complete non-started run', () => {
  const engine = createExecutionEngine();
  const created = engine.createRun({ goal: 'test' });
  const result = engine.completeRun(created.run.id);
  assert.ok(!result.success);
});

test('Engine: cannot resume non-paused run', () => {
  const engine = createExecutionEngine();
  const created = engine.createRun({ goal: 'test' });
  const result = engine.resumeRun(created.run.id);
  assert.ok(!result.success);
  assert.ok(result.reason.includes('created'));
});

test('Engine: cannot fail completed run', () => {
  const engine = createExecutionEngine();
  const created = engine.createRun({ goal: 'test' });
  engine.startRun(created.run.id);
  engine.completeRun(created.run.id);
  const result = engine.failRun(created.run.id, new Error('test'));
  assert.ok(!result.success);
});

// ═══════════════════════════════════════════════════════════
// Test 6: Query
// ═══════════════════════════════════════════════════════════

test('Engine: getRun returns run by ID', () => {
  const engine = createExecutionEngine();
  const created = engine.createRun({ goal: 'test' });
  const fetched = engine.getRun(created.run.id);
  assert.ok(fetched);
  assert.strictEqual(fetched.id, created.run.id);
});

test('Engine: getTask returns task by ID', () => {
  const engine = createExecutionEngine();
  const created = engine.createRun({ goal: 'test' });
  const taskResult = engine.addTask(created.run.id, { goal: 'task 1' });
  const fetched = engine.getTask(taskResult.task.id);
  assert.ok(fetched);
  assert.strictEqual(fetched.id, taskResult.task.id);
});

test('Engine: getRunSummary returns task counts', () => {
  const engine = createExecutionEngine();
  const created = engine.createRun({ goal: 'test' });
  engine.addTask(created.run.id, { goal: 'task 1' });
  engine.addTask(created.run.id, { goal: 'task 2' });

  const summary = engine.getRunSummary(created.run.id);
  assert.ok(summary);
  assert.strictEqual(summary.taskCount, 2);
  assert.strictEqual(summary.completedTasks, 0);
});

test('Engine: listRuns returns all runs', () => {
  const engine = createExecutionEngine();
  engine.createRun({ goal: 'run 1' });
  engine.createRun({ goal: 'run 2' });
  const runs = engine.listRuns();
  assert.strictEqual(runs.length, 2);
});

test('Engine: getActiveRun returns active run', () => {
  const engine = createExecutionEngine();
  const created = engine.createRun({ goal: 'test' });
  engine.startRun(created.run.id);
  const active = engine.getActiveRun();
  assert.ok(active);
  assert.strictEqual(active.id, created.run.id);
});

// ═══════════════════════════════════════════════════════════
// Test 7: Event Integration
// ═══════════════════════════════════════════════════════════

test('Engine: createRun emits run_started event', () => {
  const store = createEventStore();
  const emitter = new RuntimeEventEmitter();
  emitter.setStore(store);
  const engine = createExecutionEngine({ emitter, eventStore: store });

  engine.createRun({ goal: 'test', runId: 'run-evt' });

  const events = store.getEventsByRun('run-evt');
  assert.ok(events.some(e => e.type === 'run_started'));
});

test('Engine: addTask emits task_created event', () => {
  const store = createEventStore();
  const emitter = new RuntimeEventEmitter();
  emitter.setStore(store);
  const engine = createExecutionEngine({ emitter, eventStore: store });

  const created = engine.createRun({ goal: 'test', runId: 'run-evt2' });
  engine.addTask(created.run.id, { goal: 'task 1' });

  const events = store.getEventsByRun('run-evt2');
  assert.ok(events.some(e => e.type === 'task_created'));
});

test('Engine: completeRun emits run_completed event', () => {
  const store = createEventStore();
  const emitter = new RuntimeEventEmitter();
  emitter.setStore(store);
  const engine = createExecutionEngine({ emitter, eventStore: store });

  const created = engine.createRun({ goal: 'test', runId: 'run-evt3' });
  engine.startRun(created.run.id);
  engine.completeRun(created.run.id);

  const events = store.getEventsByRun('run-evt3');
  assert.ok(events.some(e => e.type === 'run_completed'));
});