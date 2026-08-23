/**
 * test/skill-runtime-cleanup.test.js — Runtime Cleanup & Architecture Debt Tests
 *
 * V0.8.2
 * Tests for module split, Event Bus, strict migration, adapter contract.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SKILL_STATUS,
  createSkill,
  SkillRegistry,
  activateSkillsForRun,
  runSkillVerification,
  safeTransitionSkillStatus,
  SkillRuntimeContext,
  EvidenceRegistry,
  RUNTIME_EVENT_TYPES,
  RuntimeEventLog,
  RuntimeEventEmitter,
  createSnapshot,
  restoreSnapshot,
  RuntimePersistence,
  MemoryPersistenceAdapter,
  RuntimePersistenceError,
  SNAPSHOT_VERSION,
  migrateSnapshot,
  SnapshotCompatibilityError,
} from '../agent/skill.js';

// ── Test 1: Module Split — Backward Compatibility ────────

test('Cleanup: skill.js barrel re-exports all old exports', () => {
  // Verify all old exports are still available
  assert.ok(typeof createSkill === 'function');
  assert.ok(typeof safeTransitionSkillStatus === 'function');
  assert.ok(typeof SkillRegistry === 'function');
  assert.ok(typeof SkillRuntimeContext === 'function');
  assert.ok(typeof EvidenceRegistry === 'function');
  assert.ok(typeof runSkillVerification === 'function');
  assert.ok(typeof createSnapshot === 'function');
  assert.ok(typeof restoreSnapshot === 'function');
  assert.ok(typeof RuntimePersistence === 'function');
  assert.ok(typeof MemoryPersistenceAdapter === 'function');
  assert.ok(typeof RuntimePersistenceError === 'function');
  assert.ok(typeof migrateSnapshot === 'function');
  assert.ok(typeof RuntimeEventLog === 'function');
  assert.ok(typeof RuntimeEventEmitter === 'function');
  assert.ok(typeof SNAPSHOT_VERSION === 'string');
});

test('Cleanup: skill domain modules are independently importable', async () => {
  const skillModule = await import('../agent/skill/index.js');
  assert.ok(skillModule.SkillRegistry);
  assert.ok(skillModule.createSkill);
  assert.ok(skillModule.safeTransitionSkillStatus);

  const runtimeModule = await import('../agent/runtime/index.js');
  assert.ok(runtimeModule.SkillRuntimeContext);
  assert.ok(runtimeModule.RuntimeEventLog);
  assert.ok(runtimeModule.RuntimeEventEmitter);
  assert.ok(runtimeModule.RuntimePersistence);
});

// ── Test 2: Runtime Event Bus ─────────────────────────────

test('Cleanup: RuntimeEventEmitter subscribe and emit', () => {
  const emitter = new RuntimeEventEmitter();
  const received = [];
  emitter.on('test_event', (ev) => received.push(ev));

  emitter.emit({ type: 'test_event', data: { n: 1 } });
  emitter.emit({ type: 'test_event', data: { n: 2 } });

  assert.strictEqual(received.length, 2);
  assert.strictEqual(received[0].data.n, 1);
  assert.strictEqual(received[1].data.n, 2);
  assert.ok(received[0].id);
  assert.ok(received[0].timestamp > 0);
});

test('Cleanup: RuntimeEventEmitter wildcard handler', () => {
  const emitter = new RuntimeEventEmitter();
  const received = [];
  emitter.onAll((ev) => received.push(ev));

  emitter.emit({ type: 'a', data: {} });
  emitter.emit({ type: 'b', data: {} });

  assert.strictEqual(received.length, 2);
});

test('Cleanup: RuntimeEventEmitter off removes handler', () => {
  const emitter = new RuntimeEventEmitter();
  const received = [];
  const handler = (ev) => received.push(ev);

  emitter.on('test', handler);
  emitter.emit({ type: 'test', data: {} });
  assert.strictEqual(received.length, 1);

  emitter.off('test', handler);
  emitter.emit({ type: 'test', data: {} });
  assert.strictEqual(received.length, 1);
});

test('Cleanup: RuntimeEventEmitter handler errors do not break emit', () => {
  const emitter = new RuntimeEventEmitter();
  emitter.on('test', () => { throw new Error('handler error'); });
  emitter.on('test', () => { /* ok */ });

  // Should not throw
  assert.doesNotThrow(() => emitter.emit({ type: 'test', data: {} }));
});

test('Cleanup: RuntimeEventEmitter handlerCount', () => {
  const emitter = new RuntimeEventEmitter();
  assert.strictEqual(emitter.handlerCount('test'), 0);

  emitter.on('test', () => {});
  emitter.on('test', () => {});
  assert.strictEqual(emitter.handlerCount('test'), 2);

  emitter.onAll(() => {});
  assert.strictEqual(emitter.handlerCount('*'), 1);
});

test('Cleanup: RuntimeEventEmitter clear removes all handlers', () => {
  const emitter = new RuntimeEventEmitter();
  emitter.on('test', () => {});
  emitter.onAll(() => {});

  emitter.clear();
  assert.strictEqual(emitter.handlerCount('test'), 0);
  assert.strictEqual(emitter.handlerCount('*'), 0);
});

// ── Test 3: Snapshot Migration Strict Mode ────────────────

test('Cleanup: migrateSnapshot rejects unknown future version', () => {
  const futureSnapshot = {
    runId: 'run-1',
    version: '99',
    timestamp: Date.now(),
  };

  assert.throws(
    () => migrateSnapshot(futureSnapshot),
    SnapshotCompatibilityError
  );
});

test('Cleanup: SnapshotCompatibilityError has correct properties', () => {
  const err = new SnapshotCompatibilityError(
    'test message',
    '99',
    ['0', '1']
  );
  assert.strictEqual(err.name, 'SnapshotCompatibilityError');
  assert.strictEqual(err.snapshotVersion, '99');
  assert.deepStrictEqual(err.supportedVersions, ['0', '1']);
  assert.ok(err.timestamp > 0);
});

test('Cleanup: SnapshotCompatibilityError is an Error', () => {
  const err = new SnapshotCompatibilityError('test', '99', ['0', '1']);
  assert.ok(err instanceof Error);
  assert.ok(err instanceof SnapshotCompatibilityError);
});

test('Cleanup: restoreSnapshot rejects unknown version', () => {
  const futureSnapshot = {
    runId: 'run-1',
    version: '99',
    timestamp: Date.now(),
    runtimeContext: new SkillRuntimeContext('run-1').serialize(),
    evidenceRegistry: new EvidenceRegistry().serialize(),
    eventLog: new RuntimeEventLog().serialize(),
  };

  assert.throws(
    () => restoreSnapshot(futureSnapshot, new SkillRegistry([])),
    SnapshotCompatibilityError
  );
});

test('Cleanup: migrateSnapshot v0 → v1 works', () => {
  const v0Snapshot = { runId: 'run-1', timestamp: Date.now() };
  const migrated = migrateSnapshot(v0Snapshot);
  assert.strictEqual(migrated.version, '1');
  assert.ok(migrated.migratedAt > 0);
});

// ── Test 4: Persistence Adapter Contract ──────────────────

test('Cleanup: MemoryPersistenceAdapter exists()', async () => {
  const adapter = new MemoryPersistenceAdapter();
  assert.ok(!await adapter.exists('nonexistent'));

  await adapter.save({ runId: 'run-1', timestamp: Date.now() });
  assert.ok(await adapter.exists('run-1'));
});

test('Cleanup: RuntimePersistence exists() delegates to adapter', async () => {
  const persistence = new RuntimePersistence(new MemoryPersistenceAdapter());
  assert.ok(!await persistence.exists('nonexistent'));

  await persistence.save({ runId: 'run-1', timestamp: Date.now() });
  assert.ok(await persistence.exists('run-1'));
});

test('Cleanup: MemoryPersistenceAdapter exists failure', async () => {
  const adapter = new MemoryPersistenceAdapter({ failOnExists: true });
  try {
    await adapter.exists('run-1');
    assert.ok(false, 'Should have thrown');
  } catch (err) {
    assert.ok(err instanceof RuntimePersistenceError);
    assert.strictEqual(err.errorCode, 'EXISTS_FAILED');
  }
});

test('Cleanup: MemoryPersistenceAdapter delete returns boolean', async () => {
  const adapter = new MemoryPersistenceAdapter();
  await adapter.save({ runId: 'run-1', timestamp: Date.now() });

  const deleted = await adapter.delete('run-1');
  assert.strictEqual(deleted, true);

  const notDeleted = await adapter.delete('nonexistent');
  assert.strictEqual(notDeleted, false);
});

// ── Test 5: Event Bus Integration with Lifecycle ──────────

test('Cleanup: safeTransitionSkillStatus works with RuntimeEventEmitter', () => {
  const skill = createSkill({ id: 's1', name: 'Test', description: 'd', version: '1.0.0', tools: ['run_command'] });
  const emitter = new RuntimeEventEmitter();
  const received = [];

  emitter.on(RUNTIME_EVENT_TYPES.SKILL_RUNNING, (ev) => received.push(ev));
  emitter.on(RUNTIME_EVENT_TYPES.SKILL_COMPLETED, (ev) => received.push(ev));

  safeTransitionSkillStatus(skill, SKILL_STATUS.AVAILABLE, emitter, { runId: 'run-1', skillId: 's1' });
  safeTransitionSkillStatus(skill, SKILL_STATUS.RUNNING, emitter, { runId: 'run-1', skillId: 's1' });
  safeTransitionSkillStatus(skill, SKILL_STATUS.VERIFYING, emitter, { runId: 'run-1', skillId: 's1' });
  safeTransitionSkillStatus(skill, SKILL_STATUS.COMPLETED, emitter, { runId: 'run-1', skillId: 's1' });

  assert.strictEqual(received.length, 2);
  assert.strictEqual(received[0].type, RUNTIME_EVENT_TYPES.SKILL_RUNNING);
  assert.strictEqual(received[1].type, RUNTIME_EVENT_TYPES.SKILL_COMPLETED);
});

test('Cleanup: safeTransitionSkillStatus works with RuntimeEventLog (backward compat)', () => {
  const skill = createSkill({ id: 's1', name: 'Test', description: 'd', version: '1.0.0', tools: ['run_command'] });
  const eventLog = new RuntimeEventLog();

  safeTransitionSkillStatus(skill, SKILL_STATUS.AVAILABLE, eventLog, { runId: 'run-1', skillId: 's1' });
  safeTransitionSkillStatus(skill, SKILL_STATUS.RUNNING, eventLog, { runId: 'run-1', skillId: 's1' });

  const events = eventLog.getSkillEvents('s1');
  assert.ok(events.length >= 1);
  assert.strictEqual(events[0].type, RUNTIME_EVENT_TYPES.SKILL_RUNNING);
});

// ── Test 6: Full Cleanup Flow ─────────────────────────────

test('Cleanup: full flow with event emitter and snapshot', () => {
  const registry = new SkillRegistry(['run_command']);
  registry.register({ id: 's1', name: 'Test', description: 'd', version: '1.0.0', tools: ['run_command'] });
  registry.load('s1');

  const emitter = new RuntimeEventEmitter();
  const eventLog = new RuntimeEventLog();
  // Wire emitter → eventLog
  emitter.onAll((ev) => eventLog.record(ev));

  const ctx = new SkillRuntimeContext('run-1');
  ctx.addSkill(registry.get('s1'));

  // Activate with emitter (AVAILABLE → RUNNING)
  // Use safeTransitionSkillStatus directly for event emission
  safeTransitionSkillStatus(registry.get('s1'), SKILL_STATUS.RUNNING, emitter, { runId: 'run-1', skillId: 's1' });

  // Verify with emitter
  const evRegistry = new EvidenceRegistry();
  runSkillVerification(registry, 's1', evRegistry, {
    checks: [{ type: 'command', passed: true, command: 'echo ok' }],
    eventEmitter: emitter,
    runId: 'run-1',
  });

  // Check events
  assert.ok(eventLog.count('run-1') > 0);
  const skillEvents = eventLog.getSkillEvents('s1');
  assert.ok(skillEvents.some(e => e.type === RUNTIME_EVENT_TYPES.SKILL_RUNNING), 'Should have SKILL_RUNNING event');
  assert.ok(skillEvents.some(e => e.type === RUNTIME_EVENT_TYPES.SKILL_COMPLETED), 'Should have SKILL_COMPLETED event');

  // Snapshot with version
  ctx.updateSkillStatus('s1', SKILL_STATUS.COMPLETED);
  const snapshot = createSnapshot('run-1', ctx, evRegistry, eventLog, 'completed');
  assert.strictEqual(snapshot.version, SNAPSHOT_VERSION);

  // Restore
  const restored = restoreSnapshot(snapshot, registry);
  assert.ok(restored);
  assert.strictEqual(restored.snapshotVersion, SNAPSHOT_VERSION);
  assert.strictEqual(restored.runtimeContext.lifecycle.get('s1').state, SKILL_STATUS.COMPLETED);
});

test('Cleanup: module split preserves all existing functionality', () => {
  // This test verifies that the module split didn't break anything
  const registry = new SkillRegistry(['run_command']);
  registry.register({ id: 's1', name: 'Test', description: 'd', version: '1.0.0', tools: ['run_command'] });
  registry.load('s1');
  activateSkillsForRun(registry, ['s1']);

  const evRegistry = new EvidenceRegistry();
  const result = runSkillVerification(registry, 's1', evRegistry, {
    checks: [{ type: 'command', passed: true, command: 'echo ok' }],
  });

  assert.ok(result.success);
  assert.strictEqual(registry.get('s1').status, SKILL_STATUS.COMPLETED);
  assert.strictEqual(evRegistry.countSkillEvidence('s1'), 1);
});