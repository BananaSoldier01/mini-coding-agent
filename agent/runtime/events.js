/**
 * agent/runtime/events.js — Runtime Event System
 *
 * V0.8.2
 * - RuntimeEventTypes
 * - RuntimeEventLog
 * - RuntimeEventEmitter (pub/sub bus)
 */

// ── Runtime Event Types ───────────────────────────────────

const RUNTIME_EVENT_TYPES = {
  // Skill events
  SKILL_ACTIVATED: 'skill_activated',
  SKILL_RUNNING: 'skill_running',
  SKILL_COMPLETED: 'skill_completed',
  SKILL_FAILED: 'skill_failed',
  SKILL_CANCELLED: 'skill_cancelled',

  // Task events (V0.9.0)
  TASK_CREATED: 'task_created',
  TASK_STARTED: 'task_started',
  TASK_COMPLETED: 'task_completed',
  TASK_FAILED: 'task_failed',
  TASK_CANCELLED: 'task_cancelled',

  // Tool events (V0.9.0)
  TOOL_REQUESTED: 'tool_requested',
  TOOL_POLICY_CHECKED: 'tool_policy_checked',
  TOOL_EXECUTING: 'tool_executing',
  TOOL_COMPLETED: 'tool_completed',
  TOOL_FAILED: 'tool_failed',

  // Legacy tool events (backward compat)
  TOOL_STARTED: 'tool_started',

  // Verification events
  VERIFICATION_STARTED: 'verification_started',
  EVIDENCE_COLLECTED: 'evidence_collected',
  VERIFICATION_COMPLETED: 'verification_completed',

  // Run events
  RUN_STARTED: 'run_started',
  RUN_COMPLETED: 'run_completed',
  RUN_FAILED: 'run_failed',

  // Snapshot events
  SNAPSHOT_SAVED: 'snapshot_saved',
  SNAPSHOT_RESTORED: 'snapshot_restored',

  // V0.9.7: Unified event types — standardized schema
  PLAN_CREATED: 'plan_created',
  PLAN_APPROVED: 'plan_approved',
  PLAN_STARTED: 'plan_started',
  PLAN_COMPLETED: 'plan_completed',
  PLAN_FAILED: 'plan_failed',
  PLAN_CANCELLED: 'plan_cancelled',

  // V0.9.7: Revision events
  REVISION_REQUESTED: 'revision_requested',
  REVISION_VALIDATED: 'revision_validated',
  REVISION_APPLIED: 'revision_applied',
  REVISION_REJECTED: 'revision_rejected',
  REVISION_CONFLICT: 'revision_conflict',
  REVISION_ROLLED_BACK: 'revision_rolled_back',

  // V0.9.7: Scheduler events
  SCHEDULER_REFRESHED: 'scheduler_refreshed',
  TASK_READY: 'task_ready',

  // V0.9.7: Task verification events
  TASK_VERIFYING: 'task_verifying',
  TASK_SUPERSEDED: 'task_superseded',

  // V0.9.8: Governance & Human Approval events
  APPROVAL_REQUESTED: 'approval_requested',
  APPROVAL_GRANTED: 'approval_granted',
  APPROVAL_REJECTED: 'approval_rejected',
  APPROVAL_EXPIRED: 'approval_expired',
  TASK_PAUSED: 'task_paused',
  TASK_RESUMED: 'task_resumend',
  HUMAN_OVERRIDE: 'human_override',
  RUN_PAUSED: 'run_paused',
  RUN_RESUMED: 'run_resumend',

  // V0.9.8: Task waiting approval
  TASK_WAITING_APPROVAL: 'task_waiting_approval',

  // V0.9.7: Tool execution events
  TOOL_REQUESTED: 'tool_requested',
  TOOL_POLICY_CHECKED: 'tool_policy_checked',
  TOOL_EXECUTING: 'tool_executing',
  TOOL_COMPLETED: 'tool_completed',
  TOOL_FAILED: 'tool_failed',

  // V0.9.7: Run events
  RUN_STARTED: 'run_started',
  RUN_COMPLETED: 'run_completed',
  RUN_FAILED: 'run_failed',

  // V0.9.9: Capability events
  CAPABILITY_REGISTERED: 'capability_registered',
  CAPABILITY_ENABLED: 'capability_enabled',
  CAPABILITY_DISABLED: 'capability_disabled',
  CAPABILITY_CHECKED: 'capability_checked',
  CAPABILITY_DENIED: 'capability_denied',

  // V0.9.9: Tool events
  TOOL_REGISTERED: 'tool_registered',
  TOOL_EXECUTION_REQUESTED: 'tool_execution_requested',
  TOOL_EXECUTION_BLOCKED: 'tool_execution_blocked',
};

// ── Runtime Event Log ─────────────────────────────────────

/**
 * V0.8: RuntimeEventLog — records the full execution timeline for observability.
 */
class RuntimeEventLog {
  constructor() {
    this.events = [];
    this.maxEvents = 1000;
  }

  /**
   * Record a runtime event.
   */
  record(event) {
    const ev = {
      id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
      timestamp: Date.now(),
      ...event,
    };
    this.events.push(ev);

    // Cap the log size
    if (this.events.length > this.maxEvents) {
      this.events = this.events.slice(-this.maxEvents);
    }

    return ev;
  }

  /**
   * Get all events for a run.
   */
  getEvents(runId) {
    if (!runId) return [...this.events];
    return this.events.filter(e => e.runId === runId);
  }

  /**
   * Get events for a specific skill.
   */
  getSkillEvents(skillId) {
    return this.events.filter(e => e.skillId === skillId);
  }

  /**
   * Get the latest event for a skill.
   */
  getLatestSkillEvent(skillId) {
    const skillEvents = this.getSkillEvents(skillId);
    return skillEvents.length > 0 ? skillEvents[skillEvents.length - 1] : null;
  }

  /**
   * Clear events for a run.
   */
  clearEvents(runId) {
    if (!runId) {
      this.events = [];
    } else {
      this.events = this.events.filter(e => e.runId !== runId);
    }
  }

  /**
   * Get event count.
   */
  count(runId) {
    if (!runId) return this.events.length;
    return this.events.filter(e => e.runId === runId).length;
  }

  /**
   * Serialize for persistence.
   */
  serialize() {
    return {
      events: this.events,
      maxEvents: this.maxEvents,
    };
  }

  /**
   * Deserialize from persistence.
   */
  static deserialize(data) {
    const log = new RuntimeEventLog();
    log.events = data.events || [];
    log.maxEvents = data.maxEvents || 1000;
    return log;
  }
}

// ── Runtime Event Emitter ─────────────────────────────────

/**
 * V0.8.2: RuntimeEventEmitter — pub/sub event bus.
 * Decouples lifecycle state changes from event consumers (Log, Metrics, Observer).
 *
 * Usage:
 *   const emitter = new RuntimeEventEmitter();
 *   emitter.on('skill_completed', handler);
 *   emitter.emit({ type: 'skill_completed', ... });
 */
class RuntimeEventEmitter {
  constructor() {
    this.handlers = new Map(); // eventType → [handlers]
    this.allHandlers = [];     // wildcard handlers
    // V0.9.7: Event Store integration — all emitted events are persisted
    this.store = null;
  }

  /**
   * V0.9.7: Set the RuntimeEventStore for persistence.
   * All emitted events are also appended to the store.
   */
  setStore(store) {
    this.store = store;
  }

  /**
   * V0.9.7: Get the current event store.
   */
  getStore() {
    return this.store;
  }

  /**
   * Subscribe to a specific event type.
   */
  on(eventType, handler) {
    if (!this.handlers.has(eventType)) {
      this.handlers.set(eventType, []);
    }
    this.handlers.get(eventType).push(handler);
    return () => this.off(eventType, handler);
  }

  /**
   * Subscribe to all events (wildcard).
   */
  onAll(handler) {
    this.allHandlers.push(handler);
    return () => {
      const idx = this.allHandlers.indexOf(handler);
      if (idx >= 0) this.allHandlers.splice(idx, 1);
    };
  }

  /**
   * Unsubscribe from a specific event type.
   */
  off(eventType, handler) {
    const handlers = this.handlers.get(eventType);
    if (handlers) {
      const idx = handlers.indexOf(handler);
      if (idx >= 0) handlers.splice(idx, 1);
    }
  }

  /**
   * Emit an event to all subscribers.
   */
  emit(event) {
    const ev = {
      id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
      timestamp: Date.now(),
      ...event,
    };

    // V0.9.7: Persist to Event Store
    if (this.store) {
      this.store.append(ev);
    }

    // Type-specific handlers
    const handlers = this.handlers.get(ev.type) || [];
    for (const h of handlers) {
      try { h(ev); } catch (err) { console.error(`[EventEmitter] handler error:`, err); }
    }

    // Wildcard handlers
    for (const h of this.allHandlers) {
      try { h(ev); } catch (err) { console.error(`[EventEmitter] wildcard error:`, err); }
    }

    return ev;
  }

  /**
   * Get handler count for an event type.
   */
  handlerCount(eventType) {
    if (eventType === '*') return this.allHandlers.length;
    return (this.handlers.get(eventType) || []).length;
  }

  /**
   * Remove all handlers.
   */
  clear() {
    this.handlers.clear();
    this.allHandlers = [];
  }
}

export {
  RUNTIME_EVENT_TYPES,
  RuntimeEventLog,
  RuntimeEventEmitter,
};