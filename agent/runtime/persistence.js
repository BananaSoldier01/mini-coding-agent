/**
 * agent/runtime/persistence.js — Runtime Persistence & Evidence
 *
 * V0.8.2
 * - EvidenceRegistry
 * - RuntimePersistenceError
 * - RuntimePersistence
 * - MemoryPersistenceAdapter (with exists() contract)
 */

// ── Evidence Registry ─────────────────────────────────────

/**
 * V0.7.3: Evidence Registry — records why a skill is considered complete.
 * Evidence is the traceable proof that a skill's execution produced expected results.
 */
class EvidenceRegistry {
  constructor() {
    this.evidences = new Map(); // id → evidence
    this.skillIndex = new Map(); // skillId → [evidenceIds]
  }

  /**
   * Add evidence for a skill execution.
   */
  addEvidence(evidence) {
    const ev = {
      id: evidence.id || `ev_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      skillId: evidence.skillId,
      type: evidence.type || 'unknown',
      timestamp: evidence.timestamp || Date.now(),
      data: evidence.data || {},
      ...evidence,
    };
    this.evidences.set(ev.id, ev);

    if (!this.skillIndex.has(ev.skillId)) {
      this.skillIndex.set(ev.skillId, []);
    }
    this.skillIndex.get(ev.skillId).push(ev.id);

    return ev;
  }

  /**
   * Get evidence by id.
   */
  getEvidence(evidenceId) {
    return this.evidences.get(evidenceId) || null;
  }

  /**
   * List all evidence for a skill.
   */
  listSkillEvidence(skillId) {
    const ids = this.skillIndex.get(skillId) || [];
    return ids.map(id => this.evidences.get(id)).filter(Boolean);
  }

  /**
   * Get evidence count for a skill.
   */
  countSkillEvidence(skillId) {
    return (this.skillIndex.get(skillId) || []).length;
  }

  /**
   * Clear evidence for a skill (used when re-verifying).
   */
  clearSkillEvidence(skillId) {
    const ids = this.skillIndex.get(skillId) || [];
    for (const id of ids) {
      this.evidences.delete(id);
    }
    this.skillIndex.delete(skillId);
  }

  /**
   * Serialize for persistence.
   */
  serialize() {
    return {
      evidences: Object.fromEntries(this.evidences),
      skillIndex: Object.fromEntries(this.skillIndex),
    };
  }

  /**
   * Deserialize from persistence.
   */
  static deserialize(data) {
    const registry = new EvidenceRegistry();
    if (data.evidences) {
      for (const [id, ev] of Object.entries(data.evidences)) {
        registry.evidences.set(id, ev);
      }
    }
    if (data.skillIndex) {
      for (const [skillId, ids] of Object.entries(data.skillIndex)) {
        registry.skillIndex.set(skillId, ids);
      }
    }
    return registry;
  }
}

// ── Runtime Persistence Error ─────────────────────────────

/**
 * V0.8.1: RuntimePersistenceError — unified error model for persistence operations.
 */
class RuntimePersistenceError extends Error {
  constructor(message, errorCode, details = {}) {
    super(message);
    this.name = 'RuntimePersistenceError';
    this.errorCode = errorCode;
    this.details = details;
    this.timestamp = Date.now();
  }

  static serializationFailed(detail) {
    return new RuntimePersistenceError(
      'Snapshot serialization failed',
      'SERIALIZATION_FAILED',
      { detail }
    );
  }

  static deserializationFailed(detail) {
    return new RuntimePersistenceError(
      'Snapshot deserialization failed',
      'DESERIALIZATION_FAILED',
      { detail }
    );
  }

  static notFound(runId) {
    return new RuntimePersistenceError(
      `Snapshot not found: ${runId}`,
      'NOT_FOUND',
      { runId }
    );
  }

  static saveFailed(runId, reason) {
    return new RuntimePersistenceError(
      `Failed to save snapshot: ${runId}`,
      'SAVE_FAILED',
      { runId, reason }
    );
  }

  static deleteFailed(runId, reason) {
    return new RuntimePersistenceError(
      `Failed to delete snapshot: ${runId}`,
      'DELETE_FAILED',
      { runId, reason }
    );
  }
}

// ── Runtime Persistence ───────────────────────────────────

/**
 * V0.8: RuntimePersistence — pluggable adapter for saving/loading snapshots.
 * V0.8.1: Added unified error handling.
 * V0.8.2: Added exists() contract.
 */
class RuntimePersistence {
  constructor(adapter) {
    this.adapter = adapter || new MemoryPersistenceAdapter();
  }

  /**
   * Save a snapshot. Throws RuntimePersistenceError on failure.
   */
  async save(snapshot) {
    try {
      if (!snapshot || !snapshot.runId) {
        throw RuntimePersistenceError.serializationFailed('Invalid snapshot: missing runId');
      }
      return await this.adapter.save(snapshot);
    } catch (err) {
      if (err instanceof RuntimePersistenceError) throw err;
      throw RuntimePersistenceError.saveFailed(snapshot?.runId, err.message);
    }
  }

  /**
   * Load a snapshot by runId. Returns null if not found.
   * Throws RuntimePersistenceError on errors other than not-found.
   */
  async load(runId) {
    try {
      return await this.adapter.load(runId);
    } catch (err) {
      if (err instanceof RuntimePersistenceError) throw err;
      throw new RuntimePersistenceError(
        `Failed to load snapshot: ${runId}`,
        'LOAD_FAILED',
        { runId, reason: err.message }
      );
    }
  }

  /**
   * Delete a snapshot by runId.
   */
  async delete(runId) {
    try {
      return await this.adapter.delete(runId);
    } catch (err) {
      if (err instanceof RuntimePersistenceError) throw err;
      throw RuntimePersistenceError.deleteFailed(runId, err.message);
    }
  }

  /**
   * List all saved snapshot runIds.
   */
  async list() {
    try {
      return await this.adapter.list();
    } catch (err) {
      throw new RuntimePersistenceError(
        'Failed to list snapshots',
        'LIST_FAILED',
        { reason: err.message }
      );
    }
  }

  /**
   * V0.8.2: Check if a snapshot exists for a runId.
   * Required by crash detection and cleanup.
   */
  async exists(runId) {
    try {
      return await this.adapter.exists(runId);
    } catch (err) {
      throw new RuntimePersistenceError(
        `Failed to check snapshot existence: ${runId}`,
        'EXISTS_FAILED',
        { runId, reason: err.message }
      );
    }
  }
}

// ── Memory Persistence Adapter ────────────────────────────

/**
 * V0.8: In-memory persistence adapter (default).
 * V0.8.1: Added error simulation capability for testing.
 * V0.8.2: Added exists() to the adapter contract.
 */
class MemoryPersistenceAdapter {
  constructor(options = {}) {
    this.store = new Map();
    this.failOnSave = options.failOnSave || false;
    this.failOnLoad = options.failOnLoad || false;
    this.failOnExists = options.failOnExists || false;
  }

  async save(snapshot) {
    if (this.failOnSave) {
      throw RuntimePersistenceError.saveFailed(snapshot?.runId, 'Simulated save failure');
    }
    this.store.set(snapshot.runId, JSON.parse(JSON.stringify(snapshot)));
    return { ok: true, runId: snapshot.runId };
  }

  async load(runId) {
    if (this.failOnLoad) {
      throw new RuntimePersistenceError(
        `Failed to load snapshot: ${runId}`,
        'LOAD_FAILED',
        { runId, reason: 'Simulated load failure' }
      );
    }
    return this.store.get(runId) || null;
  }

  async delete(runId) {
    return this.store.delete(runId);
  }

  async list() {
    return Array.from(this.store.keys());
  }

  /**
   * V0.8.2: Check if a snapshot exists for a runId.
   */
  async exists(runId) {
    if (this.failOnExists) {
      throw new RuntimePersistenceError(
        `Failed to check snapshot existence: ${runId}`,
        'EXISTS_FAILED',
        { runId, reason: 'Simulated exists failure' }
      );
    }
    return this.store.has(runId);
  }
}

export {
  EvidenceRegistry,
  RuntimePersistenceError,
  RuntimePersistence,
  MemoryPersistenceAdapter,
};