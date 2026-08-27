/**
 * agent/runtime/plan-store.js — Plan Persistence Store
 *
 * V1.2.2
 * - PlanStore: Source of Truth for Plan state
 * - Separated from ExecutionEngine
 * - Supports serialize/restore
 */

import { cloneEntity } from './clone.js';

class PlanStore {
  constructor(options = {}) {
    this.plans = new Map(); // planId → plan
    this.emitter = options.emitter || null;
    this.eventStore = options.eventStore || null;
  }

  // ── CRUD ──────────────────────────────────────────────

  create(plan) {
    if (this.plans.has(plan.id)) {
      return { success: false, reason: `Plan ${plan.id} already exists`, plan: null };
    }
    this.plans.set(plan.id, { ...plan });
    return { success: true, plan: this.plans.get(plan.id) };
  }

  get(planId) {
    const plan = this.plans.get(planId);
    if (!plan) return null;
    return cloneEntity(plan);
  }

  update(planId, updates) {
    const plan = this.plans.get(planId);
    if (!plan) return { success: false, reason: `Plan ${planId} not found` };
    Object.assign(plan, updates, { updatedAt: Date.now() });
    return { success: true, plan };
  }

  delete(planId) {
    const plan = this.plans.get(planId);
    if (!plan) return { success: false, reason: `Plan ${planId} not found` };
    this.plans.delete(planId);
    return { success: true };
  }

  // ── Query ─────────────────────────────────────────────

  list() { return Array.from(this.plans.values()).map(p => cloneEntity(p)); }
  listByRun(runId) { return this.list().filter(p => p.runId === runId); }
  count() { return this.plans.size; }
  has(planId) { return this.plans.has(planId); }

  // ── Serialization ─────────────────────────────────────

  serialize() {
    const result = {};
    for (const [id, plan] of this.plans) {
      result[id] = cloneEntity(plan);
    }
    return result;
  }

  restore(data) {
    if (!data) return { success: false, reason: 'No data' };
    let restored = 0;
    for (const [id, planData] of Object.entries(data)) {
      this.plans.set(id, { ...planData });
      restored++;
    }
    return { success: true, restored };
  }

  clear() { this.plans.clear(); }
}

function createPlanStore(options) {
  return new PlanStore(options);
}

export {
  PlanStore,
  createPlanStore,
};