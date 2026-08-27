/**
 * agent/runtime/task-store.js — Task Persistence Store
 *
 * V1.2.2
 * - TaskStore: Source of Truth for Task state
 * - Separated from ExecutionEngine
 * - Supports serialize/restore
 */

import { cloneEntity } from './clone.js';

class TaskStore {
  constructor(options = {}) {
    this.tasks = new Map(); // taskId → task
    this.emitter = options.emitter || null;
    this.eventStore = options.eventStore || null;
  }

  // ── CRUD ──────────────────────────────────────────────

  create(task) {
    if (this.tasks.has(task.id)) {
      return { success: false, reason: `Task ${task.id} already exists`, task: null };
    }
    this.tasks.set(task.id, { ...task });
    return { success: true, task: this.tasks.get(task.id) };
  }

  get(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) return null;
    return cloneEntity(task);
  }

  update(taskId, updates) {
    const task = this.tasks.get(taskId);
    if (!task) return { success: false, reason: `Task ${taskId} not found` };
    Object.assign(task, updates, { updatedAt: Date.now() });
    return { success: true, task };
  }

  delete(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) return { success: false, reason: `Task ${taskId} not found` };
    this.tasks.delete(taskId);
    return { success: true };
  }

  // ── Query ─────────────────────────────────────────────

  list() { return Array.from(this.tasks.values()).map(t => cloneEntity(t)); }
  listByRun(runId) { return this.list().filter(t => t.runId === runId); }
  listByStatus(status) { return this.list().filter(t => t.status === status); }
  count() { return this.tasks.size; }
  has(taskId) { return this.tasks.has(taskId); }

  // ── Serialization ─────────────────────────────────────

  serialize() {
    const result = {};
    for (const [id, task] of this.tasks) {
      result[id] = cloneEntity(task);
    }
    return result;
  }

  restore(data) {
    if (!data) return { success: false, reason: 'No data' };
    let restored = 0;
    for (const [id, taskData] of Object.entries(data)) {
      this.tasks.set(id, { ...taskData });
      restored++;
    }
    return { success: true, restored };
  }

  clear() { this.tasks.clear(); }
}

function createTaskStore(options) {
  return new TaskStore(options);
}

export {
  TaskStore,
  createTaskStore,
};