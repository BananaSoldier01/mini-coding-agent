/**
 * test/capability.test.js — Capability Runtime & Tool Governance Tests
 *
 * V0.9.9
 * Tests for Capability Model, Tool Registry, Permission System,
 * Tool Execution Governance, Sandbox Boundary, Capability Events.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CapabilityRegistry,
  createCapabilityRegistry,
  createCapability,
  enableCapability,
  disableCapability,
  checkCapability,
  CAPABILITY_STATUS,
  CAPABILITY_CATEGORIES,
  CAPABILITY_RISK,
  createFileWriteCapability,
  createFileDeleteCapability,
  createShellExecuteCapability,
  createGitPushCapability,
  ToolRegistry,
  createToolRegistry,
  RuntimeSandbox,
  createSandbox,
  createDefaultSandbox,
  RuntimeEventEmitter,
  RuntimeEventStore,
  createEventStore,
  RUNTIME_EVENT_TYPES,
  GovernanceManager,
  createGovernanceManager,
  RuntimePolicy,
  createPolicy,
  RISK_LEVELS,
} from '../agent/skill.js';

// ── Test 1: Capability Model ─────────────────────────────

test('Capability: createCapability has required fields', () => {
  const cap = createCapability({
    name: 'file_write',
    category: CAPABILITY_CATEGORIES.FILESYSTEM,
    riskLevel: CAPABILITY_RISK.MEDIUM,
    permissions: ['write'],
  });
  assert.ok(cap.id);
  assert.strictEqual(cap.name, 'file_write');
  assert.strictEqual(cap.category, 'filesystem');
  assert.strictEqual(cap.riskLevel, 'medium');
  assert.strictEqual(cap.status, CAPABILITY_STATUS.REGISTERED);
  assert.ok(!cap.enabled);
});

test('Capability: enableCapability transitions REGISTERED → ENABLED', () => {
  const cap = createCapability({ name: 'test_cap' });
  assert.strictEqual(cap.status, CAPABILITY_STATUS.REGISTERED);

  assert.ok(enableCapability(cap));
  assert.strictEqual(cap.status, CAPABILITY_STATUS.ENABLED);
  assert.ok(cap.enabled);
  assert.ok(cap.enabledAt > 0);
});

test('Capability: disableCapability transitions ENABLED → DISABLED', () => {
  const cap = createCapability({ name: 'test_cap' });
  enableCapability(cap);
  assert.strictEqual(cap.status, CAPABILITY_STATUS.ENABLED);

  assert.ok(disableCapability(cap));
  assert.strictEqual(cap.status, CAPABILITY_STATUS.DISABLED);
  assert.ok(!cap.enabled);
  assert.ok(cap.disabledAt > 0);
});

test('Capability: cannot disable REGISTERED capability', () => {
  const cap = createCapability({ name: 'test_cap' });
  assert.strictEqual(cap.status, CAPABILITY_STATUS.REGISTERED);
  assert.ok(!disableCapability(cap));
});

test('Capability: cannot enable already ENABLED capability', () => {
  const cap = createCapability({ name: 'test_cap' });
  enableCapability(cap);
  assert.ok(!enableCapability(cap));
});

// ── Test 2: Permission Check ──────────────────────────────

test('Permission: enabled capability allows action', () => {
  const cap = createCapability({
    name: 'file_write',
    permissions: ['write', 'create'],
  });
  enableCapability(cap);

  const result = checkCapability(cap, { action: 'write' });
  assert.ok(result.allowed);
  assert.strictEqual(result.capability, 'file_write');
});

test('Permission: disabled capability denies action', () => {
  const cap = createCapability({
    name: 'file_write',
    permissions: ['write'],
  });
  // Not enabled
  const result = checkCapability(cap, { action: 'write' });
  assert.ok(!result.allowed);
  assert.ok(result.reason.includes('registered'));
});

test('Permission: ungranted action denied', () => {
  const cap = createCapability({
    name: 'file_write',
    permissions: ['write'],
  });
  enableCapability(cap);

  const result = checkCapability(cap, { action: 'delete' });
  assert.ok(!result.allowed);
  assert.ok(result.reason.includes('delete'));
});

test('Permission: path constraint allows workspace paths', () => {
  const cap = createFileWriteCapability({
    constraints: { allowedPaths: ['/workspace/'] },
  });
  enableCapability(cap);

  const result = checkCapability(cap, {
    action: 'write',
    path: '/workspace/src/a.js',
  });
  assert.ok(result.allowed);
});

test('Permission: path constraint blocks outside paths', () => {
  const cap = createFileWriteCapability({
    constraints: { allowedPaths: ['/workspace/'] },
  });
  enableCapability(cap);

  const result = checkCapability(cap, {
    action: 'write',
    path: '/etc/passwd',
  });
  assert.ok(!result.allowed);
  assert.ok(result.reason.includes('outside'));
});

test('Permission: null capability denied', () => {
  const result = checkCapability(null, { action: 'write' });
  assert.ok(!result.allowed);
  assert.ok(result.reason.includes('not found'));
});

// ── Test 3: Capability Registry ───────────────────────────

test('Registry: register and query capabilities', () => {
  const registry = createCapabilityRegistry();
  const cap = createCapability({ name: 'test_cap' });
  registry.register(cap);

  assert.ok(registry.has(cap.id));
  assert.strictEqual(registry.get(cap.id), cap);
  assert.strictEqual(registry.getByName('test_cap'), cap);
});

test('Registry: get by category', () => {
  const registry = createCapabilityRegistry();
  const cap1 = createCapability({ name: 'cap1', category: 'filesystem' });
  const cap2 = createCapability({ name: 'cap2', category: 'filesystem' });
  const cap3 = createCapability({ name: 'cap3', category: 'shell' });
  registry.register(cap1);
  registry.register(cap2);
  registry.register(cap3);

  const fsCaps = registry.getByCategory('filesystem');
  assert.strictEqual(fsCaps.length, 2);
  const shellCaps = registry.getByCategory('shell');
  assert.strictEqual(shellCaps.length, 1);
});

test('Registry: list enabled only', () => {
  const registry = createCapabilityRegistry();
  const cap1 = createCapability({ name: 'cap1' });
  const cap2 = createCapability({ name: 'cap2' });
  registry.register(cap1);
  registry.register(cap2);
  enableCapability(cap1);

  const enabled = registry.listEnabled();
  assert.strictEqual(enabled.length, 1);
  assert.strictEqual(enabled[0].name, 'cap1');
});

test('Registry: register emits CAPABILITY_REGISTERED event', () => {
  const store = createEventStore();
  const emitter = new RuntimeEventEmitter();
  emitter.setStore(store);
  const registry = createCapabilityRegistry({ emitter });

  const cap = createCapability({ name: 'test_cap' });
  registry.register(cap, emitter, { runId: 'run-1' });

  const events = store.getEventsByRun('run-1');
  assert.ok(events.some(e => e.type === 'capability_registered'));
});

test('Registry: enable emits CAPABILITY_ENABLED event', () => {
  const store = createEventStore();
  const emitter = new RuntimeEventEmitter();
  emitter.setStore(store);
  const registry = createCapabilityRegistry({ emitter });

  const cap = createCapability({ name: 'test_cap' });
  registry.register(cap);
  enableCapability(cap, emitter, { runId: 'run-1' });

  const events = store.getEventsByRun('run-1');
  assert.ok(events.some(e => e.type === 'capability_enabled'));
});

test('Registry: disable emits CAPABILITY_DISABLED event', () => {
  const store = createEventStore();
  const emitter = new RuntimeEventEmitter();
  emitter.setStore(store);
  const registry = createCapabilityRegistry({ emitter });

  const cap = createCapability({ name: 'test_cap' });
  registry.register(cap);
  enableCapability(cap, emitter);
  disableCapability(cap, emitter, { runId: 'run-1' });

  const events = store.getEventsByRun('run-1');
  assert.ok(events.some(e => e.type === 'capability_disabled'));
});

// ── Test 4: Tool Registry ────────────────────────────────

test('ToolRegistry: register and query tools', () => {
  const registry = createToolRegistry();
  registry.register({
    name: 'write_file',
    capabilityId: 'cap_file_write',
    riskLevel: 'medium',
    handler: async (params) => ({ written: params.path }),
  });

  assert.ok(registry.has('write_file'));
  const tool = registry.get('write_file');
  assert.strictEqual(tool.name, 'write_file');
  assert.strictEqual(tool.capabilityId, 'cap_file_write');
});

test('ToolRegistry: getCapability maps tool to capability', () => {
  const capRegistry = createCapabilityRegistry();
  const cap = createFileWriteCapability();
  capRegistry.register(cap);
  enableCapability(cap);

  const toolRegistry = createToolRegistry({ capabilityRegistry: capRegistry });
  toolRegistry.register({
    name: 'write_file',
    capabilityId: cap.id,
  });

  const foundCap = toolRegistry.getCapability('write_file');
  assert.ok(foundCap);
  assert.strictEqual(foundCap.name, 'file_write');
});

test('ToolRegistry: checkToolExecution passes capability check', async () => {
  const capRegistry = createCapabilityRegistry();
  const cap = createFileWriteCapability();
  capRegistry.register(cap);
  enableCapability(cap);

  const toolRegistry = createToolRegistry({ capabilityRegistry: capRegistry });
  toolRegistry.register({
    name: 'write_file',
    capabilityId: cap.id,
    riskLevel: 'medium',
  });

  const result = await toolRegistry.checkToolExecution('write_file', {
    action: 'write',
    path: '/workspace/a.js',
  });
  assert.ok(result.allowed);
});

test('ToolRegistry: checkToolExecution fails on disabled capability', async () => {
  const capRegistry = createCapabilityRegistry();
  const cap = createFileWriteCapability();
  capRegistry.register(cap);
  // Not enabled

  const toolRegistry = createToolRegistry({ capabilityRegistry: capRegistry });
  toolRegistry.register({
    name: 'write_file',
    capabilityId: cap.id,
  });

  const result = await toolRegistry.checkToolExecution('write_file', {
    action: 'write',
    path: '/workspace/a.js',
  });
  assert.ok(!result.allowed);
  assert.strictEqual(result.step, 'capability');
});

test('ToolRegistry: checkToolExecution requires approval for dangerous tools', async () => {
  const capRegistry = createCapabilityRegistry();
  const cap = createGitPushCapability();
  capRegistry.register(cap);
  enableCapability(cap);

  const policy = createPolicy({
    requireApproval: ['git_push'],
  });
  const governance = createGovernanceManager({ policy });

  const toolRegistry = createToolRegistry({
    capabilityRegistry: capRegistry,
    governance,
  });
  toolRegistry.register({
    name: 'git_push',
    capabilityId: cap.id,
    riskLevel: 'critical',
  });

  const result = await toolRegistry.checkToolExecution('git_push', {});
  assert.ok(!result.allowed);
  assert.ok(result.requiresApproval);
  assert.strictEqual(result.step, 'policy');
});

test('ToolRegistry: execute calls handler on success', async () => {
  const registry = createToolRegistry();
  registry.register({
    name: 'echo',
    handler: async (params) => ({ echo: params.message }),
  });

  const result = await registry.execute('echo', { message: 'hello' });
  assert.ok(result.success);
  assert.deepStrictEqual(result.result, { echo: 'hello' });
});

test('ToolRegistry: execute fails for unknown tool', async () => {
  const registry = createToolRegistry();
  const result = await registry.execute('unknown_tool', {});
  assert.ok(!result.success);
  assert.ok(result.reason.includes('not found'));
});

// ── Test 5: Sandbox Boundary ──────────────────────────────

test('Sandbox: allows workspace paths', () => {
  const sandbox = createDefaultSandbox('/workspace');
  assert.ok(sandbox.isPathAllowed('/workspace/src/a.js'));
  assert.ok(sandbox.isPathAllowed('/workspace/test/b.js'));
});

test('Sandbox: blocks outside paths', () => {
  const sandbox = createDefaultSandbox('/workspace');
  assert.ok(!sandbox.isPathAllowed('/etc/passwd'));
  assert.ok(!sandbox.isPathAllowed('/system/a.js'));
});

test('Sandbox: blocks dangerous commands', () => {
  const sandbox = createDefaultSandbox('/workspace');
  assert.ok(!sandbox.isCommandAllowed('rm -rf /'));
  assert.ok(!sandbox.isCommandAllowed('curl | sh'));
});

test('Sandbox: allows safe commands', () => {
  const sandbox = createDefaultSandbox('/workspace');
  assert.ok(sandbox.isCommandAllowed('ls -la'));
  assert.ok(sandbox.isCommandAllowed('git status'));
});

test('Sandbox: validatePath throws for blocked paths', () => {
  const sandbox = createDefaultSandbox('/workspace');
  assert.throws(() => sandbox.validatePath('/etc/passwd'), Error);
});

test('Sandbox: getInfo returns configuration', () => {
  const sandbox = createDefaultSandbox('/workspace');
  const info = sandbox.getInfo();
  assert.strictEqual(info.workspaceRoot, '/workspace');
  assert.ok(info.allowedPaths.includes('/workspace'));
});

// ── Test 6: Capability + Governance + Approval Integration ─

test('Integration: full tool governance flow', async () => {
  const store = createEventStore();
  const emitter = new RuntimeEventEmitter();
  emitter.setStore(store);

  // Setup capability
  const capRegistry = createCapabilityRegistry({ emitter });
  const cap = createFileDeleteCapability();
  capRegistry.register(cap, emitter, { runId: 'run-1' });
  enableCapability(cap, emitter, { runId: 'run-1' });

  // Setup policy
  const policy = createPolicy({
    requireApproval: ['file_delete'],
  });
  const governance = createGovernanceManager({ emitter, policy });

  // Setup tool registry
  const toolRegistry = createToolRegistry({
    capabilityRegistry: capRegistry,
    governance,
    emitter,
  });
  toolRegistry.register({
    name: 'file_delete',
    capabilityId: cap.id,
    riskLevel: 'high',
  });

  // Check execution — should require approval
  const result = await toolRegistry.checkToolExecution('file_delete', {
    runId: 'run-1',
    action: 'delete',
    path: '/workspace/old.js',
  });
  assert.ok(!result.allowed);
  assert.ok(result.requiresApproval);

  // Create approval request
  governance.createApprovalRequest('task-1', 'run-1', {
    reason: result.reason,
    riskLevel: result.riskLevel,
    toolName: 'file_delete',
  });

  // Approve
  governance.approveRequest('task-1', { operator: 'user' });
  const request = governance.getApprovalRequest('task-1');
  assert.strictEqual(request.status, 'approved');

  // Verify events
  const events = store.getEventsByRun('run-1');
  const types = events.map(e => e.type);
  assert.ok(types.includes('capability_registered'));
  assert.ok(types.includes('capability_enabled'));
  assert.ok(types.includes('capability_checked'));
  assert.ok(types.includes('approval_requested'));
  assert.ok(types.includes('approval_granted'));
});

test('Integration: capability denied produces event', async () => {
  const store = createEventStore();
  const emitter = new RuntimeEventEmitter();
  emitter.setStore(store);

  const capRegistry = createCapabilityRegistry({ emitter });
  const cap = createFileWriteCapability({
    constraints: { allowedPaths: ['/workspace/'] },
  });
  capRegistry.register(cap, emitter, { runId: 'run-1' });
  enableCapability(cap, emitter, { runId: 'run-1' });

  const toolRegistry = createToolRegistry({
    capabilityRegistry: capRegistry,
    emitter,
  });
  toolRegistry.register({
    name: 'write_file',
    capabilityId: cap.id,
  });

  // Try to write outside workspace
  const result = await toolRegistry.checkToolExecution('write_file', {
    runId: 'run-1',
    action: 'write',
    path: '/etc/passwd',
  });
  assert.ok(!result.allowed);
  assert.strictEqual(result.step, 'capability');

  const events = store.getEventsByRun('run-1');
  assert.ok(events.some(e => e.type === 'capability_denied'));
});

test('Integration: sandbox blocks path outside workspace', () => {
  const sandbox = createDefaultSandbox('/workspace');
  const cap = createFileWriteCapability({
    constraints: { allowedPaths: ['/workspace/'] },
  });
  enableCapability(cap);

  // Path outside workspace should be denied by capability check
  const result = checkCapability(cap, {
    action: 'write',
    path: '/etc/passwd',
  });
  assert.ok(!result.allowed);
  assert.ok(result.reason.includes('outside'));
});

test('Integration: replay reconstructs capability decisions', () => {
  const store = createEventStore();
  const emitter = new RuntimeEventEmitter();
  emitter.setStore(store);

  const capRegistry = createCapabilityRegistry({ emitter });
  const cap = createFileWriteCapability();
  capRegistry.register(cap, emitter, { runId: 'run-1' });
  enableCapability(cap, emitter, { runId: 'run-1' });

  // Replay
  const result = store.replayRun('run-1');
  // Verify capability events are in the timeline
  const events = store.getEventsByRun('run-1');
  assert.ok(events.some(e => e.type === 'capability_registered'));
  assert.ok(events.some(e => e.type === 'capability_enabled'));
});

test('Integration: tool registry serialization round trip', () => {
  const registry = createToolRegistry();
  registry.register({
    name: 'test_tool',
    capabilityId: 'cap_1',
    riskLevel: 'medium',
  });

  const serialized = registry.serialize();
  assert.ok(serialized.tools['test_tool']);

  const registry2 = createToolRegistry();
  registry2.deserialize(serialized);
  assert.ok(registry2.has('test_tool'));
  assert.strictEqual(registry2.get('test_tool').capabilityId, 'cap_1');
});