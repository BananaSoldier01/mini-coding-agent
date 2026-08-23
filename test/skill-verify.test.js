/**
 * test/skill-verify.test.js — Skill Verification & Evidence Tests
 *
 * V0.7.3
 * Tests for Skill Verification Runtime, Evidence Registry,
 * lifecycle constraints, and persistence.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SKILL_STATUS,
  createSkill,
  transitionSkillStatus,
  SkillRegistry,
  activateSkillsForRun,
  startSkillVerification,
  completeSkill,
  failSkill,
  EvidenceRegistry,
  createVerificationResult,
  runSkillVerification,
  safeTransitionSkillStatus,
  canTransitionSkillStatus,
  SkillRuntimeContext,
} from '../agent/skill.js';

// ── Test 1: Evidence Registry ─────────────────────────────

test('Skill-Verify: EvidenceRegistry addEvidence creates evidence', () => {
  const registry = new EvidenceRegistry();
  const ev = registry.addEvidence({
    skillId: 's1',
    type: 'command',
    data: { command: 'npm test', result: 'passed' },
  });
  assert.ok(ev.id);
  assert.strictEqual(ev.skillId, 's1');
  assert.strictEqual(ev.type, 'command');
  assert.ok(ev.timestamp > 0);
});

test('Skill-Verify: EvidenceRegistry getEvidence retrieves by id', () => {
  const registry = new EvidenceRegistry();
  const ev = registry.addEvidence({
    skillId: 's1',
    type: 'test',
    data: { result: 'ok' },
  });
  const found = registry.getEvidence(ev.id);
  assert.ok(found);
  assert.strictEqual(found.id, ev.id);
  assert.strictEqual(found.data.result, 'ok');
});

test('Skill-Verify: EvidenceRegistry listSkillEvidence returns all for skill', () => {
  const registry = new EvidenceRegistry();
  registry.addEvidence({ skillId: 's1', type: 'test', data: { n: 1 } });
  registry.addEvidence({ skillId: 's1', type: 'git', data: { n: 2 } });
  registry.addEvidence({ skillId: 's2', type: 'test', data: { n: 3 } });

  const s1Evidence = registry.listSkillEvidence('s1');
  assert.strictEqual(s1Evidence.length, 2);
  const s2Evidence = registry.listSkillEvidence('s2');
  assert.strictEqual(s2Evidence.length, 1);
});

test('Skill-Verify: EvidenceRegistry countSkillEvidence', () => {
  const registry = new EvidenceRegistry();
  registry.addEvidence({ skillId: 's1', type: 'test', data: {} });
  registry.addEvidence({ skillId: 's1', type: 'test', data: {} });
  assert.strictEqual(registry.countSkillEvidence('s1'), 2);
  assert.strictEqual(registry.countSkillEvidence('s2'), 0);
});

test('Skill-Verify: EvidenceRegistry clearSkillEvidence', () => {
  const registry = new EvidenceRegistry();
  registry.addEvidence({ skillId: 's1', type: 'test', data: {} });
  registry.addEvidence({ skillId: 's1', type: 'test', data: {} });
  registry.clearSkillEvidence('s1');
  assert.strictEqual(registry.countSkillEvidence('s1'), 0);
  assert.strictEqual(registry.listSkillEvidence('s1').length, 0);
});

test('Skill-Verify: EvidenceRegistry serialize and deserialize', () => {
  const registry = new EvidenceRegistry();
  registry.addEvidence({ skillId: 's1', type: 'test', data: { v: 1 } });
  registry.addEvidence({ skillId: 's2', type: 'git', data: { v: 2 } });

  const serialized = registry.serialize();
  assert.ok(serialized.evidences);
  assert.ok(serialized.skillIndex);

  const restored = EvidenceRegistry.deserialize(serialized);
  assert.strictEqual(restored.countSkillEvidence('s1'), 1);
  assert.strictEqual(restored.countSkillEvidence('s2'), 1);
});

// ── Test 2: Verification Result ───────────────────────────

test('Skill-Verify: createVerificationResult success', () => {
  const result = createVerificationResult('s1', true, ['ev-1'], [{ type: 'command', passed: true }]);
  assert.strictEqual(result.skillId, 's1');
  assert.ok(result.success);
  assert.deepStrictEqual(result.evidenceRefs, ['ev-1']);
  assert.strictEqual(result.checks.length, 1);
  assert.ok(result.verifiedAt > 0);
});

test('Skill-Verify: createVerificationResult failure', () => {
  const result = createVerificationResult('s1', false, [], [], 'No evidence');
  assert.ok(!result.success);
  assert.strictEqual(result.reason, 'No evidence');
});

// ── Test 3: Skill Verification Runtime ────────────────────

test('Skill-Verify: runSkillVerification success → COMPLETED', () => {
  const registry = new SkillRegistry(['run_command']);
  registry.register({ id: 's1', name: 'Test', description: 'd', version: '1.0.0', tools: ['run_command'] });
  registry.load('s1');
  activateSkillsForRun(registry, ['s1']);

  const evRegistry = new EvidenceRegistry();
  const result = runSkillVerification(registry, 's1', evRegistry, {
    checks: [{ type: 'command', passed: true, command: 'npm test' }],
  });

  assert.ok(result);
  assert.ok(result.success);
  assert.ok(result.evidenceRefs.length > 0);
  assert.strictEqual(registry.get('s1').status, SKILL_STATUS.COMPLETED);
});

test('Skill-Verify: runSkillVerification failure → FAILED', () => {
  const registry = new SkillRegistry(['run_command']);
  registry.register({ id: 's1', name: 'Test', description: 'd', version: '1.0.0', tools: ['run_command'] });
  registry.load('s1');
  activateSkillsForRun(registry, ['s1']);

  const evRegistry = new EvidenceRegistry();
  const result = runSkillVerification(registry, 's1', evRegistry, {
    checks: [{ type: 'command', passed: false, command: 'npm test' }],
    reason: 'Tests failed',
  });

  assert.ok(result);
  assert.ok(!result.success);
  assert.strictEqual(result.reason, 'Tests failed');
  assert.strictEqual(registry.get('s1').status, SKILL_STATUS.FAILED);
});

test('Skill-Verify: runSkillVerification returns null if not RUNNING', () => {
  const registry = new SkillRegistry(['run_command']);
  registry.register({ id: 's1', name: 'Test', description: 'd', version: '1.0.0', tools: ['run_command'] });
  // Skill is REGISTERED, not RUNNING
  const evRegistry = new EvidenceRegistry();
  const result = runSkillVerification(registry, 's1', evRegistry, {});
  assert.strictEqual(result, null);
});

test('Skill-Verify: runSkillVerification returns null for unknown skill', () => {
  const registry = new SkillRegistry(['run_command']);
  const evRegistry = new EvidenceRegistry();
  const result = runSkillVerification(registry, 'nonexistent', evRegistry, {});
  assert.strictEqual(result, null);
});

test('Skill-Verify: runSkillVerification requires evidence', () => {
  const registry = new SkillRegistry(['run_command']);
  registry.register({ id: 's1', name: 'Test', description: 'd', version: '1.0.0', tools: ['run_command'] });
  registry.load('s1');
  activateSkillsForRun(registry, ['s1']);

  const evRegistry = new EvidenceRegistry();
  // No checks provided → no evidence → verification fails
  const result = runSkillVerification(registry, 's1', evRegistry, { checks: [] });
  assert.ok(result);
  assert.ok(!result.success, 'No evidence should cause verification failure');
  assert.strictEqual(registry.get('s1').status, SKILL_STATUS.FAILED);
});

// ── Test 4: Lifecycle Constraint Enforcement ──────────────

test('Skill-Verify: safeTransitionSkillStatus blocks AVAILABLE → COMPLETED', () => {
  const skill = createSkill({ id: 's1', name: 'Test', description: 'd', version: '1.0.0', tools: ['run_command'] });
  transitionSkillStatus(skill, SKILL_STATUS.AVAILABLE);
  // AVAILABLE → COMPLETED is illegal (must go through RUNNING → VERIFYING)
  assert.ok(!safeTransitionSkillStatus(skill, SKILL_STATUS.COMPLETED));
  assert.strictEqual(skill.status, SKILL_STATUS.AVAILABLE);
});

test('Skill-Verify: safeTransitionSkillStatus blocks REGISTERED → COMPLETED', () => {
  const skill = createSkill({ id: 's1', name: 'Test', description: 'd', version: '1.0.0', tools: ['run_command'] });
  assert.ok(!safeTransitionSkillStatus(skill, SKILL_STATUS.COMPLETED));
  assert.strictEqual(skill.status, SKILL_STATUS.REGISTERED);
});

test('Skill-Verify: safeTransitionSkillStatus allows RUNNING → VERIFYING → COMPLETED', () => {
  const skill = createSkill({ id: 's1', name: 'Test', description: 'd', version: '1.0.0', tools: ['run_command'] });
  transitionSkillStatus(skill, SKILL_STATUS.AVAILABLE);
  transitionSkillStatus(skill, SKILL_STATUS.RUNNING);
  transitionSkillStatus(skill, SKILL_STATUS.VERIFYING);
  assert.ok(safeTransitionSkillStatus(skill, SKILL_STATUS.COMPLETED));
  assert.strictEqual(skill.status, SKILL_STATUS.COMPLETED);
});

test('Skill-Verify: safeTransitionSkillStatus blocks transition from COMPLETED', () => {
  const skill = createSkill({ id: 's1', name: 'Test', description: 'd', version: '1.0.0', tools: ['run_command'] });
  transitionSkillStatus(skill, SKILL_STATUS.AVAILABLE);
  transitionSkillStatus(skill, SKILL_STATUS.RUNNING);
  transitionSkillStatus(skill, SKILL_STATUS.VERIFYING);
  safeTransitionSkillStatus(skill, SKILL_STATUS.COMPLETED);

  // Cannot transition from terminal state
  assert.ok(!safeTransitionSkillStatus(skill, SKILL_STATUS.RUNNING));
  assert.ok(!safeTransitionSkillStatus(skill, SKILL_STATUS.FAILED));
});

test('Skill-Verify: safeTransitionSkillStatus blocks transition from FAILED', () => {
  const skill = createSkill({ id: 's1', name: 'Test', description: 'd', version: '1.0.0', tools: ['run_command'] });
  transitionSkillStatus(skill, SKILL_STATUS.AVAILABLE);
  transitionSkillStatus(skill, SKILL_STATUS.RUNNING);
  safeTransitionSkillStatus(skill, SKILL_STATUS.FAILED);

  assert.ok(!safeTransitionSkillStatus(skill, SKILL_STATUS.RUNNING));
  assert.ok(!safeTransitionSkillStatus(skill, SKILL_STATUS.COMPLETED));
});

test('Skill-Verify: canTransitionSkillStatus checks without modifying', () => {
  const skill = createSkill({ id: 's1', name: 'Test', description: 'd', version: '1.0.0', tools: ['run_command'] });
  // REGISTERED → AVAILABLE is valid
  assert.ok(canTransitionSkillStatus(skill, SKILL_STATUS.AVAILABLE));
  // REGISTERED → COMPLETED is illegal
  assert.ok(!canTransitionSkillStatus(skill, SKILL_STATUS.COMPLETED));
  // REGISTERED → RUNNING is illegal
  assert.ok(!canTransitionSkillStatus(skill, SKILL_STATUS.RUNNING));
  // Status unchanged
  assert.strictEqual(skill.status, SKILL_STATUS.REGISTERED);
});

// ── Test 5: SkillRuntimeContext with Verification ─────────

test('Skill-Verify: SkillRuntimeContext stores verification result', () => {
  const ctx = new SkillRuntimeContext('run-1');
  const result = createVerificationResult('s1', true, ['ev-1'], []);
  ctx.setVerificationResult('s1', result);

  const retrieved = ctx.getVerificationResult('s1');
  assert.ok(retrieved);
  assert.strictEqual(retrieved.skillId, 's1');
  assert.ok(retrieved.success);
});

test('Skill-Verify: SkillRuntimeContext serializes verification results', () => {
  const ctx = new SkillRuntimeContext('run-1');
  ctx.setVerificationResult('s1', createVerificationResult('s1', true, ['ev-1'], []));
  ctx.setVerificationResult('s2', createVerificationResult('s2', false, [], [], 'Failed'));

  const serialized = ctx.serialize();
  assert.ok(serialized.verificationResults);
  assert.strictEqual(Object.keys(serialized.verificationResults).length, 2);

  const registry = new SkillRegistry(['run_command']);
  const restored = SkillRuntimeContext.deserialize(serialized, registry);
  const r1 = restored.getVerificationResult('s1');
  const r2 = restored.getVerificationResult('s2');
  assert.ok(r1);
  assert.ok(r1.success);
  assert.ok(r2);
  assert.ok(!r2.success);
});

test('Skill-Verify: SkillRuntimeContext full lifecycle with verification', () => {
  const registry = new SkillRegistry(['run_command']);
  registry.register({ id: 's1', name: 'Test', description: 'd', version: '1.0.0', tools: ['run_command'] });
  registry.load('s1');

  const ctx = new SkillRuntimeContext('run-1');
  ctx.addSkill(registry.get('s1'));

  // Activate
  activateSkillsForRun(registry, ['s1']);
  ctx.updateSkillStatus('s1', SKILL_STATUS.RUNNING);

  // Verify
  const evRegistry = new EvidenceRegistry();
  const result = runSkillVerification(registry, 's1', evRegistry, {
    checks: [{ type: 'command', passed: true, command: 'echo ok' }],
  });
  ctx.setVerificationResult('s1', result);

  // Check final state
  assert.strictEqual(registry.get('s1').status, SKILL_STATUS.COMPLETED);
  assert.ok(ctx.getVerificationResult('s1').success);

  // Serialize and restore
  const serialized = ctx.serialize();
  const restored = SkillRuntimeContext.deserialize(serialized, registry);
  assert.strictEqual(restored.getVerificationResult('s1').success, true);
});

// ── Test 6: Multi-Skill Verification ──────────────────────

test('Skill-Verify: multiple skills with mixed verification results', () => {
  const registry = new SkillRegistry(['run_command']);
  registry.register({ id: 'sa', name: 'Skill A', description: 'd', version: '1.0.0', tools: ['run_command'] });
  registry.register({ id: 'sb', name: 'Skill B', description: 'd', version: '1.0.0', tools: ['run_command'] });
  registry.load('sa');
  registry.load('sb');
  activateSkillsForRun(registry, ['sa', 'sb']);

  const evRegistry = new EvidenceRegistry();

  // Skill A passes
  const resultA = runSkillVerification(registry, 'sa', evRegistry, {
    checks: [{ type: 'command', passed: true, command: 'echo a' }],
  });
  assert.ok(resultA.success);
  assert.strictEqual(registry.get('sa').status, SKILL_STATUS.COMPLETED);

  // Skill B fails
  const resultB = runSkillVerification(registry, 'sb', evRegistry, {
    checks: [{ type: 'command', passed: false, command: 'echo b' }],
    reason: 'Check failed',
  });
  assert.ok(!resultB.success);
  assert.strictEqual(registry.get('sb').status, SKILL_STATUS.FAILED);

  // Summary should reflect mixed results
  const skills = registry.list();
  const completed = skills.filter(s => s.status === SKILL_STATUS.COMPLETED).length;
  const failed = skills.filter(s => s.status === SKILL_STATUS.FAILED).length;
  assert.strictEqual(completed, 1);
  assert.strictEqual(failed, 1);
});

// ── Test 7: Persistence Round-Trip ─────────────────────────

test('Skill-Verify: serialize/deserialize preserves full state', () => {
  const registry = new SkillRegistry(['run_command']);
  registry.register({ id: 's1', name: 'Test', description: 'd', version: '1.0.0', tools: ['run_command'] });
  registry.load('s1');
  activateSkillsForRun(registry, ['s1']);

  const evRegistry = new EvidenceRegistry();
  evRegistry.addEvidence({ skillId: 's1', type: 'test', data: { result: 'ok' } });

  const ctx = new SkillRuntimeContext('run-1');
  ctx.addSkill(registry.get('s1'));
  ctx.updateSkillStatus('s1', SKILL_STATUS.RUNNING);
  ctx.addEvidenceRef('s1', evRegistry.listSkillEvidence('s1')[0].id);
  ctx.setVerificationResult('s1', createVerificationResult('s1', true, ['ev-1'], []));

  const serialized = ctx.serialize();
  assert.strictEqual(serialized.runId, 'run-1');
  assert.strictEqual(serialized.activeSkills.length, 1);
  assert.ok(serialized.verificationResults['s1']);

  const restored = SkillRuntimeContext.deserialize(serialized, registry);
  assert.strictEqual(restored.runId, 'run-1');
  assert.strictEqual(restored.activeSkills.length, 1);
  assert.strictEqual(restored.evidenceRefs.get('s1').length, 1);
  assert.ok(restored.getVerificationResult('s1').success);
});

// ── Test 8: Complete Flow ─────────────────────────────────

test('Skill-Verify: full flow — activate → verify → complete', () => {
  const registry = new SkillRegistry(['run_command']);
  registry.register({ id: 's1', name: 'Test', description: 'd', version: '1.0.0', tools: ['run_command'] });
  registry.load('s1');

  const evRegistry = new EvidenceRegistry();
  const ctx = new SkillRuntimeContext('run-1');

  // 1. Activate
  ctx.addSkill(registry.get('s1'));
  activateSkillsForRun(registry, ['s1']);
  ctx.updateSkillStatus('s1', SKILL_STATUS.RUNNING);
  assert.strictEqual(registry.get('s1').status, SKILL_STATUS.RUNNING);

  // 2. Verify with evidence
  const result = runSkillVerification(registry, 's1', evRegistry, {
    checks: [{ type: 'command', passed: true, command: 'npm test' }],
  });
  ctx.setVerificationResult('s1', result);
  ctx.addEvidenceRef('s1', result.evidenceRefs[0]);

  // 3. Check final state
  assert.strictEqual(registry.get('s1').status, SKILL_STATUS.COMPLETED);
  assert.ok(result.success);
  assert.ok(result.evidenceRefs.length > 0);
  assert.ok(ctx.getVerificationResult('s1').success);
  assert.strictEqual(ctx.evidenceRefs.get('s1').length, 1);
});

test('Skill-Verify: full failure flow — activate → verify fail → failed', () => {
  const registry = new SkillRegistry(['run_command']);
  registry.register({ id: 's1', name: 'Test', description: 'd', version: '1.0.0', tools: ['run_command'] });
  registry.load('s1');

  const evRegistry = new EvidenceRegistry();
  const ctx = new SkillRuntimeContext('run-1');

  // 1. Activate
  ctx.addSkill(registry.get('s1'));
  activateSkillsForRun(registry, ['s1']);
  ctx.updateSkillStatus('s1', SKILL_STATUS.RUNNING);

  // 2. Verify fails
  const result = runSkillVerification(registry, 's1', evRegistry, {
    checks: [{ type: 'command', passed: false, command: 'npm test' }],
    reason: 'Tests failed',
  });
  ctx.setVerificationResult('s1', result);

  // 3. Check failed state
  assert.strictEqual(registry.get('s1').status, SKILL_STATUS.FAILED);
  assert.ok(!result.success);
  assert.strictEqual(result.reason, 'Tests failed');

  // 4. Cannot complete after failure
  assert.ok(!safeTransitionSkillStatus(registry.get('s1'), SKILL_STATUS.COMPLETED));
  assert.ok(!safeTransitionSkillStatus(registry.get('s1'), SKILL_STATUS.RUNNING));
});