/**
 * tools/skill.js — Skill Activation Tool
 *
 * V1.6.0: Internal tool for model-driven skill activation.
 * Provides `activate_skill({ name })` which loads the SKILL.md body
 * and resource manifest on demand (Progressive Disclosure Level 2/3).
 */

import { SkillResourceService } from '../agent/skill/resource-service.js';

// ── Tool Definition ─────────────────────────────────────────

const TOOL_DEFS = {
  activate_skill: {
    name: 'activate_skill',
    description:
      'Activate a discovered Skill by name. Returns the Skill instructions, ' +
      'resource manifest, and compatibility info. The Skill body is only loaded ' +
      'after this call (Progressive Disclosure). Use the Skill name exactly as ' +
      'shown in the Available Skills catalog.',
    input_schema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Skill name (exact match from catalog)',
        },
      },
      required: ['name'],
    },
  },
};

// ── Skill Tool Executor ─────────────────────────────────────

class SkillTools {
  constructor(catalog, options = {}) {
    this.catalog = catalog;
    this.resourceService = options.resourceService || null;
    this.activatedSkills = new Map(); // name → { descriptor, activatedAt }
  }

  /**
   * Activate a skill by name.
   * Loads SKILL.md body and returns metadata + instructions + resource manifest.
   */
  activateSkill(input) {
    const { name } = input;
    if (!name) throw new Error('activate_skill 缺少 name 参数');

    const descriptor = this.catalog.getByName(name);
    if (!descriptor) {
      return {
        error: `Skill "${name}" not found in catalog`,
        availableSkills: this.catalog.list().map(s => s.name),
      };
    }

    if (!descriptor.invocation.explicitAllowed) {
      return {
        error: `Skill "${name}" does not allow explicit invocation`,
      };
    }

    // Mark as activated
    this.activatedSkills.set(name, {
      descriptor,
      activatedAt: Date.now(),
    });

    return {
      name: descriptor.name,
      description: descriptor.description,
      source: `${descriptor.scope}/${descriptor.scopePrefix}`,
      format: descriptor.sourceFormat,
      compatibility: descriptor.compatibilityStatus,
      warnings: descriptor.compatibilityWarnings,
      instructions: descriptor.instructions,
      resources: descriptor.resources,
      toolPolicy: descriptor.toolPolicy,
      invocation: descriptor.invocation,
    };
  }

  /**
   * Check if a skill is activated.
   */
  isActivated(name) {
    return this.activatedSkills.has(name);
  }

  /**
   * Get list of activated skills.
   */
  listActivated() {
    return Array.from(this.activatedSkills.entries()).map(([name, data]) => ({
      name,
      activatedAt: data.activatedAt,
      compatibility: data.descriptor.compatibilityStatus,
    }));
  }

  /**
   * Read a reference file from an activated skill.
   */
  readReference(skillName, relativePath) {
    const data = this.activatedSkills.get(skillName);
    if (!data) {
      return { error: `Skill "${skillName}" is not activated` };
    }

    if (!this.resourceService) {
      return { error: 'ResourceService not available' };
    }

    const svc = new SkillResourceService({ skillRoot: data.descriptor.skillRoot });
    return svc.readReference(relativePath);
  }
}

// ── $skill-name Parser ──────────────────────────────────────

/**
 * Parse explicit invocation from user input.
 * Format: $skill-name [args...]
 * Returns { skillName, args } or null if not a skill invocation.
 */
function parseExplicitInvocation(input, catalog) {
  if (!input || typeof input !== 'string') return null;

  const match = input.match(/^\$([a-zA-Z][a-zA-Z0-9_-]*)\s*(.*)$/);
  if (!match) return null;

  const skillName = match[1];
  const args = match[2].trim();

  // Verify the skill exists
  if (!catalog.has(skillName)) return null;

  return { skillName, args };
}

// ── Exports ─────────────────────────────────────────────────

export {
  SkillTools,
  TOOL_DEFS,
  parseExplicitInvocation,
};