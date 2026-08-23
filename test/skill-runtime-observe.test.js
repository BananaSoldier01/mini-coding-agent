/**
 * test/skill-runtime-observe.test.js — Runtime Observability & Persistence Tests
 *
 * V0.8
 * Tests for RuntimeEventLog, RuntimeSnapshot, RuntimePersistence, and Resume/Recovery.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SKILL_STATUS,
  createSkill,
  transitionSkillStatus,
  SkillRegistry,
  activateSkillsForRun,
  runSkillVerification,
  safeTransitionSkillStatus,
  SkillRuntimeContext,
  EvidenceRegistry,
  RUNTIME_EVENT_TYPES,
  RuntimeEventLog,
  createSnapshot,
  restoreSnapshot,
  RuntimePersistence,
  MemoryPersistenceAdapter,
} from '../agent/skill.js';

// ── Test 1: Runtime Event Log ─────────────────────────────

test('Runtime-Observe: RuntimeEventLog record creates event', () => {
  const log = new RuntimeEventLog();
  const ev = log.record({
    runId: 'run-1',
    skillId: 's1',
    type: RUNTIME_EVENT_TYPES.SKILL_ACTIVATED,
    data: { status: 'running' },
  });
  assert.ok(ev.id);
  assert.strictEqual(ev.runId, 'run-1');
  assert.strictEqual(ev.skillId, 's1');
  assert.strictEqual(ev.type, RUNTIME_EVENT_TYPES.SKILL_ACTIVATED);
  assert.ok(ev.timestamp > 0);
});

test('Runtime-Observe: RuntimeEventLog getEvents by runId', () => {
  const log = new RuntimeEventLog();
  log.record({ runId: 'run-1', skillId: 's1', type: 'test', data: {} });
  log.record({ runId: 'run-1', skillId: 's1', type: 'test', data: {} });
  log.record({ runId: 'run-2', skillId: 's2', type: 'test', data: {} });

  const run1Events = log.getEvents('run-1');
  assert.strictEqual(run1Events.length, 2);
  const run2Events = log.getEvents('run-2');
  assert.strictEqual(run2Events.length, 1);
});

test('Runtime-Observe: RuntimeEventLog getSkillEvents', () => {
  const log = new RuntimeEventLog();
  log.record({ runId: 'run-1', skillId: 's1', type: 'test', data: {} });
  log.record({ runId: 'run-1', skillId: 's1', type: 'test', data: {} });
  log.record({ runId: 'run-1', skillId: 's2', type: 'test', data: {} });

  const s1Events = log.getSkillEvents('s1');
  assert.strictEqual(s1Events.length, 2);
  const s2Events = log.getSkillEvents('s2');
  assert.strictEqual(s2Events.length, 1);
});

test('Runtime-Observe: RuntimeEventLog getLatestSkillEvent', () => {
  const log = new RuntimeEventLog();
  log.record({ runId: 'run-1', skillId: 's1', type: 'a', data: { n: 1 } });
  log.record({ runId: 'run-1', skillId: 's1', type: 'b', data: { n: 2 } });

  const latest = log.getLatestSkillEvent('s1');
  assert.ok(latest);
  assert.strictEqual(latest.type, 'b');
  assert.strictEqual(latest.data.n, 2);
});

test('Runtime-Observe: RuntimeEventLog clearEvents', () => {
  const log = new RuntimeEventLog();
  log.record({ runId: 'run-1', skillId: 's1', type: 'test', data: {} });
  log.record({ runId: 'run-2', skillId: 's2', type: 'test', data: {} });

  log.clearEvents('run-1');
  assert.strictEqual(log.count('run-1'), 0);
  assert.strictEqual(log.count('run-2'), 1);

  log.clearEvents();
  assert.strictEqual(log.count(), 0);
});

test('Runtime-Observe: RuntimeEventLog serialize and deserialize', () => {
  const log = new RuntimeEventLog();
  log.record({ runId: 'run-1', skillId: 's1', type: 'test', data: { v: 1 } });

  const serialized = log.serialize();
  assert.ok(serialized.events);
  assert.ok(serialized.events.length > 0);

  const restored = RuntimeEventLog.deserialize(serialized);
  assert.strictEqual(restored.count(), 1);
  assert.strictEqual(restored.getEvents('run-1').length, 1);
});

test('Runtime-Observe: RuntimeEventLog event ordering preserved', () => {
  const log = new RuntimeEventLog();
  log.record({ runId: 'run-1', skillId: 's1', type: 'a', data: { seq: 1 } });
  log.record({ runId: 'run-1', skillId: 's1', type: 'b', data: { seq: 2 } });
  log.record({ runId: 'run-1', skillId: 's1', type: 'c', data: { seq: 3 } });

  const events = log.getEvents('run-1');
  assert.strictEqual(events[0].data.seq, 1);
  assert.strictEqual(events[1].data.seq, 2);
  assert.strictEqual(events[2].data.seq, 3);
});

// ── Test 2: Runtime Snapshot ──────────────────────────────

test('Runtime-Observe: createSnapshot captures state', () => {
  const registry = new SkillRegistry(['run_command']);
  registry.register({ id: 's1', name: 'Test', description: 'd', version: '1.0.0', tools: ['run_command'] });
  registry.load('s1');
  activateSkillsForRun(registry, ['s1']);

  const ctx = new SkillRuntimeContext('run-1');
  ctx.addSkill(registry.get('s1'));
  ctx.updateSkillStatus('s1', SKILL_STATUS.RUNNING);

  const evRegistry = new EvidenceRegistry();
  evRegistry.addEvidence({ skillId: 's1', type: 'test', data: { result: 'ok' } });

  const eventLog = new RuntimeEventLog();
  eventLog.record({ runId: 'run-1', skillId: 's1', type: RUNTIME_EVENT_TYPES.SKILL_ACTIVATED, data: {} });

  const snapshot = createSnapshot('run-1', ctx, evRegistry, eventLog, 'running');
  assert.strictEqual(snapshot.runId, 'run-1');
  assert.strictEqual(snapshot.status, 'running');
  assert.ok(snapshot.runtimeContext);
  assert.ok(snapshot.evidenceRegistry);
  assert.ok(snapshot.eventLog);
  assert.ok(snapshot.timestamp > 0);
});

test('Runtime-Observe: restoreSnapshot recovers state', () => {
  const registry = new SkillRegistry(['run_command']);
  registry.register({ id: 's1', name: 'Test', description: 'd', version: '1.0.0', tools: ['run_command'] });
  registry.load('s1');

  const ctx = new SkillRuntimeContext('run-1');
  ctx.addSkill(registry.get('s1'));
  ctx.updateSkillStatus('s1', SKILL_STATUS.RUNNING);
  ctx.eventLog.record({ runId: 'run-1', skillId: 's1', type: RUNTIME_EVENT_TYPES.SKILL_ACTIVATED, data: {} });

  const evRegistry = new EvidenceRegistry();
  evRegistry.addEvidence({ skillId: 's1', type: 'test', data: { v: 1 } });

  const snapshot = createSnapshot('run-1', ctx, evRegistry, ctx.eventLog, 'running');
  const restored = restoreSnapshot(snapshot, registry);

  assert.ok(restored);
  assert.ok(restored.runtimeContext);
  assert.strictEqual(restored.runtimeContext.runId, 'run-1');
  assert.ok(restored.evidenceRegistry);
  assert.strictEqual(restored.evidenceRegistry.countSkillEvidence('s1'), 1);
  assert.ok(restored.eventLog);
  assert.strictEqual(restored.eventLog.count('run-1'), 1);
  assert.ok(restored.restoredAt > 0);
});

test('Runtime-Observe: snapshot round-trip preserves lifecycle', () => {
  const registry = new SkillRegistry(['run_command']);
  registry.register({ id: 's1', name: 'Test', description: 'd', version: '1.0.0', tools: ['run_command'] });
  registry.load('s1');
  activateSkillsForRun(registry, ['s1']);

  const ctx = new SkillRuntimeContext('run-1');
  ctx.addSkill(registry.get('s1'));
  ctx.updateSkillStatus('s1', SKILL_STATUS.RUNNING);

  const snapshot = createSnapshot('run-1', ctx, new EvidenceRegistry(), ctx.eventLog, 'running');
  const restored = restoreSnapshot(snapshot, registry);

  // Check lifecycle preserved
  const lc = restored.runtimeContext.lifecycle.get('s1');
  assert.ok(lc);
  assert.strictEqual(lc.state, SKILL_STATUS.RUNNING);
});

test('Runtime-Observe: snapshot round-trip preserves evidence', () => {
  const ctx = new SkillRuntimeContext('run-1');
  const evRegistry = new EvidenceRegistry();
  evRegistry.addEvidence({ skillId: 's1', type: 'test', data: { result: 'passed' } });
  evRegistry.addEvidence({ skillId: 's1', type: 'git', data: { files: 3 } });

  const snapshot = createSnapshot('run-1', ctx, evRegistry, new RuntimeEventLog(), 'running');
  const restored = restoreSnapshot(snapshot, new SkillRegistry([]));

  assert.strictEqual(restored.evidenceRegistry.countSkillEvidence('s1'), 2);
  const evidence = restored.evidenceRegistry.listSkillEvidence('s1');
  assert.strictEqual(evidence[0].type, 'test');
  assert.strictEqual(evidence[1].type, 'git');
});

test('Runtime-Observe: snapshot round-trip preserves events', () => {
  const ctx = new SkillRuntimeContext('run-1');
  const eventLog = new RuntimeEventLog();
  eventLog.record({ runId: 'run-1', skillId: 's1', type: RUNTIME_EVENT_TYPES.SKILL_ACTIVATED, data: {} });
  eventLog.record({ runId: 'run-1', skillId: 's1', type: RUNTIME_EVENT_TYPES.TOOL_COMPLETED, data: { tool: 'run_command' } });

  const snapshot = createSnapshot('run-1', ctx, new EvidenceRegistry(), eventLog, 'running');
  const restored = restoreSnapshot(snapshot, new SkillRegistry([]));

  assert.strictEqual(restored.eventLog.count('run-1'), 2);
  const events = restored.eventLog.getEvents('run-1');
  assert.strictEqual(events[0].type, RUNTIME_EVENT_TYPES.SKILL_ACTIVATED);
  assert.strictEqual(events[1].type, RUNTIME_EVENT_TYPES.TOOL_COMPLETED);
});

// ── Test 3: Runtime Persistence ───────────────────────────

test('Runtime-Observe: MemoryPersistenceAdapter save and load', async () => {
  const adapter = new MemoryPersistenceAdapter();
  const snapshot = { runId: 'run-1', timestamp: Date.now(), status: 'running' };

  await adapter.save(snapshot);
  const loaded = await adapter.load('run-1');
  assert.ok(loaded);
  assert.strictEqual(loaded.runId, 'run-1');
  assert.strictEqual(loaded.status, 'running');
});

test('Runtime-Observe: MemoryPersistenceAdapter load nonexistent returns null', async () => {
  const adapter = new MemoryPersistenceAdapter();
  const loaded = await adapter.load('nonexistent');
  assert.strictEqual(loaded, null);
});

test('Runtime-Observe: MemoryPersistenceAdapter delete', async () => {
  const adapter = new MemoryPersistenceAdapter();
  await adapter.save({ runId: 'run-1', timestamp: Date.now() });
  await adapter.save({ runId: 'run-2', timestamp: Date.now() });

  const deleted = await adapter.delete('run-1');
  assert.ok(deleted);
  assert.strictEqual(await adapter.load('run-1'), null);
  assert.ok(await adapter.load('run-2'));
});

test('Runtime-Observe: MemoryPersistenceAdapter list', async () => {
  const adapter = new MemoryPersistenceAdapter();
  await adapter.save({ runId: 'run-1', timestamp: Date.now() });
  await adapter.save({ runId: 'run-2', timestamp: Date.now() });

  const list = await adapter.list();
  assert.strictEqual(list.length, 2);
  assert.ok(list.includes('run-1'));
  assert.ok(list.includes('run-2'));
});

test('Runtime-Observe: RuntimePersistence uses adapter', async () => {
  const adapter = new MemoryPersistenceAdapter();
  const persistence = new RuntimePersistence(adapter);

  const snapshot = { runId: 'run-1', timestamp: Date.now(), status: 'running' };
  await persistence.save(snapshot);

  const loaded = await persistence.load('run-1');
  assert.ok(loaded);
  assert.strictEqual(loaded.runId, 'run-1');

  const list = await persistence.list();
  assert.ok(list.includes('run-1'));
});

test('Runtime-Observe: RuntimePersistence default adapter is memory', async () => {
  const persistence = new RuntimePersistence();
  const snapshot = { runId: 'run-1', timestamp: Date.now() };
  await persistence.save(snapshot);

  const loaded = await persistence.load('run-1');
  assert.ok(loaded);
});

// ── Test 4: Resume / Recovery ─────────────────────────────

test('Runtime-Observe: full snapshot → restore → recover flow', () => {
  const registry = new SkillRegistry(['run_command']);
  registry.register({ id: 's1', name: 'Test', description: 'd', version: '1.0.0', tools: ['run_command'] });
  registry.load('s1');
  activateSkillsForRun(registry, ['s1']);

  const ctx = new SkillRuntimeContext('run-1');
  ctx.addSkill(registry.get('s1'));
  ctx.updateSkillStatus('s1', SKILL_STATUS.RUNNING);
  ctx.eventLog.record({ runId: 'run-1', skillId: 's1', type: RUNTIME_EVENT_TYPES.SKILL_ACTIVATED, data: {} });

  const evRegistry = new EvidenceRegistry();
  evRegistry.addEvidence({ skillId: 's1', type: 'test', data: { result: 'partial' } });

  // Save snapshot
  const snapshot = createSnapshot('run-1', ctx, evRegistry, ctx.eventLog, 'running');

  // Simulate restart — restore
  const restored = restoreSnapshot(snapshot, registry);

  // Verify state consistency
  assert.strictEqual(restored.runtimeContext.runId, 'run-1');
  assert.strictEqual(restored.runtimeContext.activeSkills.length, 1);
  assert.strictEqual(restored.evidenceRegistry.countSkillEvidence('s1'), 1);
  assert.strictEqual(restored.eventLog.count('run-1'), 1);

  // Lifecycle state preserved
  const lc = restored.runtimeContext.lifecycle.get('s1');
  assert.strictEqual(lc.state, SKILL_STATUS.RUNNING);
});

test('Runtime-Observe: snapshot after completion preserves terminal state', () => {
  const registry = new SkillRegistry(['run_command']);
  registry.register({ id: 's1', name: 'Test', description: 'd', version: '1.0.0', tools: ['run_command'] });
  registry.load('s1');
  activateSkillsForRun(registry, ['s1']);

  const ctx = new SkillRuntimeContext('run-1');
  ctx.addSkill(registry.get('s1'));
  ctx.updateSkillStatus('s1', SKILL_STATUS.RUNNING);

  const evRegistry = new EvidenceRegistry();
  const result = runSkillVerification(registry, 's1', evRegistry, {
    checks: [{ type: 'command', passed: true, command: 'echo ok' }],
  });
  ctx.setVerificationResult('s1', result);
  ctx.updateSkillStatus('s1', SKILL_STATUS.COMPLETED);

  const snapshot = createSnapshot('run-1', ctx, evRegistry, ctx.eventLog, 'completed');
  const restored = restoreSnapshot(snapshot, registry);

  const lc = restored.runtimeContext.lifecycle.get('s1');
  assert.strictEqual(lc.state, SKILL_STATUS.COMPLETED);
  assert.ok(restored.runtimeContext.getVerificationResult('s1').success);
});

// ── Test 5: Lifecycle Entry Unification ───────────────────

test('Runtime-Observe: safeTransitionSkillStatus is the only public entry', () => {
  const skill = createSkill({ id: 's1', name: 'Test', description: 'd', version: '1.0.0', tools: ['run_command'] });
  transitionSkillStatus(skill, SKILL_STATUS.AVAILABLE);
  transitionSkillStatus(skill, SKILL_STATUS.RUNNING);
  transitionSkillStatus(skill, SKILL_STATUS.VERIFYING);

  // safeTransitionSkillStatus should work for valid transitions
  assert.ok(safeTransitionSkillStatus(skill, SKILL_STATUS.COMPLETED));
  assert.strictEqual(skill.status, SKILL_STATUS.COMPLETED);
});

test('Runtime-Observe: direct status modification still possible but discouraged', () => {
  // V0.8: transitionSkillStatus remains available as internal helper
  // but safeTransitionSkillStatus is the recommended public API
  const skill = createSkill({ id: 's1', name: 'Test', description: 'd', version: '1.0.0', tools: ['run_command'] });

  // transitionSkillStatus works (internal helper)
  transitionSkillStatus(skill, SKILL_STATUS.AVAILABLE);
  assert.strictEqual(skill.status, SKILL_STATUS.AVAILABLE);

  // safeTransitionSkillStatus blocks illegal transitions
  assert.ok(!safeTransitionSkillStatus(skill, SKILL_STATUS.COMPLETED));
  assert.strictEqual(skill.status, SKILL_STATUS.AVAILABLE);
});

// ── Test 6: Event Timeline Full Flow ──────────────────────

test('Runtime-Observe: full event timeline for skill execution', () => {
  const registry = new SkillRegistry(['run_command']);
  registry.register({ id: 's1', name: 'Test', description: 'd', version: '1.0.0', tools: ['run_command'] });
  registry.load('s1');

  const eventLog = new RuntimeEventLog();
  const ctx = new SkillRuntimeContext('run-1');
  ctx.addSkill(registry.get('s1'));

  // Record full timeline
  eventLog.record({ runId: 'run-1', skillId: 's1', type: RUNTIME_EVENT_TYPES.SKILL_ACTIVATED, data: {} });
  eventLog.record({ runId: 'run-1', skillId: 's1', type: RUNTIME_EVENT_TYPES.SKILL_RUNNING, data: {} });
  eventLog.record({ runId: 'run-1', skillId: 's1', type: RUNTIME_EVENT_TYPES.TOOL_STARTED, data: { tool: 'run_command' } });
  eventLog.record({ runId: 'run-1', skillId: 's1', type: RUNTIME_EVENT_TYPES.TOOL_COMPLETED, data: { tool: 'run_command', exitCode: 0 } });
  eventLog.record({ runId: 'run-1', skillId: 's1', type: RUNTIME_EVENT_TYPES.VERIFICATION_STARTED, data: {} });
  eventLog.record({ runId: 'run-1', skillId: 's1', type: RUNTIME_EVENT_TYPES.EVIDENCE_COLLECTED, data: { type: 'command' } });
  eventLog.record({ runId: 'run-1', skillId: 's1', type: RUNTIME_EVENT_TYPES.VERIFICATION_COMPLETED, data: { success: true } });
  eventLog.record({ runId: 'run-1', skillId: 's1', type: RUNTIME_EVENT_TYPES.SKILL_COMPLETED, data: {} });

  const events = eventLog.getSkillEvents('s1');
  assert.strictEqual(events.length, 8);
  assert.strictEqual(events[0].type, RUNTIME_EVENT_TYPES.SKILL_ACTIVATED);
  assert.strictEqual(events[7].type, RUNTIME_EVENT_TYPES.SKILL_COMPLETED);

  // Verify ordering
  const types = events.map(e => e.type);
  const expectedOrder = [
    RUNTIME_EVENT_TYPES.SKILL_ACTIVATED,
    RUNTIME_EVENT_TYPES.SKILL_RUNNING,
    RUNTIME_EVENT_TYPES.TOOL_STARTED,
    RUNTIME_EVENT_TYPES.TOOL_COMPLETED,
    RUNTIME_EVENT_TYPES.VERIFICATION_STARTED,
    RUNTIME_EVENT_TYPES.EVIDENCE_COLLECTED,
    RUNTIME_EVENT_TYPES.VERIFICATION_COMPLETED,
    RUNTIME_EVENT_TYPES.SKILL_COMPLETED,
  ];
  assert.deepStrictEqual(types, expectedOrder);
});

test('Runtime-Observe: event timeline records failure flow', () => {
  const eventLog = new RuntimeEventLog();

  eventLog.record({ runId: 'run-1', skillId: 's1', type: RUNTIME_EVENT_TYPES.SKILL_ACTIVATED, data: {} });
  eventLog.record({ runId: 'run-1', skillId: 's1', type: RUNTIME_EVENT_TYPES.SKILL_RUNNING, data: {} });
  eventLog.record({ runId: 'run-1', skillId: 's1', type: RUNTIME_EVENT_TYPES.VERIFICATION_STARTED, data: {} });
  eventLog.record({ runId: 'run-1', skillId: 's1', type: RUNTIME_EVENT_TYPES.VERIFICATION_COMPLETED, data: { success: false } });
  eventLog.record({ runId: 'run-1', skillId: 's1', type: RUNTIME_EVENT_TYPES.SKILL_FAILED, data: { reason: 'Tests failed' } });

  const events = eventLog.getSkillEvents('s1');
  assert.strictEqual(events.length, 5);
  assert.strictEqual(events[4].type, RUNTIME_EVENT_TYPES.SKILL_FAILED);
  assert.strictEqual(events[4].data.reason, 'Tests failed');
});

// ── Test 7: Multi-Skill Snapshot ──────────────────────────

test('Runtime-Observe: snapshot with multiple skills', () => {
  const registry = new SkillRegistry(['run_command']);
  registry.register({ id: 'sa', name: 'Skill A', description: 'd', version: '1.0.0', tools: ['run_command'] });
  registry.register({ id: 'sb', name: 'Skill B', description: 'd', version: '1.0.0', tools: ['run_command'] });
  registry.load('sa');
  registry.load('sb');
  activateSkillsForRun(registry, ['sa', 'sb']);

  const ctx = new SkillRuntimeContext('run-1');
  ctx.addSkill(registry.get('sa'));
  ctx.addSkill(registry.get('sb'));
  ctx.updateSkillStatus('sa', SKILL_STATUS.RUNNING);
  ctx.updateSkillStatus('sb', SKILL_STATUS.RUNNING);

  const snapshot = createSnapshot('run-1', ctx, new EvidenceRegistry(), ctx.eventLog, 'running');
  const restored = restoreSnapshot(snapshot, registry);

  assert.strictEqual(restored.runtimeContext.activeSkills.length, 2);
  assert.strictEqual(restored.runtimeContext.lifecycle.get('sa').state, SKILL_STATUS.RUNNING);
  assert.strictEqual(restored.runtimeContext.lifecycle.get('sb').state, SKILL_STATUS.RUNNING);
});