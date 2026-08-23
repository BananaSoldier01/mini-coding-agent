/**
 * agent/skill.js — Skill Model Foundation
 *
 * V0.7.0
 * - Skill Object: reusable Agent capability unit (NOT a tool collection)
 * - Skill Lifecycle: REGISTERED → AVAILABLE → RUNNING → VERIFYING → COMPLETED/FAILED
 * - Skill Schema Validation: rejects malformed skills before loading
 * - Skill ↔ Tool Runtime binding: skills must use existing Tool Runtime
 * - Skill Instruction Layer: context injection with priority ordering
 */

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

// ── Skill Instruction Priority ────────────────────────────
// Higher number = higher priority
const SKILL_INSTRUCTION_PRIORITY = {
  SYSTEM: 100,
  RUNTIME_POLICY: 80,
  SKILL_INSTRUCTION: 60,
  USER_REQUEST: 40,
};

// ── Validation ────────────────────────────────────────────

/**
 * Validate a Skill definition.
 * Returns { valid, errors }.
 */
function validateSkill(skill) {
  const errors = [];

  if (!skill || typeof skill !== 'object') {
    return { valid: false, errors: ['Skill must be an object'] };
  }

  // Required fields
  if (!skill.id || typeof skill.id !== 'string' || skill.id.trim() === '') {
    errors.push('Skill must have a non-empty string "id"');
  }

  if (!skill.name || typeof skill.name !== 'string' || skill.name.trim() === '') {
    errors.push('Skill must have a non-empty string "name"');
  }

  if (!skill.description || typeof skill.description !== 'string') {
    errors.push('Skill must have a string "description"');
  }

  if (!skill.version || typeof skill.version !== 'string') {
    errors.push('Skill must have a string "version"');
  }

  // Tools must be an array of strings
  if (skill.tools !== undefined) {
    if (!Array.isArray(skill.tools)) {
      errors.push('Skill "tools" must be an array');
    } else {
      for (const t of skill.tools) {
        if (typeof t !== 'string' || t.trim() === '') {
          errors.push('Each tool in "tools" must be a non-empty string');
          break;
        }
      }
    }
  }

  // Verification must be valid
  if (skill.verification !== undefined) {
    if (!Array.isArray(skill.verification)) {
      errors.push('Skill "verification" must be an array');
    } else {
      for (const v of skill.verification) {
        if (!v.type || typeof v.type !== 'string') {
          errors.push('Each verification must have a "type" string');
          break;
        }
        const validTypes = ['command', 'file', 'git', 'custom'];
        if (!validTypes.includes(v.type)) {
          errors.push(`Unknown verification type: ${v.type}`);
          break;
        }
      }
    }
  }

  // Instructions must be a string
  if (skill.instructions !== undefined && typeof skill.instructions !== 'string') {
    errors.push('Skill "instructions" must be a string');
  }

  // Capabilities must be an array
  if (skill.capabilities !== undefined && !Array.isArray(skill.capabilities)) {
    errors.push('Skill "capabilities" must be an array');
  }

  return { valid: errors.length === 0, errors };
}

// ── Skill Factory ─────────────────────────────────────────

/**
 * Create a new Skill with defaults.
 */
function createSkill(definition) {
  const validation = validateSkill(definition);
  if (!validation.valid) {
    throw new Error(`Invalid Skill: ${validation.errors.join('; ')}`);
  }

  return {
    id: definition.id,
    name: definition.name,
    description: definition.description,
    version: definition.version,
    tools: Array.isArray(definition.tools) ? definition.tools : [],
    capabilities: Array.isArray(definition.capabilities) ? definition.capabilities : [],
    instructions: definition.instructions || '',
    verification: Array.isArray(definition.verification) ? definition.verification : [],
    status: SKILL_STATUS.REGISTERED,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    runCount: 0,
    lastRunAt: null,
  };
}

// ── Lifecycle ─────────────────────────────────────────────

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

// ── Instruction Layer ─────────────────────────────────────

/**
 * Build skill instruction context block.
 * Priority: System > Runtime Policy > Skill Instruction > User Request
 */
function buildSkillInstructionContext(skill) {
  if (!skill || !skill.instructions) return '';

  return `[Skill: ${skill.name} v${skill.version}]\n${skill.instructions}\n[End Skill Instruction]`;
}

/**
 * Check if a tool is allowed for this skill.
 * Skills can only use tools listed in their "tools" array,
 * or the default tool set if "tools" is empty.
 */
function isToolAllowedForSkill(skill, toolName, availableTools) {
  if (!skill) return false;
  // If skill has no tools list, no tools are allowed (explicit deny)
  if (!skill.tools || skill.tools.length === 0) return false;
  // Check against available tools
  return skill.tools.includes(toolName) && availableTools.includes(toolName);
}

// ── Serialization ─────────────────────────────────────────

function serializeSkill(skill) {
  if (!skill) return null;
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    version: skill.version,
    tools: skill.tools,
    capabilities: skill.capabilities,
    instructions: skill.instructions,
    verification: skill.verification,
    status: skill.status,
    createdAt: skill.createdAt,
    updatedAt: skill.updatedAt,
    runCount: skill.runCount,
    lastRunAt: skill.lastRunAt,
  };
}

function deserializeSkill(data) {
  if (!data) return null;
  const skill = createSkill(data);
  skill.status = data.status || SKILL_STATUS.REGISTERED;
  skill.createdAt = data.createdAt || Date.now();
  skill.updatedAt = data.updatedAt || Date.now();
  skill.runCount = data.runCount || 0;
  skill.lastRunAt = data.lastRunAt || null;
  return skill;
}

// ── Exports ───────────────────────────────────────────────

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

    // Check that all tools referenced exist in availableTools
    if (definition.tools && definition.tools.length > 0) {
      const missingTools = definition.tools.filter(t => !this.availableTools.includes(t));
      if (missingTools.length > 0) {
        throw new Error(`Skill references unknown tools: ${missingTools.join(', ')}`);
      }
    }

    // Check for duplicate id
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

// ── Skill ↔ Plan Binding ──────────────────────────────────

/**
 * Attach a skill to a plan.
 * The plan references the skill but execution still goes through Tool Runtime.
 */
function bindSkillToPlan(plan, skill) {
  if (!plan) throw new Error('Plan is required');
  if (!skill) throw new Error('Skill is required');

  if (!plan.skills) plan.skills = [];
  // Avoid duplicate binding
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
 * Priority: System > Runtime Policy > Skill Instruction > User Request
 */
function buildSkillContextForLLM(skill, baseContext = '') {
  if (!skill) return baseContext;

  const skillBlock = buildSkillInstructionContext(skill);
  if (!skillBlock) return baseContext;

  // Skill instruction goes AFTER system/runtime context, BEFORE user request
  return `${baseContext}\n\n${skillBlock}`;
}

/**
 * Verify that a tool call is allowed for a skill.
 * Skills must not bypass the Tool Runtime.
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
  SKILL_STATUS,
  SKILL_TRANSITIONS,
  SKILL_INSTRUCTION_PRIORITY,
  validateSkill,
  createSkill,
  transitionSkillStatus,
  buildSkillInstructionContext,
  isToolAllowedForSkill,
  serializeSkill,
  deserializeSkill,
  SkillRegistry,
  bindSkillToPlan,
  bindSkillToStep,
  getPlanSkill,
  buildSkillContextForLLM,
  assertSkillToolAllowed,
};