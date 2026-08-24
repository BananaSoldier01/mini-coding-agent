/**
 * test/scheduler-recovery.test.js — Runtime Scheduler & Recovery Foundation Tests
 *
 * V0.9.4
 * Tests for TaskScheduler, ExecutionCoordinator, RuntimeRecoveryManager.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  TaskScheduler,
  createScheduler,
  ExecutionCoordinator,
  createExecutionCoordinator,
  RuntimeRecoveryManager,
  createRuntimeRecoveryManager,
  createPlan,
  approvePlan,
  startPlan,
  addTaskDependency,
  createTask,
  startTask,
  completeTask,
  TASK_STATUS,
  PLAN_STATUS,
  ExecutionGate,
  ApprovalPolicy,
  createApprovalPolicy,
  createPolicyContext,
  AgentRuntimeContext,
  RuntimeEventEmitter,
  RuntimeEventLog,
  EvidenceRegistry,
  RUNTIME_EVENT_TYPES,
} from '../agent/skill.js';

// ── Test 1: TaskScheduler ─────────────────────────────────

test('Scheduler: getReadyTasks returns only PENDING tasks with satisfied deps', () => {
  const plan = createPlan('run-1', 'Goal', {
    tasks: [{ id: 't1' }, { id: 't2' }, { id: 't3' }],
  });
  const taskStatus = new Map([
    ['t1', TASK_STATUS.PENDING],
    ['t2', TASK_STATUS.RUNNING],
    ['t3', TASK_STATUS.COMPLETED],
  ]);
  const scheduler = createScheduler(plan, taskStatus, new Map());

  const ready = scheduler.getReadyTasks();
  assert.deepStrictEqual(ready, ['t1']);
});

test('Scheduler: getReadyTasks respects dependencies', () => {
  const plan = createPlan('run-1', 'Goal', {
    tasks: [{ id: 'a' }, { id: 'b' }],
  });
  addTaskDependency(plan, 'a', 'b');

  const taskStatus = new Map([
    ['a', TASK_STATUS.PENDING],
    ['b', TASK_STATUS.PENDING],
  ]);
  const scheduler = createScheduler(plan, taskStatus, new Map());

  // a is ready (no deps), b is blocked by a
  const ready = scheduler.getReadyTasks();
  assert.deepStrictEqual(ready, ['a']);
});

test('Scheduler: getReadyTasks returns empty when all blocked', () => {
  const plan = createPlan('run-1', 'Goal', {
    tasks: [{ id: 'a' }, { id: 'b' }],
  });
  addTaskDependency(plan, 'a', 'b');

  const taskStatus = new Map([
    ['a', TASK_STATUS.RUNNING],
    ['b', TASK_STATUS.PENDING],
  ]);
  const scheduler = createScheduler(plan, taskStatus, new Map());

  const ready = scheduler.getReadyTasks();
  assert.deepStrictEqual(ready, []);
});

test('Scheduler: isTaskReady checks specific task', () => {
  const plan = createPlan('run-1', 'Goal', {
    tasks: [{ id: 't1' }, { id: 't2' }],
  });
  const taskStatus = new Map([
    ['t1', TASK_STATUS.PENDING],
    ['t2', TASK_STATUS.RUNNING],
  ]);
  const scheduler = createScheduler(plan, taskStatus, new Map());

  assert.ok(scheduler.isTaskReady('t1'));
  assert.ok(!scheduler.isTaskReady('t2'));
});

test('Scheduler: selectNextTask returns first ready', () => {
  const plan = createPlan('run-1', 'Goal', {
    tasks: [{ id: 't1' }, { id: 't2' }],
  });
  const taskStatus = new Map([
    ['t1', TASK_STATUS.PENDING],
    ['t2', TASK_STATUS.PENDING],
  ]);
  const scheduler = createScheduler(plan, taskStatus, new Map());

  const next = scheduler.selectNextTask();
  assert.strictEqual(next, 't1');
});

test('Scheduler: selectNextTask returns null when nothing ready', () => {
  const plan = createPlan('run-1', 'Goal', {
    tasks: [{ id: 't1' }],
  });
  const taskStatus = new Map([['t1', TASK_STATUS.COMPLETED]]);
  const scheduler = createScheduler(plan, taskStatus, new Map());

  assert.strictEqual(scheduler.selectNextTask(), null);
});

test('Scheduler: pause prevents scheduling', () => {
  const plan = createPlan('run-1', 'Goal', {
    tasks: [{ id: 't1' }],
  });
  const taskStatus = new Map([['t1', TASK_STATUS.PENDING]]);
  const scheduler = createScheduler(plan, taskStatus, new Map());

  scheduler.pause();
  assert.strictEqual(scheduler.getReadyTasks().length, 0);
  assert.ok(scheduler.isPaused());

  scheduler.resume();
  assert.strictEqual(scheduler.getReadyTasks().length, 1);
  assert.ok(!scheduler.isPaused());
});

test('Scheduler: getSummary returns correct counts', () => {
  const plan = createPlan('run-1', 'Goal', {
    tasks: [{ id: 't1' }, { id: 't2' }, { id: 't3' }],
  });
  const taskStatus = new Map([
    ['t1', TASK_STATUS.COMPLETED],
    ['t2', TASK_STATUS.RUNNING],
    ['t3', TASK_STATUS.PENDING],
  ]);
  const scheduler = createScheduler(plan, taskStatus, new Map());

  const summary = scheduler.getSummary();
  assert.strictEqual(summary.total, 3);
  assert.strictEqual(summary.completed, 1);
  assert.strictEqual(summary.running, 1);
  assert.strictEqual(summary.pending, 1);
  assert.strictEqual(summary.ready, 1);
});

test('Scheduler: updateTaskStatus reflects in scheduling', () => {
  const plan = createPlan('run-1', 'Goal', {
    tasks: [{ id: 't1' }, { id: 't2' }],
  });
  addTaskDependency(plan, 't1', 't2');

  const taskStatus = new Map([
    ['t1', TASK_STATUS.RUNNING],
    ['t2', TASK_STATUS.PENDING],
  ]);
  const scheduler = createScheduler(plan, taskStatus, new Map());
  assert.strictEqual(scheduler.getReadyTasks().length, 0);

  // t1 completes → t2 becomes ready
  scheduler.updateTaskStatus('t1', TASK_STATUS.COMPLETED);
  assert.strictEqual(scheduler.getReadyTasks().length, 1);
  assert.strictEqual(scheduler.getReadyTasks()[0], 't2');
});

// ── Test 2: ExecutionCoordinator ──────────────────────────

test('Coordinator: executeNext returns null when nothing ready', async () => {
  const plan = createPlan('run-1', 'Goal', {
    tasks: [{ id: 't1' }],
  });
  const taskStatus = new Map([['t1', TASK_STATUS.COMPLETED]]);
  const coordinator = createExecutionCoordinator({
    plan,
    taskStatusMap: taskStatus,
  });

  const result = await coordinator.executeNext();
  assert.strictEqual(result, null);
});

test('Coordinator: executeNext returns blocked when approval needed', async () => {
  const plan = createPlan('run-1', 'Goal', {
    tasks: [{ id: 't1', goal: 'Delete file' }],
  });
  const taskStatus = new Map([['t1', TASK_STATUS.PENDING]]);
  const approvalPolicy = createApprovalPolicy();
  const gate = new ExecutionGate();

  const coordinator = createExecutionCoordinator({
    plan,
    taskStatusMap: taskStatus,
    approvalPolicy,
    executionGate: gate,
  });

  const result = await coordinator.executeNext({
    toolName: 'delete_file',
    args: { path: '/test' },
  });

  assert.ok(result.blocked);
  assert.ok(result.approvalRequest);
  assert.strictEqual(result.taskId, 't1');
});

test('Coordinator: executeNext executes when no approval needed', async () => {
  const plan = createPlan('run-1', 'Goal', {
    tasks: [{ id: 't1', goal: 'Read file' }],
  });
  const taskStatus = new Map([['t1', TASK_STATUS.PENDING]]);
  const ctx = new AgentRuntimeContext('run-1');
  const emitter = new RuntimeEventEmitter();

  const coordinator = createExecutionCoordinator({
    plan,
    taskStatusMap: taskStatus,
    runtimeContext: ctx,
    emitter,
    autoApprove: true,
  });

  const result = await coordinator.executeNext({
    toolName: 'read_file',
    args: { path: '/test' },
    execute: () => ({ success: true, result: 'file contents' }),
  });

  assert.ok(!result.blocked);
  assert.strictEqual(result.taskId, 't1');
  assert.ok(result.te);
});

test('Coordinator: getSummary delegates to scheduler', () => {
  const plan = createPlan('run-1', 'Goal', {
    tasks: [{ id: 't1' }],
  });
  const taskStatus = new Map([['t1', TASK_STATUS.PENDING]]);
  const coordinator = createExecutionCoordinator({
    plan,
    taskStatusMap: taskStatus,
  });

  const summary = coordinator.getSummary();
  assert.strictEqual(summary.total, 1);
  assert.strictEqual(summary.ready, 1);
});

test('Coordinator: pause and resume work', () => {
  const plan = createPlan('run-1', 'Goal', {
    tasks: [{ id: 't1' }],
  });
  const taskStatus = new Map([['t1', TASK_STATUS.PENDING]]);
  const coordinator = createExecutionCoordinator({
    plan,
    taskStatusMap: taskStatus,
  });

  coordinator.pause();
  assert.strictEqual(coordinator.getReadyTasks().length, 0);

  coordinator.resume();
  assert.strictEqual(coordinator.getReadyTasks().length, 1);
});

// ── Test 3: RuntimeRecoveryManager ────────────────────────

test('Recovery: restore handles null snapshot', () => {
  const recovery = createRuntimeRecoveryManager();
  const result = recovery.restore(null);
  assert.ok(!result.restored);
  assert.ok(result.issues.length > 0);
});

test('Recovery: restore recovers plan from snapshot', () => {
  const plan = createPlan('run-1', 'Goal');
  approvePlan(plan);
  startPlan(plan);

  const snapshot = {
    id: 'snap-1',
    runId: 'run-1',
    timestamp: Date.now(),
    version: '2',
    plan: {
      id: plan.id,
      runId: plan.runId,
      goal: plan.goal,
      status: plan.status,
      tasks: [],
      dependencies: [],
      evidenceRefs: [],
      createdAt: plan.createdAt,
      updatedAt: plan.updatedAt,
    },
  };

  const recovery = createRuntimeRecoveryManager();
  const result = recovery.restore(snapshot);

  assert.ok(result.restored);
  assert.ok(result.plan);
  assert.strictEqual(result.plan.status, PLAN_STATUS.EXECUTING);
  assert.ok(result.actions.some(a => a.type === 'plan_restored'));
});

test('Recovery: restore recovers task statuses', () => {
  const plan = createPlan('run-1', 'Goal', {
    tasks: [{ id: 't1' }, { id: 't2' }],
  });

  const snapshot = {
    id: 'snap-1',
    runId: 'run-1',
    timestamp: Date.now(),
    version: '2',
    plan: {
      ...plan,
      status: PLAN_STATUS.EXECUTING,
      tasks: [
        { id: 't1', status: TASK_STATUS.COMPLETED, goal: 'Done' },
        { id: 't2', status: TASK_STATUS.RUNNING, goal: 'Running' },
      ],
    },
  };

  const recovery = createRuntimeRecoveryManager();
  const result = recovery.restore(snapshot);

  assert.strictEqual(result.taskStatusMap.get('t1'), TASK_STATUS.COMPLETED);
  assert.strictEqual(result.taskStatusMap.get('t2'), TASK_STATUS.RUNNING);
});

test('Recovery: autoResetRunning resets running tasks to pending', () => {
  const plan = createPlan('run-1', 'Goal', {
    tasks: [{ id: 't1' }],
  });

  const snapshot = {
    id: 'snap-1',
    runId: 'run-1',
    timestamp: Date.now(),
    version: '2',
    plan: {
      ...plan,
      status: PLAN_STATUS.EXECUTING,
      tasks: [{ id: 't1', status: TASK_STATUS.RUNNING }],
    },
  };

  const recovery = createRuntimeRecoveryManager({ autoResetRunning: true });
  const result = recovery.restore(snapshot);

  assert.strictEqual(result.taskStatusMap.get('t1'), TASK_STATUS.PENDING);
  assert.ok(result.actions.some(a => a.type === 'task_reset'));
});

test('Recovery: validateConsistency detects plan_task_mismatch', () => {
  const recovery = createRuntimeRecoveryManager();

  const snapshot = {
    id: 'snap-1',
    runId: 'run-1',
    timestamp: Date.now(),
    version: '2',
    plan: {
      id: 'p1',
      status: 'completed',
      tasks: [
        { id: 't1', status: TASK_STATUS.COMPLETED },
        { id: 't2', status: TASK_STATUS.PENDING },
      ],
    },
  };

  const recoveryResult = {
    plan: { status: 'completed', tasks: [{ id: 't1' }, { id: 't2' }] },
    taskStatusMap: new Map([
      ['t1', TASK_STATUS.COMPLETED],
      ['t2', TASK_STATUS.PENDING],
    ]),
  };

  const validation = recovery.validateConsistency(snapshot, recoveryResult);
  assert.ok(validation.issues.length > 0);
  assert.strictEqual(validation.issues[0].type, 'plan_task_mismatch');
});

test('Recovery: recoverPendingTasks returns only pending', () => {
  const recovery = createRuntimeRecoveryManager();
  const taskStatusMap = new Map([
    ['t1', TASK_STATUS.PENDING],
    ['t2', TASK_STATUS.COMPLETED],
    ['t3', TASK_STATUS.PENDING],
  ]);

  const pending = recovery.recoverPendingTasks(taskStatusMap);
  assert.deepStrictEqual(pending.sort(), ['t1', 't3']);
});

test('Recovery: canAutoContinue returns false when plan failed', () => {
  const recovery = createRuntimeRecoveryManager();
  const recoveryResult = {
    plan: { status: 'failed' },
  };

  assert.ok(!recovery.canAutoContinue(recoveryResult));
});

test('Recovery: canAutoContinue returns true when plan executing', () => {
  const recovery = createRuntimeRecoveryManager();
  const recoveryResult = {
    plan: { status: PLAN_STATUS.EXECUTING },
  };

  assert.ok(recovery.canAutoContinue(recoveryResult));
});

test('Recovery: recovery event emitted on restore', () => {
  const emitter = new RuntimeEventEmitter();
  const events = [];
  emitter.onAll((ev) => events.push(ev));

  const plan = createPlan('run-1', 'Goal');
  const snapshot = {
    id: 'snap-1',
    runId: 'run-1',
    timestamp: Date.now(),
    version: '2',
    plan: { ...plan, tasks: [] },
  };

  const recovery = createRuntimeRecoveryManager({ emitter });
  recovery.restore(snapshot);

  const types = events.map(e => e.type);
  assert.ok(types.includes(RUNTIME_EVENT_TYPES.RUNTIME_RESTORED));
});

// ── Test 4: System Invariants ─────────────────────────────

test('INVARIANT: scheduler does not execute tools', () => {
  const plan = createPlan('run-1', 'Goal', {
    tasks: [{ id: 't1' }],
  });
  const taskStatus = new Map([['t1', TASK_STATUS.PENDING]]);
  const scheduler = createScheduler(plan, taskStatus, new Map());

  // Scheduler only returns task IDs — no tool execution
  const ready = scheduler.getReadyTasks();
  assert.strictEqual(ready.length, 1);
  assert.strictEqual(typeof ready[0], 'string');
  // No tool execution happened
  assert.strictEqual(scheduler.scheduledCount, 0);
});

test('INVARIANT: recovery does not auto-approve pending requests', () => {
  const recovery = createRuntimeRecoveryManager();
  const approvalStatusMap = new Map([
    ['t1', 'pending'],
    ['t2', 'approved'],
  ]);

  const pending = recovery.recoverPendingApprovals(approvalStatusMap);
  assert.deepStrictEqual(pending, ['t1']);
  // No auto-approval happened — t1 stays pending
  assert.strictEqual(approvalStatusMap.get('t1'), 'pending');
});

test('INVARIANT: coordinator delegates execution to ToolExecution', async () => {
  const plan = createPlan('run-1', 'Goal', {
    tasks: [{ id: 't1', goal: 'Read file' }],
  });
  const taskStatus = new Map([['t1', TASK_STATUS.PENDING]]);
  const ctx = new AgentRuntimeContext('run-1');
  const emitter = new RuntimeEventEmitter();

  const coordinator = createExecutionCoordinator({
    plan,
    taskStatusMap: taskStatus,
    runtimeContext: ctx,
    emitter,
    autoApprove: true,
  });

  const result = await coordinator.executeNext({
    toolName: 'read_file',
    args: { path: '/test' },
    execute: () => ({ success: true, result: 'contents' }),
  });

  // ToolExecution should be created in runtime context
  const toolExecs = ctx.listToolExecutions();
  assert.strictEqual(toolExecs.length, 1);
  assert.strictEqual(toolExecs[0].toolName, 'read_file');
});

test('INVARIANT: full flow — Plan → Scheduler → Approval → Execution → Evidence → Snapshot → Recovery', async () => {
  const emitter = new RuntimeEventEmitter();
  const eventLog = new RuntimeEventLog();
  emitter.onAll((ev) => eventLog.record(ev));

  const evidence = new EvidenceRegistry();
  const ctx = new AgentRuntimeContext('run-1', { evidence });

  // 1. Create Plan
  const plan = createPlan('run-1', 'Read and verify', {
    tasks: [{ id: 't1', goal: 'Read file' }],
  });
  approvePlan(plan, emitter);
  startPlan(plan, emitter);

  // 2. Setup Scheduler
  const taskStatus = new Map([['t1', TASK_STATUS.PENDING]]);
  const scheduler = createScheduler(plan, taskStatus, new Map());
  assert.strictEqual(scheduler.getReadyTasks().length, 1);

  // 3. Execute via Coordinator
  const coordinator = createExecutionCoordinator({
    plan,
    taskStatusMap: taskStatus,
    runtimeContext: ctx,
    emitter,
    evidenceRegistry: evidence,
    autoApprove: true,
  });

  const result = await coordinator.executeNext({
    toolName: 'read_file',
    args: { path: '/test' },
    execute: () => ({ success: true, result: 'file contents' }),
  });

  assert.ok(result);
  assert.strictEqual(result.taskId, 't1');

  // 4. Create Snapshot
  const { createSnapshotV2 } = await import('../agent/skill.js');
  const snapshot = createSnapshotV2('run-1', ctx, plan, evidence, eventLog, 'executing');
  assert.strictEqual(snapshot.version, '2');
  assert.ok(snapshot.plan);

  // 5. Recovery
  const recovery = createRuntimeRecoveryManager({ emitter });
  const recoveryResult = recovery.restore(snapshot);
  assert.ok(recoveryResult.restored);
  assert.ok(recoveryResult.plan);
});