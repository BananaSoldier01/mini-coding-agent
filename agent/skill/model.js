/**
 * agent/skill/model.js — Skill Object Model
 *
 * V0.8.2
 * - Skill Schema Validation
 * - Skill Factory (createSkill)
 * - Serialization (serializeSkill / deserializeSkill)
 * - Instruction Layer
 * - Tool Permission Check
 */

import { SKILL_STATUS, SKILL_TRANSITIONS } from './lifecycle.js';

// ── Skill Instruction Priority ────────────────────────────
// Higher number = higher priority
// V1.6.0-baseline: USER_EXPLICIT promoted above SKILL_INSTRUCTION.
// Previously SKILL_INSTRUCTION (60) > USER_REQUEST (40), meaning skill
// instructions could override explicit user requests. This is now fixed.
// Final order: System > Runtime Policy > User Explicit > Skill > Default
const SKILL_INSTRUCTION_PRIORITY = {
  SYSTEM: 100,
  RUNTIME_POLICY: 80,
  USER_EXPLICIT: 70,
  SKILL_INSTRUCTION: 60,
  DEFAULT_HEURISTIC: 40,
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

  if (skill.instructions !== undefined && typeof skill.instructions !== 'string') {
    errors.push('Skill "instructions" must be a string');
  }

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
 * Skills can only use tools listed in their "tools" array.
 */
function isToolAllowedForSkill(skill, toolName, availableTools) {
  if (!skill) return false;
  if (!skill.tools || skill.tools.length === 0) return false;
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

// ── Instruction Provenance ────────────────────────────────

/**
 * V0.7.2: Build instruction context with provenance tracking.
 * Returns an array of typed instruction blocks, NOT a flat string.
 * The final prompt string is built by the caller from these blocks.
 */
function buildInstructionProvenance(skill, baseBlocks = []) {
  const blocks = [...baseBlocks];

  if (skill && skill.instructions) {
    blocks.push({
      source: 'skill',
      skillId: skill.id,
      skillName: skill.name,
      priority: SKILL_INSTRUCTION_PRIORITY.SKILL_INSTRUCTION,
      timestamp: Date.now(),
      content: skill.instructions,
    });
  }

  return blocks;
}

/**
 * V0.7.2: Sort instruction blocks by priority (highest first).
 */
function sortInstructionsByPriority(blocks) {
  return [...blocks].sort((a, b) => (b.priority || 0) - (a.priority || 0));
}

/**
 * V0.7.2: Render instruction blocks to final prompt string.
 */
function renderInstructionsToPrompt(blocks) {
  const sorted = sortInstructionsByPriority(blocks);
  return sorted.map(b => {
    if (b.source === 'skill') {
      return `[Skill: ${b.skillName} v${b.skillId}]\n${b.content}\n[End Skill: ${b.skillName}]`;
    }
    return b.content;
  }).join('\n\n');
}

export {
  SKILL_INSTRUCTION_PRIORITY,
  validateSkill,
  createSkill,
  buildSkillInstructionContext,
  isToolAllowedForSkill,
  serializeSkill,
  deserializeSkill,
  buildInstructionProvenance,
  sortInstructionsByPriority,
  renderInstructionsToPrompt,
};