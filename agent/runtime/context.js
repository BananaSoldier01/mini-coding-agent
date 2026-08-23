/**
 * agent/runtime/context.js — Agent Runtime Context
 *
 * V0.9.0
 * - AgentRuntimeContext: unified runtime container
 * - Backward-compatible with SkillRuntimeContext
 * - Contains TaskContext, SkillContext, PolicyContext, ToolContext, etc.
 */

import { RuntimeEventLog } from './events.js';

/**
 * V0.7.2: Skill Runtime Context (sub-component of AgentRuntimeContext).
 * Retained for backward compatibility.
 */
class SkillRuntimeContext {
  constructor(runId) {
    this.runId = runId;
    this.activeSkills = [];
    this.permissions = new Map();
    this.lifecycle = new Map();
    this.evidenceRefs = new Map();
    this.verificationResults = new Map();
    this.instructionBlocks = [];
    this.eventLog = new RuntimeEventLog();
  }

  addSkill(skill) {
    if (!this.activeSkills.find(s => s.skill.id === skill.id)) {
      this.activeSkills.push({
        skill,
        status: skill.status,
        activatedAt: Date.now(),
      });
      this.lifecycle.set(skill.id, {
        state: skill.status,
        transitions: [{ status: skill.status, timestamp: Date.now() }],
      });
      this.permissions.set(skill.id, skill.tools);
    }
  }

  updateSkillStatus(skillId, newStatus) {
    const entry = this.activeSkills.find(s => s.skill.id === skillId);
    if (entry) entry.status = newStatus;
    const lc = this.lifecycle.get(skillId);
    if (lc) {
      lc.state = newStatus;
      lc.transitions.push({ status: newStatus, timestamp: Date.now() });
    }
  }

  addInstructionBlock(block) {
    this.instructionBlocks.push({ ...block, timestamp: Date.now() });
  }

  addEvidenceRef(skillId, evidenceId) {
    if (!this.evidenceRefs.has(skillId)) this.evidenceRefs.set(skillId, []);
    this.evidenceRefs.get(skillId).push(evidenceId);
  }

  setVerificationResult(skillId, result) {
    this.verificationResults.set(skillId, result);
  }

  getVerificationResult(skillId) {
    return this.verificationResults.get(skillId) || null;
  }

  getSkillsByStatus(status) {
    return this.activeSkills.filter(s => s.status === status);
  }

  isToolAllowed(toolName, availableTools) {
    if (this.activeSkills.length === 0) return true;
    return this.activeSkills.some(entry =>
      entry.skill.tools.includes(toolName) && availableTools.includes(toolName)
    );
  }

  serialize() {
    return {
      runId: this.runId,
      activeSkills: this.activeSkills.map(s => ({
        skillId: s.skill.id,
        status: s.status,
        activatedAt: s.activatedAt,
      })),
      permissions: Object.fromEntries(this.permissions),
      lifecycle: Object.fromEntries(this.lifecycle),
      evidenceRefs: Object.fromEntries(this.evidenceRefs),
      verificationResults: Object.fromEntries(this.verificationResults),
      instructionBlocks: this.instructionBlocks,
      eventLog: this.eventLog ? this.eventLog.serialize() : null,
    };
  }

  static deserialize(data, registry) {
    const ctx = new SkillRuntimeContext(data.runId);
    if (data.activeSkills) {
      for (const s of data.activeSkills) {
        const skill = registry.get(s.skillId);
        if (skill) {
          ctx.addSkill(skill);
          ctx.updateSkillStatus(s.skillId, s.status);
        }
      }
    }
    if (data.evidenceRefs) {
      for (const [skillId, refs] of Object.entries(data.evidenceRefs)) {
        ctx.evidenceRefs.set(skillId, refs);
      }
    }
    if (data.verificationResults) {
      for (const [skillId, result] of Object.entries(data.verificationResults)) {
        ctx.verificationResults.set(skillId, result);
      }
    }
    if (data.instructionBlocks) ctx.instructionBlocks = data.instructionBlocks;
    if (data.eventLog) ctx.eventLog = RuntimeEventLog.deserialize(data.eventLog);
    return ctx;
  }
}

/**
 * V0.9.0: AgentRuntimeContext — unified runtime container.
 *
 * Single Source of Truth for execution state.
 * Replaces scattered SkillRuntimeContext + RuntimePolicyContext usage.
 */
class AgentRuntimeContext {
  constructor(runId, options = {}) {
    this.runId = runId;
    this.sessionId = options.sessionId || null;
    this.createdAt = Date.now();
    this.updatedAt = Date.now();

    // Sub-contexts
    this.skill = new SkillRuntimeContext(runId);     // Skill lifecycle, evidence, verification
    this.policy = options.policy || null;              // RuntimePolicyContext
    this.tasks = new Map();                            // taskId → Task
    this.toolExecutions = new Map();                   // toolExecId → ToolExecution
    this.evidence = options.evidence || null;          // EvidenceRegistry
    this.events = this.skill.eventLog;                 // Shared event log (SSOT)
    this.snapshot = null;                              // Latest snapshot reference
  }

  // ── Task Management ────────────────────────────────────

  addTask(task) {
    this.tasks.set(task.id, task);
    this.updatedAt = Date.now();
    return task;
  }

  getTask(taskId) {
    return this.tasks.get(taskId) || null;
  }

  listTasks() {
    return Array.from(this.tasks.values());
  }

  getTasksByStatus(status) {
    return this.listTasks().filter(t => t.status === status);
  }

  // ── ToolExecution Management ───────────────────────────

  addToolExecution(te) {
    this.toolExecutions.set(te.id, te);
    this.updatedAt = Date.now();
    return te;
  }

  getToolExecution(toolExecId) {
    return this.toolExecutions.get(toolExecId) || null;
  }

  listToolExecutions() {
    return Array.from(this.toolExecutions.values());
  }

  getToolExecutionsByTask(taskId) {
    return this.listToolExecutions().filter(te => te.taskId === taskId);
  }

  // ── Skill Management (delegated) ───────────────────────

  addSkill(skill) {
    this.skill.addSkill(skill);
    this.updatedAt = Date.now();
  }

  getSkillStatus(skillId) {
    const entry = this.skill.activeSkills.find(s => s.skill.id === skillId);
    return entry ? entry.status : null;
  }

  // ── Evidence Management (delegated) ────────────────────

  addEvidenceRef(skillId, evidenceId) {
    this.skill.addEvidenceRef(skillId, evidenceId);
  }

  // ── Serialization ──────────────────────────────────────

  serialize() {
    return {
      runId: this.runId,
      sessionId: this.sessionId,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      skill: this.skill.serialize(),
      policy: this.policy ? this.policy.serialize() : null,
      tasks: Object.fromEntries(this.tasks),
      toolExecutions: Object.fromEntries(this.toolExecutions),
      evidence: this.evidence ? this.evidence.serialize() : null,
      events: this.events.serialize(),
    };
  }

  static deserialize(data, registry, policyContext) {
    const ctx = new AgentRuntimeContext(data.runId, { sessionId: data.sessionId });
    ctx.createdAt = data.createdAt || Date.now();
    ctx.updatedAt = data.updatedAt || Date.now();

    // Restore skill context
    if (data.skill) {
      const restored = SkillRuntimeContext.deserialize(data.skill, registry);
      ctx.skill = restored;
      ctx.events = restored.eventLog;
    }

    // Restore policy context
    if (data.policy) {
      ctx.policy = policyContext ? policyContext.constructor.deserialize(data.policy) : data.policy;
    }

    // Restore tasks
    if (data.tasks) {
      for (const [id, task] of Object.entries(data.tasks)) {
        ctx.tasks.set(id, task);
      }
    }

    // Restore tool executions
    if (data.toolExecutions) {
      for (const [id, te] of Object.entries(data.toolExecutions)) {
        ctx.toolExecutions.set(id, te);
      }
    }

    // Restore evidence
    if (data.evidence) {
      ctx.evidence = { ...data.evidence };
    }

    return ctx;
  }
}

export {
  SkillRuntimeContext,
  AgentRuntimeContext,
};