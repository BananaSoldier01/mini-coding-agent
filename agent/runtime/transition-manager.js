/**
 * agent/runtime/transition-manager.js — Unified Lifecycle Transition Manager
 *
 * V1.2.1
 * - Unified Lifecycle Pattern: Transition Request → Validate → Apply → Emit Event → Persist
 * - Prevents direct status modification (entity.status = xxx)
 * - Covers: Run, Task, Plan, Workspace
 *
 * Design:
 *   TransitionManager is the single entry point for all entity state transitions.
 *   No code may directly set entity.status outside of this manager.
 */

import { RUNTIME_EVENT_TYPES } from './events.js';

// ── Transition Request ────────────────────────────────────

/**
 * V1.2.1: A transition request for any entity.
 */
class TransitionRequest {
  constructor(entityType, entityId, fromStatus, toStatus, context = {}) {
    this.entityType = entityType; // 'run' | 'task' | 'plan' | 'workspace'
    this.entityId = entityId;
    this.fromStatus = fromStatus;
    this.toStatus = toStatus;
    this.context = context;
    this.timestamp = Date.now();
  }
}

// ── Transition Manager ────────────────────────────────────

class TransitionManager {
  constructor(options = {}) {
    this.emitter = options.emitter || null;
    this.eventStore = options.eventStore || null;

    // V1.2.1: Transition tables (single source of truth)
    this.transitions = {
      run: {
        created: ['started', 'cancelled'],
        started: ['paused', 'completed', 'failed', 'cancelled'],
        paused: ['started', 'cancelled'],
        completed: [],
        failed: [],
        cancelled: [],
      },
      task: {
        pending: ['running', 'cancelled'],
        running: ['verifying', 'failed', 'cancelled', 'waiting_approval'],
        waiting_approval: ['running', 'failed', 'cancelled'],
        verifying: ['completed', 'failed', 'cancelled', 'superseded'],
        completed: [],
        failed: [],
        cancelled: [],
        superseded: [],
      },
      plan: {
        draft: ['approved', 'cancelled'],
        approved: ['started', 'cancelled'],
        started: ['executing', 'failed', 'cancelled'],
        executing: ['verifying', 'failed', 'cancelled'],
        verifying: ['completed', 'failed', 'cancelled'],
        completed: [],
        failed: [],
        cancelled: [],
      },
      workspace: {
        created: ['active', 'archived'],
        active: ['archived'],
        archived: [],
      },
    };
  }

  // ── Core Transition ────────────────────────────────────

  /**
   * V1.2.1: Execute a state transition.
   * Returns { success, event, reason }
   */
  transition(entityType, entityId, fromStatus, toStatus, context = {}) {
    // Step 1: Validate transition
    const validation = this.validate(entityType, fromStatus, toStatus);
    if (!validation.valid) {
      return { success: false, reason: validation.reason, event: null };
    }

    // Step 2: Build event type
    const eventType = this.getEventType(entityType, toStatus);
    if (!eventType) {
      return { success: false, reason: `No event type for ${entityType}.${toStatus}`, event: null };
    }

    // Step 3: Create event
    const event = {
      type: eventType,
      runId: context.runId,
      [`${entityType}Id`]: entityId,
      workspaceId: context.workspaceId,
      timestamp: Date.now(),
      data: {
        [`${entityType}Id`]: entityId,
        fromStatus,
        toStatus,
        ...context.data,
      },
    };

    // Step 4: Emit event
    if (this.emitter) {
      this.emitter.emit(event);
    }

    // Step 5: Persist to event store
    if (this.eventStore) {
      this.eventStore.append(event);
    }

    return { success: true, event, reason: null };
  }

  // ── Validation ─────────────────────────────────────────

  /**
   * V1.2.1: Validate a transition request.
   */
  validate(entityType, fromStatus, toStatus) {
    const entityTransitions = this.transitions[entityType];
    if (!entityTransitions) {
      return { valid: false, reason: `Unknown entity type: ${entityType}` };
    }

    const allowed = entityTransitions[fromStatus] || [];
    if (!allowed.includes(toStatus)) {
      return {
        valid: false,
        reason: `Invalid transition: ${entityType} ${fromStatus} → ${toStatus}. Allowed: ${allowed.join(', ')}`,
      };
    }

    return { valid: true };
  }

  /**
   * V1.2.1: Check if a transition is allowed.
   */
  canTransition(entityType, fromStatus, toStatus) {
    return this.validate(entityType, fromStatus, toStatus).valid;
  }

  // ── Event Type Mapping ─────────────────────────────────

  /**
   * V1.2.1: Map entity type + target status to event type.
   */
  getEventType(entityType, toStatus) {
    const map = {
      run: {
        started: 'run_started',
        paused: 'run_paused',
        resumed: 'run_resumed',
        completed: 'run_completed',
        failed: 'run_failed',
        cancelled: 'plan_cancelled',
      },
      task: {
        created: 'task_created',
        running: 'task_started',
        verifying: 'task_verifying',
        completed: 'task_completed',
        failed: 'task_failed',
        cancelled: 'task_cancelled',
        superseded: 'task_superseded',
        paused: 'task_paused',
        resumed: 'task_resumed',
        waiting_approval: 'task_waiting_approval',
      },
      plan: {
        created: 'plan_created',
        approved: 'plan_approved',
        started: 'plan_started',
        completed: 'plan_completed',
        failed: 'plan_failed',
        cancelled: 'plan_cancelled',
      },
      workspace: {
        created: 'workspace_created',
        active: 'workspace_activated',
        archived: 'workspace_archived',
      },
    };

    const entityMap = map[entityType];
    if (!entityMap) return null;
    return entityMap[toStatus] || null;
  }

  // ── Convenience Methods ────────────────────────────────

  /**
   * V1.2.1: Transition run state.
   */
  transitionRun(runId, fromStatus, toStatus, context = {}) {
    return this.transition('run', runId, fromStatus, toStatus, context);
  }

  /**
   * V1.2.1: Transition task state.
   */
  transitionTask(taskId, fromStatus, toStatus, context = {}) {
    return this.transition('task', taskId, fromStatus, toStatus, context);
  }

  /**
   * V1.2.1: Transition plan state.
   */
  transitionPlan(planId, fromStatus, toStatus, context = {}) {
    return this.transition('plan', planId, fromStatus, toStatus, context);
  }

  /**
   * V1.2.1: Transition workspace state.
   */
  transitionWorkspace(workspaceId, fromStatus, toStatus, context = {}) {
    return this.transition('workspace', workspaceId, fromStatus, toStatus, context);
  }
}

// ── Factory ───────────────────────────────────────────────

function createTransitionManager(options) {
  return new TransitionManager(options);
}

export {
  TransitionRequest,
  TransitionManager,
  createTransitionManager,
};