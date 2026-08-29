/**
 * agent/runtime/workspace.js — Workspace Model
 *
 * V1.1.0
 * - Workspace: persistent, isolated, observable working environment
 * - Lifecycle: CREATED → ACTIVE → ARCHIVED
 * - Structure: files/, context/, artifacts/, snapshots/, logs/
 *
 * Design:
 *   Workspace is where Agent works.
 *   Each Run binds to one Workspace.
 *   Workspace state is observable and replayable.
 */

import { RUNTIME_EVENT_TYPES } from './events.js';
import { cloneEntity } from './clone.js';

// ── Workspace Status ──────────────────────────────────────

const WORKSPACE_STATUS = {
  CREATED: 'created',
  ACTIVE: 'active',
  ARCHIVED: 'archived',
};

const WORKSPACE_TRANSITIONS = {
  [WORKSPACE_STATUS.CREATED]: [WORKSPACE_STATUS.ACTIVE, WORKSPACE_STATUS.ARCHIVED],
  [WORKSPACE_STATUS.ACTIVE]: [WORKSPACE_STATUS.ARCHIVED],
  [WORKSPACE_STATUS.ARCHIVED]: [],
};

// ── Workspace Factory ─────────────────────────────────────

/**
 * V1.1.0: Create a Workspace.
 */
function createWorkspace(options = {}) {
  const now = Date.now();
  return {
    id: options.id || `ws_${now}_${Math.random().toString(36).slice(2, 8)}`,
    name: options.name || `workspace_${now}`,
    rootPath: options.rootPath || `/workspace/${options.id || `ws_${now}`}`,
    status: WORKSPACE_STATUS.CREATED,
    metadata: options.metadata || {},
    runIds: [],
    createdAt: now,
    updatedAt: now,
    activatedAt: null,
    archivedAt: null,
    // V1.1.0: Sub-directory structure
    paths: {
      files: options.rootPath ? `${options.rootPath}/files` : `/workspace/files`,
      context: options.rootPath ? `${options.rootPath}/context` : `/workspace/context`,
      artifacts: options.rootPath ? `${options.rootPath}/artifacts` : `/workspace/artifacts`,
      snapshots: options.rootPath ? `${options.rootPath}/snapshots` : `/workspace/snapshots`,
      logs: options.rootPath ? `${options.rootPath}/logs` : `/workspace/logs`,
    },
  };
}

// ── Workspace Lifecycle ───────────────────────────────────

/**
 * V1.1.0: Activate workspace — CREATED → ACTIVE.
 */
function activateWorkspace(workspace, emitter, context = {}) {
  if (!workspace) return false;
  if (workspace.status !== WORKSPACE_STATUS.CREATED) {
    console.warn(`[Workspace] Cannot activate workspace in status: ${workspace.status}`);
    return false;
  }

  workspace.status = WORKSPACE_STATUS.ACTIVE;
  workspace.activatedAt = Date.now();
  workspace.updatedAt = Date.now();

  if (emitter) {
    emitter.emit({
      runId: context.runId,
      workspaceId: workspace.id,
      type: RUNTIME_EVENT_TYPES.WORKSPACE_ACTIVATED,
      data: { workspaceId: workspace.id, name: workspace.name },
    });
  }

  return true;
}

/**
 * V1.1.0: Archive workspace — ACTIVE/CREATED → ARCHIVED.
 */
function archiveWorkspace(workspace, emitter, context = {}) {
  if (!workspace) return false;
  if (workspace.status === WORKSPACE_STATUS.ARCHIVED) return false;

  workspace.status = WORKSPACE_STATUS.ARCHIVED;
  workspace.archivedAt = Date.now();
  workspace.updatedAt = Date.now();

  if (emitter) {
    emitter.emit({
      runId: context.runId,
      workspaceId: workspace.id,
      type: RUNTIME_EVENT_TYPES.WORKSPACE_ARCHIVED,
      data: { workspaceId: workspace.id, reason: context.reason || 'Archived' },
    });
  }

  return true;
}

// ── Workspace Run Binding ─────────────────────────────────

/**
 * V1.1.0: Bind a run to a workspace.
 */
function bindRun(workspace, runId) {
  if (!workspace) return false;
  if (!workspace.runIds.includes(runId)) {
    workspace.runIds.push(runId);
    workspace.updatedAt = Date.now();
  }
  return true;
}

/**
 * V1.1.0: Unbind a run from a workspace.
 */
function unbindRun(workspace, runId) {
  if (!workspace) return false;
  const idx = workspace.runIds.indexOf(runId);
  if (idx >= 0) {
    workspace.runIds.splice(idx, 1);
    workspace.updatedAt = Date.now();
  }
  return true;
}

/**
 * V1.1.0: Check if a run is bound to this workspace.
 */
function hasRun(workspace, runId) {
  if (!workspace) return false;
  return workspace.runIds.includes(runId);
}

// ── Serialization ─────────────────────────────────────────

/**
 * V1.1.0: Serialize workspace for snapshot.
 */
function serializeWorkspace(workspace) {
  if (!workspace) return null;
  // V1.2.3-fix: deep-clone so the snapshot is a detached, frozen copy. The old
  // version spread the workspace (shallow clone), leaving nested fields like
  // metadata / runIds / paths as live references into the running Runtime.
  return cloneEntity(workspace);
}

/**
 * V1.1.0: Deserialize workspace from snapshot.
 */
function deserializeWorkspace(data) {
  if (!data) return null;
  return { ...data };
}

export {
  WORKSPACE_STATUS,
  WORKSPACE_TRANSITIONS,
  createWorkspace,
  activateWorkspace,
  archiveWorkspace,
  bindRun,
  unbindRun,
  hasRun,
  serializeWorkspace,
  deserializeWorkspace,
};