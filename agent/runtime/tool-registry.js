/**
 * agent/runtime/tool-registry.js — Tool Registry & Capability Mapping
 *
 * V0.9.9
 * - ToolRegistry: register, query, map tools to capabilities
 * - Tool execution governance: capability check → policy check → approval → execute
 * - Integration with CapabilityRegistry, GovernanceManager, EventStore
 *
 * Design:
 *   Tool is the execution unit.
 *   Capability is the permission unit.
 *   Registry maps tools to capabilities.
 *   Every tool execution must pass capability check.
 */

import { RUNTIME_EVENT_TYPES } from './events.js';
import { checkCapability } from './capability.js';

// ── Tool Registry ─────────────────────────────────────────

class ToolRegistry {
  constructor(options = {}) {
    this.tools = new Map();           // name → tool
    this.capabilityRegistry = options.capabilityRegistry || null;
    this.governance = options.governance || null;
    this.emitter = options.emitter || null;
    this.eventStore = options.eventStore || null;
  }

  // ── Registration ──────────────────────────────────────

  /**
   * V0.9.9: Register a tool with capability mapping.
   */
  register(tool, options = {}) {
    const toolDef = {
      name: tool.name,
      description: tool.description || '',
      capabilityId: tool.capabilityId || tool.capability,
      riskLevel: tool.riskLevel || 'medium',
      handler: tool.handler || null,
      params: tool.params || {},
      category: tool.category || 'custom',
      registeredAt: Date.now(),
      enabled: tool.enabled !== false,
    };

    if (this.tools.has(toolDef.name)) {
      return { success: false, reason: `Tool ${toolDef.name} already registered`, tool: toolDef };
    }

    this.tools.set(toolDef.name, toolDef);

    if (this.emitter) {
      this.emitter.emit({
        runId: options.runId,
        type: RUNTIME_EVENT_TYPES.TOOL_REGISTERED,
        data: {
          toolName: toolDef.name,
          capabilityId: toolDef.capabilityId,
          riskLevel: toolDef.riskLevel,
        },
      });
    }

    return { success: true, tool: toolDef };
  }

  /**
   * V0.9.9: Get tool by name.
   */
  get(name) {
    return this.tools.get(name) || null;
  }

  /**
   * V0.9.9: Check if tool exists.
   */
  has(name) {
    return this.tools.has(name);
  }

  /**
   * V0.9.9: List all tools.
   */
  list() {
    return Array.from(this.tools.values());
  }

  /**
   * V0.9.9: List enabled tools.
   */
  listEnabled() {
    return this.list().filter(t => t.enabled);
  }

  // ── Capability Mapping ────────────────────────────────

  /**
   * V0.9.9: Get capability for a tool.
   */
  getCapability(toolName) {
    const tool = this.tools.get(toolName);
    if (!tool || !tool.capabilityId) return null;
    if (!this.capabilityRegistry) return null;
    return this.capabilityRegistry.get(tool.capabilityId);
  }

  /**
   * V0.9.9: Check if tool execution is allowed.
   * Performs: capability check → policy check → approval check
   */
  async checkToolExecution(toolName, context = {}) {
    const tool = this.tools.get(toolName);
    if (!tool) {
      return { allowed: false, reason: `Tool ${toolName} not found`, step: 'lookup' };
    }

    if (!tool.enabled) {
      return { allowed: false, reason: `Tool ${toolName} is disabled`, step: 'enabled' };
    }

    // Step 1: Capability check
    if (this.capabilityRegistry && tool.capabilityId) {
      const capResult = this.capabilityRegistry.check(tool.capabilityId, {
        action: context.action,
        path: context.path,
        riskLevel: tool.riskLevel,
      });

      if (this.emitter) {
        this.emitter.emit({
          runId: context.runId,
          type: capResult.allowed ? RUNTIME_EVENT_TYPES.CAPABILITY_CHECKED : RUNTIME_EVENT_TYPES.CAPABILITY_DENIED,
          data: {
            toolName,
            capabilityId: tool.capabilityId,
            allowed: capResult.allowed,
            reason: capResult.reason,
          },
        });
      }

      if (!capResult.allowed) {
        return { allowed: false, reason: capResult.reason, step: 'capability' };
      }
    }

    // Step 2: Policy check
    if (this.governance) {
      const requiresApproval = this.governance.checkPolicy(toolName, tool.riskLevel);
      if (requiresApproval) {
        return {
          allowed: false,
          reason: `Tool ${toolName} requires human approval`,
          step: 'policy',
          requiresApproval: true,
          toolName,
          riskLevel: tool.riskLevel,
        };
      }
    }

    return { allowed: true, step: 'ok' };
  }

  // ── Execution ─────────────────────────────────────────

  /**
   * V0.9.9: Execute a tool with full governance.
   * Flow: lookup → capability → policy → approval → execute → event
   */
  async execute(toolName, params = {}, context = {}) {
    const tool = this.tools.get(toolName);
    if (!tool) {
      return { success: false, reason: `Tool ${toolName} not found` };
    }

    // Check execution
    const check = await this.checkToolExecution(toolName, context);
    if (!check.allowed) {
      if (check.requiresApproval) {
        return {
          success: false,
          reason: check.reason,
          requiresApproval: true,
          toolName,
          riskLevel: check.riskLevel,
        };
      }
      return { success: false, reason: check.reason };
    }

    // Execute
    if (!tool.handler) {
      return { success: false, reason: `Tool ${toolName} has no handler` };
    }

    try {
      const result = await tool.handler(params, context);
      return { success: true, result, toolName };
    } catch (err) {
      return { success: false, reason: err.message, toolName };
    }
  }

  /**
   * V0.9.9: Emit tool execution requested event.
   */
  emitToolRequested(toolName, context = {}) {
    if (!this.emitter) return;
    this.emitter.emit({
      runId: context.runId,
      type: RUNTIME_EVENT_TYPES.TOOL_EXECUTION_REQUESTED,
      data: {
        toolName,
        params: context.params,
        riskLevel: this.tools.get(toolName)?.riskLevel,
      },
    });
  }

  /**
   * V0.9.9: Emit tool execution blocked event.
   */
  emitToolBlocked(toolName, reason, context = {}) {
    if (!this.emitter) return;
    this.emitter.emit({
      runId: context.runId,
      type: RUNTIME_EVENT_TYPES.TOOL_EXECUTION_BLOCKED,
      data: {
        toolName,
        reason,
      },
    });
  }

  // ── Serialization ─────────────────────────────────────

  serialize() {
    return {
      tools: Object.fromEntries(this.tools),
    };
  }

  deserialize(data) {
    if (!data || !data.tools) return;
    for (const [name, tool] of Object.entries(data.tools)) {
      this.tools.set(name, tool);
    }
  }
}

// ── Factory ───────────────────────────────────────────────

/**
 * V0.9.9: Create a ToolRegistry.
 */
function createToolRegistry(options) {
  return new ToolRegistry(options);
}

export {
  ToolRegistry,
  createToolRegistry,
};