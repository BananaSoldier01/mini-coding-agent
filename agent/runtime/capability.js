/**
 * agent/runtime/capability.js — Capability Model & Permission System
 *
 * V0.9.9
 * - Capability: what the Agent is allowed to do
 * - Capability Lifecycle: REGISTERED → ENABLED → DISABLED
 * - Permission Check: checkCapability(capability, context)
 * - Integration with Tool Registry, Policy, Approval
 *
 * Design:
 *   Capability is the permission boundary.
 *   Every Tool execution must pass Capability check before Policy/Approval.
 */

import { RUNTIME_EVENT_TYPES } from './events.js';

// ── Capability Status ─────────────────────────────────────

const CAPABILITY_STATUS = {
  REGISTERED: 'registered',
  ENABLED: 'enabled',
  DISABLED: 'disabled',
};

const CAPABILITY_TRANSITIONS = {
  [CAPABILITY_STATUS.REGISTERED]: [CAPABILITY_STATUS.ENABLED, CAPABILITY_STATUS.DISABLED],
  [CAPABILITY_STATUS.ENABLED]: [CAPABILITY_STATUS.DISABLED],
  [CAPABILITY_STATUS.DISABLED]: [CAPABILITY_STATUS.ENABLED],
};

// ── Capability Categories ─────────────────────────────────

const CAPABILITY_CATEGORIES = {
  FILESYSTEM: 'filesystem',
  SHELL: 'shell',
  GIT: 'git',
  NETWORK: 'network',
  DATABASE: 'database',
  SYSTEM: 'system',
  EDITOR: 'editor',
  BROWSER: 'browser',
  CUSTOM: 'custom',
};

// ── Risk Levels ───────────────────────────────────────────

const CAPABILITY_RISK = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical',
};

const RISK_ORDER = {
  [CAPABILITY_RISK.LOW]: 1,
  [CAPABILITY_RISK.MEDIUM]: 2,
  [CAPABILITY_RISK.HIGH]: 3,
  [CAPABILITY_RISK.CRITICAL]: 4,
};

// ── Capability Factory ────────────────────────────────────

/**
 * V0.9.9: Create a Capability definition.
 */
function createCapability(options = {}) {
  return {
    id: options.id || `cap_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name: options.name || 'unnamed',
    description: options.description || '',
    category: options.category || CAPABILITY_CATEGORIES.CUSTOM,
    riskLevel: options.riskLevel || CAPABILITY_RISK.LOW,
    permissions: options.permissions || [],
    status: CAPABILITY_STATUS.REGISTERED,
    enabled: false,
    createdAt: Date.now(),
    enabledAt: null,
    disabledAt: null,
    // V0.9.9: Sandbox constraints
    constraints: options.constraints || {},
  };
}

// ── Capability Lifecycle ──────────────────────────────────

/**
 * V0.9.9: Enable a capability — REGISTERED → ENABLED.
 */
function enableCapability(capability, emitter, context = {}) {
  if (!capability) return false;
  if (capability.status === CAPABILITY_STATUS.ENABLED) return false;
  if (capability.status === CAPABILITY_STATUS.DISABLED) return false;

  capability.status = CAPABILITY_STATUS.ENABLED;
  capability.enabled = true;
  capability.enabledAt = Date.now();
  capability.disabledAt = null;

  if (emitter) {
    emitter.emit({
      runId: context.runId,
      type: RUNTIME_EVENT_TYPES.CAPABILITY_ENABLED,
      data: {
        capabilityId: capability.id,
        name: capability.name,
        category: capability.category,
      },
    });
  }

  return true;
}

/**
 * V0.9.9: Disable a capability — ENABLED → DISABLED.
 */
function disableCapability(capability, emitter, context = {}) {
  if (!capability) return false;
  if (capability.status === CAPABILITY_STATUS.DISABLED) return false;
  if (capability.status === CAPABILITY_STATUS.REGISTERED) return false;

  capability.status = CAPABILITY_STATUS.DISABLED;
  capability.enabled = false;
  capability.disabledAt = Date.now();

  if (emitter) {
    emitter.emit({
      runId: context.runId,
      type: RUNTIME_EVENT_TYPES.CAPABILITY_DISABLED,
      data: {
        capabilityId: capability.id,
        name: capability.name,
        reason: context.reason || 'Disabled',
      },
    });
  }

  return true;
}

// ── Permission Check ──────────────────────────────────────

/**
 * V0.9.9: Check if a capability allows a specific action.
 *
 * @param {object} capability - Capability definition
 * @param {object} context - { action, path, ... }
 * @returns {object} { allowed, reason, riskLevel }
 */
function checkCapability(capability, context = {}) {
  if (!capability) {
    return { allowed: false, reason: 'Capability not found', riskLevel: null };
  }

  // Check if enabled
  if (!capability.enabled || capability.status !== CAPABILITY_STATUS.ENABLED) {
    return {
      allowed: false,
      reason: `Capability ${capability.name} is ${capability.status}`,
      riskLevel: capability.riskLevel,
    };
  }

  // Check permissions
  if (capability.permissions && capability.permissions.length > 0) {
    const action = context.action;
    if (action && !capability.permissions.includes(action)) {
      return {
        allowed: false,
        reason: `Permission ${action} not granted for capability ${capability.name}`,
        riskLevel: capability.riskLevel,
      };
    }
  }

  // Check constraints (path, etc.)
  if (capability.constraints) {
    const constraintCheck = checkConstraints(capability.constraints, context);
    if (!constraintCheck.allowed) {
      return {
        allowed: false,
        reason: constraintCheck.reason,
        riskLevel: capability.riskLevel,
      };
    }
  }

  return {
    allowed: true,
    reason: 'Allowed',
    riskLevel: capability.riskLevel,
    capability: capability.name,
  };
}

/**
 * V0.9.9: Check sandbox constraints.
 */
function checkConstraints(constraints, context) {
  // Path constraints
  if (constraints.allowedPaths && context.path) {
    const allowed = constraints.allowedPaths.some(prefix =>
      context.path.startsWith(prefix)
    );
    if (!allowed) {
      return {
        allowed: false,
        reason: `Path ${context.path} is outside allowed paths`,
      };
    }
  }

  // Blocked paths
  if (constraints.blockedPaths && context.path) {
    const blocked = constraints.blockedPaths.some(prefix =>
      context.path.startsWith(prefix)
    );
    if (blocked) {
      return {
        allowed: false,
        reason: `Path ${context.path} is blocked`,
      };
    }
  }

  // Max risk level
  if (constraints.maxRiskLevel) {
    const contextRisk = context.riskLevel || CAPABILITY_RISK.LOW;
    if (RISK_ORDER[contextRisk] > RISK_ORDER[constraints.maxRiskLevel]) {
      return {
        allowed: false,
        reason: `Risk level ${contextRisk} exceeds max ${constraints.maxRiskLevel}`,
      };
    }
  }

  return { allowed: true };
}

// ── Capability Registry ───────────────────────────────────

/**
 * V0.9.9: CapabilityRegistry — manages capability definitions.
 */
class CapabilityRegistry {
  constructor() {
    this.capabilities = new Map(); // id → capability
    this.byCategory = new Map();   // category → [capabilities]
    this.byName = new Map();        // name → capability
  }

  /**
   * Register a capability.
   */
  register(capability, emitter, context = {}) {
    if (this.capabilities.has(capability.id)) {
      return { success: false, reason: 'Capability already registered', capability };
    }

    this.capabilities.set(capability.id, capability);
    this.byName.set(capability.name, capability);

    if (!this.byCategory.has(capability.category)) {
      this.byCategory.set(capability.category, []);
    }
    this.byCategory.get(capability.category).push(capability);

    if (emitter) {
      emitter.emit({
        runId: context.runId,
        type: RUNTIME_EVENT_TYPES.CAPABILITY_REGISTERED,
        data: {
          capabilityId: capability.id,
          name: capability.name,
          category: capability.category,
          riskLevel: capability.riskLevel,
        },
      });
    }

    return { success: true, capability };
  }

  /**
   * Get capability by ID.
   */
  get(capabilityId) {
    return this.capabilities.get(capabilityId) || null;
  }

  /**
   * Get capability by name.
   */
  getByName(name) {
    return this.byName.get(name) || null;
  }

  /**
   * Get capabilities by category.
   */
  getByCategory(category) {
    return this.byCategory.get(category) || [];
  }

  /**
   * Check if a capability exists.
   */
  has(capabilityId) {
    return this.capabilities.has(capabilityId);
  }

  /**
   * List all capabilities.
   */
  list() {
    return Array.from(this.capabilities.values());
  }

  /**
   * List enabled capabilities.
   */
  listEnabled() {
    return this.list().filter(c => c.enabled);
  }

  /**
   * Check capability permission.
   */
  check(capabilityId, context) {
    const capability = this.get(capabilityId);
    if (!capability) {
      return { allowed: false, reason: `Capability ${capabilityId} not found`, riskLevel: null };
    }
    return checkCapability(capability, context);
  }

  /**
   * Serialize for snapshot.
   */
  serialize() {
    return {
      capabilities: Object.fromEntries(this.capabilities),
    };
  }

  /**
   * Deserialize from snapshot.
   */
  deserialize(data) {
    if (!data || !data.capabilities) return;
    for (const [id, cap] of Object.entries(data.capabilities)) {
      this.capabilities.set(id, cap);
      this.byName.set(cap.name, cap);
      if (!this.byCategory.has(cap.category)) {
        this.byCategory.set(cap.category, []);
      }
      this.byCategory.get(cap.category).push(cap);
    }
  }
}

// ── Factory ───────────────────────────────────────────────

/**
 * V0.9.9: Create a CapabilityRegistry.
 */
function createCapabilityRegistry() {
  return new CapabilityRegistry();
}

/**
 * V0.9.9: Create a capability with common presets.
 */
function createFileWriteCapability(options = {}) {
  return createCapability({
    id: options.id || 'cap_file_write',
    name: 'file_write',
    description: 'Write files within workspace',
    category: CAPABILITY_CATEGORIES.FILESYSTEM,
    riskLevel: CAPABILITY_RISK.MEDIUM,
    permissions: ['write', 'create', 'modify'],
    constraints: {
      allowedPaths: options.allowedPaths || ['/workspace/'],
    },
    ...options,
  });
}

function createFileDeleteCapability(options = {}) {
  return createCapability({
    id: options.id || 'cap_file_delete',
    name: 'file_delete',
    description: 'Delete files within workspace',
    category: CAPABILITY_CATEGORIES.FILESYSTEM,
    riskLevel: CAPABILITY_RISK.HIGH,
    permissions: ['delete'],
    constraints: {
      allowedPaths: options.allowedPaths || ['/workspace/'],
    },
    ...options,
  });
}

function createShellExecuteCapability(options = {}) {
  return createCapability({
    id: options.id || 'cap_shell_execute',
    name: 'shell_execute',
    description: 'Execute shell commands',
    category: CAPABILITY_CATEGORIES.SHELL,
    riskLevel: CAPABILITY_RISK.HIGH,
    permissions: ['execute'],
    constraints: {
      maxRiskLevel: options.maxRiskLevel || CAPABILITY_RISK.HIGH,
    },
    ...options,
  });
}

function createGitPushCapability(options = {}) {
  return createCapability({
    id: options.id || 'cap_git_push',
    name: 'git_push',
    description: 'Push to remote git repository',
    category: CAPABILITY_CATEGORIES.GIT,
    riskLevel: CAPABILITY_RISK.CRITICAL,
    permissions: ['push'],
    ...options,
  });
}

export {
  CAPABILITY_STATUS,
  CAPABILITY_TRANSITIONS,
  CAPABILITY_CATEGORIES,
  CAPABILITY_RISK,
  RISK_ORDER,
  createCapability,
  enableCapability,
  disableCapability,
  checkCapability,
  checkConstraints,
  CapabilityRegistry,
  createCapabilityRegistry,
  createFileWriteCapability,
  createFileDeleteCapability,
  createShellExecuteCapability,
  createGitPushCapability,
};