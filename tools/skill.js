/**
 * tools/skill.js — Skill Activation Tool
 *
 * V1.6.0: Internal tool for model-driven skill activation.
 * Provides `activate_skill({ name })` which loads the SKILL.md body
 * and resource manifest on demand (Progressive Disclosure Level 2/3).
 *
 * P1-1 fix: toolPolicy from external skills is enforced at execution gate.
 * P1-2 fix: implicitAllowed/explicitAllowed checked with invocation context.
 * P1-3 fix: activation triggers ContextBuilder re-injection.
 * P1-5 fix: read_skill_reference / read_skill_asset / request_skill_script tools.
 */

import { SkillResourceService } from '../agent/skill/resource-service.js';
import { loadSkillBody } from '../agent/skill/compatibility.js';

// ── Invocation Context ──────────────────────────────────────

const INVOCATION_CONTEXT = {
  EXPLICIT_USER: 'explicit_user',     // $skill-name from user input
  EXPLICIT_MODEL: 'explicit_model',   // activate_skill tool call
  IMPLICIT_MODEL: 'implicit_model',   // model noticed skill in catalog
};

// ── Tool Definitions ────────────────────────────────────────

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
  read_skill_reference: {
    name: 'read_skill_reference',
    description:
      'Read a reference file from an activated Skill. ' +
      'Only accessible after activate_skill. Path is relative to the Skill root.',
    input_schema: {
      type: 'object',
      properties: {
        skill: { type: 'string', description: 'Skill name' },
        path: { type: 'string', description: 'Relative path within skill (e.g. references/guide.md)' },
      },
      required: ['skill', 'path'],
    },
  },
  read_skill_asset: {
    name: 'read_skill_asset',
    description:
      'Read an asset file from an activated Skill. ' +
      'Only accessible after activate_skill. Returns base64-encoded content.',
    input_schema: {
      type: 'object',
      properties: {
        skill: { type: 'string', description: 'Skill name' },
        path: { type: 'string', description: 'Relative path within skill (e.g. assets/icon.png)' },
      },
      required: ['skill', 'path'],
    },
  },
  request_skill_script: {
    name: 'request_skill_script',
    description:
      'Request execution of a script from an activated Skill. ' +
      'Script execution requires user approval (User Scope scripts are NOT auto-executed).',
    input_schema: {
      type: 'object',
      properties: {
        skill: { type: 'string', description: 'Skill name' },
        script: { type: 'string', description: 'Script name from skill manifest' },
        args: { type: 'string', description: 'Optional arguments' },
      },
      required: ['skill', 'script'],
    },
  },
};

// ── Skill Tool Executor ─────────────────────────────────────

class SkillTools {
  constructor(catalog, options = {}) {
    this.catalog = catalog;
    this.resourceService = options.resourceService || null;
    this.activatedSkills = new Map(); // name → { descriptor, activatedAt, invocationContext }
    this.totalLoadedBytes = 0;
    this.maxTotalBytes = options.maxTotalBytes || (1024 * 1024 * 5); // 5MB
  }

  /**
   * Activate a skill by name.
   * P1-2 fix: checks implicitAllowed/explicitAllowed based on invocation context.
   */
  activateSkill(input, invocationContext = INVOCATION_CONTEXT.EXPLICIT_MODEL) {
    const { name } = input;
    if (!name) throw new Error('activate_skill 缺少 name 参数');

    const descriptor = this.catalog.getByName(name);
    if (!descriptor) {
      return {
        error: `Skill "${name}" not found in catalog`,
        availableSkills: this.catalog.list().map(s => s.name),
      };
    }

    // P1-2 fix: check invocation policy
    if (invocationContext === INVOCATION_CONTEXT.IMPLICIT_MODEL) {
      if (!descriptor.invocation.implicitAllowed) {
        return {
          error: `Skill "${name}" does not allow implicit invocation (disable-model-invocation: true)`,
          name,
        };
      }
      if (descriptor.compatibilityStatus === 'unsupported') {
        return {
          error: `Skill "${name}" is unsupported (${descriptor.compatibilityStatus})`,
          name,
        };
      }
    }

    if (invocationContext === INVOCATION_CONTEXT.EXPLICIT_USER ||
        invocationContext === INVOCATION_CONTEXT.EXPLICIT_MODEL) {
      if (!descriptor.invocation.explicitAllowed) {
        return {
          error: `Skill "${name}" does not allow explicit invocation (user-invocable: false)`,
          name,
        };
      }
    }

    // P1-4 fix: lazy-read SKILL.md body at activation time.
    // During discovery, only frontmatter (metadata) was read.
    // The full body is loaded NOW at activation (Progressive Disclosure Level 2).
    let instructions = descriptor.instructions || '';
    if (!instructions && descriptor.skillRoot) {
      instructions = loadSkillBody(descriptor.skillRoot);
    }

    // Mark as activated
    this.activatedSkills.set(name, {
      descriptor,
      activatedAt: Date.now(),
      invocationContext,
    });

    return {
      name: descriptor.name,
      description: descriptor.description,
      source: `${descriptor.scope}/${descriptor.scopePrefix}`,
      format: descriptor.sourceFormat,
      compatibility: descriptor.compatibilityStatus,
      warnings: descriptor.compatibilityWarnings,
      instructions,
      resources: descriptor.resources,
      toolPolicy: descriptor.toolPolicy,
      invocation: descriptor.invocation,
    };
  }

  /**
   * P1-1 fix: check if a tool is allowed for an activated skill.
   * Returns { allowed: true } or { allowed: false, reason }
   */
  checkToolPolicy(skillName, toolName) {
    const data = this.activatedSkills.get(skillName);
    if (!data) {
      // Not activated — no skill-specific policy applies, inherit base
      return { allowed: true, policy: 'inherit' };
    }

    const { toolPolicy } = data.descriptor;

    if (!toolPolicy || toolPolicy.mode === 'inherit') {
      return { allowed: true, policy: 'inherit' };
    }

    if (toolPolicy.mode === 'allowlist') {
      if (toolPolicy.tools.includes(toolName)) {
        return { allowed: true, policy: 'allowlist-match' };
      }
      return {
        allowed: false,
        reason: `Tool "${toolName}" not in skill "${skillName}" allowed-tools: [${toolPolicy.tools.join(', ')}]`,
        policy: 'allowlist-deny',
      };
    }

    return { allowed: true, policy: 'inherit' };
  }

  /**
   * Check if any activated skill restricts this tool.
   * Returns the most restrictive policy across all activated skills.
   */
  checkToolPolicyAll(toolName) {
    const results = [];
    for (const [name] of this.activatedSkills) {
      const result = this.checkToolPolicy(name, toolName);
      if (!result.allowed) {
        results.push({ skill: name, ...result });
      }
    }
    return results;
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
      invocationContext: data.invocationContext,
    }));
  }

  /**
   * P1-5 fix: read a reference file from an activated skill.
   */
  readReference(input) {
    const { skill, path: relPath } = input;
    const data = this.activatedSkills.get(skill);
    if (!data) {
      return { error: `Skill "${skill}" is not activated` };
    }

    const svc = new SkillResourceService({
      skillRoot: data.descriptor.skillRoot,
      maxTotalBytes: this.maxTotalBytes,
    });

    // Check budget
    if (this.totalLoadedBytes >= this.maxTotalBytes) {
      return { error: 'Resource budget exhausted', loaded: this.totalLoadedBytes, max: this.maxTotalBytes };
    }

    const result = svc.readReference(relPath);
    if (!result.error) {
      this.totalLoadedBytes += result.size;
    }
    return result;
  }

  /**
   * P1-5 fix: read an asset file from an activated skill.
   */
  readAsset(input) {
    const { skill, path: relPath } = input;
    const data = this.activatedSkills.get(skill);
    if (!data) {
      return { error: `Skill "${skill}" is not activated` };
    }

    const svc = new SkillResourceService({
      skillRoot: data.descriptor.skillRoot,
      maxTotalBytes: this.maxTotalBytes,
    });

    if (this.totalLoadedBytes >= this.maxTotalBytes) {
      return { error: 'Resource budget exhausted', loaded: this.totalLoadedBytes, max: this.maxTotalBytes };
    }

    const result = svc.readAsset(relPath);
    if (!result.error) {
      this.totalLoadedBytes += result.size;
    }
    return result;
  }

  /**
   * P1-5 fix: request script execution (requires approval).
   * User Scope scripts are NOT auto-executed.
   */
  requestScript(input) {
    const { skill, script, args } = input;
    const data = this.activatedSkills.get(skill);
    if (!data) {
      return { error: `Skill "${skill}" is not activated` };
    }

    // Check if script exists
    const manifest = new SkillResourceService({
      skillRoot: data.descriptor.skillRoot,
    }).getScriptManifest();

    const entry = manifest.find(s => s.name === script);
    if (!entry) {
      return {
        error: `Script "${script}" not found in skill "${skill}" manifest`,
        available: manifest.map(s => s.name),
      };
    }

    // P1-5 fix: User Scope scripts require explicit approval
    const isUserScope = data.descriptor.scope === 'user';
    if (isUserScope) {
      return {
        pending: true,
        skill,
        script: entry.path,
        args: args || '',
        requiresApproval: true,
        reason: 'User Scope script execution requires explicit user approval (partial compatibility)',
        scope: 'user',
      };
    }

    return {
      pending: true,
      skill,
      script: entry.path,
      args: args || '',
      requiresApproval: true,
      reason: 'Skill script execution requires user approval',
      scope: data.descriptor.scope,
    };
  }
}

// ── $skill-name Parser ──────────────────────────────────────

/**
 * Parse explicit invocation from user input.
 * Format: $skill-name [args...]
 * Returns { skillName, args, invocationContext } or null.
 */
function parseExplicitInvocation(input, catalog) {
  if (!input || typeof input !== 'string') return null;

  const match = input.match(/^\$([a-zA-Z][a-zA-Z0-9_-]*)\s*(.*)$/);
  if (!match) return null;

  const skillName = match[1];
  const args = match[2].trim();

  // Verify the skill exists
  if (!catalog.has(skillName)) return null;

  return { skillName, args, invocationContext: INVOCATION_CONTEXT.EXPLICIT_USER };
}

// ── Exports ─────────────────────────────────────────────────

export {
  SkillTools,
  TOOL_DEFS,
  parseExplicitInvocation,
  INVOCATION_CONTEXT,
};