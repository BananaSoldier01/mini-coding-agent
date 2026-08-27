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
    // V1.2.3: Store dependencies for state mutation
    this.runStore = options.runStore || null;
    this.taskStore = options.taskStore || null;
    this.planStore = options.planStore || null;
    this.workspaceStore = options.workspaceStore || null;

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
        // V1.2.3: Restored strict machine — matches task.js TASK_TRANSITIONS.
        // PENDING may only advance to RUNNING or be CANCELLED. The loose
        // PENDING→COMPLETED / PENDING→FAILED shortcuts let tests bypass the
        // RUNNING→VERIFYING→COMPLETED invariant and are removed.
        pending: ['running', 'cancelled'],
        running: ['verifying', 'failed', 'cancelled', 'waiting_approval', 'superseded'],
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
   * V1.2.3: Execute a state transition — the single entry point for lifecycle mutation.
   * Pattern: Validate → Apply → Persist → Emit Event
   * Returns { success, event, reason, entity }
   */
  transition(entityType, entityId, fromStatus, toStatus, context = {}) {
    // Step 1: Validate transition
    const validation = this.validate(entityType, fromStatus, toStatus);
    if (!validation.valid) {
      return { success: false, reason: validation.reason, event: null };
    }

    // Step 1b: Verify the Store's CURRENT status matches the requested
    // fromStatus. TransitionManager owns lifecycle mutation, so it must not
    // trust the caller's claimed source state — a lying caller could move a
    // FAILED entity back to RUNNING by passing fromStatus=PENDING.
    const currentStore = this._getStore(entityType);
    if (currentStore) {
      const entity = currentStore.get(entityId);
      if (!entity) {
        return { success: false, reason: `${entityType} ${entityId} not found in store`, event: null };
      }
      if (entity.status !== fromStatus) {
        return {
          success: false,
          reason: `Stale transition: ${entityType} ${entityId} current status is '${entity.status}', not '${fromStatus}'`,
          event: null,
        };
      }
    }

    // Step 2: Build event type (using from→to pair)
    const eventType = this.getEventType(entityType, fromStatus, toStatus);
    if (!eventType) {
      return { success: false, reason: `No event type for ${entityType}: ${fromStatus}→${toStatus}`, event: null };
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

    // Step 4: Apply state mutation through Store
    const store = this._getStore(entityType);
    if (store) {
      const idField = `${entityType}Id`;
      const updateResult = store.update(entityId, {
        status: toStatus,
        [`${toStatus}At`]: Date.now(),
        updatedAt: Date.now(),
        ...context.data,
      });
      if (!updateResult.success) {
        return { success: false, reason: updateResult.reason, event: null };
      }
      event.entity = updateResult[entityType] || updateResult.entity;
    }

    // Step 5: Emit event (emitter handles EventStore persistence via setStore)
    if (this.emitter) {
      this.emitter.emit(event);
    }

    return { success: true, event, reason: null, entity: event.entity };
  }

  /**
   * V1.2.3: Map entity type to its Store.
   */
  _getStore(entityType) {
    const stores = {
      run: this.runStore,
      task: this.taskStore,
      plan: this.planStore,
      workspace: this.workspaceStore,
    };
    return stores[entityType] || null;
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
   * V1.2.3: Map entity type + fromStatus + toStatus to event type.
   * Uses from→to pair to distinguish resume (PAUSED→STARTED = run_resumed)
   * from initial start (CREATED→STARTED = run_started).
   */
  getEventType(entityType, fromStatus, toStatus) {
    const map = {
      run: {
        'created→started': 'run_started',
        'started→paused': 'run_paused',
        'paused→started': 'run_resumed',
        'started→completed': 'run_completed',
        'started→failed': 'run_failed',
        'started→cancelled': 'run_cancelled',
        'paused→cancelled': 'run_cancelled',
      },
      task: {
        'pending→running': 'task_started',
        'running→verifying': 'task_verifying',
        'verifying→completed': 'task_completed',
        'running→failed': 'task_failed',
        'running→cancelled': 'task_cancelled',
        'verifying→cancelled': 'task_cancelled',
        'verifying→superseded': 'task_superseded',
        'running→waiting_approval': 'task_waiting_approval',
        'waiting_approval→running': 'task_resumed',
        'waiting_approval→failed': 'task_failed',
        'waiting_approval→cancelled': 'task_cancelled',
        'pending→cancelled': 'task_cancelled',
      },
      plan: {
        'draft→approved': 'plan_approved',
        'approved→started': 'plan_started',
        'started→executing': 'plan_started',
        'executing→verifying': 'plan_verifying',
        'verifying→completed': 'plan_completed',
        'verifying→failed': 'plan_failed',
        'started→failed': 'plan_failed',
        'executing→completed': 'plan_completed',
        'executing→failed': 'plan_failed',
        'executing→cancelled': 'plan_cancelled',
        'started→cancelled': 'plan_cancelled',
        'approved→cancelled': 'plan_cancelled',
        'verifying→cancelled': 'plan_cancelled',
        'draft→cancelled': 'plan_cancelled',
        '*→cancelled': 'plan_cancelled',
      },
      workspace: {
        'created→active': 'workspace_activated',
        'active→archived': 'workspace_archived',
      },
    };

    const entityMap = map[entityType];
    if (!entityMap) return null;

    const key = `${fromStatus}→${toStatus}`;
    return entityMap[key] || entityMap['*→' + toStatus] || null;
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