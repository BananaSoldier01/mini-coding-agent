/**
 * agent/skill/lifecycle.js — Skill Lifecycle State Machine
 *
 * V0.8.2
 * - SKILL_STATUS, SKILL_TRANSITIONS
 * - transitionSkillStatus (internal helper)
 * - safeTransitionSkillStatus (public API, auto-emits events)
 * - canTransitionSkillStatus (non-mutating check)
 * - verifyEventStateConsistency
 */

import { RUNTIME_EVENT_TYPES } from '../runtime/events.js';

// ── Skill Status ──────────────────────────────────────────

const SKILL_STATUS = {
  REGISTERED: 'registered',
  AVAILABLE: 'available',
  RUNNING: 'running',
  VERIFYING: 'verifying',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
};

const SKILL_TRANSITIONS = {
  [SKILL_STATUS.REGISTERED]: [SKILL_STATUS.AVAILABLE],
  [SKILL_STATUS.AVAILABLE]: [SKILL_STATUS.RUNNING, SKILL_STATUS.CANCELLED],
  [SKILL_STATUS.RUNNING]: [SKILL_STATUS.VERIFYING, SKILL_STATUS.COMPLETED, SKILL_STATUS.FAILED, SKILL_STATUS.CANCELLED],
  [SKILL_STATUS.VERIFYING]: [SKILL_STATUS.COMPLETED, SKILL_STATUS.FAILED, SKILL_STATUS.CANCELLED],
  [SKILL_STATUS.COMPLETED]: [],
  [SKILL_STATUS.FAILED]: [],
  [SKILL_STATUS.CANCELLED]: [],
};

// ── Internal Transition ───────────────────────────────────

/**
 * Internal transition without event emission.
 * For use within this module where events are handled separately.
 */
function transitionSkillStatus(skill, newStatus) {
  if (!skill) return false;
  const allowed = SKILL_TRANSITIONS[skill.status] || [];
  if (!allowed.includes(newStatus)) {
    console.warn(`[Skill] Invalid transition: ${skill.status} → ${newStatus}`);
    return false;
  }
  skill.status = newStatus;
  skill.updatedAt = Date.now();
  return true;
}

// ── Safe Transition (Public API) ──────────────────────────

/**
 * V0.8.2: Unified lifecycle transition — the ONLY public entry point.
 * Auto-emits runtime events via the event emitter or event log.
 *
 * Backward-compatible: accepts both RuntimeEventEmitter (new) and RuntimeEventLog (old).
 *
 * @param {object} skill - The skill to transition
 * @param {string} newStatus - Target status
 * @param {object} eventSink - Optional RuntimeEventEmitter or RuntimeEventEmitter
 * @param {object} context - Optional context { runId, skillId, reason }
 * @returns {boolean} True if transition succeeded
 */
function safeTransitionSkillStatus(skill, newStatus, eventSink, context) {
  if (!skill) return false;
  const allowed = SKILL_TRANSITIONS[skill.status] || [];

  // Must go through VERIFYING before COMPLETED
  if (newStatus === SKILL_STATUS.COMPLETED && skill.status !== SKILL_STATUS.VERIFYING) {
    console.warn(
      `[Skill] Illegal transition: ${skill.status} → ${newStatus}. ` +
      `Skill must go through VERIFYING before COMPLETED.`
    );
    return false;
  }

  // Cannot transition from terminal states
  if (skill.status === SKILL_STATUS.COMPLETED || skill.status === SKILL_STATUS.FAILED) {
    console.warn(`[Skill] Cannot transition from terminal state: ${skill.status}`);
    return false;
  }

  if (!allowed.includes(newStatus)) {
    console.warn(`[Skill] Invalid transition: ${skill.status} → ${newStatus}`);
    return false;
  }

  // Execute transition
  const oldStatus = skill.status;
  skill.status = newStatus;
  skill.updatedAt = Date.now();

  // V0.8.2: Auto-emit event via event sink (if provided)
  // Supports both RuntimeEventEmitter (emit) and RuntimeEventLog (record)
  if (eventSink) {
    const eventType = statusToEventType(newStatus);
    if (eventType) {
      const event = {
        runId: context?.runId,
        skillId: context?.skillId || skill.id,
        type: eventType,
        data: {
          from: oldStatus,
          to: newStatus,
          reason: context?.reason,
        },
      };
      if (typeof eventSink.emit === 'function') {
        eventSink.emit(event);
      } else if (typeof eventSink.record === 'function') {
        eventSink.record(event);
      }
    }
  }

  return true;
}

/**
 * V0.8.2: Map skill status to runtime event type.
 */
function statusToEventType(status) {
  const map = {
    [SKILL_STATUS.RUNNING]: RUNTIME_EVENT_TYPES.SKILL_RUNNING,
    [SKILL_STATUS.VERIFYING]: RUNTIME_EVENT_TYPES.VERIFICATION_STARTED,
    [SKILL_STATUS.COMPLETED]: RUNTIME_EVENT_TYPES.SKILL_COMPLETED,
    [SKILL_STATUS.FAILED]: RUNTIME_EVENT_TYPES.SKILL_FAILED,
    [SKILL_STATUS.CANCELLED]: RUNTIME_EVENT_TYPES.SKILL_CANCELLED,
  };
  return map[status] || null;
}

/**
 * V0.8.2: Check if a skill transition is valid (without executing it).
 */
function canTransitionSkillStatus(skill, newStatus) {
  if (!skill) return false;
  if (newStatus === SKILL_STATUS.COMPLETED && skill.status !== SKILL_STATUS.VERIFYING) {
    return false;
  }
  if (skill.status === SKILL_STATUS.COMPLETED || skill.status === SKILL_STATUS.FAILED) {
    return false;
  }
  return (SKILL_TRANSITIONS[skill.status] || []).includes(newStatus);
}

// ── Event-State Consistency ───────────────────────────────

/**
 * V0.8.1: Verify event-state consistency.
 * Checks that every state transition has a corresponding event.
 * Returns { consistent, missingEvents }.
 */
function verifyEventStateConsistency(skill, eventLog) {
  if (!skill || !eventLog) return { consistent: true, missingEvents: [] };

  const skillEvents = eventLog.getSkillEvents(skill.id);
  const stateTransitions = skillEvents.filter(e =>
    e.type === RUNTIME_EVENT_TYPES.SKILL_RUNNING ||
    e.type === RUNTIME_EVENT_TYPES.VERIFICATION_STARTED ||
    e.type === RUNTIME_EVENT_TYPES.SKILL_COMPLETED ||
    e.type === RUNTIME_EVENT_TYPES.SKILL_FAILED ||
    e.type === RUNTIME_EVENT_TYPES.SKILL_CANCELLED
  );

  const terminalStates = [SKILL_STATUS.COMPLETED, SKILL_STATUS.FAILED, SKILL_STATUS.CANCELLED];
  if (terminalStates.includes(skill.status)) {
    const hasCompletionEvent = stateTransitions.some(e =>
      e.type === (skill.status === SKILL_STATUS.COMPLETED ? RUNTIME_EVENT_TYPES.SKILL_COMPLETED :
                   skill.status === SKILL_STATUS.FAILED ? RUNTIME_EVENT_TYPES.SKILL_FAILED :
                   RUNTIME_EVENT_TYPES.SKILL_CANCELLED)
    );
    if (!hasCompletionEvent) {
      return {
        consistent: false,
        missingEvents: [`Missing ${skill.status} event for skill ${skill.id}`],
      };
    }
  }

  return { consistent: true, missingEvents: [] };
}

export {
  SKILL_STATUS,
  SKILL_TRANSITIONS,
  transitionSkillStatus,
  safeTransitionSkillStatus,
  canTransitionSkillStatus,
  statusToEventType,
  verifyEventStateConsistency,
};