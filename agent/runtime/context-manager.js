/**
 * agent/runtime/context-manager.js — Context Management
 *
 * V1.1.0
 * - Runtime Context: workspace info, active files, task context, skill context
 * - createContext / updateContext / getContext
 * - Integration with Workspace Registry, Event Store
 *
 * Design:
 *   Context is the execution environment for Skills and Tools.
 *   Context carries workspace information through the entire execution pipeline.
 */

import { RUNTIME_EVENT_TYPES } from './events.js';

// ── Context Manager ───────────────────────────────────────

class ContextManager {
  constructor(options = {}) {
    this.workspaceRegistry = options.workspaceRegistry || null;
    this.emitter = options.emitter || null;
    this.eventStore = options.eventStore || null;
    this.contexts = new Map(); // contextId → context
    this.runContextMap = new Map(); // runId → contextId
  }

  // ── Context Lifecycle ─────────────────────────────────

  /**
   * V1.1.0: Create a new execution context.
   */
  create(context = {}) {
    const contextId = `ctx_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const ctx = {
      id: contextId,
      workspaceId: context.workspaceId || null,
      runId: context.runId || null,
      taskId: context.taskId || null,
      skillId: context.skillId || null,
      files: context.files || [],
      variables: context.variables || {},
      metadata: context.metadata || {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    this.contexts.set(contextId, ctx);
    if (ctx.runId) {
      this.runContextMap.set(ctx.runId, contextId);
    }

    if (this.emitter) {
      this.emitter.emit({
        runId: ctx.runId,
        workspaceId: ctx.workspaceId,
        type: RUNTIME_EVENT_TYPES.CONTEXT_UPDATED,
        data: {
          contextId,
          action: 'created',
          workspaceId: ctx.workspaceId,
        },
      });
    }

    return ctx;
  }

  /**
   * V1.1.0: Get context by ID.
   */
  get(contextId) {
    return this.contexts.get(contextId) || null;
  }

  /**
   V1.1.0: Get context for a run.
   */
  getByRun(runId) {
    const contextId = this.runContextMap.get(runId);
    if (!contextId) return null;
    return this.get(contextId);
  }

  /**
   V1.1.0: Update context.
   */
  update(contextId, updates) {
    const ctx = this.contexts.get(contextId);
    if (!ctx) return null;

    Object.assign(ctx, updates, { updatedAt: Date.now() });

    if (this.emitter) {
      this.emitter.emit({
        runId: ctx.runId,
        workspaceId: ctx.workspaceId,
        type: RUNTIME_EVENT_TYPES.CONTEXT_UPDATED,
        data: {
          contextId,
          action: 'updated',
          updates: Object.keys(updates),
        },
      });
    }

    return ctx;
  }

  /**
   V1.1.0: Add file to context.
   */
  addFile(contextId, file) {
    const ctx = this.contexts.get(contextId);
    if (!ctx) return null;
    if (!ctx.files.includes(file)) {
      ctx.files.push(file);
      ctx.updatedAt = Date.now();
    }
    return ctx;
  }

  /**
   V1.1.0: Set context variable.
   */
  setVariable(contextId, key, value) {
    const ctx = this.contexts.get(contextId);
    if (!ctx) return null;
    ctx.variables[key] = value;
    ctx.updatedAt = Date.now();
    return ctx;
  }

  /**
   V1.1.0: Get context variable.
   */
  getVariable(contextId, key) {
    const ctx = this.contexts.get(contextId);
    if (!ctx) return null;
    return ctx.variables[key];
  }

  /**
   V1.1.0: Create context for a run with workspace binding.
   */
  createForRun(runId, workspaceId, options = {}) {
    const ctx = this.create({
      runId,
      workspaceId,
      ...options,
    });

    // Bind to workspace
    if (this.workspaceRegistry && workspaceId) {
      this.workspaceRegistry.bindRun(workspaceId, runId);
    }

    return ctx;
  }

  // ── Serialization ─────────────────────────────────────

  serialize() {
    return {
      contexts: Object.fromEntries(this.contexts),
      runContextMap: Object.fromEntries(this.runContextMap),
    };
  }

  deserialize(data) {
    if (!data) return;
    if (data.contexts) {
      for (const [id, ctx] of Object.entries(data.contexts)) {
        this.contexts.set(id, ctx);
      }
    }
    if (data.runContextMap) {
      this.runContextMap = new Map(Object.entries(data.runContextMap));
    }
  }
}

// ── Factory ───────────────────────────────────────────────

function createContextManager(options) {
  return new ContextManager(options);
}

export {
  ContextManager,
  createContextManager,
};