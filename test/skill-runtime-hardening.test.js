/**
 * test/skill-runtime-hardening.test.js — Runtime Hardening Tests
 *
 * V0.8.1
 * Tests for event-state consistency, snapshot versioning,
 * persistence error handling, and recovery boundaries.
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
  canTransitionSkillStatus,
  SkillRuntimeContext,
  EvidenceRegistry,
  RUNTIME_EVENT_TYPES,
  RuntimeEventLog,
  createSnapshot,
  restoreSnapshot,
  RuntimePersistence,
  MemoryPersistenceAdapter,
  RuntimePersistenceError,
  SNAPSHOT_VERSION,
  migrateSnapshot,
  verifyEventStateConsistency,
} from '../agent/skill.js';

// ── Test 1: Event-State Auto Sync ─────────────────────────

test('Runtime-Harden: safeTransitionSkillStatus auto-emits event', () => {
  const skill = createSkill({ id: 's1', name: 'Test', description: 'd', version: '1.0.0', tools: ['run_command'] });
  const eventLog = new RuntimeEventLog();

  // Transition with event log
  safeTransitionSkillStatus(skill, SKILL_STATUS.AVAILABLE, eventLog, { runId: 'run-1', skillId: 's1' });
  safeTransitionSkillStatus(skill, SKILL_STATUS.RUNNING, eventLog, { runId: 'run-1', skillId: 's1' });

  const events = eventLog.getSkillEvents('s1');
  assert.ok(events.length >= 1, 'Should have at least one event');
  assert.strictEqual(events[0].type, RUNTIME_EVENT_TYPES.SKILL_RUNNING);
});

test('Runtime-Harden: state change without event log still works', () => {
  const skill = createSkill({ id: 's1', name: 'Test', description: 'd', version: '1.0.0', tools: ['run_command'] });
  // No event log — should still work
  assert.ok(safeTransitionSkillStatus(skill, SKILL_STATUS.AVAILABLE));
  assert.strictEqual(skill.status, SKILL_STATUS.AVAILABLE);
});

test('Runtime-Harden: verifyEventStateConsistency detects missing events', () => {
  // Create a skill that's COMPLETED but has no SKILL_COMPLETED event
  const skill = createSkill({ id: 's1', name: 'Test', description: 'd', version: '1.0.0', tools: ['run_command'] });
  const eventLog = new RuntimeEventLog();

  // Manually set status to COMPLETED without emitting event
  skill.status = SKILL_STATUS.COMPLETED;

  const result = verifyEventStateConsistency(skill, eventLog);
  assert.ok(!result.consistent);
  assert.ok(result.missingEvents.length > 0);
  assert.ok(result.missingEvents[0].includes('completed'));
});

test('Runtime-Harden: verifyEventStateConsistency passes with matching events', () => {
  const skill = createSkill({ id: 's1', name: 'Test', description: 'd', version: '1.0.0', tools: ['run_command'] });
  const eventLog = new RuntimeEventLog();

  // Proper transition with events
  safeTransitionSkillStatus(skill, SKILL_STATUS.AVAILABLE, eventLog, { runId: 'run-1', skillId: 's1' });
  safeTransitionSkillStatus(skill, SKILL_STATUS.RUNNING, eventLog, { runId: 'run-1', skillId: 's1' });
  safeTransitionSkillStatus(skill, SKILL_STATUS.VERIFYING, eventLog, { runId: 'run-1', skillId: 's1' });
  safeTransitionSkillStatus(skill, SKILL_STATUS.COMPLETED, eventLog, { runId: 'run-1', skillId: 's1' });

  const result = verifyEventStateConsistency(skill, eventLog);
  assert.ok(result.consistent);
  assert.strictEqual(result.missingEvents.length, 0);
});

test('Runtime-Harden: verifyEventStateConsistency passes for FAILED with event', () => {
  const skill = createSkill({ id: 's1', name: 'Test', description: 'd', version: '1.0.0', tools: ['run_command'] });
  const eventLog = new RuntimeEventLog();

  safeTransitionSkillStatus(skill, SKILL_STATUS.AVAILABLE, eventLog, { runId: 'run-1', skillId: 's1' });
  safeTransitionSkillStatus(skill, SKILL_STATUS.RUNNING, eventLog, { runId: 'run-1', skillId: 's1' });
  safeTransitionSkillStatus(skill, SKILL_STATUS.FAILED, eventLog, { runId: 'run-1', skillId: 's1', reason: 'test failure' });

  const result = verifyEventStateConsistency(skill, eventLog);
  assert.ok(result.consistent);
});

test('Runtime-Harden: event-state consistency for CANCELLED', () => {
  const skill = createSkill({ id: 's1', name: 'Test', description: 'd', version: '1.0.0', tools: ['run_command'] });
  const eventLog = new RuntimeEventLog();

  safeTransitionSkillStatus(skill, SKILL_STATUS.AVAILABLE, eventLog, { runId: 'run-1', skillId: 's1' });
  safeTransitionSkillStatus(skill, SKILL_STATUS.RUNNING, eventLog, { runId: 'run-1', skillId: 's1' });
  safeTransitionSkillStatus(skill, SKILL_STATUS.CANCELLED, eventLog, { runId: 'run-1', skillId: 's1' });

  const result = verifyEventStateConsistency(skill, eventLog);
  assert.ok(result.consistent);
});

// ── Test 2: Snapshot Versioning ───────────────────────────

test('Runtime-Harden: createSnapshot includes version field', () => {
  const ctx = new SkillRuntimeContext('run-1');
  const snapshot = createSnapshot('run-1', ctx, new EvidenceRegistry(), new RuntimeEventLog(), 'running');
  assert.ok(snapshot.version);
  assert.strictEqual(snapshot.version, SNAPSHOT_VERSION);
});

test('Runtime-Harden: migrateSnapshot adds version to v0 snapshots', () => {
  const v0Snapshot = {
    runId: 'run-1',
    timestamp: Date.now(),
    status: 'running',
    // No version field — this is v0
  };
  const migrated = migrateSnapshot(v0Snapshot);
  assert.strictEqual(migrated.version, '1');
  assert.ok(migrated.migratedAt > 0);
  assert.ok(migrated.migration);
});

test('Runtime-Harden: migrateSnapshot passes through current version', () => {
  const currentSnapshot = {
    runId: 'run-1',
    timestamp: Date.now(),
    status: 'running',
    version: SNAPSHOT_VERSION,
  };
  const migrated = migrateSnapshot(currentSnapshot);
  assert.strictEqual(migrated.version, SNAPSHOT_VERSION);
  assert.strictEqual(migrated, currentSnapshot); // No change for current version
});

test('Runtime-Harden: restoreSnapshot applies migration', () => {
  const v0Snapshot = {
    runId: 'run-1',
    timestamp: Date.now(),
    status: 'running',
    runtimeContext: new SkillRuntimeContext('run-1').serialize(),
    evidenceRegistry: new EvidenceRegistry().serialize(),
    eventLog: new RuntimeEventLog().serialize(),
  };
  const restored = restoreSnapshot(v0Snapshot, new SkillRegistry([]));
  assert.ok(restored);
  assert.ok(restored.snapshotVersion);
  assert.strictEqual(restored.snapshotVersion, '1');
});

test('Runtime-Harden: SNAPSHOT_VERSION is a string', () => {
  assert.strictEqual(typeof SNAPSHOT_VERSION, 'string');
  assert.ok(SNAPSHOT_VERSION.length > 0);
});

// ── Test 3: Persistence Error Handling ────────────────────

test('Runtime-Harden: RuntimePersistenceError has correct properties', () => {
  const err = new RuntimePersistenceError('Test error', 'TEST_ERROR', { detail: 'test' });
  assert.strictEqual(err.name, 'RuntimePersistenceError');
  assert.strictEqual(err.errorCode, 'TEST_ERROR');
  assert.strictEqual(err.message, 'Test error');
  assert.ok(err.timestamp > 0);
  assert.deepStrictEqual(err.details, { detail: 'test' });
});

test('Runtime-Harden: RuntimePersistenceError factory methods', () => {
  const err1 = RuntimePersistenceError.serializationFailed('bad json');
  assert.strictEqual(err1.errorCode, 'SERIALIZATION_FAILED');
  assert.ok(err1.message.includes('serialization'));

  const err2 = RuntimePersistenceError.notFound('run-1');
  assert.strictEqual(err2.errorCode, 'NOT_FOUND');
  assert.ok(err2.message.includes('run-1'));

  const err3 = RuntimePersistenceError.saveFailed('run-1', 'disk full');
  assert.strictEqual(err3.errorCode, 'SAVE_FAILED');
  assert.ok(err3.details.reason.includes('disk full'));
});

test('Runtime-Harden: RuntimePersistenceError is an Error subclass', () => {
  const err = new RuntimePersistenceError('test', 'TEST');
  assert.ok(err instanceof Error);
  assert.ok(err instanceof RuntimePersistenceError);
});

test('Runtime-Harden: MemoryPersistenceAdapter throws on save failure', async () => {
  const adapter = new MemoryPersistenceAdapter({ failOnSave: true });
  try {
    await adapter.save({ runId: 'run-1' });
    assert.ok(false, 'Should have thrown');
  } catch (err) {
    assert.ok(err instanceof RuntimePersistenceError);
    assert.strictEqual(err.errorCode, 'SAVE_FAILED');
  }
});

test('Runtime-Harden: MemoryPersistenceAdapter throws on load failure', async () => {
  const adapter = new MemoryPersistenceAdapter({ failOnLoad: true });
  try {
    await adapter.load('run-1');
    assert.ok(false, 'Should have thrown');
  } catch (err) {
    assert.ok(err instanceof RuntimePersistenceError);
    assert.strictEqual(err.errorCode, 'LOAD_FAILED');
  }
});

test('Runtime-Harden: RuntimePersistence wraps adapter errors', async () => {
  const adapter = new MemoryPersistenceAdapter({ failOnSave: true });
  const persistence = new RuntimePersistence(adapter);

  try {
    await persistence.save({ runId: 'run-1' });
    assert.ok(false, 'Should have thrown');
  } catch (err) {
    assert.ok(err instanceof RuntimePersistenceError);
  }
});

test('Runtime-Harden: RuntimePersistence load not-found returns null', async () => {
  const persistence = new RuntimePersistence(new MemoryPersistenceAdapter());
  const result = await persistence.load('nonexistent');
  assert.strictEqual(result, null);
});

// ── Test 4: Recovery Boundary ─────────────────────────────

test('Runtime-Harden: restoreSnapshot restores state but does not resume tools', () => {
  const registry = new SkillRegistry(['run_command']);
  registry.register({ id: 's1', name: 'Test', description: 'd', version: '1.0.0', tools: ['run_command'] });
  registry.load('s1');
  activateSkillsForRun(registry, ['s1']);

  const ctx = new SkillRuntimeContext('run-1');
  ctx.addSkill(registry.get('s1'));
  ctx.updateSkillStatus('s1', SKILL_STATUS.RUNNING);

  const snapshot = createSnapshot('run-1', ctx, new EvidenceRegistry(), ctx.eventLog, 'running');
  const restored = restoreSnapshot(snapshot, registry);

  // Restore: state is recovered
  assert.strictEqual(restored.runtimeContext.activeSkills.length, 1);
  assert.strictEqual(restored.runtimeContext.lifecycle.get('s1').state, SKILL_STATUS.RUNNING);

  // Resume: NOT supported — no tool execution state
  // This is a documented limitation, not a bug
  assert.strictEqual(restored.restoredAt > 0, true);
});

test('Runtime-Harden: restoreSnapshot preserves verification results', () => {
  const registry = new SkillRegistry(['run_command']);
  registry.register({ id: 's1', name: 'Test', description: 'd', version: '1.0.0', tools: ['run_command'] });
  registry.load('s1');
  activateSkillsForRun(registry, ['s1']);

  const ctx = new SkillRuntimeContext('run-1');
  ctx.addSkill(registry.get('s1'));

  const evRegistry = new EvidenceRegistry();
  const result = runSkillVerification(registry, 's1', evRegistry, {
    checks: [{ type: 'command', passed: true, command: 'echo ok' }],
  });
  ctx.setVerificationResult('s1', result);

  const snapshot = createSnapshot('run-1', ctx, evRegistry, ctx.eventLog, 'completed');
  const restored = restoreSnapshot(snapshot, registry);

  const vr = restored.runtimeContext.getVerificationResult('s1');
  assert.ok(vr);
  assert.ok(vr.success);
});

// ── Test 5: Full Hardening Flow ───────────────────────────

test('Runtime-Harden: full flow — event-state consistency end-to-end', () => {
  const registry = new SkillRegistry(['run_command']);
  registry.register({ id: 's1', name: 'Test', description: 'd', version: '1.0.0', tools: ['run_command'] });
  registry.load('s1');

  const eventLog = new RuntimeEventLog();
  const ctx = new SkillRuntimeContext('run-1');
  ctx.addSkill(registry.get('s1'));

  // Activate with events
  activateSkillsForRun(registry, ['s1']);
  safeTransitionSkillStatus(registry.get('s1'), SKILL_STATUS.RUNNING, eventLog, { runId: 'run-1', skillId: 's1' });

  // Verify with event log
  const evRegistry = new EvidenceRegistry();
  const result = runSkillVerification(registry, 's1', evRegistry, {
    checks: [{ type: 'command', passed: true, command: 'echo ok' }],
    eventLog,
    runId: 'run-1',
  });

  // Check consistency
  const consistency = verifyEventStateConsistency(registry.get('s1'), eventLog);
  assert.ok(consistency.consistent, `Consistency check failed: ${consistency.missingEvents.join(', ')}`);

  // Snapshot with version
  ctx.updateSkillStatus('s1', SKILL_STATUS.COMPLETED);
  ctx.setVerificationResult('s1', result);
  const snapshot = createSnapshot('run-1', ctx, evRegistry, eventLog, 'completed');
  assert.strictEqual(snapshot.version, SNAPSHOT_VERSION);

  // Restore
  const restored = restoreSnapshot(snapshot, registry);
  assert.ok(restored);
  assert.strictEqual(restored.runtimeContext.lifecycle.get('s1').state, SKILL_STATUS.COMPLETED);
  assert.ok(restored.runtimeContext.getVerificationResult('s1').success);
  assert.strictEqual(restored.snapshotVersion, SNAPSHOT_VERSION);
});

test('Runtime-Harden: failure flow with event-state consistency', () => {
  const registry = new SkillRegistry(['run_command']);
  registry.register({ id: 's1', name: 'Test', description: 'd', version: '1.0.0', tools: ['run_command'] });
  registry.load('s1');

  const eventLog = new RuntimeEventLog();

  activateSkillsForRun(registry, ['s1']);
  safeTransitionSkillStatus(registry.get('s1'), SKILL_STATUS.RUNNING, eventLog, { runId: 'run-1', skillId: 's1' });

  const evRegistry = new EvidenceRegistry();
  runSkillVerification(registry, 's1', evRegistry, {
    checks: [{ type: 'command', passed: false, command: 'fail' }],
    reason: 'Tests failed',
    eventLog,
    runId: 'run-1',
  });

  const consistency = verifyEventStateConsistency(registry.get('s1'), eventLog);
  assert.ok(consistency.consistent);
  assert.strictEqual(registry.get('s1').status, SKILL_STATUS.FAILED);
});

// ── Test 6: canTransitionSkillStatus Still Works ──────────

test('Runtime-Harden: canTransitionSkillStatus checks without modifying', () => {
  const skill = createSkill({ id: 's1', name: 'Test', description: 'd', version: '1.0.0', tools: ['run_command'] });
  // REGISTERED → AVAILABLE is valid
  assert.ok(canTransitionSkillStatus(skill, SKILL_STATUS.AVAILABLE));
  // REGISTERED → COMPLETED is illegal
  assert.ok(!canTransitionSkillStatus(skill, SKILL_STATUS.COMPLETED));
  // Status unchanged
  assert.strictEqual(skill.status, SKILL_STATUS.REGISTERED);
});