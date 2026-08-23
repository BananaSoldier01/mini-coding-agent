/**
 * agent/skill/registry.js — Skill Registry & Plan Binding
 *
 * V0.8.2
 * - SkillRegistry
 * - Skill ↔ Plan Binding
 * - Skill Execution Context
 * - Lifecycle Helpers (activate/complete/fail/cancel)
 */

import {
  SKILL_STATUS,
  SKILL_TRANSITIONS,
  transitionSkillStatus,
  safeTransitionSkillStatus,
} from './lifecycle.js';
import {
  validateSkill,
  createSkill,
  buildSkillInstructionContext,
  isToolAllowedForSkill,
} from './model.js';

// ── Skill Registry ────────────────────────────────────────

/**
 * SkillRegistry — manages Skill lifecycle: register, query, load, validate.
 * Skills must pass validation before being available for execution.
 */
class SkillRegistry {
  constructor(availableTools = []) {
    this.skills = new Map(); // id → skill
    this.availableTools = availableTools;
  }

  /**
   * Register a skill definition. Validates before accepting.
   * Returns the created skill or throws on invalid.
   */
  register(definition) {
    const validation = validateSkill(definition);
    if (!validation.valid) {
      throw new Error(`Cannot register invalid skill: ${validation.errors.join('; ')}`);
    }

    if (definition.tools && definition.tools.length > 0) {
      const missingTools = definition.tools.filter(t => !this.availableTools.includes(t));
      if (missingTools.length > 0) {
        throw new Error(`Skill references unknown tools: ${missingTools.join(', ')}`);
      }
    }

    if (this.skills.has(definition.id)) {
      throw new Error(`Skill already registered: ${definition.id}`);
    }

    const skill = createSkill(definition);
    this.skills.set(skill.id, skill);
    return skill;
  }

  /**
   * Get a skill by id. Returns null if not found.
   */
  get(skillId) {
    return this.skills.get(skillId) || null;
  }

  /**
   * List all registered skills, optionally filtered by status.
   */
  list(filterStatus = null) {
    const all = Array.from(this.skills.values());
    if (filterStatus) {
      return all.filter(s => s.status === filterStatus);
    }
    return all;
  }

  /**
   * Load a skill (transition to AVAILABLE).
   * Returns the skill or null if not found.
   */
  load(skillId) {
    const skill = this.get(skillId);
    if (!skill) return null;
    if (skill.status === SKILL_STATUS.REGISTERED) {
      transitionSkillStatus(skill, SKILL_STATUS.AVAILABLE);
    }
    return skill;
  }

  /**
   * Validate a skill definition without registering.
   */
  validate(definition) {
    return validateSkill(definition);
  }

  /**
   * Unregister a skill.
   */
  unregister(skillId) {
    return this.skills.delete(skillId);
  }

  /**
   * Get count of registered skills.
   */
  count() {
    return this.skills.size;
  }

  /**
   * Check if a skill exists.
   */
  has(skillId) {
    return this.skills.has(skillId);
  }
}

// ── Skill Runtime Lifecycle Helpers ───────────────────────

/**
 * V0.7.2: Activate skills for a run — transition from AVAILABLE to RUNNING.
 */
function activateSkillsForRun(registry, skillIds) {
  const activated = [];
  for (const id of skillIds) {
    const skill = registry.get(id);
    if (skill && skill.status === SKILL_STATUS.AVAILABLE) {
      transitionSkillStatus(skill, SKILL_STATUS.RUNNING);
      activated.push(skill);
    }
  }
  return activated;
}

/**
 * V0.7.2: Start skill verification — transition from RUNNING to VERIFYING.
 */
function startSkillVerification(registry, skillId) {
  const skill = registry.get(skillId);
  if (skill && skill.status === SKILL_STATUS.RUNNING) {
    transitionSkillStatus(skill, SKILL_STATUS.VERIFYING);
    return skill;
  }
  return null;
}

/**
 * V0.7.2: Complete a skill — transition from VERIFYING to COMPLETED.
 */
function completeSkill(registry, skillId) {
  const skill = registry.get(skillId);
  if (skill && (skill.status === SKILL_STATUS.VERIFYING || skill.status === SKILL_STATUS.RUNNING)) {
    transitionSkillStatus(skill, SKILL_STATUS.COMPLETED);
    return skill;
  }
  return null;
}

/**
 * V0.7.2: Fail a skill — transition to FAILED.
 */
function failSkill(registry, skillId) {
  const skill = registry.get(skillId);
  if (skill && (skill.status === SKILL_STATUS.RUNNING || skill.status === SKILL_STATUS.VERIFYING)) {
    transitionSkillStatus(skill, SKILL_STATUS.FAILED);
    return skill;
  }
  return null;
}

/**
 * V0.7.2: Cancel all skills — transition to CANCELLED.
 */
function cancelAllSkills(registry) {
  const cancelled = [];
  for (const skill of registry.list()) {
    if (skill.status !== SKILL_STATUS.COMPLETED && skill.status !== SKILL_STATUS.FAILED) {
      transitionSkillStatus(skill, SKILL_STATUS.CANCELLED);
      cancelled.push(skill);
    }
  }
  return cancelled;
}

/**
 * V0.7.2: Get skill lifecycle summary for a run.
 */
function getSkillLifecycleSummary(registry) {
  const skills = registry.list();
  return {
    total: skills.length,
    registered: skills.filter(s => s.status === SKILL_STATUS.REGISTERED).length,
    available: skills.filter(s => s.status === SKILL_STATUS.AVAILABLE).length,
    running: skills.filter(s => s.status === SKILL_STATUS.RUNNING).length,
    verifying: skills.filter(s => s.status === SKILL_STATUS.VERIFYING).length,
    completed: skills.filter(s => s.status === SKILL_STATUS.COMPLETED).length,
    failed: skills.filter(s => s.status === SKILL_STATUS.FAILED).length,
    cancelled: skills.filter(s => s.status === SKILL_STATUS.CANCELLED).length,
  };
}

// ── Skill ↔ Plan Binding ──────────────────────────────────

/**
 * Attach a skill to a plan.
 */
function bindSkillToPlan(plan, skill) {
  if (!plan) throw new Error('Plan is required');
  if (!skill) throw new Error('Skill is required');

  if (!plan.skills) plan.skills = [];
  if (!plan.skills.some(s => s.skillId === skill.id)) {
    plan.skills.push({
      skillId: skill.id,
      skillName: skill.name,
      boundAt: Date.now(),
    });
  }
  plan.updatedAt = Date.now();
  return plan;
}

/**
 * Attach a skill to a specific step.
 */
function bindSkillToStep(step, skill) {
  if (!step) throw new Error('Step is required');
  if (!skill) throw new Error('Skill is required');

  step.skillId = skill.id;
  step.skillName = skill.name;
  step.updatedAt = Date.now();
  return step;
}

/**
 * Get the skill bound to a plan.
 */
function getPlanSkill(plan, skillId) {
  if (!plan || !plan.skills) return null;
  const binding = plan.skills.find(s => s.skillId === skillId);
  return binding || null;
}

// ── Skill Execution Context ───────────────────────────────

/**
 * Build the full skill instruction context for LLM injection.
 */
function buildSkillContextForLLM(skill, baseContext = '') {
  if (!skill) return baseContext;

  const skillBlock = buildSkillInstructionContext(skill);
  if (!skillBlock) return baseContext;

  return `${baseContext}\n\n${skillBlock}`;
}

/**
 * Verify that a tool call is allowed for a skill.
 */
function assertSkillToolAllowed(skill, toolName, availableTools) {
  if (!isToolAllowedForSkill(skill, toolName, availableTools)) {
    throw new Error(
      `Skill "${skill.id}" is not permitted to use tool "${toolName}". ` +
      `Allowed tools: ${skill.tools.length > 0 ? skill.tools.join(', ') : '(none)'}`
    );
  }
}

export {
  SkillRegistry,
  activateSkillsForRun,
  startSkillVerification,
  completeSkill,
  failSkill,
  cancelAllSkills,
  getSkillLifecycleSummary,
  bindSkillToPlan,
  bindSkillToStep,
  getPlanSkill,
  buildSkillContextForLLM,
  assertSkillToolAllowed,
};