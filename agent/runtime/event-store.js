/**
 * agent/runtime/event-store.js — Runtime Event Store & Replay
 *
 * V0.9.7
 * - RuntimeEventStore: persistent event log
 * - Unified Event Schema: every event has { id, runId, planId, taskId, type, timestamp, data, source }
 * - Event Query: getEventsByRun, getEventsByTask, getRevisionTimeline
 * - Runtime Replay: replayRuntime(events) reconstructs state from event sequence
 * - Snapshot + Event integration
 *
 * Design:
 *   Event Store is the Runtime History Source.
 *   Runtime state transitions produce Events.
 *   Runtime state can be reconstructed from Event sequence.
 */

import { RUNTIME_EVENT_TYPES } from './events.js';
import { createPlan, PLAN_STATUS } from './plan.js';
import { TASK_STATUS } from './task.js';
import { REVISION_STATUS } from './revision.js';

// ── Event Store ───────────────────────────────────────────

class RuntimeEventStore {
  constructor(options = {}) {
    this.events = [];
    this.maxEvents = options.maxEvents || 10000;
    this.indexByRun = new Map();
    this.indexByTask = new Map();
    this.indexByPlan = new Map();
    this.indexByType = new Map();
  }

  // ── Append ─────────────────────────────────────────────

  /**
   * Append a runtime event with unified schema.
   */
  append(event) {
    const ev = this._normalize(event);

    // Index
    this.events.push(ev);
    this._index(ev);

    // Cap
    if (this.events.length > this.maxEvents) {
      const removed = this.events.slice(0, this.events.length - this.maxEvents);
      for (const r of removed) {
        this._unindex(r);
      }
      this.events = this.events.slice(-this.maxEvents);
    }

    return ev;
  }

  /**
   * Append multiple events in order.
   */
  appendAll(events) {
    const appended = [];
    for (const ev of events) {
      appended.push(this.append(ev));
    }
    return appended;
  }

  _normalize(event) {
    return {
      id: event.id || `evt_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
      runId: event.runId,
      planId: event.planId || null,
      taskId: event.taskId || null,
      type: event.type,
      timestamp: event.timestamp || Date.now(),
      data: event.data || {},
      source: event.source || 'runtime',
      // V0.9.7: Preserve revision context
      revision: event.revision || null,
      // V0.9.7: Preserve plan revision number
      planRevision: event.planRevision || null,
    };
  }

  _index(ev) {
    if (ev.runId) {
      if (!this.indexByRun.has(ev.runId)) this.indexByRun.set(ev.runId, []);
      this.indexByRun.get(ev.runId).push(ev);
    }
    if (ev.taskId) {
      if (!this.indexByTask.has(ev.taskId)) this.indexByTask.set(ev.taskId, []);
      this.indexByTask.get(ev.taskId).push(ev);
    }
    if (ev.planId) {
      if (!this.indexByPlan.has(ev.planId)) this.indexByPlan.set(ev.planId, []);
      this.indexByPlan.get(ev.planId).push(ev);
    }
    if (ev.type) {
      if (!this.indexByType.has(ev.type)) this.indexByType.set(ev.type, []);
      this.indexByType.get(ev.type).push(ev);
    }
  }

  _unindex(ev) {
    if (ev.runId && this.indexByRun.has(ev.runId)) {
      const arr = this.indexByRun.get(ev.runId);
      const i = arr.indexOf(ev);
      if (i >= 0) arr.splice(i, 1);
    }
    if (ev.taskId && this.indexByTask.has(ev.taskId)) {
      const arr = this.indexByTask.get(ev.taskId);
      const i = arr.indexOf(ev);
      if (i >= 0) arr.splice(i, 1);
    }
    if (ev.planId && this.indexByPlan.has(ev.planId)) {
      const arr = this.indexByPlan.get(ev.planId);
      const i = arr.indexOf(ev);
      if (i >= 0) arr.splice(i, 1);
    }
  }

  // ── Query ──────────────────────────────────────────────

  /**
   * Get all events for a run, ordered by timestamp.
   */
  getEventsByRun(runId) {
    if (!runId) return [...this.events];
    return (this.indexByRun.get(runId) || []).slice().sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * Get all events for a task, ordered by timestamp.
   */
  getEventsByTask(taskId) {
    if (!taskId) return [];
    return (this.indexByTask.get(taskId) || []).slice().sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * Get all events for a plan, ordered by timestamp.
   */
  getEventsByPlan(planId) {
    if (!planId) return [];
    return (this.indexByPlan.get(planId) || []).slice().sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * Get events by type.
   */
  getEventsByType(type) {
    return (this.indexByType.get(type) || []).slice();
  }

  /**
   * Get events in a time range.
   */
  getEventsInRange(from, to) {
    return this.events.filter(e => e.timestamp >= from && e.timestamp <= to);
  }

  /**
   * Get the revision timeline for a plan.
   * Returns ordered list of revision events with context.
   */
  getRevisionTimeline(planId) {
    const events = this.getEventsByPlan(planId);
    const revisionEvents = events.filter(e =>
      e.type === 'revision_requested' ||
      e.type === 'revision_validated' ||
      e.type === 'revision_applied' ||
      e.type === 'revision_rejected' ||
      e.type === 'revision_conflict' ||
      e.type === 'revision_rolled_back'
    );

    return revisionEvents.map(e => ({
      id: e.id,
      timestamp: e.timestamp,
      type: e.type,
      revision: e.revision || e.planRevision,
      reason: e.data?.reason,
      status: e.data?.status || e.data?.revision?.status,
      supersededIds: e.data?.supersededIds,
      conflictReason: e.data?.conflictReason || e.data?.reason,
    }));
  }

  /**
   * Get task lifecycle timeline.
   */
  getTaskTimeline(taskId) {
    const events = this.getEventsByTask(taskId);
    return events.map(e => ({
      id: e.id,
      timestamp: e.timestamp,
      type: e.type,
      status: e.data?.status || e.data?.task?.status,
      reason: e.data?.reason,
      previousStatus: e.data?.previousStatus,
    }));
  }

  /**
   * Get all events, ordered by timestamp.
   */
  getAllEvents() {
    return [...this.events].sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * Get event count.
   */
  count() {
    return this.events.length;
  }

  /**
   * Clear all events.
   */
  clear() {
    this.events = [];
    this.indexByRun.clear();
    this.indexByTask.clear();
    this.indexByPlan.clear();
    this.indexByType.clear();
  }

  /**
   * Clear events for a specific run.
   */
  clearRun(runId) {
    const runEvents = this.indexByRun.get(runId) || [];
    for (const ev of runEvents) {
      this._unindex(ev);
    }
    this.events = this.events.filter(e => e.runId !== runId);
  }

  // ── Serialization ──────────────────────────────────────

  /**
   * Serialize store for snapshot.
   */
  serialize() {
    return {
      events: this.events.map(e => ({ ...e })),
      maxEvents: this.maxEvents,
      count: this.events.length,
    };
  }

  /**
   * Deserialize store from snapshot.
   */
  deserialize(data) {
    if (!data) return;
    this.events = (data.events || []).map(e => ({ ...e }));
    this.maxEvents = data.maxEvents || 10000;
    // Rebuild indexes
    this.indexByRun.clear();
    this.indexByTask.clear();
    this.indexByPlan.clear();
    this.indexByType.clear();
    for (const ev of this.events) {
      this._index(ev);
    }
  }

  // ── Runtime Replay ─────────────────────────────────────

  /**
   * V0.9.7: Replay events to reconstruct Runtime state.
   *
   * Given an ordered list of events, reconstructs:
   * - Plan state (tasks, dependencies, revision history)
   * - Task states
   * - Revision history
   *
   * @param {Array} events - Ordered event list
   * @returns {object} { plan, taskStates, revisions, summary }
   */
  static replay(events) {
    if (!events || events.length === 0) {
      return {
        plan: null,
        taskStates: new Map(),
        revisions: [],
        summary: { totalEvents: 0, planEvents: 0, taskEvents: 0, revisionEvents: 0 },
      };
    }

    // Sort by timestamp
    const sorted = [...events].sort((a, b) => a.timestamp - b.timestamp);

    let plan = null;
    const taskStates = new Map();
    const revisions = [];
    const summary = {
      totalEvents: sorted.length,
      planEvents: 0,
      taskEvents: 0,
      revisionEvents: 0,
      toolEvents: 0,
      skillEvents: 0,
    };

    for (const ev of sorted) {
      const type = ev.type;
      const data = ev.data || {};

      // ── Plan Events ──────────────────────────────────
      if (type === 'plan_created' || type === 'plan_created') {
        summary.planEvents++;
        plan = {
          id: data.planId || ev.planId,
          runId: data.runId || ev.runId,
          goal: data.goal,
          status: PLAN_STATUS.DRAFT,
          tasks: data.tasks || [],
          dependencies: data.dependencies || [],
          evidenceRefs: [],
          revisions: [],
          revision: 1,
          createdAt: ev.timestamp,
          updatedAt: ev.timestamp,
        };
      }

      if (type === 'plan_approved') {
        summary.planEvents++;
        if (plan) plan.status = PLAN_STATUS.APPROVED;
      }

      if (type === 'plan_started') {
        summary.planEvents++;
        if (plan) plan.status = PLAN_STATUS.EXECUTING;
      }

      if (type === 'plan_verifying' || type === 'verification_started') {
        summary.planEvents++;
        if (plan) plan.status = PLAN_STATUS.VERIFYING;
      }

      if (type === 'plan_completed') {
        summary.planEvents++;
        if (plan) {
          plan.status = PLAN_STATUS.COMPLETED;
          plan.completedAt = ev.timestamp;
        }
      }

      if (type === 'plan_failed') {
        summary.planEvents++;
        if (plan) {
          plan.status = PLAN_STATUS.FAILED;
          plan.failedAt = ev.timestamp;
          plan.reason = data.reason;
        }
      }

      if (type === 'plan_cancelled') {
        summary.planEvents++;
        if (plan) {
          plan.status = PLAN_STATUS.CANCELLED;
          plan.cancelledAt = ev.timestamp;
          plan.reason = data.reason;
        }
      }

      // ── Task Events ──────────────────────────────────
      if (type.startsWith('task_') || type.startsWith('TASK_')) {
        summary.taskEvents++;
        const taskId = data.taskId || ev.taskId;
        if (!taskId) continue;

        if (!taskStates.has(taskId)) {
          taskStates.set(taskId, {
            id: taskId,
            goal: data.goal || '',
            status: TASK_STATUS.PENDING,
            createdAt: ev.timestamp,
            evidenceRefs: [],
          });
        }

        const task = taskStates.get(taskId);

        if (type === 'task_created') {
          // Already initialized above
          task.status = TASK_STATUS.PENDING;
          task.goal = data.goal || task.goal;
        } else if (type === 'task_started') {
          task.status = TASK_STATUS.RUNNING;
          task.startedAt = ev.timestamp;
        } else if (type === 'task_verifying' || type === 'task_verifying') {
          task.status = TASK_STATUS.VERIFYING;
          task.verifyStartedAt = ev.timestamp;
        } else if (type === 'task_completed') {
          task.status = TASK_STATUS.COMPLETED;
          task.completedAt = ev.timestamp;
        } else if (type === 'task_failed') {
          task.status = TASK_STATUS.FAILED;
          task.failedAt = ev.timestamp;
          task.reason = data.reason;
        } else if (type === 'task_cancelled') {
          task.status = TASK_STATUS.CANCELLED;
          task.cancelledAt = ev.timestamp;
          task.reason = data.reason;
        } else if (type === 'task_superseded') {
          task.status = TASK_STATUS.SUPERSEDED;
          task.supersededAt = ev.timestamp;
          task.supersededReason = data.reason;
          task.previousStatus = data.previousStatus;
        }
      }

      // ── Revision Events ──────────────────────────────
      if (type.startsWith('revision_') || type.startsWith('REVISION_')) {
        summary.revisionEvents++;
        const revision = {
          id: data.revisionId || ev.id,
          planId: data.planId || ev.planId,
          parentRevision: data.parentRevision,
          reason: data.reason,
          status: data.status,
          timestamp: ev.timestamp,
          supersededIds: data.supersededIds,
          conflictReason: data.conflictReason,
        };
        revisions.push(revision);

        // Update plan revision
        if (plan && data.toRevision) {
          plan.revision = data.toRevision;
          plan.revisionReason = data.reason;
          if (data.status === 'applied') {
            plan.revisions = plan.revisions || [];
            plan.revisions.push(revision);
          }
        }
      }

      // ── Tool Events ──────────────────────────────────
      if (type.startsWith('tool_') || type.startsWith('TOOL_')) {
        summary.toolEvents++;
      }

      // ── Skill Events ─────────────────────────────────
      if (type.startsWith('skill_') || type.startsWith('SKILL_')) {
        summary.skillEvents++;
      }
    }

    return { plan, taskStates, revisions, summary };
  }

  /**
   * V0.9.7: Replay from store for a specific run.
   */
  replayRun(runId) {
    const events = this.getEventsByRun(runId);
    return RuntimeEventStore.replay(events);
  }

  /**
   * V0.9.7: Replay from store for a specific plan.
   */
  replayPlan(planId) {
    const events = this.getEventsByPlan(planId);
    return RuntimeEventStore.replay(events);
  }
}

// ── Factory ───────────────────────────────────────────────

/**
 * Create a RuntimeEventStore.
 */
function createEventStore(options) {
  return new RuntimeEventStore(options);
}

export {
  RuntimeEventStore,
  createEventStore,
};