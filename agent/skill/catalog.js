/**
 * agent/skill/catalog.js — External Skill Catalog
 *
 * V1.6.0: Manages discovered external SKILL.md skills.
 * Catalog ≠ Registry — no lifecycle states, no Plan Binding.
 *
 * Responsibilities:
 *   discover, normalize, deduplicate, resolve precedence,
 *   list, enable/disable, lookup, compatibility metadata
 *
 * NOT responsible for:
 *   REGISTERED/RUNNING/VERIFYING/COMPLETED lifecycle
 *   Plan Binding
 *   SkillRuntime execution
 */

import os from 'os';
import { discoverSkills, resolvePrecedence } from './discovery.js';
import { COMPATIBILITY_STATUS } from './compatibility.js';

// ── SkillCatalog ────────────────────────────────────────────

class SkillCatalog {
  constructor(options = {}) {
    this.workspaceRoot = options.workspaceRoot || process.cwd();
    this.userHome = options.userHome || os.homedir();
    this.includeUser = options.includeUser || false;
    this.skills = new Map(); // internalId → descriptor
    this.shadowed = [];
    this.enabled = new Set(); // internalIds that are enabled
    this.lastScanAt = null;
    this.scanErrors = [];
    this.truncated = false;
  }

  /**
   * Scan filesystem for external skills.
   * Populates the catalog with normalized descriptors.
   */
  scan() {
    const result = discoverSkills({
      workspaceRoot: this.workspaceRoot,
      userHome: this.userHome,
      includeUser: this.includeUser,
    });

    this.scanErrors = result.errors;
    this.truncated = result.truncated;
    this.lastScanAt = Date.now();

    // Resolve duplicates
    const resolved = resolvePrecedence(result.allSkills);
    this.shadowed = resolved.shadowed;

    // Index by internalId
    this.skills.clear();
    this.enabled.clear();
    for (const skill of resolved.winners) {
      this.skills.set(skill.internalId, skill);
      if (skill.enabled !== false) {
        this.enabled.add(skill.internalId);
      }
    }

    return this.list();
  }

  /**
   * List all catalog skills (metadata only, no body).
   * Returns array of lightweight descriptors for Level 1 disclosure.
   */
  list() {
    const result = [];
    for (const [id, skill] of this.skills) {
      result.push({
        internalId: id,
        name: skill.name,
        description: skill.description,
        scope: skill.scope,
        source: skill.scopePrefix,
        sourceFormat: skill.sourceFormat,
        compatibilityStatus: skill.compatibilityStatus,
        compatibilityWarnings: skill.compatibilityWarnings,
        implicitAllowed: skill.invocation.implicitAllowed,
        explicitAllowed: skill.invocation.explicitAllowed,
        toolPolicy: skill.toolPolicy,
        enabled: this.enabled.has(id),
        resources: {
          scripts: skill.resources.scripts.length,
          references: skill.resources.references.length,
          assets: skill.resources.assets.length,
        },
      });
    }
    return result;
  }

  /**
   * Get full descriptor by name (for activation).
   */
  getByName(name) {
    for (const [id, skill] of this.skills) {
      if (skill.name === name) {
        return skill;
      }
    }
    return null;
  }

  /**
   * Get full descriptor by internalId.
   */
  get(internalId) {
    return this.skills.get(internalId) || null;
  }

  /**
   * Get catalog metadata for ContextBuilder Level 1.
   * Returns compact list ≤ budget chars.
   */
  getCatalogMetadata(maxChars = 8000) {
    const items = this.list();
    const lines = [];
    let chars = 0;

    lines.push('## Available Skills');
    lines.push('');
    chars += '## Available Skills\n'.length;

    for (const item of items) {
      const line = `- **${item.name}** (${item.compatibilityStatus}): ${item.description} [${item.scope}/${item.source}]`;
      if (chars + line.length > maxChars) {
        lines.push(`... and ${items.length - lines.length + 1} more (truncated)`);
        this.truncated = true;
        break;
      }
      lines.push(line);
      chars += line.length + 1;
    }

    return lines.join('\n');
  }

  /**
   * Enable a skill by name or internalId.
   */
  enable(identifier) {
    const skill = this._resolve(identifier);
    if (skill) {
      this.enabled.add(skill.internalId);
      return true;
    }
    return false;
  }

  /**
   * Disable a skill by name or internalId.
   */
  disable(identifier) {
    const skill = this._resolve(identifier);
    if (skill) {
      this.enabled.delete(skill.internalId);
      return true;
    }
    return false;
  }

  /**
   * Check if a skill name exists in catalog.
   */
  has(name) {
    const skill = this.getByName(name);
    return skill !== null && this.enabled.has(skill.internalId);
  }

  /**
   * Get count of enabled skills.
   */
  count() {
    return this.enabled.size;
  }

  /**
   * Get shadowed skills (for UI transparency).
   */
  getShadowed() {
    return this.shadowed;
  }

  /**
   * Get scan errors.
   */
  getErrors() {
    return this.scanErrors;
  }

  // ── Internal ──

  _resolve(identifier) {
    // Try internalId first
    if (this.skills.has(identifier)) {
      return this.skills.get(identifier);
    }
    // Try name
    return this.getByName(identifier);
  }
}

// ── Exports ─────────────────────────────────────────────────

export { SkillCatalog, COMPATIBILITY_STATUS };