/**
 * test/verification.test.js — Verification Foundation Tests
 *
 * V0.6.0
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createVerification,
  addCheck,
  startVerification,
  completeCheck,
  completeVerification,
  createVerificationFromStep,
  VERIFICATION_STATUS,
  VERIFICATION_TYPE,
} from '../agent/verification.js';
import { createPlan, transitionPlanStatus, PLAN_STATUS } from '../agent/plan.js';

// ── Test 1: Verification Object ────────────────────────
test('Verification: create + serialize + restore', () => {
  const v = createVerification({ planId: 'plan_1', stepId: 'step_1' });
  assert.ok(v.id.startsWith('verify_'));
  assert.strictEqual(v.planId, 'plan_1');
  assert.strictEqual(v.stepId, 'step_1');
  assert.strictEqual(v.status, VERIFICATION_STATUS.PENDING);
  assert.strictEqual(v.checks.length, 0);

  // Serialize
  const serialized = JSON.parse(JSON.stringify(v));
  assert.strictEqual(serialized.id, v.id);
  assert.strictEqual(serialized.status, VERIFICATION_STATUS.PENDING);

  // Restore
  const restored = { ...serialized };
  assert.strictEqual(restored.id, v.id);
  assert.strictEqual(restored.status, VERIFICATION_STATUS.PENDING);
});

test('Verification: addCheck', () => {
  const v = createVerification({ planId: 'p1' });
  addCheck(v, {
    type: VERIFICATION_TYPE.COMMAND,
    description: 'Run tests',
    command: 'npm test',
  });
  assert.strictEqual(v.checks.length, 1);
  assert.strictEqual(v.checks[0].type, VERIFICATION_TYPE.COMMAND);
  assert.strictEqual(v.checks[0].status, VERIFICATION_STATUS.PENDING);
  assert.strictEqual(v.checks[0].command, 'npm test');
});

test('Verification: start + complete lifecycle', () => {
  const v = createVerification({ planId: 'p1' });
  startVerification(v);
  assert.strictEqual(v.status, VERIFICATION_STATUS.RUNNING);
  assert.ok(v.startedAt !== null);

  completeCheck(v, v.checks[0]?.id || 'check_1', VERIFICATION_STATUS.PASSED, 'OK');
  completeVerification(v, VERIFICATION_STATUS.PASSED);
  assert.strictEqual(v.status, VERIFICATION_STATUS.PASSED);
  assert.ok(v.completedAt !== null);
});

// ── Test 2: Command Verification ───────────────────────
test('Verification: Command success → PASSED', async () => {
  const { runCommandVerification } = await import('../agent/verification.js');
  const result = await runCommandVerification('echo "hello"');
  assert.strictEqual(result.status, VERIFICATION_STATUS.PASSED);
  assert.ok(result.result.includes('hello'));
});

test('Verification: Command failure → FAILED', async () => {
  const { runCommandVerification } = await import('../agent/verification.js');
  const result = await runCommandVerification('exit 1');
  assert.strictEqual(result.status, VERIFICATION_STATUS.FAILED);
  assert.ok(result.exitCode === 1);
});

// ── Test 3: Plan Step Lifecycle ────────────────────────
test('Verification: Plan Step Lifecycle EXECUTING → VERIFYING → COMPLETED', () => {
  const plan = createPlan({
    goal: 'verify lifecycle',
    steps: [
      { id: 's1', description: 'Step 1', expectedOutcome: 'Tests pass' },
    ],
  });

  // Step starts pending
  assert.strictEqual(plan.steps[0].status, 'pending');
  assert.strictEqual(plan.steps[0].verificationState, null);

  // EXECUTING
  transitionPlanStatus(plan, PLAN_STATUS.AWAITING_APPROVAL);
  transitionPlanStatus(plan, PLAN_STATUS.APPROVED);
  transitionPlanStatus(plan, PLAN_STATUS.EXECUTING);
  assert.strictEqual(plan.status, PLAN_STATUS.EXECUTING);

  // Step completes
  plan.steps[0].status = 'completed';
  plan.steps[0].completedAt = Date.now();

  // Create verification from step
  const vs = createVerificationFromStep(plan, plan.steps[0]);
  assert.ok(vs.id.startsWith('verify_'));
  assert.strictEqual(vs.planId, plan.id);
  assert.strictEqual(vs.stepId, 's1');
  assert.strictEqual(vs.checks.length, 1);
  assert.strictEqual(vs.checks[0].description, 'Tests pass');
});

// ── Test 4: Verification Failure ───────────────────────
test('Verification: VERIFYING → FAILED', () => {
  const v = createVerification({ planId: 'p1' });
  startVerification(v);

  // Add a check and fail it
  addCheck(v, { type: VERIFICATION_TYPE.COMMAND, description: 'lint', command: 'npm run lint' });
  completeCheck(v, v.checks[0].id, VERIFICATION_STATUS.FAILED, 'lint error');
  completeVerification(v, VERIFICATION_STATUS.FAILED);

  assert.strictEqual(v.status, VERIFICATION_STATUS.FAILED);
  assert.strictEqual(v.checks[0].status, VERIFICATION_STATUS.FAILED);
});

test('Verification: All checks passed → PASSED', () => {
  const v = createVerification({ planId: 'p1' });
  startVerification(v);

  addCheck(v, { type: VERIFICATION_TYPE.COMMAND, description: 'test 1', command: 'echo 1' });
  addCheck(v, { type: VERIFICATION_TYPE.COMMAND, description: 'test 2', command: 'echo 2' });

  completeCheck(v, v.checks[0].id, VERIFICATION_STATUS.PASSED, 'OK');
  completeCheck(v, v.checks[1].id, VERIFICATION_STATUS.PASSED, 'OK');
  completeVerification(v, VERIFICATION_STATUS.PASSED);

  assert.strictEqual(v.status, VERIFICATION_STATUS.PASSED);
});

// ── Test 5: Timeline Events ────────────────────────────
test('Verification: Timeline events emit correctly', () => {
  const events = [];
  const mockEmit = (event) => events.push(event);

  const v = createVerification({ planId: 'p1', stepId: 's1' });
  addCheck(v, { type: VERIFICATION_TYPE.COMMAND, description: 'npm test', command: 'npm test' });

  // verification_started
  mockEmit({ type: 'verification_started', planId: 'p1', stepId: 's1', verificationId: v.id });
  // verification_completed
  completeVerification(v, VERIFICATION_STATUS.PASSED);
  mockEmit({
    type: 'verification_completed',
    planId: 'p1',
    stepId: 's1',
    verificationId: v.id,
    status: v.status,
    checks: v.checks,
  });

  assert.strictEqual(events.length, 2);
  assert.strictEqual(events[0].type, 'verification_started');
  assert.strictEqual(events[1].type, 'verification_completed');
  assert.strictEqual(events[1].status, VERIFICATION_STATUS.PASSED);
});

// ── Test 6: Session Restore ────────────────────────────
test('Verification: Session Restore — verificationState 恢复', () => {
  const v = createVerification({ planId: 'p1', stepId: 's1' });
  startVerification(v);
  addCheck(v, { type: VERIFICATION_TYPE.COMMAND, description: 'test', command: 'npm test' });
  completeCheck(v, v.checks[0].id, VERIFICATION_STATUS.PASSED, 'OK');
  completeVerification(v, VERIFICATION_STATUS.PASSED);

  // Serialize
  const serialized = JSON.parse(JSON.stringify(v));

  // Restore
  const restored = { ...serialized };
  assert.strictEqual(restored.id, v.id);
  assert.strictEqual(restored.status, VERIFICATION_STATUS.PASSED);
  assert.strictEqual(restored.checks.length, 1);
  assert.strictEqual(restored.checks[0].status, VERIFICATION_STATUS.PASSED);
});

// ── Test 7: Plan Step with expectedOutcome ─────────────
test('Verification: Plan Step expectedOutcome + verificationState', () => {
  const plan = createPlan({
    goal: 'test',
    steps: [
      { id: 's1', description: 'Update API', expectedOutcome: 'API tests pass' },
    ],
  });

  // Verify step has expectedOutcome
  assert.strictEqual(plan.steps[0].expectedOutcome, 'API tests pass');

  // Create verification from step
  const vs = createVerificationFromStep(plan, plan.steps[0]);
  plan.steps[0].verificationState = vs;

  assert.ok(plan.steps[0].verificationState !== null);
  assert.strictEqual(plan.steps[0].verificationState.checks.length, 1);
  assert.strictEqual(plan.steps[0].verificationState.checks[0].description, 'API tests pass');
});

// ── Test 8: Verification Status Constants ──────────────
test('Verification: Status constants complete', () => {
  assert.strictEqual(VERIFICATION_STATUS.PENDING, 'pending');
  assert.strictEqual(VERIFICATION_STATUS.RUNNING, 'running');
  assert.strictEqual(VERIFICATION_STATUS.PASSED, 'passed');
  assert.strictEqual(VERIFICATION_STATUS.FAILED, 'failed');
  assert.strictEqual(VERIFICATION_STATUS.SKIPPED, 'skipped');
});

test('Verification: Type constants complete', () => {
  assert.strictEqual(VERIFICATION_TYPE.COMMAND, 'command');
  assert.strictEqual(VERIFICATION_TYPE.FILE, 'file');
  assert.strictEqual(VERIFICATION_TYPE.GIT, 'git');
  assert.strictEqual(VERIFICATION_TYPE.CUSTOM, 'custom');
});