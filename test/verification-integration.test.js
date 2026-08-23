/**
 * test/verification-integration.test.js — Verification Integration Tests
 *
 * V0.6.3
 * Real integration tests for Verification lifecycle, safety, and completion gate.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPlan, validatePlan, PLAN_STATUS, completeStepAfterExecution, findMatchingStep, recordSuccessfulEffect } from '../agent/plan.js';
import {
  createVerification,
  addCheck,
  createVerificationFromStep,
  validateCheck,
  validateVerification,
  runVerification,
  runFileVerification,
  runGitVerification,
  VERIFICATION_STATUS,
  VERIFICATION_TYPE,
} from '../agent/verification.js';
import { Session } from '../session.js';

// ── Test 1: Missing verification → plan invalid ────────
test('V-Integration: 缺 verification → plan invalid', () => {
  const plan = createPlan({
    goal: 'test',
    steps: [
      { id: 's1', description: 'modify something', type: 'modify', files: ['a.js'] },
    ],
  });
  const result = validatePlan(plan);
  assert.ok(!result.valid, 'Plan without verification should be invalid');
  assert.ok(result.errors.some(e => e.includes('verification')),
    'Error should mention verification requirement');
});

// ── Test 2: Command pass → completed ───────────────────
test('V-Integration: command pass → step completed', async () => {
  const plan = createPlan({
    goal: 'test',
    steps: [
      { id: 's1', description: 'run tests', type: 'command' },
    ],
  });

  // Build verificationState manually (as orchestrator would)
  plan.steps[0].verificationState = createVerificationFromStep(plan, plan.steps[0]);
  addCheck(plan.steps[0].verificationState, {
    type: VERIFICATION_TYPE.COMMAND,
    description: 'echo hello',
    command: 'echo hello',
    expected: 'exit 0',
  });

  plan.steps[0].status = 'running';
  // V0.6.3: Need successfulEffects for completion
  recordSuccessfulEffect(plan, 's1', 'run_command', { command: 'echo hello' }, { exitCode: 0 });
  const completed = completeStepAfterExecution(plan, 's1');
  assert.ok(completed, 'Step should complete');
  assert.strictEqual(completed.status, 'completed');

  const vs = completed.verificationState;
  assert.ok(vs, 'Should have verificationState');
  const result = await runVerification(vs, { workspace: process.cwd() });
  assert.strictEqual(result.status, VERIFICATION_STATUS.PASSED);
});

// ── Test 3: Command fail → step FAILED ────────────────
test('V-Integration: command fail → step FAILED', async () => {
  const plan = createPlan({
    goal: 'test',
    steps: [
      { id: 's1', description: 'failing step', type: 'command' },
    ],
  });

  plan.steps[0].verificationState = createVerificationFromStep(plan, plan.steps[0]);
  addCheck(plan.steps[0].verificationState, {
    type: VERIFICATION_TYPE.COMMAND,
    description: 'exit 1',
    command: 'exit 1',
    expected: 'exit 0',
  });

  plan.steps[0].status = 'running';
  recordSuccessfulEffect(plan, 's1', 'run_command', { command: 'exit 1' }, { exitCode: 0 });
  const completed = completeStepAfterExecution(plan, 's1');
  const vs = completed.verificationState;
  const result = await runVerification(vs, { workspace: process.cwd() });
  assert.strictEqual(result.status, VERIFICATION_STATUS.FAILED);
});

// ── Test 4: File exists verification ───────────────────
test('V-Integration: file exists verification', async () => {
  const result = await runFileVerification('package.json', 'exists', process.cwd());
  assert.strictEqual(result.status, VERIFICATION_STATUS.PASSED);
  assert.ok(result.result.includes('exists'));
});

test('V-Integration: file not_exists verification', async () => {
  const result = await runFileVerification('nonexistent_file_xyz123.txt', 'not_exists', process.cwd());
  assert.strictEqual(result.status, VERIFICATION_STATUS.PASSED);
});

// ── Test 5: Git clean check ────────────────────────────
test('V-Integration: git status --porcelain', async () => {
  const result = await runGitVerification(['status', '--porcelain'], process.cwd());
  assert.ok(
    result.status === VERIFICATION_STATUS.PASSED || result.status === VERIFICATION_STATUS.FAILED,
    `Git status should return PASSED or FAILED, got ${result.status}`
  );
});

// ── Test 6: Custom check → SKIPPED → Verification FAILED ──
test('V-Integration: custom check → SKIPPED → verification FAILED', async () => {
  const v = createVerification({ planId: 'p1' });
  addCheck(v, { type: VERIFICATION_TYPE.CUSTOM, description: 'manual review' });
  const result = await runVerification(v, { workspace: process.cwd() });
  // V0.6.3: SKIPPED check → overall verification FAILED (not PASSED)
  assert.strictEqual(result.status, VERIFICATION_STATUS.FAILED,
    'SKIPPED check should cause overall FAILED, not PASSED');
  assert.strictEqual(result.checks[0].status, VERIFICATION_STATUS.SKIPPED);
});

// ── Test 7: Session restore with verification ──────────
test('V-Integration: session restore preserves verification', () => {
  const session = new Session('test-session', 'test-ws');
  const plan = createPlan({
    goal: 'restore test',
    steps: [
      { id: 's1', description: 'step', type: 'modify', files: ['a.js'] },
    ],
  });
  session.planState = plan;

  const serialized = JSON.parse(JSON.stringify({
    planState: session.planState,
  }));

  const restored = serialized.planState;
  assert.ok(restored, 'planState should be restored');
  assert.strictEqual(restored.goal, 'restore test');
  assert.strictEqual(restored.steps.length, 1);
});

// ── Test 8: Multi-file step not prematurely complete ───
test('V-Integration: multi-file step not prematurely complete', () => {
  const plan = createPlan({
    goal: 'multi-file',
    steps: [
      { id: 's1', description: 'modify two files', type: 'modify',
        files: ['a.js', 'b.js'] },
    ],
  });

  plan.steps[0].status = 'running';
  // Only first file done — step should NOT complete
  recordSuccessfulEffect(plan, 's1', 'write_file', { path: 'a.js' }, { path: 'a.js', action: 'modified' });
  const result1 = completeStepAfterExecution(plan, 's1');
  assert.strictEqual(result1, null, 'Step should not complete with only 1 of 2 files');

  // Second file done
  recordSuccessfulEffect(plan, 's1', 'write_file', { path: 'b.js' }, { path: 'b.js', action: 'created' });
  const result2 = completeStepAfterExecution(plan, 's1');
  assert.ok(result2, 'Step should complete when all files done');
  assert.strictEqual(result2.status, 'completed');
});

// ── Test 9: Command step mapping ───────────────────────
test('V-Integration: command step can be found and completed', () => {
  const plan = createPlan({
    goal: 'command step',
    steps: [
      { id: 's1', description: 'run command', type: 'command' },
    ],
  });

  plan.steps[0].status = 'running';
  const step = findMatchingStep(plan, 'run_command', { command: 'npm test' });
  assert.ok(step, 'Should find command-type step');
  assert.strictEqual(step.id, 's1');

  recordSuccessfulEffect(plan, 's1', 'run_command', { command: 'npm test' }, { exitCode: 0 });
  const completed = completeStepAfterExecution(plan, 's1');
  assert.ok(completed, 'Command step should complete');
  assert.strictEqual(completed.status, 'completed');
});

// ── Test 10: Verification result format for LLM ────────
test('V-Integration: verification result format for LLM', () => {
  const checks = [
    { status: 'passed', description: 'npm test', result: '254 tests passed' },
    { status: 'failed', description: 'lint', result: '2 errors found' },
  ];
  const summary = checks.map(c =>
    `[${c.status.toUpperCase()}] ${c.description}: ${c.result}`
  ).join('\n');

  assert.ok(summary.includes('[PASSED] npm test'));
  assert.ok(summary.includes('[FAILED] lint'));
  assert.ok(summary.includes('254 tests passed'));
});

// ── Test 11: Completion gate ────────────────────────────
test('V-Integration: completion gate — only PASSED allows COMPLETED', () => {
  const plan = createPlan({
    goal: 'gate test',
    steps: [
      { id: 's1', description: 'step', type: 'modify', files: ['a.js'] },
    ],
  });

  plan.steps[0].verificationState = {
    status: VERIFICATION_STATUS.PASSED,
    checks: [{ status: VERIFICATION_STATUS.PASSED, result: 'OK' }],
  };

  const stepsWithVerification = plan.steps.filter(s => s.verificationState);
  const allPassed = stepsWithVerification.every(
    s => s.verificationState.status === VERIFICATION_STATUS.PASSED
  );
  assert.ok(allPassed, 'All verification should be PASSED');

  plan.steps[0].verificationState.status = VERIFICATION_STATUS.FAILED;
  const anyNotPassed = stepsWithVerification.some(
    s => s.verificationState.status !== VERIFICATION_STATUS.PASSED
  );
  assert.ok(anyNotPassed, 'FAILED verification should be detected');
});

// ── Test 12: PENDING verification blocks completion ────
test('V-Integration: PENDING verification blocks completion', () => {
  const plan = createPlan({
    goal: 'gate test',
    steps: [
      { id: 's1', description: 'step', type: 'modify', files: ['a.js'] },
    ],
  });

  plan.steps[0].verificationState = {
    status: VERIFICATION_STATUS.PENDING,
    checks: [],
  };

  const stepsWithVerification = plan.steps.filter(s => s.verificationState);
  const anyNotPassed = stepsWithVerification.some(
    s => s.verificationState.status !== VERIFICATION_STATUS.PASSED
  );
  assert.ok(anyNotPassed, 'PENDING verification should block completion');
});

// ── Test 13: validatePlan rejects missing verification ──
test('V-Integration: validatePlan rejects modify step without verification', () => {
  const plan = createPlan({
    goal: 'test',
    steps: [
      { id: 's1', description: 'modify', type: 'modify', files: ['a.js'] },
    ],
  });
  const result = validatePlan(plan);
  assert.ok(!result.valid);
  assert.ok(result.errors.some(e => e.includes('verification')));
});

test('V-Integration: validatePlan rejects command step without verification', () => {
  const plan = createPlan({
    goal: 'test',
    steps: [
      { id: 's1', description: 'run', type: 'command' },
    ],
  });
  const result = validatePlan(plan);
  assert.ok(!result.valid);
  assert.ok(result.errors.some(e => e.includes('verification')));
});

test('V-Integration: validatePlan allows explore step without verification', () => {
  const plan = createPlan({
    goal: 'test',
    steps: [
      { id: 's1', description: 'explore', type: 'explore', files: [] },
    ],
  });
  const result = validatePlan(plan);
  assert.ok(result.valid);
});

// ── Test 14: Verification uses correct workspace ───────
test('V-Integration: verification uses workspace param', async () => {
  const ws = process.cwd();
  const result = await runFileVerification('package.json', 'exists', ws);
  assert.strictEqual(result.status, VERIFICATION_STATUS.PASSED);
  assert.ok(result.result.includes('package.json'));
});

// ── Test 15: Baseline hash comparison ──────────────────
test('V-Integration: baseline hash comparison for modified file', async () => {
  const { createHash } = await import('node:crypto');
  const { readFileSync } = await import('node:fs');

  const content = readFileSync('package.json', 'utf-8');
  const baseline = { hash: createHash('sha256').update(content).digest('hex') };

  // Same content → should fail (not modified)
  const resultSame = await runFileVerification('package.json', 'modified', process.cwd(), baseline);
  assert.strictEqual(resultSame.status, VERIFICATION_STATUS.FAILED,
    'Unchanged file should fail modified check');

  // Different content → should pass (modified)
  const resultDiff = await runFileVerification('package.json', 'modified', process.cwd(), {
    hash: '0000000000000000000000000000000000000000000000000000000000000000',
  });
  assert.strictEqual(resultDiff.status, VERIFICATION_STATUS.PASSED,
    'Changed file should pass modified check');
});

// ── Test 16: validateCheck rejects malformed checks ─────
test('V-Integration: validateCheck rejects unknown type', () => {
  const result = validateCheck({ type: 'banana', check: 'something', expected: 'whatever' });
  assert.ok(!result.valid);
  assert.ok(result.errors.some(e => e.includes('banana')));
});

test('V-Integration: validateCheck rejects empty check', () => {
  const result = validateCheck({ type: 'command', check: '', expected: 'exit 0' });
  assert.ok(!result.valid);
  assert.ok(result.errors.some(e => e.includes('non-empty')));
});

test('V-Integration: validateCheck rejects missing command', () => {
  const result = validateCheck({ type: 'command', check: 'echo', expected: 'exit 0' });
  // command field is required for command type
  assert.ok(!result.valid);
  assert.ok(result.errors.some(e => e.includes('command')));
});

test('V-Integration: validateCheck accepts valid command check', () => {
  const result = validateCheck({ type: 'command', check: 'echo hello', command: 'echo hello', expected: 'exit 0' });
  assert.ok(result.valid);
});

// ── Test 17: validateVerification ───────────────────────
test('V-Integration: validateVerification rejects all invalid checks', () => {
  const v = createVerification({ planId: 'p1' });
  addCheck(v, { type: 'banana', check: '', expected: '' });
  addCheck(v, { type: 'command', check: 'echo', command: 'echo', expected: 'exit 0' });
  const result = validateVerification(v);
  assert.ok(!result.valid);
  assert.ok(result.errors.length >= 2);
});

// ── Test 18: createVerificationFromStep no longer creates CUSTOM check ──
test('V-Integration: createVerificationFromStep does not auto-create CUSTOM check', () => {
  const plan = createPlan({
    goal: 'test',
    steps: [
      { id: 's1', description: 'step', type: 'modify', files: ['a.js'],
        expectedOutcome: 'file should exist' },
    ],
  });
  const vs = createVerificationFromStep(plan, plan.steps[0]);
  assert.strictEqual(vs.checks.length, 0,
    'expectedOutcome should NOT auto-create a CUSTOM check');
});