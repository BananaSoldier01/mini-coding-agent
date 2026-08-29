/**
 * agent/runtime/artifact-store.js — Artifact Management
 *
 * V1.1.0
 * - Artifacts: generated outputs (reports, patches, test results, code)
 * - createArtifact / getArtifact / listArtifacts
 * - Integration with Workspace Registry, Event Store
 *
 * Design:
 *   Artifacts are Agent-generated outputs.
 *   Artifacts are bound to Workspace and Task/Skill.
 *   Artifact creation is observable and replayable.
 */

import { RUNTIME_EVENT_TYPES } from './events.js';
import { cloneEntity } from './clone.js';

// ── Artifact Types ────────────────────────────────────────

const ARTIFACT_TYPES = {
  REPORT: 'report',
  PATCH: 'patch',
  TEST_RESULT: 'test_result',
  CODE: 'code',
  DOCUMENT: 'document',
  IMAGE: 'image',
  DATA: 'data',
  LOG: 'log',
  OTHER: 'other',
};

// ── Artifact Store ────────────────────────────────────────

class ArtifactStore {
  constructor(options = {}) {
    this.artifacts = new Map(); // id → artifact
    this.workspaceRegistry = options.workspaceRegistry || null;
    this.emitter = options.emitter || null;
    this.eventStore = options.eventStore || null;
  }

  // ── CRUD ──────────────────────────────────────────────

  /**
   * V1.1.0: Create an artifact.
   */
  create(options = {}) {
    const artifact = {
      id: options.id || `art_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      workspaceId: options.workspaceId || null,
      taskId: options.taskId || null,
      skillId: options.skillId || null,
      name: options.name || `artifact_${Date.now()}`,
      type: options.type || ARTIFACT_TYPES.OTHER,
      path: options.path || null,
      content: options.content || null,
      metadata: options.metadata || {},
      createdBy: options.createdBy || 'system',
      createdAt: Date.now(),
    };

    this.artifacts.set(artifact.id, artifact);

    if (this.emitter) {
      this.emitter.emit({
        runId: options.runId,
        workspaceId: artifact.workspaceId,
        taskId: artifact.taskId,
        type: RUNTIME_EVENT_TYPES.ARTIFACT_CREATED,
        data: {
          artifactId: artifact.id,
          name: artifact.name,
          type: artifact.type,
          workspaceId: artifact.workspaceId,
          taskId: artifact.taskId,
        },
      });
    }

    return artifact;
  }

  /**
   * V1.1.0: Get artifact by ID.
   */
  get(artifactId) {
    return this.artifacts.get(artifactId) || null;
  }

  /**
   * V1.1.0: List artifacts for a workspace.
   */
  listByWorkspace(workspaceId) {
    return Array.from(this.artifacts.values())
      .filter(a => a.workspaceId === workspaceId);
  }

  /**
   * V1.1.0: List artifacts for a task.
   */
  listByTask(taskId) {
    return Array.from(this.artifacts.values())
      .filter(a => a.taskId === taskId);
  }

  /**
   * V1.1.0: List artifacts for a run (via workspace).
   */
  listByRun(runId) {
    if (!this.workspaceRegistry) {
      return Array.from(this.artifacts.values());
    }
    const workspace = this.workspaceRegistry.getWorkspaceForRun(runId);
    if (!workspace) return [];
    return this.listByWorkspace(workspace.id);
  }

  /**
   * V1.1.0: Delete an artifact.
   */
  delete(artifactId) {
    const artifact = this.artifacts.get(artifactId);
    if (!artifact) {
      return { success: false, reason: `Artifact ${artifactId} not found` };
    }

    this.artifacts.delete(artifactId);

    if (this.emitter) {
      this.emitter.emit({
        workspaceId: artifact.workspaceId,
        taskId: artifact.taskId,
        type: RUNTIME_EVENT_TYPES.ARTIFACT_DELETED,
        data: {
          artifactId,
          name: artifact.name,
        },
      });
    }

    return { success: true };
  }

  // ── Serialization ─────────────────────────────────────

  serialize() {
    // V1.2.3-fix: deep-clone every artifact so the snapshot is detached. The
    // old Object.fromEntries(this.artifacts) shared references with the live
    // Runtime — artifact content / metadata could be mutated after the
    // snapshot was taken, violating the "frozen crash snapshot" contract.
    const artifacts = {};
    for (const [id, art] of this.artifacts) {
      artifacts[id] = cloneEntity(art);
    }
    return { artifacts };
  }

  deserialize(data) {
    if (!data || !data.artifacts) return;
    for (const [id, art] of Object.entries(data.artifacts)) {
      this.artifacts.set(id, art);
    }
  }
}

// ── Factory ───────────────────────────────────────────────

function createArtifactStore(options) {
  return new ArtifactStore(options);
}

export {
  ARTIFACT_TYPES,
  ArtifactStore,
  createArtifactStore,
};