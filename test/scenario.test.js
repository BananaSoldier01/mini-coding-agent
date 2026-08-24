/**
 * test/scenario.test.js — Runtime Scenario Tests
 *
 * V1.1.1
 * Scenario 1: Full Workspace Lifecycle
 * Scenario 2: Runtime Recovery
 * Scenario 3: Illegal State Operations
 * Scenario 4: State Consistency
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  WorkspaceStore,
  createWorkspaceStore,
  ContextManager,
  createContextManager,
  ArtifactStore,
  createArtifactStore,
  RuntimeEventEmitter,
  RuntimeEventStore,
  createEventStore,
  createSkillRuntime,
  createCapabilityRegistry,
  createCapability,
  enableCapability,
  CAPABILITY_CATEGORIES,
  createToolRegistry,
  WORKSPACE_STATUS,
} from '../agent/skill.js';

// ═══════════════════════════════════════════════════════════════
// Scenario 1: Full Workspace Lifecycle
// ═══════════════════════════════════════════════════════════════

test('Scenario 1: Full Workspace Lifecycle', async () => {
  const store = createEventStore();
  const emitter = new RuntimeEventEmitter();
  emitter.setStore(store);
  const wsStore = createWorkspaceStore({ emitter });
  const ctxMgr = createContextManager({ emitter, workspaceRegistry: wsStore });
  const artStore = createArtifactStore({ emitter, workspaceRegistry: wsStore });

  // 1. Create Workspace
  const created = wsStore.create({ name: 'test-run', runId: 'run-1' });
  assert.ok(created.success);
  const ws = created.workspace;
  assert.strictEqual(ws.status, WORKSPACE_STATUS.ACTIVE);

  // 2. Create Context
  const ctx = ctxMgr.createForRun('run-1', ws.id);
  assert.ok(ctx);
  assert.strictEqual(ctx.workspaceId, ws.id);

  // 3. Create Task (simulated)
  // Task is created by the runtime; here we verify workspace binding
  assert.ok(wsStore.getWorkspaceForRun('run-1'));

  // 4. Execute Skill (simulated via capability + tool)
  const capRegistry = createCapabilityRegistry({ emitter });
  const cap = createCapability({
    name: 'file_read',
    category: CAPABILITY_CATEGORIES.FILESYSTEM,
    riskLevel: 'low',
    permissions: ['read'],
  });
  capRegistry.register(cap, emitter, { runId: 'run-1', workspaceId: ws.id });
  enableCapability(cap, emitter, { runId: 'run-1', workspaceId: ws.id });

  const toolRegistry = createToolRegistry({ capabilityRegistry: capRegistry, emitter });
  toolRegistry.register({
    name: 'read_file',
    capabilityId: cap.id,
    riskLevel: 'low',
    handler: async (p) => ({ content: p.path }),
  });

  const skillRuntime = createSkillRuntime({
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

  const result = await skillRuntime.executeSkill('code-review', {
    runId: 'run-1',
    workspaceId: ws.id,
    params: { path: '/workspace/a.js' },
  });
  assert.ok(result.success);

  // 5. Generate Artifact
  const art = artStore.create({
    name: 'report.md',
    type: 'report',
    workspaceId: ws.id,
    runId: 'run-1',
    taskId: 'task-1',
    content: '# Code Review Report',
  });
  assert.strictEqual(art.workspaceId, ws.id);

  // 6. Archive Workspace
  const archived = wsStore.archive(ws.id, { runId: 'run-1' });
  assert.ok(archived.success);
  assert.strictEqual(archived.workspace.status, WORKSPACE_STATUS.ARCHIVED);

  // Verify all events
  const events = store.getEventsByRun('run-1');
  const types = events.map(e => e.type);
  assert.ok(types.includes('workspace_created'));
  assert.ok(types.includes('workspace_activated'));
  assert.ok(types.includes('capability_registered'));
  assert.ok(types.includes('capability_enabled'));
  assert.ok(types.includes('skill_execution_started'));
  assert.ok(types.includes('skill_execution_completed'));
  assert.ok(types.includes('artifact_created'));
  assert.ok(types.includes('workspace_archived'));

  // Verify data associations
  const artifactEvents = events.filter(e => e.type === 'artifact_created');
  assert.strictEqual(artifactEvents[0].data.workspaceId, ws.id);
  assert.strictEqual(artifactEvents[0].data.taskId, 'task-1');
});

// ═══════════════════════════════════════════════════════════════
// Scenario 2: Runtime Recovery
// ═══════════════════════════════════════════════════════════════

test('Scenario 2: Runtime Recovery — workspace restore after restart', () => {
  const emitter = new RuntimeEventEmitter();
  const wsStore = createWorkspaceStore({ emitter });

  // Create and modify workspace
  const created = wsStore.create({ name: 'recover-test', runId: 'run-1' });
  const ws = created.workspace;

  // Serialize for persistence
  const serialized = wsStore.serialize();
  assert.ok(serialized[ws.id]);
  assert.strictEqual(serialized[ws.id].name, 'recover-test');

  // Simulate runtime restart — clear and restore
  wsStore.clear();
  assert.strictEqual(wsStore.list().length, 0);

  const restored = wsStore.restore(serialized);
  assert.ok(restored.success);
  assert.strictEqual(restored.restored, 1);

  // Verify restored state
  const restoredWs = wsStore.get(ws.id);
  assert.ok(restoredWs);
  assert.strictEqual(restoredWs.name, 'recover-test');
  assert.strictEqual(restoredWs.status, WORKSPACE_STATUS.ACTIVE);
});

test('Scenario 2b: Runtime Recovery — context restore after restart', () => {
  const emitter = new RuntimeEventEmitter();
  const wsStore = createWorkspaceStore({ emitter });
  const ctxMgr = createContextManager({ emitter, workspaceRegistry: wsStore });

  // Create workspace and context
  wsStore.create({ name: 'ctx-test', runId: 'run-1' });
  const ctx = ctxMgr.createForRun('run-1', wsStore.getWorkspaceForRun('run-1').id);
  ctxMgr.setVariable(ctx.id, 'key1', 'value1');
  ctxMgr.addFile(ctx.id, '/workspace/a.js');

  // Serialize
  const serialized = ctxMgr.serialize();
  assert.ok(serialized.contexts[ctx.id]);

  // Simulate restart
  const ctxMgr2 = createContextManager({ emitter });
  ctxMgr2.deserialize(serialized);

  // Verify restored context
  const restoredCtx = ctxMgr2.get(ctx.id);
  assert.ok(restoredCtx);
  assert.strictEqual(restoredCtx.variables.key1, 'value1');
  assert.ok(restoredCtx.files.includes('/workspace/a.js'));
});

test('Scenario 2c: Runtime Recovery — artifact restore after restart', () => {
  const emitter = new RuntimeEventEmitter();
  const wsStore = createWorkspaceStore({ emitter });
  const artStore = createArtifactStore({ emitter, workspaceRegistry: wsStore });

  // Create workspace and artifact
  const created = wsStore.create({ name: 'art-test', runId: 'run-1' });
  artStore.create({
    name: 'report.md',
    type: 'report',
    workspaceId: created.workspace.id,
    runId: 'run-1',
  });

  // Serialize
  const serialized = artStore.serialize();
  assert.ok(serialized.artifacts);

  // Simulate restart
  const artStore2 = createArtifactStore({ emitter, workspaceRegistry: wsStore });
  artStore2.deserialize(serialized);

  // Verify restored artifacts
  const arts = artStore2.listByWorkspace(created.workspace.id);
  assert.strictEqual(arts.length, 1);
  assert.strictEqual(arts[0].name, 'report.md');
});

// ═══════════════════════════════════════════════════════════════
// Scenario 3: Illegal State Operations
// ═══════════════════════════════════════════════════════════════

test('Scenario 3a: Cannot activate archived workspace', () => {
  const wsStore = createWorkspaceStore();
  const created = wsStore.create({ name: 'test', runId: 'run-1' });
  wsStore.archive(created.workspace.id);

  const result = wsStore.activate(created.workspace.id);
  assert.ok(!result.success);
  assert.ok(result.reason.includes('archived'));
});

test('Scenario 3b: Cannot activate already active workspace', () => {
  const wsStore = createWorkspaceStore();
  const created = wsStore.create({ name: 'test', runId: 'run-1' });

  // Already active (auto-activated on create)
  const result = wsStore.activate(created.workspace.id);
  assert.ok(!result.success);
  assert.ok(result.reason.includes('already active'));
});

test('Scenario 3c: Cannot delete non-archived workspace', () => {
  const wsStore = createWorkspaceStore();
  const created = wsStore.create({ name: 'test', runId: 'run-1' });

  const result = wsStore.delete(created.workspace.id);
  assert.ok(!result.success);
  assert.ok(result.reason.includes('archived'));
});

test('Scenario 3d: Can delete archived workspace', () => {
  const wsStore = createWorkspaceStore();
  const created = wsStore.create({ name: 'test', runId: 'run-1' });
  wsStore.archive(created.workspace.id);

  const result = wsStore.delete(created.workspace.id);
  assert.ok(result.success);
  assert.strictEqual(wsStore.get(created.workspace.id), null);
});

test('Scenario 3e: Cannot archive already archived workspace', () => {
  const wsStore = createWorkspaceStore();
  const created = wsStore.create({ name: 'test', runId: 'run-1' });
  wsStore.archive(created.workspace.id);

  const result = wsStore.archive(created.workspace.id);
  assert.ok(!result.success);
});

// ═══════════════════════════════════════════════════════════════
// Scenario 4: State Consistency
// ═══════════════════════════════════════════════════════════════

test('Scenario 4a: Workspace state matches event log', () => {
  const store = createEventStore();
  const emitter = new RuntimeEventEmitter();
  emitter.setStore(store);
  const wsStore = createWorkspaceStore({ emitter });

  wsStore.create({ name: 'test', runId: 'run-1' });
  const created = wsStore.create({ name: 'test2', runId: 'run-2' });
  wsStore.archive(created.workspace.id, { runId: 'run-2' });

  // Verify workspace state
  const archived = wsStore.get(created.workspace.id);
  assert.strictEqual(archived.status, WORKSPACE_STATUS.ARCHIVED);

  // Verify events match
  const events = store.getEventsByRun('run-2');
  const types = events.map(e => e.type);
  assert.ok(types.includes('workspace_created'));
  assert.ok(types.includes('workspace_activated'));
  assert.ok(types.includes('workspace_archived'));
});

test('Scenario 4b: Context state persists across operations', () => {
  const wsStore = createWorkspaceStore();
  const ctxMgr = createContextManager({ workspaceRegistry: wsStore });

  // Create workspace and context
  wsStore.create({ name: 'test', runId: 'run-1' });
  const ctx = ctxMgr.createForRun('run-1', wsStore.getWorkspaceForRun('run-1').id);

  // Modify context
  ctxMgr.setVariable(ctx.id, 'var1', 'val1');
  ctxMgr.addFile(ctx.id, '/workspace/a.js');

  // Verify modifications persisted
  const fetched = ctxMgr.get(ctx.id);
  assert.strictEqual(fetched.variables.var1, 'val1');
  assert.ok(fetched.files.includes('/workspace/a.js'));
});

test('Scenario 4c: Artifact state is consistent with workspace', () => {
  const wsStore = createWorkspaceStore();
  const artStore = createArtifactStore({ workspaceRegistry: wsStore });

  const created = wsStore.create({ name: 'test', runId: 'run-1' });

  // Create artifacts
  artStore.create({ name: 'a.md', workspaceId: created.workspace.id, runId: 'run-1' });
  artStore.create({ name: 'b.md', workspaceId: created.workspace.id, runId: 'run-1' });

  // Verify consistency
  const arts = artStore.listByWorkspace(created.workspace.id);
  assert.strictEqual(arts.length, 2);

  // Delete one
  artStore.delete(arts[0].id);
  const artsAfter = artStore.listByWorkspace(created.workspace.id);
  assert.strictEqual(artsAfter.length, 1);
});

test('Scenario 4d: Run-to-workspace binding is consistent', () => {
  const wsStore = createWorkspaceStore();

  wsStore.create({ name: 'test', runId: 'run-1' });
  const created2 = wsStore.create({ name: 'test2', runId: 'run-2' });

  // Verify each run has its own workspace
  const ws1 = wsStore.getWorkspaceForRun('run-1');
  const ws2 = wsStore.getWorkspaceForRun('run-2');
  assert.ok(ws1);
  assert.ok(ws2);
  assert.notStrictEqual(ws1.id, ws2.id);

  // Bind run-2 to workspace 1
  wsStore.bindRun(ws1.id, 'run-2');

  // Now run-2 should have two workspaces
  const run2Ws = wsStore.listByRun('run-2');
  assert.strictEqual(run2Ws.length, 2);
});

// ═══════════════════════════════════════════════════════════════
// Scenario 5: Event Validation
// ═══════════════════════════════════════════════════════════════

test('Scenario 5: Event validation catches missing fields', () => {
  const emitter = new RuntimeEventEmitter();
  emitter.setStrictValidation(true);

  assert.throws(() => {
    emitter.emit({ type: 'task_started' }); // missing taskId
  });

  emitter.setStrictValidation(false);
});

test('Scenario 5b: Event validation catches unknown types', () => {
  const emitter = new RuntimeEventEmitter();
  emitter.setStrictValidation(true);

  assert.throws(() => {
    emitter.emit({ type: 'unknown_event_type', runId: 'run-1', data: {} });
  });

  emitter.setStrictValidation(false);
});