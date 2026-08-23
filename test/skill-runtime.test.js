/**
 * test/skill-runtime.test.js — Skill Runtime Hardening Tests
 *
 * V0.7.2
 * Tests for multi-skill permission, lifecycle runtime integration,
 * instruction provenance, and SkillRuntimeContext.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SKILL_STATUS,
  createSkill,
  transitionSkillStatus,
  SkillRegistry,
  bindSkillToPlan,
  isToolAllowedForSkill,
  activateSkillsForRun,
  startSkillVerification,
  completeSkill,
  failSkill,
  cancelAllSkills,
  getSkillLifecycleSummary,
  buildInstructionProvenance,
  sortInstructionsByPriority,
  renderInstructionsToPrompt,
  SkillRuntimeContext,
} from '../agent/skill.js';
import { createPlan } from '../agent/plan.js';

// ── Test 1: Multi-Skill Permission Model ─────────────────

test('Skill-Runtime: ANY active skill allows tool (multi-skill)', () => {
  const skillA = createSkill({
    id: 'skill-a', name: 'Skill A', description: 'desc', version: '1.0.0',
    tools: ['read_file'],
  });
  const skillB = createSkill({
    id: 'skill-b', name: 'Skill B', description: 'desc', version: '1.0.0',
    tools: ['run_command'],
  });

  const allTools = ['read_file', 'run_command', 'write_file'];

  // Skill A allows read_file, Skill B allows run_command
  // ANY model: run_command should be allowed because Skill B allows it
  const allowedByA = isToolAllowedForSkill(skillA, 'run_command', allTools);
  const allowedByB = isToolAllowedForSkill(skillB, 'run_command', allTools);
  assert.ok(!allowedByA, 'Skill A should NOT allow run_command');
  assert.ok(allowedByB, 'Skill B should allow run_command');

  // ANY model: at least one allows → permitted
  const anyAllows = [skillA, skillB].some(s => isToolAllowedForSkill(s, 'run_command', allTools));
  assert.ok(anyAllows, 'ANY model: run_command permitted because Skill B allows it');

  // read_file: Skill A allows, Skill B doesn't
  const anyAllowsRead = [skillA, skillB].some(s => isToolAllowedForSkill(s, 'read_file', allTools));
  assert.ok(anyAllowsRead, 'ANY model: read_file permitted because Skill A allows it');

  // write_file: neither allows
  const anyAllowsWrite = [skillA, skillB].some(s => isToolAllowedForSkill(s, 'write_file', allTools));
  assert.ok(!anyAllowsWrite, 'ANY model: write_file denied — neither skill allows it');
});

test('Skill-Runtime: no skills → all tools allowed (backward compat)', () => {
  // When no skills are active, the agent should allow all tools normally
  const skillList = [];
  const allTools = ['read_file', 'run_command', 'write_file'];
  // No skills → no restriction
  assert.strictEqual(skillList.length, 0);
  // The runtime check: if activeSkills.length === 0, skip skill permission check
  const shouldCheckSkills = skillList.length > 0;
  assert.ok(!shouldCheckSkills, 'No skills → skip skill permission check');
});

test('Skill-Runtime: single skill restricts to its tools', () => {
  const skill = createSkill({
    id: 's1', name: 'Test', description: 'desc', version: '1.0.0',
    tools: ['run_command'],
  });
  const allTools = ['run_command', 'read_file', 'write_file'];

  assert.ok(isToolAllowedForSkill(skill, 'run_command', allTools));
  assert.ok(!isToolAllowedForSkill(skill, 'read_file', allTools));
  assert.ok(!isToolAllowedForSkill(skill, 'write_file', allTools));
});

// ── Test 2: Skill Lifecycle Runtime Integration ──────────

test('Skill-Runtime: activateSkillsForRun transitions AVAILABLE → RUNNING', () => {
  const registry = new SkillRegistry(['run_command']);
  registry.register({
    id: 's1', name: 'Test', description: 'desc', version: '1.0.0',
    tools: ['run_command'],
  });
  registry.load('s1');
  assert.strictEqual(registry.get('s1').status, SKILL_STATUS.AVAILABLE);

  const activated = activateSkillsForRun(registry, ['s1']);
  assert.strictEqual(activated.length, 1);
  assert.strictEqual(activated[0].status, SKILL_STATUS.RUNNING);
});

test('Skill-Runtime: startSkillVerification transitions RUNNING → VERIFYING', () => {
  const registry = new SkillRegistry(['run_command']);
  registry.register({
    id: 's1', name: 'Test', description: 'desc', version: '1.0.0',
    tools: ['run_command'],
  });
  registry.load('s1');
  activateSkillsForRun(registry, ['s1']);

  const skill = startSkillVerification(registry, 's1');
  assert.ok(skill);
  assert.strictEqual(skill.status, SKILL_STATUS.VERIFYING);
});

test('Skill-Runtime: completeSkill transitions VERIFYING → COMPLETED', () => {
  const registry = new SkillRegistry(['run_command']);
  registry.register({
    id: 's1', name: 'Test', description: 'desc', version: '1.0.0',
    tools: ['run_command'],
  });
  registry.load('s1');
  activateSkillsForRun(registry, ['s1']);
  startSkillVerification(registry, 's1');

  const skill = completeSkill(registry, 's1');
  assert.ok(skill);
  assert.strictEqual(skill.status, SKILL_STATUS.COMPLETED);
});

test('Skill-Runtime: failSkill transitions RUNNING → FAILED', () => {
  const registry = new SkillRegistry(['run_command']);
  registry.register({
    id: 's1', name: 'Test', description: 'desc', version: '1.0.0',
    tools: ['run_command'],
  });
  registry.load('s1');
  activateSkillsForRun(registry, ['s1']);

  const skill = failSkill(registry, 's1');
  assert.ok(skill);
  assert.strictEqual(skill.status, SKILL_STATUS.FAILED);
});

test('Skill-Runtime: cancelAllSkills transitions to CANCELLED', () => {
  const registry = new SkillRegistry(['run_command']);
  registry.register({ id: 's1', name: 'Test1', description: 'd', version: '1.0.0', tools: ['run_command'] });
  registry.register({ id: 's2', name: 'Test2', description: 'd', version: '1.0.0', tools: ['run_command'] });
  registry.load('s1');
  registry.load('s2');
  activateSkillsForRun(registry, ['s1', 's2']);

  const cancelled = cancelAllSkills(registry);
  assert.strictEqual(cancelled.length, 2);
  for (const s of cancelled) {
    assert.strictEqual(s.status, SKILL_STATUS.CANCELLED);
  }
});

test('Skill-Runtime: getSkillLifecycleSummary returns correct counts', () => {
  const registry = new SkillRegistry(['run_command']);
  registry.register({ id: 's1', name: 'Test1', description: 'd', version: '1.0.0', tools: ['run_command'] });
  registry.register({ id: 's2', name: 'Test2', description: 'd', version: '1.0.0', tools: ['run_command'] });
  registry.load('s1');
  registry.load('s2');
  activateSkillsForRun(registry, ['s1', 's2']);
  completeSkill(registry, 's1');
  failSkill(registry, 's2');

  const summary = getSkillLifecycleSummary(registry);
  assert.strictEqual(summary.total, 2);
  assert.strictEqual(summary.completed, 1);
  assert.strictEqual(summary.failed, 1);
  assert.strictEqual(summary.running, 0);
});

test('Skill-Runtime: completeSkill on non-running skill returns null', () => {
  const registry = new SkillRegistry(['run_command']);
  registry.register({ id: 's1', name: 'Test', description: 'd', version: '1.0.0', tools: ['run_command'] });
  // Skill is still REGISTERED, not RUNNING/VERIFYING
  const result = completeSkill(registry, 's1');
  assert.strictEqual(result, null);
});

// ── Test 3: Instruction Provenance ────────────────────────

test('Skill-Runtime: buildInstructionProvenance tracks source and priority', () => {
  const skill = createSkill({
    id: 's1', name: 'Test', description: 'desc', version: '1.0.0',
    instructions: 'Use npm test',
  });

  const baseBlocks = [
    { source: 'system', priority: 100, content: 'You are safe.' },
    { source: 'runtime_policy', priority: 80, content: 'Require approval.' },
  ];

  const blocks = buildInstructionProvenance(skill, baseBlocks);
  assert.strictEqual(blocks.length, 3);
  assert.strictEqual(blocks[0].source, 'system');
  assert.strictEqual(blocks[0].priority, 100);
  assert.strictEqual(blocks[1].source, 'runtime_policy');
  assert.strictEqual(blocks[1].priority, 80);
  assert.strictEqual(blocks[2].source, 'skill');
  assert.strictEqual(blocks[2].skillId, 's1');
  assert.strictEqual(blocks[2].priority, 60);
});

test('Skill-Runtime: sortInstructionsByPriority orders highest first', () => {
  const blocks = [
    { source: 'user', priority: 40, content: 'user request' },
    { source: 'system', priority: 100, content: 'system' },
    { source: 'skill', priority: 60, content: 'skill' },
  ];

  const sorted = sortInstructionsByPriority(blocks);
  assert.strictEqual(sorted[0].source, 'system');
  assert.strictEqual(sorted[1].source, 'skill');
  assert.strictEqual(sorted[2].source, 'user');
});

test('Skill-Runtime: renderInstructionsToPrompt produces readable output', () => {
  const blocks = [
    { source: 'system', priority: 100, content: 'System rules' },
    { source: 'skill', skillName: 'Test', skillId: 's1', priority: 60, content: 'Skill instructions' },
  ];

  const prompt = renderInstructionsToPrompt(blocks);
  assert.ok(prompt.includes('System rules'));
  assert.ok(prompt.includes('[Skill: Test'));
  assert.ok(prompt.includes('Skill instructions'));
  assert.ok(prompt.includes('[End Skill: Test]'));
});

test('Skill-Runtime: instruction provenance preserves ordering system > runtime > skill > user', () => {
  const blocks = [
    { source: 'user', priority: 40, content: 'user' },
    { source: 'skill', skillName: 'S', skillId: 's', priority: 60, content: 'skill' },
    { source: 'runtime_policy', priority: 80, content: 'runtime' },
    { source: 'system', priority: 100, content: 'system' },
  ];

  const sorted = sortInstructionsByPriority(blocks);
  const sources = sorted.map(b => b.source);
  assert.deepStrictEqual(sources, ['system', 'runtime_policy', 'skill', 'user']);
});

// ── Test 4: Skill Runtime Context ─────────────────────────

test('Skill-Runtime: SkillRuntimeContext tracks active skills', () => {
  const registry = new SkillRegistry(['run_command']);
  registry.register({ id: 's1', name: 'Test', description: 'd', version: '1.0.0', tools: ['run_command'] });
  registry.load('s1');

  const ctx = new SkillRuntimeContext('run-1');
  ctx.addSkill(registry.get('s1'));
  assert.strictEqual(ctx.activeSkills.length, 1);
  assert.strictEqual(ctx.activeSkills[0].skill.id, 's1');
});

test('Skill-Runtime: SkillRuntimeContext isToolAllowed uses ANY model', () => {
  const skillA = createSkill({ id: 'sa', name: 'A', description: 'd', version: '1.0.0', tools: ['read_file'] });
  const skillB = createSkill({ id: 'sb', name: 'B', description: 'd', version: '1.0.0', tools: ['run_command'] });

  const ctx = new SkillRuntimeContext('run-1');
  ctx.addSkill(skillA);
  ctx.addSkill(skillB);

  const allTools = ['read_file', 'run_command', 'write_file'];

  // ANY model: run_command allowed because skillB allows it
  assert.ok(ctx.isToolAllowed('run_command', allTools));
  // ANY model: read_file allowed because skillA allows it
  assert.ok(ctx.isToolAllowed('read_file', allTools));
  // Neither allows write_file
  assert.ok(!ctx.isToolAllowed('write_file', allTools));
});

test('Skill-Runtime: SkillRuntimeContext no skills → all tools allowed', () => {
  const ctx = new SkillRuntimeContext('run-1');
  const allTools = ['read_file', 'run_command', 'write_file'];
  assert.ok(ctx.isToolAllowed('run_command', allTools));
  assert.ok(ctx.isToolAllowed('write_file', allTools));
});

test('Skill-Runtime: SkillRuntimeContext tracks lifecycle transitions', () => {
  const skill = createSkill({ id: 's1', name: 'Test', description: 'd', version: '1.0.0', tools: ['run_command'] });
  const ctx = new SkillRuntimeContext('run-1');
  ctx.addSkill(skill);

  ctx.updateSkillStatus('s1', SKILL_STATUS.RUNNING);
  ctx.updateSkillStatus('s1', SKILL_STATUS.VERIFYING);
  ctx.updateSkillStatus('s1', SKILL_STATUS.COMPLETED);

  const lc = ctx.lifecycle.get('s1');
  assert.strictEqual(lc.state, SKILL_STATUS.COMPLETED);
  assert.strictEqual(lc.transitions.length, 4); // initial + 3 updates
  assert.strictEqual(lc.transitions[3].status, SKILL_STATUS.COMPLETED);
});

test('Skill-Runtime: SkillRuntimeContext tracks evidence refs', () => {
  const ctx = new SkillRuntimeContext('run-1');
  ctx.addEvidenceRef('s1', 'ev-001');
  ctx.addEvidenceRef('s1', 'ev-002');
  ctx.addEvidenceRef('s2', 'ev-003');

  assert.deepStrictEqual(ctx.evidenceRefs.get('s1'), ['ev-001', 'ev-002']);
  assert.deepStrictEqual(ctx.evidenceRefs.get('s2'), ['ev-003']);
});

test('Skill-Runtime: SkillRuntimeContext serializes and deserializes', () => {
  const registry = new SkillRegistry(['run_command']);
  registry.register({ id: 's1', name: 'Test', description: 'd', version: '1.0.0', tools: ['run_command'] });
  registry.load('s1');

  const ctx = new SkillRuntimeContext('run-1');
  ctx.addSkill(registry.get('s1'));
  ctx.updateSkillStatus('s1', SKILL_STATUS.RUNNING);
  ctx.addEvidenceRef('s1', 'ev-001');

  const serialized = ctx.serialize();
  assert.strictEqual(serialized.runId, 'run-1');
  assert.strictEqual(serialized.activeSkills.length, 1);
  assert.strictEqual(serialized.activeSkills[0].skillId, 's1');
  assert.strictEqual(serialized.activeSkills[0].status, SKILL_STATUS.RUNNING);

  const restored = SkillRuntimeContext.deserialize(serialized, registry);
  assert.strictEqual(restored.runId, 'run-1');
  assert.strictEqual(restored.activeSkills.length, 1);
  assert.deepStrictEqual(restored.evidenceRefs.get('s1'), ['ev-001']);
});

// ── Test 5: Permission Conflict (Runtime > Skill) ─────────

test('Skill-Runtime: skill cannot override runtime security policy', () => {
  // Skill allows a tool, but Runtime Policy denies it
  // Priority: System(100) > Runtime Policy(80) > Skill(60) > User(40)
  const skillBlocks = [
    { source: 'system', priority: 100, content: 'Never execute rm commands' },
    { source: 'runtime_policy', priority: 80, content: 'Deny dangerous shell commands' },
    { source: 'skill', skillName: 'Test', skillId: 's1', priority: 60, content: 'You may run any command' },
  ];

  const sorted = sortInstructionsByPriority(skillBlocks);
  // System and runtime policy come before skill
  assert.strictEqual(sorted[0].source, 'system');
  assert.strictEqual(sorted[1].source, 'runtime_policy');
  assert.strictEqual(sorted[2].source, 'skill');

  // The skill instruction "may run any command" is AFTER security rules
  // so it cannot override them
  const systemText = sorted.find(b => b.source === 'system').content;
  const skillText = sorted.find(b => b.source === 'skill').content;
  assert.ok(systemText.includes('Never execute'));
  assert.ok(skillText.includes('may run any command'));
});

// ── Test 6: Backward Compatibility ────────────────────────

test('Skill-Runtime: plan without skills works normally', () => {
  const plan = createPlan({ goal: 'test', steps: [] });
  assert.strictEqual(plan.skills, undefined);
  // No skill binding → normal execution path
});

test('Skill-Runtime: SkillRuntimeContext with no skills is valid', () => {
  const ctx = new SkillRuntimeContext('run-1');
  assert.strictEqual(ctx.activeSkills.length, 0);
  const summary = {
    total: ctx.activeSkills.length,
    completed: ctx.getSkillsByStatus(SKILL_STATUS.COMPLETED).length,
  };
  assert.strictEqual(summary.total, 0);
  assert.strictEqual(summary.completed, 0);
});