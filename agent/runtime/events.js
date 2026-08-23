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
  SKILL_ACTIVATED: 'skill_activated',
  SKILL_RUNNING: 'skill_running',
  TOOL_STARTED: 'tool_started',
  TOOL_COMPLETED: 'tool_completed',
  VERIFICATION_STARTED: 'verification_started',
  EVIDENCE_COLLECTED: 'evidence_collected',
  VERIFICATION_COMPLETED: 'verification_completed',
  SKILL_COMPLETED: 'skill_completed',
  SKILL_FAILED: 'skill_failed',
  SKILL_CANCELLED: 'skill_cancelled',
  RUN_STARTED: 'run_started',
  RUN_COMPLETED: 'run_completed',
  RUN_FAILED: 'run_failed',
  SNAPSHOT_SAVED: 'snapshot_saved',
  SNAPSHOT_RESTORED: 'snapshot_restored',
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