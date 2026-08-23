/**
 * agent/runtime/snapshot.js — Runtime Snapshot & Migration
 *
 * V0.8.2
 * - SNAPSHOT_VERSION
 * - createSnapshot / restoreSnapshot
 * - migrateSnapshot (strict mode: rejects unknown future versions)
 * - SnapshotCompatibilityError
 */

import { SkillRuntimeContext } from './context.js';
import { RuntimeEventLog } from './events.js';
import { EvidenceRegistry } from './persistence.js';

// ── Snapshot Version ──────────────────────────────────────

// V0.8.1: Current snapshot format version
const SNAPSHOT_VERSION = '1';

// Known migration versions (must be <= current)
const KNOWN_VERSIONS = ['0', '1'];

// ── Snapshot Compatibility Error ──────────────────────────

/**
 * V0.8.2: SnapshotCompatibilityError — thrown when a snapshot
 * cannot be safely restored because its version is unknown.
 * Agent state errors are more dangerous than failures.
 */
class SnapshotCompatibilityError extends Error {
  constructor(message, snapshotVersion, supportedVersions) {
    super(message);
    this.name = 'SnapshotCompatibilityError';
    this.snapshotVersion = snapshotVersion;
    this.supportedVersions = supportedVersions;
    this.timestamp = Date.now();
  }
}

// ── Create Snapshot ───────────────────────────────────────

/**
 * V0.8: RuntimeSnapshot — captures the full state of a run at a point in time.
 * V0.8.1: Added version field.
 * V0.9.4.1: Added approvals field for ExecutionGate state.
 */
function createSnapshot(runId, runtimeContext, evidenceRegistry, eventLog, status, executionGate) {
  const snapshot = {
    id: `snap_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    runId,
    timestamp: Date.now(),
    version: SNAPSHOT_VERSION,
    status: status || 'unknown',
    runtimeContext: runtimeContext ? runtimeContext.serialize() : null,
    evidenceRegistry: evidenceRegistry ? evidenceRegistry.serialize() : null,
    eventLog: eventLog ? eventLog.serialize() : null,
  };

  // V0.9.4.1: Include approval requests from ExecutionGate
  if (executionGate && executionGate.getRequestsByRun) {
    const approvals = executionGate.getRequestsByRun(runId);
    if (approvals.length > 0) {
      snapshot.approvals = approvals.map(a => ({
        id: a.id,
        runId: a.runId,
        target: a.target,
        reason: a.reason,
        context: a.context,
        status: a.status,
        createdAt: a.createdAt,
        resolvedAt: a.resolvedAt,
        resolvedBy: a.resolvedBy,
        resolutionReason: a.resolutionReason,
        timeoutMs: a.timeoutMs,
        expiresAt: a.expiresAt,
      }));
    }
  }

  return snapshot;
}

// ── Restore Snapshot ──────────────────────────────────────

/**
 * V0.8: Restore a RuntimeSnapshot into fresh runtime objects.
 * V0.8.1: Applies version migration.
 * V0.8.2: Strict mode — rejects unknown future versions.
 */
function restoreSnapshot(snapshot, registry) {
  if (!snapshot) return null;

  // V0.8.2: Strict version check (may throw SnapshotCompatibilityError)
  const migrated = migrateSnapshot(snapshot);

  const ctx = new SkillRuntimeContext(migrated.runId);
  if (migrated.runtimeContext) {
    const restored = SkillRuntimeContext.deserialize(migrated.runtimeContext, registry);
    Object.assign(ctx, restored);
  }

  const evRegistry = new EvidenceRegistry();
  if (migrated.evidenceRegistry) {
    const restoredEv = EvidenceRegistry.deserialize(migrated.evidenceRegistry);
    Object.assign(evRegistry, restoredEv);
  }

  const eventLog = new RuntimeEventLog();
  if (migrated.eventLog) {
    const restoredEv = RuntimeEventLog.deserialize(migrated.eventLog);
    Object.assign(eventLog, restoredEv);
  }

  return {
    runtimeContext: ctx,
    evidenceRegistry: evRegistry,
    eventLog,
    restoredAt: Date.now(),
    snapshotVersion: migrated.version,
  };
}

// ── Migrate Snapshot ──────────────────────────────────────

/**
 * V0.8.1: Migrate a snapshot to the current version.
 * V0.8.2: Strict mode — rejects unknown future versions.
 *
 * Known versions: v0 (no version field), v1 (current).
 * Unknown versions throw SnapshotCompatibilityError.
 */
function migrateSnapshot(snapshot) {
  if (!snapshot) return snapshot;

  // v0 snapshots have no version field
  if (!snapshot.version) {
    return {
      ...snapshot,
      version: '1',
      migratedAt: Date.now(),
      migration: 'v0 → v1 (added version field)',
    };
  }

  // Already current version
  if (snapshot.version === SNAPSHOT_VERSION) {
    return snapshot;
  }

  // Known but older version — attempt migration
  if (KNOWN_VERSIONS.includes(snapshot.version)) {
    console.warn(`[Snapshot] Migrating from v${snapshot.version} to v${SNAPSHOT_VERSION}`);
    return {
      ...snapshot,
      version: SNAPSHOT_VERSION,
      migratedAt: Date.now(),
      migration: `v${snapshot.version} → v${SNAPSHOT_VERSION}`,
    };
  }

  // Unknown future version — REJECT, do not best-effort restore
  throw new SnapshotCompatibilityError(
    `Cannot restore snapshot: unknown version "${snapshot.version}". ` +
    `Supported versions: ${KNOWN_VERSIONS.join(', ')}. ` +
    `Agent state errors are more dangerous than failures.`,
    snapshot.version,
    KNOWN_VERSIONS
  );
}

export {
  SNAPSHOT_VERSION,
  KNOWN_VERSIONS,
  SnapshotCompatibilityError,
  createSnapshot,
  restoreSnapshot,
  migrateSnapshot,
};