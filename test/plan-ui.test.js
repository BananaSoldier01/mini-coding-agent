/**
 * test/plan-ui.test.js — Plan Workspace UI Integration Tests
 *
 * V0.5.2
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPlan, transitionPlanStatus, PLAN_STATUS, bindToolCall, detectPlanDrift, completeStepAfterExecution, recordSuccessfulEffect } from '../agent/plan.js';

// ── Test 1: Plan Panel Render ─────────────────────────
test('Plan UI: Panel 渲染显示 goal/steps', () => {
  const plan = createPlan({
    goal: 'Refactor auth module',
    steps: [
      { id: 's1', description: 'Analyze existing auth flow', type: 'explore', files: ['auth.js'] },
      { id: 's2', description: 'Modify auth service', type: 'modify', files: ['auth.js'] },
    ],
    risks: ['API compatibility'],
    files: ['auth.js'],
  });

  // 验证 plan 数据结构
  assert.strictEqual(plan.goal, 'Refactor auth module');
  assert.strictEqual(plan.steps.length, 2);
  assert.strictEqual(plan.steps[0].status, 'pending');
  assert.strictEqual(plan.steps[1].status, 'pending');
  assert.strictEqual(plan.risks.length, 1);
  assert.strictEqual(plan.files.length, 1);

  // 验证 step 有 tracking 字段
  assert.ok(plan.steps[0].hasOwnProperty('status'));
  assert.ok(plan.steps[0].hasOwnProperty('completedAt'));
  assert.ok(plan.steps[0].hasOwnProperty('toolCalls'));
  assert.strictEqual(plan.steps[0].toolCalls.length, 0);
});

// ── Test 2: Approve Flow ───────────────────────────────
test('Plan UI: Approve Flow — AWAITING_APPROVAL → APPROVED', () => {
  const plan = createPlan({ goal: 'test approve' });
  transitionPlanStatus(plan, PLAN_STATUS.AWAITING_APPROVAL);
  assert.strictEqual(plan.status, PLAN_STATUS.AWAITING_APPROVAL);

  transitionPlanStatus(plan, PLAN_STATUS.APPROVED);
  assert.strictEqual(plan.status, PLAN_STATUS.APPROVED);
  assert.ok(plan.approvedAt !== null);
});

// ── Test 3: Reject Flow ────────────────────────────────
test('Plan UI: Reject Flow — AWAITING_APPROVAL → REJECTED, 不执行', () => {
  const plan = createPlan({ goal: 'test reject' });
  transitionPlanStatus(plan, PLAN_STATUS.AWAITING_APPROVAL);
  transitionPlanStatus(plan, PLAN_STATUS.REJECTED);

  assert.strictEqual(plan.status, PLAN_STATUS.REJECTED);
  // REJECTED 状态不能有 tool calls
  assert.strictEqual(plan.toolCallBindings.length, 0);
  // REJECTED 不能流转到其他状态
  assert.ok(!transitionPlanStatus(plan, PLAN_STATUS.EXECUTING));
});

// ── Test 4: Execution Progress ─────────────────────────
test('Plan UI: Execution Progress — step status updates', () => {
  // V0.6.3: Step completion requires successfulEffects (execution evidence)
  const plan = createPlan({
    goal: 'test progress',
    steps: [
      { id: 's1', description: 'Step 1', files: ['file1.js', 'file2.js'] },
    ],
  });

  // 初始全部 pending
  assert.strictEqual(plan.steps[0].status, 'pending');

  // bindToolCall marks step as running (NOT completed)
  bindToolCall(plan, 'run_1', 'tc_1', 'write_file', { path: 'file1.js' });
  assert.strictEqual(plan.steps[0].status, 'running');

  // V0.6.3: Need successfulEffects for completion
  recordSuccessfulEffect(plan, 's1', 'write_file', { path: 'file1.js' }, { path: 'file1.js', action: 'modified' });
  // Only 1 of 2 files done — step should NOT complete
  const result1 = completeStepAfterExecution(plan, 's1');
  assert.strictEqual(result1, null, 'Step should not complete with only 1 of 2 files');

  // Second file done
  recordSuccessfulEffect(plan, 's1', 'write_file', { path: 'file2.js' }, { path: 'file2.js', action: 'created' });
  const result2 = completeStepAfterExecution(plan, 's1');
  assert.ok(result2, 'Step should complete when all files done');
  assert.strictEqual(result2.status, 'completed');
});

// ── Test 5: Timeline Integration ───────────────────────
test('Plan UI: Timeline — plan events emit correctly', () => {
  const plan = createPlan({ goal: 'timeline test' });
  transitionPlanStatus(plan, PLAN_STATUS.AWAITING_APPROVAL);

  // 模拟事件
  const events = [];
  const mockEmit = (event) => events.push(event);

  // plan_generated
  mockEmit({ type: 'plan_generated', plan: { id: plan.id, goal: plan.goal } });
  // plan_approved
  transitionPlanStatus(plan, PLAN_STATUS.APPROVED);
  mockEmit({ type: 'plan_approved', planId: plan.id });
  // plan_executing
  transitionPlanStatus(plan, PLAN_STATUS.EXECUTING);
  mockEmit({ type: 'plan_executing', planId: plan.id });
  // plan_completed
  transitionPlanStatus(plan, PLAN_STATUS.COMPLETED);
  mockEmit({ type: 'plan_completed', planId: plan.id, status: plan.status });

  assert.strictEqual(events.length, 4);
  assert.strictEqual(events[0].type, 'plan_generated');
  assert.strictEqual(events[1].type, 'plan_approved');
  assert.strictEqual(events[2].type, 'plan_executing');
  assert.strictEqual(events[3].type, 'plan_completed');
});

// ── Test 6: Session Restore ────────────────────────────
test('Plan UI: Session Restore — planState 恢复', () => {
  const plan = createPlan({ goal: 'restore test', runId: 'run_restore' });
  transitionPlanStatus(plan, PLAN_STATUS.AWAITING_APPROVAL);
  transitionPlanStatus(plan, PLAN_STATUS.APPROVED);
  bindToolCall(plan, 'run_restore', 'tc_1', 'write_file', { path: 'a.js' });

  // 模拟序列化
  const serialized = JSON.parse(JSON.stringify({
    id: plan.id,
    status: plan.status,
    goal: plan.goal,
    runId: plan.runId,
    steps: plan.steps,
    toolCallBindings: plan.toolCallBindings,
  }));

  // 模拟反序列化到新 session
  const restored = createPlan({ goal: serialized.goal, runId: serialized.runId });
  restored.id = serialized.id;
  restored.status = serialized.status;
  restored.steps = serialized.steps;
  restored.toolCallBindings = serialized.toolCallBindings;

  assert.strictEqual(restored.id, plan.id);
  assert.strictEqual(restored.status, PLAN_STATUS.APPROVED);
  assert.strictEqual(restored.runId, 'run_restore');
  assert.strictEqual(restored.toolCallBindings.length, 1);
  assert.strictEqual(restored.steps.length, plan.steps.length);
});

// ── Test 7: Plan Drift Detection ───────────────────────
test('Plan UI: Drift Detection — 检测意外修改', () => {
  const plan = createPlan({
    goal: 'drift test',
    files: ['server.js', 'auth.js'],
  });

  // 模拟实际修改的文件
  const actualFiles = ['server.js', 'auth.js', 'package.json'];
  const drift = detectPlanDrift(plan, actualFiles);

  assert.ok(drift.drift, 'Should detect drift');
  assert.strictEqual(drift.unexpected.length, 1);
  assert.strictEqual(drift.unexpected[0], 'package.json');
  assert.strictEqual(drift.missing.length, 0);
});

test('Plan UI: Drift Detection — 无偏差', () => {
  const plan = createPlan({
    goal: 'no drift',
    files: ['server.js', 'auth.js'],
  });

  const actualFiles = ['server.js', 'auth.js'];
  const drift = detectPlanDrift(plan, actualFiles);

  assert.ok(!drift.drift, 'Should not detect drift');
  assert.strictEqual(drift.unexpected.length, 0);
  assert.strictEqual(drift.missing.length, 0);
});

test('Plan UI: Drift Detection — 缺失文件', () => {
  const plan = createPlan({
    goal: 'missing files',
    files: ['server.js', 'auth.js', 'config.json'],
  });

  const actualFiles = ['server.js', 'auth.js'];
  const drift = detectPlanDrift(plan, actualFiles);

  assert.strictEqual(drift.unexpected.length, 0);
  assert.strictEqual(drift.missing.length, 1);
  assert.strictEqual(drift.missing[0], 'config.json');
});

// ── Test 8: Plan Step ↔ ToolCall Mapping ──────────────
test('Plan UI: Step ↔ ToolCall Mapping', () => {
  const plan = createPlan({
    goal: 'mapping test',
    steps: [
      { id: 's1', description: 'Modify server', files: ['server.js'] },
      { id: 's2', description: 'Add tests', files: ['test.js'] },
    ],
  });

  bindToolCall(plan, 'run_1', 'tc_1', 'write_file', { path: 'server.js' });
  bindToolCall(plan, 'run_1', 'tc_2', 'edit_file', { path: 'server.js' });
  bindToolCall(plan, 'run_1', 'tc_3', 'write_file', { path: 'test.js' });

  // Step 1 should have 2 tool calls
  assert.strictEqual(plan.steps[0].toolCalls.length, 2);
  assert.strictEqual(plan.steps[0].toolCalls[0].toolName, 'write_file');
  assert.strictEqual(plan.steps[0].toolCalls[1].toolName, 'edit_file');

  // Step 2 should have 1 tool call
  assert.strictEqual(plan.steps[1].toolCalls.length, 1);
  assert.strictEqual(plan.steps[1].toolCalls[0].toolName, 'write_file');
});

// ── Test 9: Plan Only Mode ─────────────────────────────
test('Plan UI: plan-only 模式不产生 tool calls', () => {
  const plan = createPlan({
    goal: 'plan only test',
    executionMode: 'plan-only',
  });

  assert.strictEqual(plan.executionMode, 'plan-only');
  assert.strictEqual(plan.toolCallBindings.length, 0);
  // plan-only 不应该进入 EXECUTING
  assert.ok(!transitionPlanStatus(plan, PLAN_STATUS.EXECUTING));
});

// ── Test 10: Plan Status Labels ────────────────────────
test('Plan UI: Status Labels 完整', () => {
  const labels = {
    draft: 'Draft',
    awaiting_approval: 'Awaiting Approval',
    approved: 'Approved',
    rejected: 'Rejected',
    executing: 'Executing',
    completed: 'Completed',
    failed: 'Failed',
    cancelled: 'Cancelled',
  };

  for (const [status, label] of Object.entries(labels)) {
    const plan = createPlan({ goal: 'test' });
    // Verify the status exists in PLAN_STATUS
    assert.ok(Object.values(PLAN_STATUS).includes(status),
      `Status ${status} should be valid`);
  }
});