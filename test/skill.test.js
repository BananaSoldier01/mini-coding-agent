/**
 * test/skill.test.js — Skill Model Unit Tests
 *
 * V0.7.0
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SKILL_STATUS,
  SKILL_TRANSITIONS,
  SKILL_INSTRUCTION_PRIORITY,
  validateSkill,
  createSkill,
  transitionSkillStatus,
  buildSkillInstructionContext,
  isToolAllowedForSkill,
  serializeSkill,
  deserializeSkill,
  SkillRegistry,
} from '../agent/skill.js';

// ── Test 1: Skill Status Constants ────────────────────────
test('Skill: Status constants complete', () => {
  assert.strictEqual(SKILL_STATUS.REGISTERED, 'registered');
  assert.strictEqual(SKILL_STATUS.AVAILABLE, 'available');
  assert.strictEqual(SKILL_STATUS.RUNNING, 'running');
  assert.strictEqual(SKILL_STATUS.VERIFYING, 'verifying');
  assert.strictEqual(SKILL_STATUS.COMPLETED, 'completed');
  assert.strictEqual(SKILL_STATUS.FAILED, 'failed');
  assert.strictEqual(SKILL_STATUS.CANCELLED, 'cancelled');
});

// ── Test 2: Skill Transitions ─────────────────────────────
test('Skill: REGISTERED → AVAILABLE is valid', () => {
  const skill = createSkill({
    id: 's1', name: 'Test', description: 'desc', version: '1.0.0',
  });
  assert.strictEqual(skill.status, SKILL_STATUS.REGISTERED);
  assert.ok(transitionSkillStatus(skill, SKILL_STATUS.AVAILABLE));
  assert.strictEqual(skill.status, SKILL_STATUS.AVAILABLE);
});

test('Skill: REGISTERED → RUNNING is invalid', () => {
  const skill = createSkill({
    id: 's1', name: 'Test', description: 'desc', version: '1.0.0',
  });
  assert.ok(!transitionSkillStatus(skill, SKILL_STATUS.RUNNING));
  assert.strictEqual(skill.status, SKILL_STATUS.REGISTERED);
});

test('Skill: AVAILABLE → RUNNING → VERIFYING → COMPLETED', () => {
  const skill = createSkill({
    id: 's1', name: 'Test', description: 'desc', version: '1.0.0',
  });
  transitionSkillStatus(skill, SKILL_STATUS.AVAILABLE);
  assert.ok(transitionSkillStatus(skill, SKILL_STATUS.RUNNING));
  assert.ok(transitionSkillStatus(skill, SKILL_STATUS.VERIFYING));
  assert.ok(transitionSkillStatus(skill, SKILL_STATUS.COMPLETED));
  assert.strictEqual(skill.status, SKILL_STATUS.COMPLETED);
});

test('Skill: COMPLETED → any transition is invalid', () => {
  const skill = createSkill({
    id: 's1', name: 'Test', description: 'desc', version: '1.0.0',
  });
  transitionSkillStatus(skill, SKILL_STATUS.AVAILABLE);
  transitionSkillStatus(skill, SKILL_STATUS.RUNNING);
  transitionSkillStatus(skill, SKILL_STATUS.VERIFYING);
  transitionSkillStatus(skill, SKILL_STATUS.COMPLETED);
  assert.ok(!transitionSkillStatus(skill, SKILL_STATUS.RUNNING));
  assert.ok(!transitionSkillStatus(skill, SKILL_STATUS.FAILED));
});

// ── Test 3: Skill Validation ──────────────────────────────
test('Skill: validateSkill rejects missing id', () => {
  const result = validateSkill({ name: 'Test', description: 'desc', version: '1.0.0' });
  assert.ok(!result.valid);
  assert.ok(result.errors.some(e => e.includes('id')));
});

test('Skill: validateSkill rejects missing name', () => {
  const result = validateSkill({ id: 's1', description: 'desc', version: '1.0.0' });
  assert.ok(!result.valid);
  assert.ok(result.errors.some(e => e.includes('name')));
});

test('Skill: validateSkill rejects missing description', () => {
  const result = validateSkill({ id: 's1', name: 'Test', version: '1.0.0' });
  assert.ok(!result.valid);
  assert.ok(result.errors.some(e => e.includes('description')));
});

test('Skill: validateSkill rejects missing version', () => {
  const result = validateSkill({ id: 's1', name: 'Test', description: 'desc' });
  assert.ok(!result.valid);
  assert.ok(result.errors.some(e => e.includes('version')));
});

test('Skill: validateSkill rejects non-array tools', () => {
  const result = validateSkill({
    id: 's1', name: 'Test', description: 'desc', version: '1.0.0',
    tools: 'not_an_array',
  });
  assert.ok(!result.valid);
  assert.ok(result.errors.some(e => e.includes('tools')));
});

test('Skill: validateSkill rejects unknown verification type', () => {
  const result = validateSkill({
    id: 's1', name: 'Test', description: 'desc', version: '1.0.0',
    verification: [{ type: 'banana' }],
  });
  assert.ok(!result.valid);
  assert.ok(result.errors.some(e => e.includes('banana')));
});

test('Skill: validateSkill accepts valid skill', () => {
  const result = validateSkill({
    id: 'test-runner', name: 'Test Runner', description: 'Run tests', version: '1.0.0',
    tools: ['run_command', 'read_file'],
    verification: [{ type: 'command', command: 'npm test' }],
  });
  assert.ok(result.valid);
  assert.strictEqual(result.errors.length, 0);
});

// ── Test 4: Skill Factory ─────────────────────────────────
test('Skill: createSkill creates valid skill with defaults', () => {
  const skill = createSkill({
    id: 'test-runner', name: 'Test Runner', description: 'Run tests', version: '1.0.0',
  });
  assert.strictEqual(skill.id, 'test-runner');
  assert.strictEqual(skill.name, 'Test Runner');
  assert.strictEqual(skill.description, 'Run tests');
  assert.strictEqual(skill.version, '1.0.0');
  assert.deepStrictEqual(skill.tools, []);
  assert.deepStrictEqual(skill.capabilities, []);
  assert.strictEqual(skill.instructions, '');
  assert.deepStrictEqual(skill.verification, []);
  assert.strictEqual(skill.status, SKILL_STATUS.REGISTERED);
  assert.ok(skill.createdAt > 0);
});

test('Skill: createSkill throws on invalid definition', () => {
  assert.throws(() => {
    createSkill({ name: 'No ID' });
  }, /Invalid Skill/);
});

test('Skill: createSkill preserves tools and verification', () => {
  const skill = createSkill({
    id: 's1', name: 'Test', description: 'desc', version: '1.0.0',
    tools: ['run_command', 'read_file'],
    verification: [{ type: 'command', command: 'npm test' }],
    instructions: 'Run tests carefully',
    capabilities: ['test-execution'],
  });
  assert.deepStrictEqual(skill.tools, ['run_command', 'read_file']);
  assert.deepStrictEqual(skill.verification, [{ type: 'command', command: 'npm test' }]);
  assert.strictEqual(skill.instructions, 'Run tests carefully');
  assert.deepStrictEqual(skill.capabilities, ['test-execution']);
});

// ── Test 5: Instruction Layer ─────────────────────────────
test('Skill: buildSkillInstructionContext returns formatted block', () => {
  const skill = createSkill({
    id: 's1', name: 'Test Runner', description: 'desc', version: '1.0.0',
    instructions: 'Run tests carefully',
  });
  const context = buildSkillInstructionContext(skill);
  assert.ok(context.includes('[Skill: Test Runner'));
  assert.ok(context.includes('v1.0.0'));
  assert.ok(context.includes('Run tests carefully'));
  assert.ok(context.includes('[End Skill Instruction]'));
});

test('Skill: buildSkillInstructionContext returns empty for no instructions', () => {
  const skill = createSkill({
    id: 's1', name: 'Test', description: 'desc', version: '1.0.0',
  });
  const context = buildSkillInstructionContext(skill);
  assert.strictEqual(context, '');
});

test('Skill: instruction priority constants exist', () => {
  assert.ok(SKILL_INSTRUCTION_PRIORITY.SYSTEM > SKILL_INSTRUCTION_PRIORITY.RUNTIME_POLICY);
  assert.ok(SKILL_INSTRUCTION_PRIORITY.RUNTIME_POLICY > SKILL_INSTRUCTION_PRIORITY.USER_EXPLICIT);
  assert.ok(SKILL_INSTRUCTION_PRIORITY.USER_EXPLICIT > SKILL_INSTRUCTION_PRIORITY.SKILL_INSTRUCTION);
  assert.ok(SKILL_INSTRUCTION_PRIORITY.SKILL_INSTRUCTION > SKILL_INSTRUCTION_PRIORITY.DEFAULT_HEURISTIC);
});

// ── Test 6: Tool Permission ───────────────────────────────
test('Skill: isToolAllowedForSkill allows listed tools', () => {
  const skill = createSkill({
    id: 's1', name: 'Test', description: 'desc', version: '1.0.0',
    tools: ['run_command', 'read_file'],
  });
  assert.ok(isToolAllowedForSkill(skill, 'run_command', ['run_command', 'read_file', 'write_file']));
  assert.ok(isToolAllowedForSkill(skill, 'read_file', ['run_command', 'read_file', 'write_file']));
});

test('Skill: isToolAllowedForSkill denies unlisted tools', () => {
  const skill = createSkill({
    id: 's1', name: 'Test', description: 'desc', version: '1.0.0',
    tools: ['run_command'],
  });
  assert.ok(!isToolAllowedForSkill(skill, 'write_file', ['run_command', 'write_file']));
});

test('Skill: isToolAllowedForSkill denies when tools list is empty', () => {
  const skill = createSkill({
    id: 's1', name: 'Test', description: 'desc', version: '1.0.0',
  });
  assert.ok(!isToolAllowedForSkill(skill, 'run_command', ['run_command']));
});

// ── Test 7: Serialization ─────────────────────────────────
test('Skill: serializeSkill preserves all fields', () => {
  const skill = createSkill({
    id: 's1', name: 'Test', description: 'desc', version: '1.0.0',
    tools: ['run_command'],
  });
  transitionSkillStatus(skill, SKILL_STATUS.AVAILABLE);
  const serialized = serializeSkill(skill);
  assert.strictEqual(serialized.id, 's1');
  assert.strictEqual(serialized.name, 'Test');
  assert.strictEqual(serialized.status, SKILL_STATUS.AVAILABLE);
  assert.deepStrictEqual(serialized.tools, ['run_command']);
  assert.ok(serialized.createdAt > 0);
});

test('Skill: deserializeSkill restores skill', () => {
  const skill = createSkill({
    id: 's1', name: 'Test', description: 'desc', version: '1.0.0',
    tools: ['run_command'],
  });
  transitionSkillStatus(skill, SKILL_STATUS.AVAILABLE);
  const serialized = serializeSkill(skill);
  const restored = deserializeSkill(serialized);
  assert.ok(restored);
  assert.strictEqual(restored.id, 's1');
  assert.strictEqual(restored.name, 'Test');
  assert.strictEqual(restored.status, SKILL_STATUS.AVAILABLE);
  assert.deepStrictEqual(restored.tools, ['run_command']);
});

test('Skill: deserializeSkill returns null for null input', () => {
  const restored = deserializeSkill(null);
  assert.strictEqual(restored, null);
});

// ── Test 8: Skill Registry ────────────────────────────────
test('SkillRegistry: register creates skill', () => {
  const registry = new SkillRegistry(['run_command', 'read_file']);
  const skill = registry.register({
    id: 'test-runner', name: 'Test Runner', description: 'Run tests', version: '1.0.0',
    tools: ['run_command'],
  });
  assert.strictEqual(skill.id, 'test-runner');
  assert.strictEqual(skill.status, SKILL_STATUS.REGISTERED);
  assert.strictEqual(registry.count(), 1);
});

test('SkillRegistry: register rejects invalid skill', () => {
  const registry = new SkillRegistry(['run_command']);
  assert.throws(() => {
    registry.register({ name: 'No ID' });
  }, /Cannot register invalid/);
});

test('SkillRegistry: register rejects unknown tools', () => {
  const registry = new SkillRegistry(['run_command']);
  assert.throws(() => {
    registry.register({
      id: 's1', name: 'Test', description: 'desc', version: '1.0.0',
      tools: ['nonexistent_tool'],
    });
  }, /unknown tools/);
});

test('SkillRegistry: register rejects duplicate id', () => {
  const registry = new SkillRegistry(['run_command']);
  registry.register({
    id: 's1', name: 'Test', description: 'desc', version: '1.0.0',
  });
  assert.throws(() => {
    registry.register({
      id: 's1', name: 'Test2', description: 'desc2', version: '2.0.0',
    });
  }, /already registered/);
});

test('SkillRegistry: get returns skill by id', () => {
  const registry = new SkillRegistry(['run_command']);
  registry.register({
    id: 's1', name: 'Test', description: 'desc', version: '1.0.0',
  });
  const skill = registry.get('s1');
  assert.ok(skill);
  assert.strictEqual(skill.id, 's1');
  assert.strictEqual(registry.get('nonexistent'), null);
});

test('SkillRegistry: list returns all skills', () => {
  const registry = new SkillRegistry(['run_command']);
  registry.register({ id: 's1', name: 'Test1', description: 'd1', version: '1.0.0' });
  registry.register({ id: 's2', name: 'Test2', description: 'd2', version: '1.0.0' });
  const all = registry.list();
  assert.strictEqual(all.length, 2);
});

test('SkillRegistry: list filters by status', () => {
  const registry = new SkillRegistry(['run_command']);
  registry.register({ id: 's1', name: 'Test1', description: 'd1', version: '1.0.0' });
  registry.load('s1');
  const available = registry.list(SKILL_STATUS.AVAILABLE);
  assert.strictEqual(available.length, 1);
  assert.strictEqual(available[0].id, 's1');
  const registered = registry.list(SKILL_STATUS.REGISTERED);
  assert.strictEqual(registered.length, 0);
});

test('SkillRegistry: load transitions to AVAILABLE', () => {
  const registry = new SkillRegistry(['run_command']);
  registry.register({ id: 's1', name: 'Test', description: 'desc', version: '1.0.0' });
  const loaded = registry.load('s1');
  assert.ok(loaded);
  assert.strictEqual(loaded.status, SKILL_STATUS.AVAILABLE);
});

test('SkillRegistry: load returns null for unknown id', () => {
  const registry = new SkillRegistry(['run_command']);
  assert.strictEqual(registry.load('nonexistent'), null);
});

test('SkillRegistry: validate delegates to validateSkill', () => {
  const registry = new SkillRegistry(['run_command']);
  const valid = registry.validate({
    id: 's1', name: 'Test', description: 'desc', version: '1.0.0',
  });
  assert.ok(valid.valid);

  const invalid = registry.validate({ name: 'No ID' });
  assert.ok(!invalid.valid);
});

test('SkillRegistry: unregister removes skill', () => {
  const registry = new SkillRegistry(['run_command']);
  registry.register({ id: 's1', name: 'Test', description: 'desc', version: '1.0.0' });
  assert.strictEqual(registry.count(), 1);
  assert.ok(registry.unregister('s1'));
  assert.strictEqual(registry.count(), 0);
  assert.ok(!registry.has('s1'));
});

test('SkillRegistry: has checks existence', () => {
  const registry = new SkillRegistry(['run_command']);
  registry.register({ id: 's1', name: 'Test', description: 'desc', version: '1.0.0' });
  assert.ok(registry.has('s1'));
  assert.ok(!registry.has('nonexistent'));
});

test('SkillRegistry: empty tools list means no tools allowed', () => {
  const registry = new SkillRegistry(['run_command']);
  // Skill with no tools list — should still register (tools is optional)
  const skill = registry.register({
    id: 's1', name: 'Test', description: 'desc', version: '1.0.0',
  });
  assert.strictEqual(skill.tools.length, 0);
});