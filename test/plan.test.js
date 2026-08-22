/**
 * test/plan.test.js — Plan Lifecycle Regression Tests
 *
 * V0.5.1.1
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPlan, validatePlan, transitionPlanStatus, PLAN_STATUS, PLAN_TRANSITIONS, EXECUTION_MODE, bindToolCall } from '../agent/plan.js';

// ── Test 1: Generate Plan ──────────────────────────────
test('Plan: 生成 Plan — status DRAFT', () => {
  const plan = createPlan({
    goal: 'test goal',
    steps: [{ id: 'step-1', description: 'do something' }],
    risks: ['risk 1'],
    files: ['file1.js'],
  });

  assert.strictEqual(plan.status, PLAN_STATUS.DRAFT);
  assert.strictEqual(plan.goal, 'test goal');
  assert.strictEqual(plan.steps.length, 1);
  assert.strictEqual(plan.risks.length, 1);
  assert.strictEqual(plan.files.length, 1);
  assert.ok(plan.id.startsWith('plan_'));
  assert.strictEqual(plan.runId, null);
  assert.strictEqual(plan.toolCallBindings.length, 0);
});

// ── Test 2: Reject Plan ────────────────────────────────
test('Plan: 拒绝 Plan — AWAITING_APPROVAL → REJECTED', () => {
  const plan = createPlan({ goal: 'test' });
  transitionPlanStatus(plan, PLAN_STATUS.AWAITING_APPROVAL);
  assert.strictEqual(plan.status, PLAN_STATUS.AWAITING_APPROVAL);

  const ok = transitionPlanStatus(plan, PLAN_STATUS.REJECTED);
  assert.ok(ok, 'Should transition to REJECTED');
  assert.strictEqual(plan.status, PLAN_STATUS.REJECTED);
  assert.ok(plan.updatedAt >= plan.createdAt);
});

test('Plan: 拒绝后不能再流转', () => {
  const plan = createPlan({ goal: 'test' });
  transitionPlanStatus(plan, PLAN_STATUS.AWAITING_APPROVAL);
  transitionPlanStatus(plan, PLAN_STATUS.REJECTED);

  // REJECTED → any other status should fail
  assert.ok(!transitionPlanStatus(plan, PLAN_STATUS.APPROVED));
  assert.ok(!transitionPlanStatus(plan, PLAN_STATUS.EXECUTING));
  assert.strictEqual(plan.status, PLAN_STATUS.REJECTED);
});

// ── Test 3: Approve Plan ───────────────────────────────
test('Plan: 批准 Plan — AWAITING_APPROVAL → APPROVED', () => {
  const plan = createPlan({ goal: 'test', runId: 'run_123' });
  transitionPlanStatus(plan, PLAN_STATUS.AWAITING_APPROVAL);
  const ok = transitionPlanStatus(plan, PLAN_STATUS.APPROVED);
  assert.ok(ok);
  assert.strictEqual(plan.status, PLAN_STATUS.APPROVED);
  assert.ok(plan.approvedAt !== null);
  assert.strictEqual(plan.runId, 'run_123');
});

test('Plan: Approve → Execute → Bind ToolCall', () => {
  const plan = createPlan({ goal: 'test', runId: 'run_456' });
  transitionPlanStatus(plan, PLAN_STATUS.AWAITING_APPROVAL);
  transitionPlanStatus(plan, PLAN_STATUS.APPROVED);
  transitionPlanStatus(plan, PLAN_STATUS.EXECUTING);

  assert.strictEqual(plan.status, PLAN_STATUS.EXECUTING);
  assert.ok(plan.executedAt !== null);

  bindToolCall(plan, 'run_456', 'tc_001', 'write_file', { path: 'test.js' });
  assert.strictEqual(plan.toolCallBindings.length, 1);
  assert.strictEqual(plan.toolCallBindings[0].planId, plan.id);
  assert.strictEqual(plan.toolCallBindings[0].runId, 'run_456');
  assert.strictEqual(plan.toolCallBindings[0].toolCallId, 'tc_001');
  assert.strictEqual(plan.toolCallBindings[0].toolName, 'write_file');
});

// ── Test 4: Complete Lifecycle ─────────────────────────
test('Plan: 完整生命周期 DRAFT → COMPLETED', () => {
  const plan = createPlan({ goal: 'full lifecycle' });
  assert.strictEqual(plan.status, PLAN_STATUS.DRAFT);

  assert.ok(transitionPlanStatus(plan, PLAN_STATUS.AWAITING_APPROVAL));
  assert.strictEqual(plan.status, PLAN_STATUS.AWAITING_APPROVAL);

  assert.ok(transitionPlanStatus(plan, PLAN_STATUS.APPROVED));
  assert.strictEqual(plan.status, PLAN_STATUS.APPROVED);

  assert.ok(transitionPlanStatus(plan, PLAN_STATUS.EXECUTING));
  assert.strictEqual(plan.status, PLAN_STATUS.EXECUTING);

  assert.ok(transitionPlanStatus(plan, PLAN_STATUS.COMPLETED));
  assert.strictEqual(plan.status, PLAN_STATUS.COMPLETED);
  assert.ok(plan.completedAt !== null);
});

test('Plan: 非法状态转换被拒绝', () => {
  const plan = createPlan({ goal: 'test' });
  // DRAFT → COMPLETED should fail
  assert.ok(!transitionPlanStatus(plan, PLAN_STATUS.COMPLETED));
  assert.ok(!transitionPlanStatus(plan, PLAN_STATUS.EXECUTING));
  assert.strictEqual(plan.status, PLAN_STATUS.DRAFT);
});

// ── Test 5: Failed Lifecycle ───────────────────────────
test('Plan: 失败生命周期 APPROVED → FAILED', () => {
  const plan = createPlan({ goal: 'fail test' });
  transitionPlanStatus(plan, PLAN_STATUS.AWAITING_APPROVAL);
  transitionPlanStatus(plan, PLAN_STATUS.APPROVED);

  const ok = transitionPlanStatus(plan, PLAN_STATUS.FAILED);
  assert.ok(ok);
  assert.strictEqual(plan.status, PLAN_STATUS.FAILED);
});

test('Plan: EXECUTING → FAILED on tool error', () => {
  const plan = createPlan({ goal: 'exec fail' });
  transitionPlanStatus(plan, PLAN_STATUS.AWAITING_APPROVAL);
  transitionPlanStatus(plan, PLAN_STATUS.APPROVED);
  transitionPlanStatus(plan, PLAN_STATUS.EXECUTING);

  const ok = transitionPlanStatus(plan, PLAN_STATUS.FAILED);
  assert.ok(ok);
  assert.strictEqual(plan.status, PLAN_STATUS.FAILED);
});

test('Plan: EXECUTING → CANCELLED', () => {
  const plan = createPlan({ goal: 'cancel test' });
  transitionPlanStatus(plan, PLAN_STATUS.AWAITING_APPROVAL);
  transitionPlanStatus(plan, PLAN_STATUS.APPROVED);
  transitionPlanStatus(plan, PLAN_STATUS.EXECUTING);

  const ok = transitionPlanStatus(plan, PLAN_STATUS.CANCELLED);
  assert.ok(ok);
  assert.strictEqual(plan.status, PLAN_STATUS.CANCELLED);
});

// ── Test 6: Session Restore ────────────────────────────
test('Plan: 序列化/反序列化恢复 planState', () => {
  const plan = createPlan({ goal: 'restore test', runId: 'run_restore' });
  transitionPlanStatus(plan, PLAN_STATUS.AWAITING_APPROVAL);
  transitionPlanStatus(plan, PLAN_STATUS.APPROVED);

  // 模拟序列化
  const serialized = {
    id: plan.id,
    status: plan.status,
    goal: plan.goal,
    runId: plan.runId,
    toolCallBindings: plan.toolCallBindings,
  };

  // 模拟反序列化
  const restored = createPlan({ goal: serialized.goal, runId: serialized.runId });
  restored.status = serialized.status;
  restored.id = serialized.id;
  restored.toolCallBindings = serialized.toolCallBindings;

  assert.strictEqual(restored.id, plan.id);
  assert.strictEqual(restored.status, PLAN_STATUS.APPROVED);
  assert.strictEqual(restored.goal, 'restore test');
  assert.strictEqual(restored.runId, 'run_restore');
});

// ── Test 7: Plan Only ──────────────────────────────────
test('Plan: plan-only 模式不执行工具', () => {
  const plan = createPlan({ goal: 'plan only', executionMode: EXECUTION_MODE.PLAN_ONLY });
  assert.strictEqual(plan.executionMode, EXECUTION_MODE.PLAN_ONLY);
  assert.strictEqual(plan.toolCallBindings.length, 0);
  // plan-only 不应该有任何 tool call binding
});

// ── Test 8: Plan Execute ───────────────────────────────
test('Plan: plan-execute 模式可绑定 tool calls', () => {
  const plan = createPlan({ goal: 'plan execute', executionMode: EXECUTION_MODE.PLAN_EXECUTE });
  assert.strictEqual(plan.executionMode, EXECUTION_MODE.PLAN_EXECUTE);

  bindToolCall(plan, 'run_exec', 'tc_001', 'write_file', { path: 'a.js' });
  bindToolCall(plan, 'run_exec', 'tc_002', 'edit_file', { path: 'b.js' });
  assert.strictEqual(plan.toolCallBindings.length, 2);
  assert.strictEqual(plan.toolCallBindings[0].runId, 'run_exec');
  assert.strictEqual(plan.toolCallBindings[1].runId, 'run_exec');
});

// ── Test 9: Plan Validation ────────────────────────────
test('Plan: validatePlan — 有效 Plan', () => {
  const plan = createPlan({
    goal: 'valid',
    steps: [{ id: 's1', description: 'step 1' }],
    risks: [],
    files: [],
  });
  const result = validatePlan(plan);
  assert.ok(result.valid);
  assert.strictEqual(result.errors.length, 0);
});

test('Plan: validatePlan — 无效 Plan（缺 goal）', () => {
  const plan = createPlan({ goal: '' });
  const result = validatePlan(plan);
  assert.ok(!result.valid);
  assert.ok(result.errors.some(e => e.includes('goal')));
});

test('Plan: validatePlan — steps 不是数组', () => {
  const result = validatePlan({ goal: 'test', steps: 'not an array', risks: [], files: [] });
  assert.ok(!result.valid);
});

test('Plan: validatePlan — step 缺 id', () => {
  const plan = createPlan({ goal: 'test', steps: [{ description: 'no id' }] });
  const result = validatePlan(plan);
  assert.ok(!result.valid);
});

// ── Test 10: Plan Transitions Table ────────────────────
test('Plan: 状态转换表完整', () => {
  // DRAFT → AWAITING_APPROVAL
  assert.ok(PLAN_TRANSITIONS[PLAN_STATUS.DRAFT].includes(PLAN_STATUS.AWAITING_APPROVAL));
  // AWAITING_APPROVAL → APPROVED, REJECTED
  assert.ok(PLAN_TRANSITIONS[PLAN_STATUS.AWAITING_APPROVAL].includes(PLAN_STATUS.APPROVED));
  assert.ok(PLAN_TRANSITIONS[PLAN_STATUS.AWAITING_APPROVAL].includes(PLAN_STATUS.REJECTED));
  // APPROVED → EXECUTING, FAILED, CANCELLED
  assert.ok(PLAN_TRANSITIONS[PLAN_STATUS.APPROVED].includes(PLAN_STATUS.EXECUTING));
  assert.ok(PLAN_TRANSITIONS[PLAN_STATUS.APPROVED].includes(PLAN_STATUS.FAILED));
  assert.ok(PLAN_TRANSITIONS[PLAN_STATUS.APPROVED].includes(PLAN_STATUS.CANCELLED));
  // EXECUTING → COMPLETED, FAILED, CANCELLED
  assert.ok(PLAN_TRANSITIONS[PLAN_STATUS.EXECUTING].includes(PLAN_STATUS.COMPLETED));
  assert.ok(PLAN_TRANSITIONS[PLAN_STATUS.EXECUTING].includes(PLAN_STATUS.FAILED));
  assert.ok(PLAN_TRANSITIONS[PLAN_STATUS.EXECUTING].includes(PLAN_STATUS.CANCELLED));
  // Terminal states have no outgoing
  assert.strictEqual(PLAN_TRANSITIONS[PLAN_STATUS.COMPLETED].length, 0);
  assert.strictEqual(PLAN_TRANSITIONS[PLAN_STATUS.REJECTED].length, 0);
  assert.strictEqual(PLAN_TRANSITIONS[PLAN_STATUS.FAILED].length, 0);
  assert.strictEqual(PLAN_TRANSITIONS[PLAN_STATUS.CANCELLED].length, 0);
});