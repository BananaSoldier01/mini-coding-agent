/**
 * agent/runtime/skill-runtime.js — Skill Execution Runtime
 *
 * V1.0.0
 * - Skill Execution: load → validate → prepare → invoke → evidence → event
 * - Integration with Capability Registry, Tool Registry, Governance
 * - Skill Capability Binding: skills declare required capabilities
 * - Skill must NOT bypass: Capability, Policy, Approval, Event logging
 *
 * Design:
 *   Skill is a reusable ability package.
 *   Skill Runtime executes skills through the full governance pipeline.
 *   Skill execution is observable and replayable.
 */

import { RUNTIME_EVENT_TYPES } from './events.js';
import { checkCapability } from './capability.js';

// ── Skill Execution Status ────────────────────────────────

const SKILL_EXECUTION_STATUS = {
  LOADING: 'loading',
  VALIDATING: 'validating',
  READY: 'ready',
  EXECUTING: 'executing',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
};

// ── Skill Runtime ─────────────────────────────────────────

/**
 * V1.0.0: SkillRuntime — executes skills through governance pipeline.
 */
class SkillRuntime {
  constructor(options = {}) {
    this.skillRegistry = options.skillRegistry || null;
    this.capabilityRegistry = options.capabilityRegistry || null;
    this.toolRegistry = options.toolRegistry || null;
    this.governance = options.governance || null;
    this.emitter = options.emitter || null;
    this.eventStore = options.eventStore || null;
    this.sandbox = options.sandbox || null;
  }

  // ── Execution Pipeline ─────────────────────────────────

  /**
   * V1.0.0: Execute a skill through the full governance pipeline.
   *
   * Flow:
   *   Skill → Tool Resolution → Capability Validation →
   *   Governance Check → Task Execution → Evidence Collection → Event Recording
   *
   * @param {string} skillId - Skill ID
   * @param {object} context - Execution context { runId, taskId, params }
   * @returns {object} { success, result, evidence, events }
   */
  async executeSkill(skillId, context = {}) {
    const runId = context.runId;
    const taskId = context.taskId;

    // Step 1: Load skill
    this._emit(runId, taskId, RUNTIME_EVENT_TYPES.SKILL_EXECUTION_STARTED, {
      skillId,
      step: 'loading',
    });

    const skill = this.skillRegistry ? this.skillRegistry.get(skillId) : null;
    if (!skill) {
      this._emit(runId, taskId, RUNTIME_EVENT_TYPES.SKILL_EXECUTION_FAILED, {
        skillId,
        step: 'load',
        reason: `Skill ${skillId} not found`,
      });
      return { success: false, reason: `Skill ${skillId} not found`, step: 'load' };
    }

    if (!skill.enabled) {
      this._emit(runId, taskId, RUNTIME_EVENT_TYPES.SKILL_EXECUTION_FAILED, {
        skillId,
        step: 'validate',
        reason: `Skill ${skillId} is disabled`,
      });
      return { success: false, reason: `Skill ${skillId} is disabled`, step: 'validate' };
    }

    // Step 2: Validate capabilities
    this._emit(runId, taskId, RUNTIME_EVENT_TYPES.SKILL_EXECUTION_STARTED, {
      skillId,
      step: 'validating',
    });

    const capResult = await this._validateCapabilities(skill, context);
    if (!capResult.allowed) {
      this._emit(runId, taskId, RUNTIME_EVENT_TYPES.SKILL_CAPABILITY_DENIED, {
        skillId,
        reason: capResult.reason,
        missingCapabilities: capResult.missing,
      });
      return {
        success: false,
        reason: capResult.reason,
        step: 'capability',
        missingCapabilities: capResult.missing,
      };
    }

    // Step 3: Check governance (policy + approval)
    if (this.governance) {
      const toolNames = skill.tools || [];
      for (const toolName of toolNames) {
        const tool = this.toolRegistry ? this.toolRegistry.get(toolName) : null;
        const riskLevel = tool ? tool.riskLevel : 'medium';
        const requiresApproval = this.governance.checkPolicy(toolName, riskLevel);
        if (requiresApproval) {
          this._emit(runId, taskId, RUNTIME_EVENT_TYPES.SKILL_EXECUTION_STARTED, {
            skillId,
            step: 'approval_required',
            toolName,
          });
          return {
            success: false,
            reason: `Tool ${toolName} requires human approval`,
            step: 'approval',
            requiresApproval: true,
            toolName,
          };
        }
      }
    }

    // Step 4: Execute
    this._emit(runId, taskId, RUNTIME_EVENT_TYPES.SKILL_EXECUTION_STARTED, {
      skillId,
      step: 'executing',
    });

    try {
      const result = await this._invokeSkill(skill, context);
      const evidence = this._collectEvidence(skill, result);

      this._emit(runId, taskId, RUNTIME_EVENT_TYPES.SKILL_EXECUTION_COMPLETED, {
        skillId,
        result,
        evidence,
      });

      return {
        success: true,
        result,
        evidence,
        skillId,
        step: 'completed',
      };
    } catch (err) {
      this._emit(runId, taskId, RUNTIME_EVENT_TYPES.SKILL_EXECUTION_FAILED, {
        skillId,
        step: 'execute',
        reason: err.message,
      });
      return {
        success: false,
        reason: err.message,
        step: 'execute',
      };
    }
  }

  /**
   * V1.0.0: Validate all capabilities required by a skill.
   */
  async _validateCapabilities(skill, context) {
    const requiredCaps = skill.capabilities || [];
    if (requiredCaps.length === 0) {
      return { allowed: true, missing: [] };
    }

    if (!this.capabilityRegistry) {
      return { allowed: true, missing: [] };
    }

    const missing = [];
    for (const capName of requiredCaps) {
      const cap = this.capabilityRegistry.getByName(capName);
      if (!cap) {
        missing.push({ name: capName, reason: 'not found' });
        continue;
      }
      if (!cap.enabled) {
        missing.push({ name: capName, reason: 'disabled' });
        continue;
      }
      // Check permission
      const result = checkCapability(cap, {
        action: context.action,
        path: context.path,
      });
      if (!result.allowed) {
        missing.push({ name: capName, reason: result.reason });
      }
    }

    return {
      allowed: missing.length === 0,
      missing,
    };
  }

  /**
   * V1.0.0: Invoke skill tools.
   */
  async _invokeSkill(skill, context) {
    const toolNames = skill.tools || [];
    const results = [];

    for (const toolName of toolNames) {
      if (this.toolRegistry && this.toolRegistry.has(toolName)) {
        const execResult = await this.toolRegistry.execute(toolName, context.params || {}, {
          ...context,
          skillId: skill.id,
          // V1.0.0: Pass path/action from params for capability check
          path: context.params?.path || context.path,
          action: context.params?.action || context.action,
        });
        results.push({ tool: toolName, ...execResult });
      } else {
        results.push({ tool: toolName, success: false, reason: 'Tool not registered' });
      }
    }

    return { toolResults: results };
  }

  /**
   * V1.0.0: Collect evidence from skill execution.
   */
  _collectEvidence(skill, result) {
    const evidence = [];
    if (result.toolResults) {
      for (const tr of result.toolResults) {
        if (tr.success && tr.result) {
          evidence.push({
            type: 'tool_execution',
            tool: tr.tool,
            timestamp: Date.now(),
            data: tr.result,
          });
        }
      }
    }
    return evidence;
  }

  /**
   * V1.0.0: Emit event through emitter and store.
   */
  _emit(runId, taskId, type, data) {
    if (this.emitter) {
      this.emitter.emit({
        runId,
        taskId,
        type,
        data,
      });
    }
  }

  /**
   * V1.0.0: Check if a skill can be executed (without executing).
   */
  async canExecute(skillId, context = {}) {
    const skill = this.skillRegistry ? this.skillRegistry.get(skillId) : null;
    if (!skill) return { allowed: false, reason: 'Skill not found' };
    if (!skill.enabled) return { allowed: false, reason: 'Skill disabled' };

    const capResult = await this._validateCapabilities(skill, context);
    if (!capResult.allowed) {
      return { allowed: false, reason: capResult.reason, missing: capResult.missing };
    }

    return { allowed: true };
  }
}

// ── Skill Definition Model ────────────────────────────────

/**
 * V1.0.0: Create a Skill definition for Runtime execution.
 */
function createSkillDefinition(options = {}) {
  return {
    id: options.id || `skill_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name: options.name || 'unnamed',
    description: options.description || '',
    version: options.version || '1.0.0',
    author: options.author || 'system',
    tools: options.tools || [],
    capabilities: options.capabilities || [],
    config: options.config || {},
    enabled: options.enabled !== false,
    createdAt: Date.now(),
  };
}

// ── Factory ───────────────────────────────────────────────

/**
 * V1.0.0: Create a SkillRuntime.
 */
function createSkillRuntime(options) {
  return new SkillRuntime(options);
}

export {
  SKILL_EXECUTION_STATUS,
  SkillRuntime,
  createSkillRuntime,
  createSkillDefinition,
};