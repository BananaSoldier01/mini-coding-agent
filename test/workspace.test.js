/**
 * test/workspace.test.js — Workspace Runtime & Context Management Tests
 *
 * V1.1.0
 * Tests for Workspace Model, Workspace Registry, Context Management,
 * Artifact Management, Workspace Snapshot, Workspace Events.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createWorkspace,
  activateWorkspace,
  archiveWorkspace,
  bindRun,
  unbindRun,
  hasRun,
  serializeWorkspace,
  deserializeWorkspace,
  WORKSPACE_STATUS,
  WorkspaceRegistry,
  createWorkspaceRegistry,
  ContextManager,
  createContextManager,
  ArtifactStore,
  createArtifactStore,
  ARTIFACT_TYPES,
  RuntimeEventEmitter,
  RuntimeEventStore,
  createEventStore,
  RUNTIME_EVENT_TYPES,
} from '../agent/skill.js';

// ── Test 1: Workspace Model ───────────────────────────────

test('Workspace: createWorkspace has required fields', () => {
  const ws = createWorkspace({ name: 'test-ws' });
  assert.ok(ws.id);
  assert.strictEqual(ws.name, 'test-ws');
  assert.strictEqual(ws.status, WORKSPACE_STATUS.CREATED);
  assert.ok(ws.rootPath);
  assert.ok(ws.paths.files);
  assert.ok(ws.paths.artifacts);
  assert.ok(ws.createdAt > 0);
});

test('Workspace: activateWorkspace transitions CREATED → ACTIVE', () => {
  const ws = createWorkspace({ name: 'test' });
  assert.strictEqual(ws.status, WORKSPACE_STATUS.CREATED);

  assert.ok(activateWorkspace(ws));
  assert.strictEqual(ws.status, WORKSPACE_STATUS.ACTIVE);
  assert.ok(ws.activatedAt > 0);
});

test('Workspace: archiveWorkspace transitions ACTIVE → ARCHIVED', () => {
  const ws = createWorkspace({ name: 'test' });
  activateWorkspace(ws);
  assert.strictEqual(ws.status, WORKSPACE_STATUS.ACTIVE);

  assert.ok(archiveWorkspace(ws));
  assert.strictEqual(ws.status, WORKSPACE_STATUS.ARCHIVED);
  assert.ok(ws.archivedAt > 0);
});

test('Workspace: cannot archive already archived workspace', () => {
  const ws = createWorkspace({ name: 'test' });
  activateWorkspace(ws);
  archiveWorkspace(ws);
  assert.ok(!archiveWorkspace(ws));
});

test('Workspace: bindRun adds run to workspace', () => {
  const ws = createWorkspace({ name: 'test' });
  assert.ok(bindRun(ws, 'run-1'));
  assert.ok(hasRun(ws, 'run-1'));
  assert.ok(!hasRun(ws, 'run-2'));
});

test('Workspace: unbindRun removes run from workspace', () => {
  const ws = createWorkspace({ name: 'test' });
  bindRun(ws, 'run-1');
  assert.ok(unbindRun(ws, 'run-1'));
  assert.ok(!hasRun(ws, 'run-1'));
});

test('Workspace: serialize/deserialize round trip', () => {
  const ws = createWorkspace({ name: 'test' });
  const serialized = serializeWorkspace(ws);
  const restored = deserializeWorkspace(serialized);
  assert.strictEqual(restored.id, ws.id);
  assert.strictEqual(restored.name, ws.name);
  assert.strictEqual(restored.status, ws.status);
});

// ── Test 2: Workspace Registry ────────────────────────────

test('Registry: create workspace', () => {
  const registry = createWorkspaceRegistry();
  const result = registry.create({ name: 'test-ws' });
  assert.ok(result.success);
  assert.ok(result.workspace);
  assert.strictEqual(result.workspace.status, WORKSPACE_STATUS.ACTIVE);
});

test('Registry: get workspace by ID', () => {
  const registry = createWorkspaceRegistry();
  const created = registry.create({ name: 'test' });
  const fetched = registry.get(created.workspace.id);
  assert.ok(fetched);
  assert.strictEqual(fetched.name, 'test');
});

test('Registry: list workspaces', () => {
  const registry = createWorkspaceRegistry();
  registry.create({ name: 'ws1' });
  registry.create({ name: 'ws2' });
  const list = registry.list();
  assert.strictEqual(list.length, 2);
});

test('Registry: archive workspace', () => {
  const registry = createWorkspaceRegistry();
  const created = registry.create({ name: 'test' });
  const result = registry.archive(created.workspace.id);
  assert.ok(result.success);
  assert.strictEqual(result.workspace.status, WORKSPACE_STATUS.ARCHIVED);
});

test('Registry: getOrCreateForRun creates new workspace', () => {
  const registry = createWorkspaceRegistry();
  const result = registry.getOrCreateForRun('run-1', { name: 'run-ws' });
  assert.ok(result.success);
  assert.ok(result.created);
  assert.strictEqual(result.workspace.name, 'run-ws');
});

test('Registry: getOrCreateForRun returns existing workspace', () => {
  const registry = createWorkspaceRegistry();
  const first = registry.getOrCreateForRun('run-1', { name: 'ws' });
  const second = registry.getOrCreateForRun('run-1', { name: 'ws' });
  assert.ok(!second.created);
  assert.strictEqual(first.workspace.id, second.workspace.id);
});

test('Registry: getWorkspaceForRun returns bound workspace', () => {
  const registry = createWorkspaceRegistry();
  registry.getOrCreateForRun('run-1', { name: 'test' });
  const ws = registry.getWorkspaceForRun('run-1');
  assert.ok(ws);
  assert.ok(hasRun(ws, 'run-1'));
});

test('Registry: listByRun returns run workspaces', () => {
  const registry = createWorkspaceRegistry();
  registry.getOrCreateForRun('run-1', { name: 'ws1' });
  registry.getOrCreateForRun('run-2', { name: 'ws2' });
  const run1Ws = registry.listByRun('run-1');
  assert.strictEqual(run1Ws.length, 1);
});

// ── Test 3: Context Management ────────────────────────────

test('Context: createContext has required fields', () => {
  const mgr = createContextManager();
  const ctx = mgr.create({ runId: 'run-1', workspaceId: 'ws-1' });
  assert.ok(ctx.id);
  assert.strictEqual(ctx.runId, 'run-1');
  assert.strictEqual(ctx.workspaceId, 'ws-1');
  assert.deepStrictEqual(ctx.files, []);
  assert.deepStrictEqual(ctx.variables, {});
});

test('Context: get context by ID', () => {
  const mgr = createContextManager();
  const created = mgr.create({ runId: 'run-1' });
  const fetched = mgr.get(created.id);
  assert.ok(fetched);
  assert.strictEqual(fetched.id, created.id);
});

test('Context: getByRun returns run context', () => {
  const mgr = createContextManager();
  mgr.create({ runId: 'run-1', workspaceId: 'ws-1' });
  const ctx = mgr.getByRun('run-1');
  assert.ok(ctx);
  assert.strictEqual(ctx.runId, 'run-1');
});

test('Context: update context', () => {
  const mgr = createContextManager();
  const created = mgr.create({ runId: 'run-1' });
  const updated = mgr.update(created.id, { skillId: 'skill-1' });
  assert.ok(updated);
  assert.strictEqual(updated.skillId, 'skill-1');
});

test('Context: addFile to context', () => {
  const mgr = createContextManager();
  const created = mgr.create({ runId: 'run-1' });
  mgr.addFile(created.id, '/workspace/a.js');
  mgr.addFile(created.id, '/workspace/b.js');
  const fetched = mgr.get(created.id);
  assert.strictEqual(fetched.files.length, 2);
  assert.ok(fetched.files.includes('/workspace/a.js'));
});

test('Context: setVariable and getVariable', () => {
  const mgr = createContextManager();
  const created = mgr.create({ runId: 'run-1' });
  mgr.setVariable(created.id, 'key1', 'value1');
  assert.strictEqual(mgr.getVariable(created.id, 'key1'), 'value1');
});

test('Context: createForRun binds workspace', () => {
  const registry = createWorkspaceRegistry();
  const mgr = createContextManager({ workspaceRegistry: registry });

  registry.create({ name: 'test', runId: 'run-1' });
  const ctx = mgr.createForRun('run-1', registry.getWorkspaceForRun('run-1').id);
  assert.ok(ctx);
  assert.strictEqual(ctx.runId, 'run-1');
});

// ── Test 4: Artifact Management ───────────────────────────

test('Artifact: createArtifact has required fields', () => {
  const store = createArtifactStore();
  const art = store.create({
    name: 'report.md',
    type: ARTIFACT_TYPES.REPORT,
    workspaceId: 'ws-1',
    taskId: 'task-1',
  });
  assert.ok(art.id);
  assert.strictEqual(art.name, 'report.md');
  assert.strictEqual(art.type, 'report');
  assert.strictEqual(art.workspaceId, 'ws-1');
});

test('Artifact: getArtifact by ID', () => {
  const store = createArtifactStore();
  const created = store.create({ name: 'test.txt' });
  const fetched = store.get(created.id);
  assert.ok(fetched);
  assert.strictEqual(fetched.name, 'test.txt');
});

test('Artifact: listByWorkspace', () => {
  const store = createArtifactStore();
  store.create({ name: 'a.md', workspaceId: 'ws-1' });
  store.create({ name: 'b.md', workspaceId: 'ws-1' });
  store.create({ name: 'c.md', workspaceId: 'ws-2' });

  const ws1Arts = store.listByWorkspace('ws-1');
  assert.strictEqual(ws1Arts.length, 2);
});

test('Artifact: listByTask', () => {
  const store = createArtifactStore();
  store.create({ name: 'a.md', taskId: 'task-1' });
  store.create({ name: 'b.md', taskId: 'task-2' });

  const task1Arts = store.listByTask('task-1');
  assert.strictEqual(task1Arts.length, 1);
});

test('Artifact: delete artifact', () => {
  const store = createArtifactStore();
  const created = store.create({ name: 'test.txt' });
  const result = store.delete(created.id);
  assert.ok(result.success);
  assert.strictEqual(store.get(created.id), null);
});

// ── Test 5: Workspace Events ──────────────────────────────

test('Workspace: create emits WORKSPACE_CREATED event', () => {
  const store = createEventStore();
  const emitter = new RuntimeEventEmitter();
  emitter.setStore(store);
  const registry = createWorkspaceRegistry({ emitter });

  registry.create({ name: 'test', runId: 'run-1' });

  const events = store.getEventsByRun('run-1');
  assert.ok(events.some(e => e.type === 'workspace_created'));
  assert.ok(events.some(e => e.type === 'workspace_activated'));
});

test('Context: update emits CONTEXT_UPDATED event', () => {
  const store = createEventStore();
  const emitter = new RuntimeEventEmitter();
  emitter.setStore(store);
  const mgr = createContextManager({ emitter });

  const ctx = mgr.create({ runId: 'run-1', workspaceId: 'ws-1' });
  mgr.update(ctx.id, { skillId: 'skill-1' });

  const events = store.getEventsByRun('run-1');
  assert.ok(events.some(e => e.type === 'context_updated'));
});

test('Artifact: create emits ARTIFACT_CREATED event', () => {
  const store = createEventStore();
  const emitter = new RuntimeEventEmitter();
  emitter.setStore(store);
  const store2 = createArtifactStore({ emitter });

  store2.create({ name: 'report.md', workspaceId: 'ws-1', runId: 'run-1' });

  const events = store.getEventsByRun('run-1');
  assert.ok(events.some(e => e.type === 'artifact_created'));
});

// ── Test 6: Integration ───────────────────────────────────

test('Integration: full workspace lifecycle with events', () => {
  const store = createEventStore();
  const emitter = new RuntimeEventEmitter();
  emitter.setStore(store);
  const registry = createWorkspaceRegistry({ emitter });

  // Create workspace
  const created = registry.create({ name: 'test', runId: 'run-1' });
  assert.ok(created.success);

  // Archive
  registry.archive(created.workspace.id, { runId: 'run-1' });

  // Verify events
  const events = store.getEventsByRun('run-1');
  const types = events.map(e => e.type);
  assert.ok(types.includes('workspace_created'));
  assert.ok(types.includes('workspace_activated'));
  assert.ok(types.includes('workspace_archived'));
});

test('Integration: context manager with workspace registry', () => {
  const registry = createWorkspaceRegistry();
  const mgr = createContextManager({ workspaceRegistry: registry });

  // Create workspace for run
  registry.getOrCreateForRun('run-1', { name: 'test' });
  const ws = registry.getWorkspaceForRun('run-1');

  // Create context
  const ctx = mgr.createForRun('run-1', ws.id);
  assert.ok(ctx);
  assert.strictEqual(ctx.workspaceId, ws.id);

  // Verify workspace has run bound
  assert.ok(hasRun(ws, 'run-1'));
});

test('Integration: artifact store with workspace', () => {
  const registry = createWorkspaceRegistry();
  const store = createArtifactStore({ workspaceRegistry: registry });

  // Create workspace
  const created = registry.create({ name: 'test', runId: 'run-1' });
  const ws = created.workspace;

  // Create artifact
  const art = store.create({
    name: 'report.md',
    type: ARTIFACT_TYPES.REPORT,
    workspaceId: ws.id,
    runId: 'run-1',
  });
  assert.strictEqual(art.workspaceId, ws.id);

  // List by workspace
  const arts = store.listByWorkspace(ws.id);
  assert.strictEqual(arts.length, 1);
});

test('Integration: workspace serialization round trip', () => {
  const registry = createWorkspaceRegistry();
  registry.create({ name: 'test', runId: 'run-1' });

  const serialized = registry.serialize();
  assert.ok(serialized.workspaces);

  const registry2 = createWorkspaceRegistry();
  registry2.deserialize(serialized);
  assert.strictEqual(registry2.list().length, 1);
});