/**
 * agent/runtime/events.js — Runtime Event System
 *
 * V1.1.1
 * - RuntimeEventTypes (deduplicated, standardized)
 * - RuntimeEventLog
 * - RuntimeEventEmitter (pub/sub bus)
 * - Event Schema Validation
 *
 * Design:
 *   Event is the audit trail.
 *   Every state transition produces an Event.
 *   Events are the source for Replay.
 */

// ── Runtime Event Types ───────────────────────────────────
// V1.1.1: Deduplicated — removed legacy duplicates, fixed typos.

const RUNTIME_EVENT_TYPES = {
  // ── Skill events ─────────────────────────────────────
  SKILL_ACTIVATED: 'skill_activated',
  SKILL_RUNNING: 'skill_running',
  SKILL_COMPLETED: 'skill_completed',
  SKILL_FAILED: 'skill_failed',
  SKILL_CANCELLED: 'skill_cancelled',
  SKILL_REGISTERED: 'skill_registered',
  SKILL_ENABLED: 'skill_enabled',
  SKILL_DISABLED: 'skill_disabled',
  SKILL_REMOVED: 'skill_removed',
  SKILL_EXECUTION_STARTED: 'skill_execution_started',
  SKILL_EXECUTION_COMPLETED: 'skill_execution_completed',
  SKILL_EXECUTION_FAILED: 'skill_execution_failed',
  SKILL_CAPABILITY_DENIED: 'skill_capability_denied',

  // ── Task events ──────────────────────────────────────
  TASK_CREATED: 'task_created',
  TASK_STARTED: 'task_started',
  TASK_VERIFYING: 'task_verifying',
  TASK_COMPLETED: 'task_completed',
  TASK_FAILED: 'task_failed',
  TASK_CANCELLED: 'task_cancelled',
  TASK_SUPERSEDED: 'task_superseded',
  TASK_PAUSED: 'task_paused',
  TASK_RESUMED: 'task_resumed',
  TASK_WAITING_APPROVAL: 'task_waiting_approval',

  // ── Plan events ──────────────────────────────────────
  PLAN_CREATED: 'plan_created',
  PLAN_APPROVED: 'plan_approved',
  PLAN_STARTED: 'plan_started',
  PLAN_COMPLETED: 'plan_completed',
  PLAN_FAILED: 'plan_failed',
  PLAN_CANCELLED: 'plan_cancelled',

  // ── Revision events ──────────────────────────────────
  REVISION_REQUESTED: 'revision_requested',
  REVISION_VALIDATED: 'revision_validated',
  REVISION_APPLIED: 'revision_applied',
  REVISION_REJECTED: 'revision_rejected',
  REVISION_CONFLICT: 'revision_conflict',
  REVISION_ROLLED_BACK: 'revision_rolled_back',

  // ── Tool events ──────────────────────────────────────
  TOOL_REQUESTED: 'tool_requested',
  TOOL_POLICY_CHECKED: 'tool_policy_checked',
  TOOL_EXECUTING: 'tool_executing',
  TOOL_COMPLETED: 'tool_completed',
  TOOL_FAILED: 'tool_failed',
  TOOL_REGISTERED: 'tool_registered',
  TOOL_EXECUTION_REQUESTED: 'tool_execution_requested',
  TOOL_EXECUTION_BLOCKED: 'tool_execution_blocked',

  // ── Capability events ────────────────────────────────
  CAPABILITY_REGISTERED: 'capability_registered',
  CAPABILITY_ENABLED: 'capability_enabled',
  CAPABILITY_DISABLED: 'capability_disabled',
  CAPABILITY_CHECKED: 'capability_checked',
  CAPABILITY_DENIED: 'capability_denied',

  // ── Approval / Governance events ─────────────────────
  APPROVAL_REQUESTED: 'approval_requested',
  APPROVAL_GRANTED: 'approval_granted',
  APPROVAL_REJECTED: 'approval_rejected',
  APPROVAL_EXPIRED: 'approval_expired',
  HUMAN_OVERRIDE: 'human_override',
  RUN_PAUSED: 'run_paused',
  RUN_RESUMED: 'run_resumed',

  // ── Scheduler events ─────────────────────────────────
  SCHEDULER_REFRESHED: 'scheduler_refreshed',
  TASK_READY: 'task_ready',

  // ── Verification events ──────────────────────────────
  VERIFICATION_STARTED: 'verification_started',
  EVIDENCE_COLLECTED: 'evidence_collected',
  VERIFICATION_COMPLETED: 'verification_completed',

  // ── Run events ───────────────────────────────────────
  RUN_CREATED: 'run_created',
  RUN_STARTED: 'run_started',
  RUN_COMPLETED: 'run_completed',
  RUN_FAILED: 'run_failed',
  RUN_CANCELLED: 'run_cancelled',

  // ── Snapshot events ──────────────────────────────────
  SNAPSHOT_SAVED: 'snapshot_saved',
  SNAPSHOT_RESTORED: 'snapshot_restored',

  // ── Workspace events (V1.1.0) ────────────────────────
  WORKSPACE_CREATED: 'workspace_created',
  WORKSPACE_ACTIVATED: 'workspace_activated',
  WORKSPACE_ARCHIVED: 'workspace_archived',
  CONTEXT_UPDATED: 'context_updated',
  ARTIFACT_CREATED: 'artifact_created',
  ARTIFACT_DELETED: 'artifact_deleted',
  WORKSPACE_SNAPSHOT_CREATED: 'workspace_snapshot_created',
};

// ── Event Schema ──────────────────────────────────────────

/**
 * V1.1.1: Event Schema — defines required fields per event type.
 * Used for validation in development mode.
 */
const EVENT_SCHEMA = {
  // Required fields for all events
  _base: ['type', 'timestamp', 'runId'],

  // Skill events
  skill_activated: ['type', 'timestamp', 'runId', 'data'],
  skill_execution_started: ['type', 'timestamp', 'runId', 'data'],
  skill_execution_completed: ['type', 'timestamp', 'runId', 'data'],
  skill_execution_failed: ['type', 'timestamp', 'runId', 'data'],
  skill_capability_denied: ['type', 'timestamp', 'runId', 'data'],

  // Task events
  task_created: ['type', 'timestamp', 'runId', 'taskId', 'data'],
  task_started: ['type', 'timestamp', 'runId', 'taskId', 'data'],
  task_completed: ['type', 'timestamp', 'runId', 'taskId', 'data'],
  task_failed: ['type', 'timestamp', 'runId', 'taskId', 'data'],
  task_superseded: ['type', 'timestamp', 'runId', 'taskId', 'data'],
  task_paused: ['type', 'timestamp', 'runId', 'taskId', 'data'],
  task_resumed: ['type', 'timestamp', 'runId', 'taskId', 'data'],
  task_waiting_approval: ['type', 'timestamp', 'runId', 'taskId', 'data'],

  // Plan events
  plan_created: ['type', 'timestamp', 'runId', 'planId', 'data'],
  plan_approved: ['type', 'timestamp', 'runId', 'planId', 'data'],
  plan_started: ['type', 'timestamp', 'runId', 'planId', 'data'],
  plan_completed: ['type', 'timestamp', 'runId', 'planId', 'data'],
  plan_failed: ['type', 'timestamp', 'runId', 'planId', 'data'],

  // Revision events
  revision_requested: ['type', 'timestamp', 'runId', 'planId', 'data'],
  revision_validated: ['type', 'timestamp', 'runId', 'planId', 'data'],
  revision_applied: ['type', 'timestamp', 'runId', 'planId', 'data'],
  revision_rejected: ['type', 'timestamp', 'runId', 'planId', 'data'],
  revision_conflict: ['type', 'timestamp', 'runId', 'planId', 'data'],
  revision_rolled_back: ['type', 'timestamp', 'runId', 'planId', 'data'],

  // Approval events
  approval_requested: ['type', 'timestamp', 'runId', 'taskId', 'data'],
  approval_granted: ['type', 'timestamp', 'runId', 'taskId', 'data'],
  approval_rejected: ['type', 'timestamp', 'runId', 'taskId', 'data'],

  // Workspace events
  workspace_created: ['type', 'timestamp', 'runId', 'workspaceId', 'data'],
  workspace_activated: ['type', 'timestamp', 'runId', 'workspaceId', 'data'],
  workspace_archived: ['type', 'timestamp', 'runId', 'workspaceId', 'data'],
  context_updated: ['type', 'timestamp', 'runId', 'workspaceId', 'data'],
  artifact_created: ['type', 'timestamp', 'runId', 'workspaceId', 'taskId', 'data'],
  artifact_deleted: ['type', 'timestamp', 'runId', 'workspaceId', 'data'],
};

// ── Event Validation ──────────────────────────────────────

/**
 * V1.1.1: Validate an event against the schema.
 * In development mode, throws on invalid events.
 * In production mode, logs warnings.
 */
function validateEvent(event, strict = false) {
  if (!event || typeof event !== 'object') {
    const msg = '[EventValidation] Invalid event: not an object';
    if (strict) throw new Error(msg);
    console.warn(msg);
    return false;
  }

  if (!event.type) {
    const msg = '[EventValidation] Event missing type';
    if (strict) throw new Error(msg);
    console.warn(msg);
    return false;
  }

  const schema = EVENT_SCHEMA[event.type] || EVENT_SCHEMA._base;
  for (const field of schema) {
    if (event[field] === undefined || event[field] === null) {
      const msg = `[EventValidation] Event ${event.type} missing required field: ${field}`;
      if (strict) throw new Error(msg);
      console.warn(msg);
      return false;
    }
  }

  // Check for unknown event types
  if (!RUNTIME_EVENT_TYPES[event.type] && !EVENT_SCHEMA[event.type]) {
    const msg = `[EventValidation] Unknown event type: ${event.type}`;
    if (strict) throw new Error(msg);
    console.warn(msg);
    return false;
  }

  return true;
}

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
    // V1.1.1: Event Store integration
    this.store = null;
    // V1.1.1: Development mode validation
    this.strictValidation = false;
  }

  /**
   * V1.1.1: Enable strict event validation.
   */
  setStrictValidation(enabled) {
    this.strictValidation = enabled;
  }

  /**
   * V1.1.1: Set the RuntimeEventStore for persistence.
   */
  setStore(store) {
    this.store = store;
  }

  /**
   * V1.1.1: Get the current event store.
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
    // V1.1.1: Validate event schema
    if (this.strictValidation) {
      validateEvent(event, true);
    }

    const ev = {
      id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
      timestamp: Date.now(),
      ...event,
    };

    // V1.1.1: Persist to Event Store
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
  EVENT_SCHEMA,
  validateEvent,
  RuntimeEventLog,
  RuntimeEventEmitter,
};