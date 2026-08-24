/**
 * agent/runtime/workspace-registry.js — Workspace Registry
 *
 * V1.1.0
 * - Create, get, archive, delete, list workspaces
 * - Run-to-workspace binding
 * - Integration with Event Store
 *
 * Design:
 *   Workspace Registry is the single source of truth for workspace lifecycle.
 */

import { RUNTIME_EVENT_TYPES } from './events.js';
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

class WorkspaceRegistry {
  constructor(options = {}) {
    this.workspaces = new Map(); // id → workspace
    this.emitter = options.emitter || null;
    this.eventStore = options.eventStore || null;
    this.defaultWorkspaceId = options.defaultWorkspaceId || null;
  }

  // ── CRUD ──────────────────────────────────────────────

  /**
   * V1.1.0: Create a new workspace.
   */
  create(config = {}) {
    const workspace = createWorkspace(config);

    if (this.workspaces.has(workspace.id)) {
      return { success: false, reason: `Workspace ${workspace.id} already exists`, workspace: null };
    }

    this.workspaces.set(workspace.id, workspace);

    // Bind run if provided
    if (config.runId) {
      bindRun(workspace, config.runId);
    }

    // Auto-activate
    activateWorkspace(workspace, this.emitter, { runId: config.runId });

    if (this.emitter) {
      this.emitter.emit({
        runId: config.runId,
        workspaceId: workspace.id,
        type: RUNTIME_EVENT_TYPES.WORKSPACE_CREATED,
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
   * V1.1.0: Get workspace by ID.
   */
  get(workspaceId) {
    return this.workspaces.get(workspaceId) || null;
  }

  /**
   * V1.1.0: Get or create default workspace for a run.
   */
  getOrCreateForRun(runId, config = {}) {
    // Check existing workspaces for this run
    for (const ws of this.workspaces.values()) {
      if (hasRun(ws, runId)) {
        return { success: true, workspace: ws, created: false };
      }
    }

    // Create new workspace
    const wsConfig = {
      ...config,
      runId,
      name: config.name || `workspace_${runId}`,
    };
    return this.create(wsConfig);
  }

  /**
   * V1.1.0: Archive a workspace.
   */
  archive(workspaceId, context = {}) {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) {
      return { success: false, reason: `Workspace ${workspaceId} not found` };
    }

    const ok = archiveWorkspace(workspace, this.emitter, context);
    if (!ok) {
      return { success: false, reason: `Cannot archive workspace in status: ${workspace.status}` };
    }

    return { success: true, workspace };
  }

  /**
   * V1.1.0: Delete a workspace (only archived workspaces).
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

  /**
   * V1.1.0: List all workspaces.
   */
  list() {
    return Array.from(this.workspaces.values());
  }

  /**
   * V1.1.0: List workspaces by status.
   */
  listByStatus(status) {
    return this.list().filter(ws => ws.status === status);
  }

  /**
   * V1.1.0: List workspaces for a run.
   */
  listByRun(runId) {
    return this.list().filter(ws => hasRun(ws, runId));
  }

  /**
   * V1.1.0: Bind a run to a workspace.
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
   * V1.1.0: Get workspace for a run.
   */
  getWorkspaceForRun(runId) {
    for (const ws of this.workspaces.values()) {
      if (hasRun(ws, runId)) return ws;
    }
    return null;
  }

  // ── Serialization ─────────────────────────────────────

  serialize() {
    return {
      workspaces: Object.fromEntries(this.workspaces),
      defaultWorkspaceId: this.defaultWorkspaceId,
    };
  }

  deserialize(data) {
    if (!data) return;
    if (data.workspaces) {
      for (const [id, ws] of Object.entries(data.workspaces)) {
        this.workspaces.set(id, deserializeWorkspace(ws));
      }
    }
    if (data.defaultWorkspaceId) {
      this.defaultWorkspaceId = data.defaultWorkspaceId;
    }
  }
}

// ── Factory ───────────────────────────────────────────────

function createWorkspaceRegistry(options) {
  return new WorkspaceRegistry(options);
}

export {
  WorkspaceRegistry,
  createWorkspaceRegistry,
};