/**
 * agent/runtime/context.js — Skill Runtime Context
 *
 * V0.8.2
 * - SkillRuntimeContext: centralizes skill state, lifecycle, evidence, verification
 */

import { RuntimeEventLog } from './events.js';

/**
 * V0.7.2: Unified Skill Runtime Context.
 * Centralizes skill state instead of scattering across agent/index.js, plan.js, verification.js.
 */
class SkillRuntimeContext {
  constructor(runId) {
    this.runId = runId;
    this.activeSkills = [];       // [{ skill, status, activatedAt }]
    this.permissions = new Map(); // skillId → allowedTools[]
    this.lifecycle = new Map();   // skillId → { state, transitions[] }
    this.evidenceRefs = new Map(); // skillId → [evidenceIds]
    this.verificationResults = new Map(); // skillId → VerificationResult
    this.instructionBlocks = [];  // provenance-tracked instructions
    this.eventLog = new RuntimeEventLog(); // V0.8: runtime event timeline
  }

  /**
   * Add a skill to the runtime context.
   */
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

  /**
   * Update skill lifecycle state with transition tracking.
   */
  updateSkillStatus(skillId, newStatus) {
    const entry = this.activeSkills.find(s => s.skill.id === skillId);
    if (entry) {
      entry.status = newStatus;
    }
    const lc = this.lifecycle.get(skillId);
    if (lc) {
      lc.state = newStatus;
      lc.transitions.push({ status: newStatus, timestamp: Date.now() });
    }
  }

  /**
   * Add an instruction block with provenance.
   */
  addInstructionBlock(block) {
    this.instructionBlocks.push({
      ...block,
      timestamp: Date.now(),
    });
  }

  /**
   * Add an evidence reference.
   */
  addEvidenceRef(skillId, evidenceId) {
    if (!this.evidenceRefs.has(skillId)) {
      this.evidenceRefs.set(skillId, []);
    }
    this.evidenceRefs.get(skillId).push(evidenceId);
  }

  /**
   * V0.7.3: Store verification result for a skill.
   */
  setVerificationResult(skillId, result) {
    this.verificationResults.set(skillId, result);
  }

  /**
   * V0.7.3: Get verification result for a skill.
   */
  getVerificationResult(skillId) {
    return this.verificationResults.get(skillId) || null;
  }

  /**
   * Get skills by status.
   */
  getSkillsByStatus(status) {
    return this.activeSkills.filter(s => s.status === status);
  }

  /**
   * Check if a tool is allowed across all active skills (ANY model).
   */
  isToolAllowed(toolName, availableTools) {
    if (this.activeSkills.length === 0) return true;
    return this.activeSkills.some(entry =>
      entry.skill.tools.includes(toolName) && availableTools.includes(toolName)
    );
  }

  /**
   * Serialize for session persistence.
   */
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

  /**
   * Deserialize from session.
   */
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
    if (data.instructionBlocks) {
      ctx.instructionBlocks = data.instructionBlocks;
    }
    if (data.eventLog) {
      ctx.eventLog = RuntimeEventLog.deserialize(data.eventLog);
    }
    return ctx;
  }
}

export {
  SkillRuntimeContext,
};