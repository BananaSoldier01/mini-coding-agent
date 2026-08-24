/**
 * test/skill-v1.test.js — Skill Runtime & Plugin System Tests
 *
 * V1.0.0
 * Tests for Skill Definition Model, Skill Registry, Skill Lifecycle,
 * Skill Capability Binding, Skill Execution Runtime, Plugin Package Format.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SkillRuntime,
  createSkillRuntime,
  createSkillDefinition,
  SKILL_EXECUTION_STATUS,
  CapabilityRegistry,
  createCapabilityRegistry,
  createCapability,
  enableCapability,
  disableCapability,
  CAPABILITY_STATUS,
  CAPABILITY_CATEGORIES,
  ToolRegistry,
  createToolRegistry,
  GovernanceManager,
  createGovernanceManager,
  RuntimePolicy,
  createPolicy,
  RuntimeSandbox,
  createDefaultSandbox,
  RuntimeEventEmitter,
  RuntimeEventStore,
  createEventStore,
  RUNTIME_EVENT_TYPES,
} from '../agent/skill.js';

// ── Test 1: Skill Definition Model ────────────────────────

test('Skill: createSkillDefinition has required fields', () => {
  const skill = createSkillDefinition({
    id: 'code-review',
    name: 'Code Review Skill',
    version: '1.0.0',
    tools: ['file_read', 'git_diff'],
    capabilities: ['file_read'],
  });
  assert.strictEqual(skill.id, 'code-review');
  assert.strictEqual(skill.name, 'Code Review Skill');
  assert.strictEqual(skill.version, '1.0.0');
  assert.deepStrictEqual(skill.tools, ['file_read', 'git_diff']);
  assert.deepStrictEqual(skill.capabilities, ['file_read']);
  assert.ok(skill.enabled);
});

test('Skill: createSkillDefinition auto-generates id', () => {
  const skill = createSkillDefinition({ name: 'Test' });
  assert.ok(skill.id);
  assert.ok(skill.id.startsWith('skill_'));
});

// ── Test 2: Skill Execution Pipeline ──────────────────────

test('SkillRuntime: executeSkill fails for unknown skill', async () => {
  const runtime = createSkillRuntime({});
  const result = await runtime.executeSkill('unknown_skill', { runId: 'run-1' });
  assert.ok(!result.success);
  assert.ok(result.reason.includes('not found'));
  assert.strictEqual(result.step, 'load');
});

test('SkillRuntime: executeSkill fails for disabled skill', async () => {
  const capRegistry = createCapabilityRegistry();
  const toolRegistry = createToolRegistry({ capabilityRegistry: capRegistry });
  const runtime = createSkillRuntime({
    skillRegistry: {
      get: () => ({ id: 's1', name: 'Test', enabled: false, tools: [], capabilities: [] }),
    },
    capabilityRegistry: capRegistry,
    toolRegistry,
  });

  const result = await runtime.executeSkill('s1', { runId: 'run-1' });
  assert.ok(!result.success);
  assert.ok(result.reason.includes('disabled'));
});

test('SkillRuntime: executeSkill passes capability check', async () => {
  const capRegistry = createCapabilityRegistry();
  const cap = createCapability({
    name: 'file_read',
    category: CAPABILITY_CATEGORIES.FILESYSTEM,
    riskLevel: 'low',
    permissions: ['read'],
  });
  capRegistry.register(cap);
  enableCapability(cap);

  const toolRegistry = createToolRegistry({ capabilityRegistry: capRegistry });
  toolRegistry.register({
    name: 'read_file',
    capabilityId: cap.id,
    riskLevel: 'low',
    handler: async (params) => ({ content: `file: ${params.path}` }),
  });

  const runtime = createSkillRuntime({
    skillRegistry: {
      get: () => ({
        id: 'code-review',
        name: 'Code Review',
        enabled: true,
        tools: ['read_file'],
        capabilities: ['file_read'],
      }),
    },
    capabilityRegistry: capRegistry,
    toolRegistry,
  });

  const result = await runtime.executeSkill('code-review', {
    runId: 'run-1',
    params: { path: '/workspace/a.js' },
  });
  assert.ok(result.success);
  assert.ok(result.evidence.length > 0);
  assert.strictEqual(result.step, 'completed');
});

test('SkillRuntime: executeSkill fails on missing capability', async () => {
  const capRegistry = createCapabilityRegistry();
  // No capabilities registered

  const runtime = createSkillRuntime({
    skillRegistry: {
      get: () => ({
        id: 'git-release',
        name: 'Git Release',
        enabled: true,
        tools: ['git_push'],
        capabilities: ['git_push'],
      }),
    },
    capabilityRegistry: capRegistry,
    toolRegistry: createToolRegistry(),
  });

  const result = await runtime.executeSkill('git-release', { runId: 'run-1' });
  assert.ok(!result.success);
  assert.strictEqual(result.step, 'capability');
  assert.ok(result.missingCapabilities.length > 0);
});

test('SkillRuntime: executeSkill fails on disabled capability', async () => {
  const capRegistry = createCapabilityRegistry();
  const cap = createCapability({
    name: 'git_push',
    category: CAPABILITY_CATEGORIES.GIT,
    riskLevel: 'critical',
    permissions: ['push'],
  });
  capRegistry.register(cap);
  // Not enabled

  const runtime = createSkillRuntime({
    skillRegistry: {
      get: () => ({
        id: 'git-release',
        name: 'Git Release',
        enabled: true,
        tools: ['git_push'],
        capabilities: ['git_push'],
      }),
    },
    capabilityRegistry: capRegistry,
    toolRegistry: createToolRegistry(),
  });

  const result = await runtime.executeSkill('git-release', { runId: 'run-1' });
  assert.ok(!result.success);
  assert.strictEqual(result.step, 'capability');
});

test('SkillRuntime: executeSkill requires approval for dangerous tools', async () => {
  const capRegistry = createCapabilityRegistry();
  const cap = createCapability({
    name: 'git_push',
    category: CAPABILITY_CATEGORIES.GIT,
    riskLevel: 'critical',
    permissions: ['push'],
  });
  capRegistry.register(cap);
  enableCapability(cap);

  const policy = createPolicy({
    requireApproval: ['git_push'],
  });
  const governance = createGovernanceManager({ policy });

  const toolRegistry = createToolRegistry({ governance });
  toolRegistry.register({
    name: 'git_push',
    capabilityId: cap.id,
    riskLevel: 'critical',
  });

  const runtime = createSkillRuntime({
    skillRegistry: {
      get: () => ({
        id: 'git-release',
        name: 'Git Release',
        enabled: true,
        tools: ['git_push'],
        capabilities: ['git_push'],
      }),
    },
    capabilityRegistry: capRegistry,
    toolRegistry,
    governance,
  });

  const result = await runtime.executeSkill('git-release', { runId: 'run-1' });
  assert.ok(!result.success);
  assert.strictEqual(result.step, 'approval');
  assert.ok(result.requiresApproval);
});

// ── Test 3: Skill Events ──────────────────────────────────

test('Skill: execution emits SKILL_EXECUTION_STARTED event', async () => {
  const store = createEventStore();
  const emitter = new RuntimeEventEmitter();
  emitter.setStore(store);

  const capRegistry = createCapabilityRegistry();
  const cap = createCapability({
    name: 'file_read',
    category: CAPABILITY_CATEGORIES.FILESYSTEM,
    riskLevel: 'low',
    permissions: ['read'],
  });
  capRegistry.register(cap);
  enableCapability(cap);

  const toolRegistry = createToolRegistry({ capabilityRegistry: capRegistry, emitter });
  toolRegistry.register({
    name: 'read_file',
    capabilityId: cap.id,
    riskLevel: 'low',
    handler: async (p) => ({ content: p.path }),
  });

  const runtime = createSkillRuntime({
    skillRegistry: {
      get: () => ({
        id: 'code-review',
        name: 'Code Review',
        enabled: true,
        tools: ['read_file'],
        capabilities: ['file_read'],
      }),
    },
    capabilityRegistry: capRegistry,
    toolRegistry,
    emitter,
  });

  await runtime.executeSkill('code-review', { runId: 'run-1', params: { path: '/workspace/a.js' } });

  const events = store.getEventsByRun('run-1');
  assert.ok(events.some(e => e.type === 'skill_execution_started'));
  assert.ok(events.some(e => e.type === 'skill_execution_completed'));
});

test('Skill: capability denied emits SKILL_CAPABILITY_DENIED event', async () => {
  const store = createEventStore();
  const emitter = new RuntimeEventEmitter();
  emitter.setStore(store);

  const capRegistry = createCapabilityRegistry();
  // No capabilities

  const runtime = createSkillRuntime({
    skillRegistry: {
      get: () => ({
        id: 'git-release',
        name: 'Git Release',
        enabled: true,
        tools: ['git_push'],
        capabilities: ['git_push'],
      }),
    },
    capabilityRegistry: capRegistry,
    toolRegistry: createToolRegistry(),
    emitter,
  });

  await runtime.executeSkill('git-release', { runId: 'run-1' });

  const events = store.getEventsByRun('run-1');
  assert.ok(events.some(e => e.type === 'skill_capability_denied'));
});

// ── Test 4: canExecute Pre-check ──────────────────────────

test('SkillRuntime: canExecute returns allowed for valid skill', async () => {
  const capRegistry = createCapabilityRegistry();
  const cap = createCapability({
    name: 'file_read',
    category: CAPABILITY_CATEGORIES.FILESYSTEM,
    riskLevel: 'low',
    permissions: ['read'],
  });
  capRegistry.register(cap);
  enableCapability(cap);

  const runtime = createSkillRuntime({
    skillRegistry: {
      get: () => ({
        id: 'code-review',
        name: 'Code Review',
        enabled: true,
        tools: ['read_file'],
        capabilities: ['file_read'],
      }),
    },
    capabilityRegistry: capRegistry,
    toolRegistry: createToolRegistry(),
  });

  const result = await runtime.canExecute('code-review', { runId: 'run-1' });
  assert.ok(result.allowed);
});

test('SkillRuntime: canExecute returns denied for missing capability', async () => {
  const capRegistry = createCapabilityRegistry();
  const runtime = createSkillRuntime({
    skillRegistry: {
      get: () => ({
        id: 'git-release',
        name: 'Git Release',
        enabled: true,
        tools: ['git_push'],
        capabilities: ['git_push'],
      }),
    },
    capabilityRegistry: capRegistry,
    toolRegistry: createToolRegistry(),
  });

  const result = await runtime.canExecute('git-release', { runId: 'run-1' });
  assert.ok(!result.allowed);
  assert.ok(result.missing.length > 0);
});

// ── Test 5: Plugin Package Format ─────────────────────────

test('Plugin: createSkillDefinition from plugin format', () => {
  // Simulate loading from skill.json
  const skillJson = {
    id: 'code-review',
    version: '1.0.0',
    tools: ['file_read', 'git_diff'],
    capabilities: ['file_read'],
  };

  const skill = createSkillDefinition({
    id: skillJson.id,
    version: skillJson.version,
    tools: skillJson.tools,
    capabilities: skillJson.capabilities,
  });

  assert.strictEqual(skill.id, 'code-review');
  assert.strictEqual(skill.version, '1.0.0');
  assert.deepStrictEqual(skill.tools, ['file_read', 'git_diff']);
  assert.deepStrictEqual(skill.capabilities, ['file_read']);
});

test('Plugin: skill with config', () => {
  const skill = createSkillDefinition({
    id: 'code-review',
    name: 'Code Review',
    config: {
      maxLines: 100,
      style: 'strict',
    },
  });
  assert.deepStrictEqual(skill.config, { maxLines: 100, style: 'strict' });
});

// ── Test 6: Integration ───────────────────────────────────

test('Integration: full skill execution with governance', async () => {
  const store = createEventStore();
  const emitter = new RuntimeEventEmitter();
  emitter.setStore(store);

  // Capability
  const capRegistry = createCapabilityRegistry({ emitter });
  const cap = createCapability({
    name: 'file_read',
    category: CAPABILITY_CATEGORIES.FILESYSTEM,
    riskLevel: 'low',
    permissions: ['read'],
  });
  capRegistry.register(cap, emitter, { runId: 'run-1' });
  enableCapability(cap, emitter, { runId: 'run-1' });

  // Tool
  const toolRegistry = createToolRegistry({
    capabilityRegistry: capRegistry,
    emitter,
  });
  toolRegistry.register({
    name: 'read_file',
    capabilityId: cap.id,
    riskLevel: 'low',
    handler: async (p) => ({ content: `read: ${p.path}` }),
  });

  // Skill Runtime
  const runtime = createSkillRuntime({
    skillRegistry: {
      get: () => ({
        id: 'code-review',
        name: 'Code Review',
        enabled: true,
        tools: ['read_file'],
        capabilities: ['file_read'],
      }),
    },
    capabilityRegistry: capRegistry,
    toolRegistry,
    emitter,
  });

  const result = await runtime.executeSkill('code-review', {
    runId: 'run-1',
    params: { path: '/workspace/src/a.js' },
  });

  assert.ok(result.success);
  assert.ok(result.evidence.length > 0);

  // Verify events
  const events = store.getEventsByRun('run-1');
  const types = events.map(e => e.type);
  assert.ok(types.includes('capability_registered'));
  assert.ok(types.includes('capability_enabled'));
  assert.ok(types.includes('skill_execution_started'));
  assert.ok(types.includes('skill_execution_completed'));
});

test('Integration: replay reconstructs skill execution', async () => {
  const store = createEventStore();
  const emitter = new RuntimeEventEmitter();
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

  const runtime = createSkillRuntime({
    skillRegistry: {
      get: () => ({
        id: 'code-review',
        name: 'Code Review',
        enabled: true,
        tools: ['read_file'],
        capabilities: ['file_read'],
      }),
    },
    capabilityRegistry: capRegistry,
    toolRegistry,
    emitter,
  });

  await runtime.executeSkill('code-review', {
    runId: 'run-1',
    params: { path: '/workspace/a.js' },
  });

  // Replay
  const events = store.getEventsByRun('run-1');
  assert.ok(events.some(e => e.type === 'skill_execution_started'));
  assert.ok(events.some(e => e.type === 'skill_execution_completed'));
});

test('Integration: skill respects sandbox boundary', async () => {
  const sandbox = createDefaultSandbox('/workspace');
  const capRegistry = createCapabilityRegistry();
  const cap = createCapability({
    name: 'file_write',
    category: CAPABILITY_CATEGORIES.FILESYSTEM,
    riskLevel: 'medium',
    permissions: ['write'],
    constraints: { allowedPaths: ['/workspace/'] },
  });
  capRegistry.register(cap);
  enableCapability(cap);

  const toolRegistry = createToolRegistry({ capabilityRegistry: capRegistry });
  toolRegistry.register({
    name: 'write_file',
    capabilityId: cap.id,
    riskLevel: 'medium',
    handler: async (p) => ({ written: p.path }),
  });

  const runtime = createSkillRuntime({
    skillRegistry: {
      get: () => ({
        id: 'write-skill',
        name: 'Write Skill',
        enabled: true,
        tools: ['write_file'],
        capabilities: ['file_write'],
      }),
    },
    capabilityRegistry: capRegistry,
    toolRegistry,
    sandbox,
  });

  // Allowed path
  const result1 = await runtime.executeSkill('write-skill', {
    runId: 'run-1',
    params: { path: '/workspace/a.js' },
  });
  assert.ok(result1.success);

  // Blocked path
  const result2 = await runtime.executeSkill('write-skill', {
    runId: 'run-1',
    params: { path: '/etc/passwd' },
  });
  // Tool execution should fail due to sandbox boundary
  assert.ok(!result2.result.toolResults[0].success);
  assert.ok(result2.result.toolResults[0].reason.includes('outside'));
});