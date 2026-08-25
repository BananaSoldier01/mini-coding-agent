/**
 * agent/runtime/run-store.js — Run Persistence Store
 *
 * V1.2.2
 * - RunStore: Source of Truth for Run state
 * - Separated from ExecutionEngine
 * - Supports serialize/restore for crash recovery
 *
 * Design:
 *   RunStore owns Run state.
 *   ExecutionEngine queries RunStore, does not duplicate state.
 *   EventStore is the audit trail for Run lifecycle.
 */

import { RUNTIME_EVENT_TYPES } from './events.js';

const RUN_STATUS = {
  CREATED: 'created',
  STARTED: 'started',
  PAUSED: 'paused',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
};

class RunStore {
  constructor(options = {}) {
    this.runs = new Map(); // runId → run
    this.emitter = options.emitter || null;
    this.eventStore = options.eventStore || null;
  }

  // ── CRUD ──────────────────────────────────────────────

  /**
   * V1.2.2: Create a new Run.
   */
  create(config = {}) {
    const runId = config.runId || `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const goal = config.goal || 'Untitled Run';

    if (this.runs.has(runId)) {
      return { success: false, reason: `Run ${runId} already exists`, run: null };
    }

    const run = {
      id: runId,
      goal,
      status: RUN_STATUS.CREATED,
      workspaceId: config.workspaceId || null,
      planId: null,
      taskIds: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      startedAt: null,
      completedAt: null,
      failedAt: null,
      error: null,
      metadata: config.metadata || {},
    };

    this.runs.set(runId, run);

    // V1.2.3: Store does NOT emit lifecycle events — that's the Manager/Transition layer's job.
    // RunManager.create() emits run_created; startRun() emits run_started.

    return { success: true, run };
  }

  /**
   * V1.2.3: Get run by ID — returns a shallow clone to prevent
   * external mutation of internal Store state.
   */
  get(runId) {
    const run = this.runs.get(runId);
    if (!run) return null;
    return { ...run };
  }

  /**
   * V1.2.2: Update run state (called by TransitionManager only).
   */
  update(runId, updates) {
    const run = this.runs.get(runId);
    if (!run) return { success: false, reason: `Run ${runId} not found` };
    Object.assign(run, updates, { updatedAt: Date.now() });
    return { success: true, run };
  }

  /**
   * V1.2.2: Delete a run (only terminal states).
   */
  delete(runId) {
    const run = this.runs.get(runId);
    if (!run) return { success: false, reason: `Run ${runId} not found` };
    if (run.status !== RUN_STATUS.COMPLETED && run.status !== RUN_STATUS.CANCELLED) {
      return { success: false, reason: `Can only delete terminal runs, got: ${run.status}` };
    }
    this.runs.delete(runId);
    return { success: true };
  }

  // ── Query ─────────────────────────────────────────────

  list() { return Array.from(this.runs.values()).map(r => ({ ...r })); }
  listByStatus(status) { return this.list().filter(r => r.status === status); }
  count() { return this.runs.size; }
  has(runId) { return this.runs.has(runId); }

  // ── Serialization / Recovery ──────────────────────────

  /**
   * V1.2.2: Serialize all runs for persistence.
   */
  serialize() {
    const result = {};
    for (const [id, run] of this.runs) {
      result[id] = { ...run };
    }
    return result;
  }

  /**
   * V1.2.2: Restore runs from serialized data.
   */
  restore(data) {
    if (!data) return { success: false, reason: 'No data' };
    let restored = 0;
    for (const [id, runData] of Object.entries(data)) {
      this.runs.set(id, { ...runData });
      restored++;
    }
    return { success: true, restored };
  }

  /**
   * V1.2.2: Clear all runs.
   */
  clear() { this.runs.clear(); }
}

// ── Factory ───────────────────────────────────────────────

function createRunStore(options) {
  return new RunStore(options);
}

export {
  RunStore,
  createRunStore,
};

// Re-export RUN_STATUS for convenience (aliased to avoid conflict)
export { RUN_STATUS as RUN_STORE_STATUS } from './run-manager.js';