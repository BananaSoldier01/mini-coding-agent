/**
 * agent/runtime/workspace-store.js — Workspace Persistence Store
 *
 * V1.1.1
 * - WorkspaceStore: unified persistence layer for Workspace
 * - Separates persistence from Registry (Registry = query, Store = persistence)
 * - Supports restore after runtime restart
 *
 * Design:
 *   WorkspaceStore is the Source of Truth for Workspace state.
 *   WorkspaceRegistry queries the Store.
 *   Workspace state changes go through the Store.
 */

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
} from './workspace.js';

class WorkspaceStore {
  constructor(options = {}) {
    this.workspaces = new Map(); // id → workspace
    this.emitter = options.emitter || null;
    this.eventStore = options.eventStore || null;
  }

  // ── CRUD ──────────────────────────────────────────────

  /**
   * V1.1.1: Create and persist a workspace.
   */
  create(config = {}) {
    const workspace = createWorkspace(config);

    if (this.workspaces.has(workspace.id)) {
      return { success: false, reason: `Workspace ${workspace.id} already exists`, workspace: null };
    }

    // Bind run if provided
    if (config.runId) {
      bindRun(workspace, config.runId);
    }

    // Persist
    this.workspaces.set(workspace.id, workspace);

    // Auto-activate
    activateWorkspace(workspace, this.emitter, { runId: config.runId });

    if (this.emitter) {
      this.emitter.emit({
        runId: config.runId,
        workspaceId: workspace.id,
        type: 'workspace_created',
        data: {
          workspaceId: workspace.id,
          name: workspace.name,
          rootPath: workspace.rootPath,
        },
      });
    }

    return { success: true, workspace, created: true };
  }

  /**
   * V1.1.1: Get workspace by ID.
   */
  get(workspaceId) {
    return this.workspaces.get(workspaceId) || null;
  }

  /**
   * V1.1.1: Update workspace state.
   */
  update(workspaceId, updates) {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) {
      return { success: false, reason: `Workspace ${workspaceId} not found` };
    }

    Object.assign(workspace, updates, { updatedAt: Date.now() });
    return { success: true, workspace };
  }

  /**
   * V1.1.1: Delete workspace (only archived).
   */
  delete(workspaceId) {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) {
      return { success: false, reason: `Workspace ${workspaceId} not found` };
    }
    if (workspace.status !== WORKSPACE_STATUS.ARCHIVED) {
      return { success: false, reason: 'Can only delete archived workspaces' };
    }

    this.workspaces.delete(workspaceId);
    return { success: true };
  }

  // ── Lifecycle ─────────────────────────────────────────

  /**
   * V1.1.1: Activate workspace with duplicate protection.
   */
  activate(workspaceId, context = {}) {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) {
      return { success: false, reason: `Workspace ${workspaceId} not found` };
    }
    if (workspace.status === WORKSPACE_STATUS.ACTIVE) {
      return { success: false, reason: 'Workspace already active' };
    }
    if (workspace.status === WORKSPACE_STATUS.ARCHIVED) {
      return { success: false, reason: 'Cannot activate archived workspace' };
    }

    const ok = activateWorkspace(workspace, this.emitter, context);
    if (!ok) {
      return { success: false, reason: `Cannot activate workspace in status: ${workspace.status}` };
    }

    return { success: true, workspace };
  }

  /**
   * V1.1.1: Archive workspace with protection.
   */
  archive(workspaceId, context = {}) {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) {
      return { success: false, reason: `Workspace ${workspaceId} not found` };
    }
    if (workspace.status === WORKSPACE_STATUS.ARCHIVED) {
      return { success: false, reason: 'Workspace already archived' };
    }

    const ok = archiveWorkspace(workspace, this.emitter, context);
    if (!ok) {
      return { success: false, reason: `Cannot archive workspace in status: ${workspace.status}` };
    }

    return { success: true, workspace };
  }

  // ── Run Binding ───────────────────────────────────────

  /**
   * V1.1.1: Bind run to workspace.
   */
  bindRun(workspaceId, runId) {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) {
      return { success: false, reason: `Workspace ${workspaceId} not found` };
    }
    bindRun(workspace, runId);
    return { success: true, workspace };
  }

  /**
   * V1.1.1: Unbind run from workspace.
   */
  unbindRun(workspaceId, runId) {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) {
      return { success: false, reason: `Workspace ${workspaceId} not found` };
    }
    unbindRun(workspace, runId);
    return { success: true, workspace };
  }

  /**
   * V1.1.1: Get workspace for a run.
   */
  getWorkspaceForRun(runId) {
    for (const ws of this.workspaces.values()) {
      if (hasRun(ws, runId)) return ws;
    }
    return null;
  }

  /**
   * V1.1.1: Get or create workspace for a run.
   */
  getOrCreateForRun(runId, config = {}) {
    // Check existing
    const existing = this.getWorkspaceForRun(runId);
    if (existing) {
      return { success: true, workspace: existing, created: false };
    }

    // Create new
    return this.create({
      ...config,
      runId,
      name: config.name || `workspace_${runId}`,
    });
  }

  // ── Query ─────────────────────────────────────────────

  /**
   * V1.1.1: List all workspaces.
   */
  list() {
    return Array.from(this.workspaces.values());
  }

  /**
   * V1.1.1: List by status.
   */
  listByStatus(status) {
    return this.list().filter(ws => ws.status === status);
  }

  /**
   * V1.1.1: List by run.
   */
  listByRun(runId) {
    return this.list().filter(ws => hasRun(ws, runId));
  }

  // ── Recovery ──────────────────────────────────────────

  /**
   * V1.1.1: Restore workspace state from serialized data.
   * Used after runtime restart.
   */
  restore(data) {
    if (!data) return { success: false, reason: 'No data to restore' };

    let restored = 0;
    for (const [id, wsData] of Object.entries(data)) {
      const ws = deserializeWorkspace(wsData);
      if (ws) {
        this.workspaces.set(id, ws);
        restored++;
      }
    }

    return { success: true, restored };
  }

  /**
   * V1.1.1: Serialize all workspaces for persistence.
   */
  serialize() {
    const result = {};
    for (const [id, ws] of this.workspaces) {
      result[id] = serializeWorkspace(ws);
    }
    return result;
  }

  /**
   * V1.1.1: Clear all workspaces.
   */
  clear() {
    this.workspaces.clear();
  }
}

// ── Factory ───────────────────────────────────────────────

function createWorkspaceStore(options) {
  return new WorkspaceStore(options);
}

export {
  WorkspaceStore,
  createWorkspaceStore,
};