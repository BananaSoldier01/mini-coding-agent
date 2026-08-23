/**
 * test/skill-execution.test.js — Skill Execution Integration Tests
 *
 * V0.7.2
 * Tests for Skill ↔ Plan binding, instruction injection, and tool permission.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SKILL_STATUS,
  createSkill,
  transitionSkillStatus,
  SkillRegistry,
  bindSkillToPlan,
  bindSkillToStep,
  getPlanSkill,
  buildSkillContextForLLM,
  assertSkillToolAllowed,
  isToolAllowedForSkill,
} from '../agent/skill.js';
import { createPlan } from '../agent/plan.js';

// ── Helper: create a test skill ──
function makeTestSkill(overrides = {}) {
  return createSkill({
    id: 'test-runner',
    name: 'Test Runner',
    description: 'Run project tests',
    version: '1.0.0',
    tools: ['run_command', 'read_file'],
    instructions: 'Always use npm test. Do not modify test files.',
    verification: [{ type: 'command', command: 'npm test' }],
    ...overrides,
  });
}

// ── Test 1: Skill ↔ Plan Binding ──────────────────────────
test('Skill-Exec: bindSkillToPlan adds skill reference', () => {
  const plan = createPlan({ goal: 'test', steps: [] });
  const skill = makeTestSkill();
  bindSkillToPlan(plan, skill);
  assert.ok(plan.skills);
  assert.strictEqual(plan.skills.length, 1);
  assert.strictEqual(plan.skills[0].skillId, 'test-runner');
  assert.strictEqual(plan.skills[0].skillName, 'Test Runner');
});

test('Skill-Exec: bindSkillToPlan prevents duplicates', () => {
  const plan = createPlan({ goal: 'test', steps: [] });
  const skill = makeTestSkill();
  bindSkillToPlan(plan, skill);
  bindSkillToPlan(plan, skill);
  assert.strictEqual(plan.skills.length, 1);
});

test('Skill-Exec: bindSkillToStep attaches skill to step', () => {
  const plan = createPlan({
    goal: 'test',
    steps: [{ id: 's1', description: 'run tests', type: 'command' }],
  });
  const skill = makeTestSkill();
  bindSkillToStep(plan.steps[0], skill);
  assert.strictEqual(plan.steps[0].skillId, 'test-runner');
  assert.strictEqual(plan.steps[0].skillName, 'Test Runner');
});

test('Skill-Exec: getPlanSkill finds bound skill', () => {
  const plan = createPlan({ goal: 'test', steps: [] });
  const skill = makeTestSkill();
  bindSkillToPlan(plan, skill);
  const found = getPlanSkill(plan, 'test-runner');
  assert.ok(found);
  assert.strictEqual(found.skillId, 'test-runner');
  assert.strictEqual(found.skillName, 'Test Runner');
});

test('Skill-Exec: getPlanSkill returns null for unbound skill', () => {
  const plan = createPlan({ goal: 'test', steps: [] });
  assert.strictEqual(getPlanSkill(plan, 'nonexistent'), null);
});

// ── Test 2: Skill Instruction Injection ───────────────────
test('Skill-Exec: buildSkillContextForLLM injects skill instructions', () => {
  const skill = makeTestSkill();
  const base = 'You are a coding agent.';
  const context = buildSkillContextForLLM(skill, base);
  assert.ok(context.includes('You are a coding agent.'));
  assert.ok(context.includes('[Skill: Test Runner'));
  assert.ok(context.includes('Always use npm test'));
  assert.ok(context.includes('[End Skill Instruction]'));
});

test('Skill-Exec: buildSkillContextForLLM returns base when no instructions', () => {
  const skill = makeTestSkill({ instructions: '' });
  const base = 'Base context';
  const context = buildSkillContextForLLM(skill, base);
  assert.strictEqual(context, 'Base context');
});

test('Skill-Exec: buildSkillContextForLLM returns base when no skill', () => {
  const base = 'Base context';
  const context = buildSkillContextForLLM(null, base);
  assert.strictEqual(context, 'Base context');
});

// ── Test 3: Skill Tool Permission ─────────────────────────
test('Skill-Exec: assertSkillToolAllowed passes for allowed tool', () => {
  const skill = makeTestSkill();
  assert.doesNotThrow(() => {
    assertSkillToolAllowed(skill, 'run_command', ['run_command', 'read_file', 'write_file']);
  });
});

test('Skill-Exec: assertSkillToolAllowed throws for denied tool', () => {
  const skill = makeTestSkill();
  assert.throws(() => {
    assertSkillToolAllowed(skill, 'write_file', ['run_command', 'write_file']);
  }, /not permitted/);
});

test('Skill-Exec: assertSkillToolAllowed throws for unknown tool', () => {
  const skill = makeTestSkill();
  assert.throws(() => {
    assertSkillToolAllowed(skill, 'nonexistent', ['run_command']);
  }, /not permitted/);
});

// ── Test 4: Skill Registry Integration with Plan ──────────
test('Skill-Exec: registry + plan binding full flow', () => {
  const registry = new SkillRegistry(['run_command', 'read_file']);
  const skill = registry.register({
    id: 'test-runner',
    name: 'Test Runner',
    description: 'Run tests',
    version: '1.0.0',
    tools: ['run_command', 'read_file'],
    instructions: 'Use npm test',
  });
  registry.load('test-runner');
  assert.strictEqual(skill.status, SKILL_STATUS.AVAILABLE);

  const plan = createPlan({ goal: 'run tests', steps: [] });
  bindSkillToPlan(plan, skill);
  assert.strictEqual(plan.skills[0].skillId, 'test-runner');
});

// ── Test 5: Skill Cannot Bypass Tool Runtime ──────────────
test('Skill-Exec: skill with empty tools cannot use any tool', () => {
  const skill = makeTestSkill({ tools: [] });
  assert.ok(!isToolAllowedForSkill(skill, 'run_command', ['run_command']));
  assert.ok(!isToolAllowedForSkill(skill, 'read_file', ['read_file']));
});

test('Skill-Exec: skill can only use explicitly listed tools', () => {
  const skill = makeTestSkill({ tools: ['run_command'] });
  assert.ok(isToolAllowedForSkill(skill, 'run_command', ['run_command', 'read_file']));
  assert.ok(!isToolAllowedForSkill(skill, 'read_file', ['run_command', 'read_file']));
});

// ── Test 6: Skill Lifecycle with Plan ─────────────────────
test('Skill-Exec: skill lifecycle integrated with plan execution', () => {
  const registry = new SkillRegistry(['run_command']);
  const skill = registry.register({
    id: 's1', name: 'Test', description: 'desc', version: '1.0.0',
    tools: ['run_command'],
  });
  registry.load('s1');
  assert.strictEqual(skill.status, SKILL_STATUS.AVAILABLE);

  // Simulate execution start
  transitionSkillStatus(skill, SKILL_STATUS.RUNNING);
  assert.strictEqual(skill.status, SKILL_STATUS.RUNNING);

  // Simulate verification
  transitionSkillStatus(skill, SKILL_STATUS.VERIFYING);
  assert.strictEqual(skill.status, SKILL_STATUS.VERIFYING);

  // Simulate completion
  transitionSkillStatus(skill, SKILL_STATUS.COMPLETED);
  assert.strictEqual(skill.status, SKILL_STATUS.COMPLETED);
});

// ── Test 7: Skill Plan Without Skill (Backward Compat) ───
test('Skill-Exec: plan without skill still works (backward compat)', () => {
  const plan = createPlan({ goal: 'test', steps: [] });
  assert.strictEqual(plan.skills, undefined);
  // No skill binding — normal plan execution
  assert.strictEqual(getPlanSkill(plan, 'any-skill'), null);
});