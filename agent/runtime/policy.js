/**
 * agent/runtime/policy.js — Runtime Policy Context
 *
 * V0.8.3 (Pre-V0.9 Cleanup)
 * V0.9.0.1: skillId instead of skill object for clean serialization
 *
 * Design:
 *   Permission is currently bound to Skill only.
 *   This adds the missing Execution Context layer:
 *
 *   Run → RuntimePolicyContext → Skill → Tool Call → Environment
 *
 *   This allows expressing:
 *   - Same skill, different environment → different allowed tools
 *   - Workspace-level restrictions
 *   - User-level permissions
 *   - Time-based restrictions (future)
 */

/**
 * V0.8.3: RuntimePolicyContext — unified permission & execution context.
 *
 * This is NOT a full Policy Engine. It is a context carrier that:
 * 1. Holds the current execution environment
 * 2. Carries user/workspace/skill context
 * 3. Provides a single evaluate() entry point for tool permission checks
 *
 * Future V0.9 Policy Engine will build on this foundation.
 *
 * V0.9.0.1: Uses skillId instead of skill object for clean serialization.
 * Skill is resolved at runtime via registry, not stored in context.
 */
class RuntimePolicyContext {
  constructor(options = {}) {
    this.environment = options.environment || 'development';
    this.user = options.user || null;
    this.workspace = options.workspace || null;
    // V0.9.0.1: Store skillId, not skill object — clean serialization
    this.skillId = options.skillId || (options.skill ? options.skill.id : null);
    this.allowedTools = options.allowedTools || [];
    this.restrictions = options.restrictions || [];
    this.sessionId = options.sessionId || null;
    this.runId = options.runId || null;
    this.createdAt = Date.now();
  }

  /**
   * Check if a tool is allowed in this context.
   * Combines: skill permissions + environment restrictions + workspace rules.
   *
   * Priority (highest to lowest):
   *   1. Explicit restrictions (always deny)
   *   2. Environment restrictions
   *   3. Skill tool list (resolved via skillTools param)
   *   4. Allowed tools list
   *   5. Available tools
   *
   * @param {string} toolName - Tool to check
   * @param {string[]} availableTools - Tools available in this run
   * @param {string[]} [skillTools] - Tools allowed by the active skill (resolved externally)
   */
  isToolAllowed(toolName, availableTools, skillTools) {
    // 1. Explicit restrictions always deny
    for (const r of this.restrictions) {
      if (r.type === 'deny' && r.tools.includes(toolName)) {
        return false;
      }
    }

    // 2. Environment restrictions
    const envRestrictions = this.restrictions.filter(r => r.environment === this.environment);
    for (const r of envRestrictions) {
      if (r.type === 'deny' && r.tools.includes(toolName)) {
        return false;
      }
      if (r.type === 'allow' && !r.tools.includes(toolName)) {
        return false;
      }
    }

    // 3. Skill-based check (if skillTools provided)
    if (skillTools && skillTools.length > 0 && !skillTools.includes(toolName)) {
      return false;
    }

    // 4. Allowed tools check
    if (this.allowedTools.length > 0 && !this.allowedTools.includes(toolName)) {
      return false;
    }

    // 5. Available tools check (empty array = no restriction)
    if (availableTools && availableTools.length > 0 && !availableTools.includes(toolName)) {
      return false;
    }

    return true;
  }

  /**
   * Add a restriction.
   */
  addRestriction(restriction) {
    this.restrictions.push({
      ...restriction,
      id: `restrict_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      createdAt: Date.now(),
    });
  }

  /**
   * V0.9.0.1: Create a child context for a specific skill.
   * Uses skillId (not skill object) for clean serialization.
   */
  forSkill(skill) {
    return new RuntimePolicyContext({
      ...this,
      skillId: skill.id,
      restrictions: [...this.restrictions],
    });
  }

  /**
   * Serialize for persistence.
   * V0.9.0.1: skillId only — no skill object.
   */
  serialize() {
    return {
      environment: this.environment,
      user: this.user,
      workspace: this.workspace,
      skillId: this.skillId,
      allowedTools: this.allowedTools,
      restrictions: this.restrictions,
      sessionId: this.sessionId,
      runId: this.runId,
      createdAt: this.createdAt,
    };
  }

  /**
   * Deserialize from persistence.
   * V0.9.0.1: skillId only — resolve via registry at runtime.
   */
  static deserialize(data) {
    if (!data) return new RuntimePolicyContext();
    return new RuntimePolicyContext({
      environment: data.environment,
      user: data.user,
      workspace: data.workspace,
      skillId: data.skillId,
      allowedTools: data.allowedTools,
      restrictions: data.restrictions,
      sessionId: data.sessionId,
      runId: data.runId,
    });
  }
}

/**
 * V0.8.3: Pre-defined restriction presets.
 */
const POLICY_PRESETS = {
  development: {
    environment: 'development',
    restrictions: [
      { type: 'allow', tools: ['run_shell', 'read_file', 'write_file', 'list_dir', 'git_*'] },
    ],
  },
  production: {
    environment: 'production',
    restrictions: [
      { type: 'deny', tools: ['run_shell', 'write_file'] },
      { type: 'allow', tools: ['read_file', 'list_dir', 'git_status'] },
    ],
  },
  readonly: {
    environment: 'any',
    restrictions: [
      { type: 'deny', tools: ['run_shell', 'write_file', 'delete_file'] },
    ],
  },
};

/**
 * V0.8.3: Create a RuntimePolicyContext from a preset.
 */
function createPolicyContext(presetName, overrides = {}) {
  const preset = POLICY_PRESETS[presetName] || POLICY_PRESETS.development;
  return new RuntimePolicyContext({
    ...preset,
    ...overrides,
  });
}

export {
  RuntimePolicyContext,
  POLICY_PRESETS,
  createPolicyContext,
};