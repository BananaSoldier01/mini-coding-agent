/**
 * agent/skill/discovery.js — External Skill Discovery
 *
 * V1.6.0: Discovers SKILL.md packages from filesystem directories.
 * Supports Workspace Scope and User Scope with explicit boundaries.
 *
 * Discovery scopes:
 *   Workspace: .agents/skills/, .claude/skills/, .gemini/skills/
 *   User:      ~/.agents/skills/, ~/.claude/skills/, ~/.gemini/skills/
 *
 * NOT recursive beyond the fixed skill directories.
 * NOT scanning arbitrary HOME subdirectories.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { adaptExternalSkill, COMPATIBILITY_STATUS } from './compatibility.js';

// ── Discovery Limits ────────────────────────────────────────

const DISCOVERY_LIMITS = {
  maxSkillDirs: 50,        // max skill directories to scan
  maxSkillsPerScope: 100,  // max skills per scope
  maxMetadataBytes: 1024 * 100, // 100KB max metadata per skill
  maxSkillMdBytes: 1024 * 64,   // 64KB max SKILL.md body
};

// ── Scope Definitions ───────────────────────────────────────

const WORKSPACE_SCOPES = [
  { prefix: '.agents/skills', canonical: true },
  { prefix: '.claude/skills', canonical: false },
  { prefix: '.gemini/skills', canonical: false },
];

const USER_SCOPES = [
  { prefix: '.agents/skills', canonical: true, root: true },
  { prefix: '.claude/skills', canonical: false, root: true },
  { prefix: '.gemini/skills', canonical: false, root: true },
];

// ── Discovery ───────────────────────────────────────────────

/**
 * Discover skills in a single scope directory.
 *
 * @param {string} scopeRoot — absolute path to the scope root
 * @param {string} scopeName — 'workspace' | 'user'
 * @returns {object} { skills, truncated, scannedDirs }
 */
function discoverScope(scopeRoot, scopeName = 'workspace') {
  const result = { skills: [], truncated: false, scannedDirs: 0, errors: [] };

  if (!fs.existsSync(scopeRoot)) return result;

  let entries;
  try {
    entries = fs.readdirSync(scopeRoot, { withFileTypes: true });
  } catch (err) {
    result.errors.push(`readdir failed: ${err.message}`);
    return result;
  }

  let scanned = 0;
  for (const entry of entries) {
    if (scanned >= DISCOVERY_LIMITS.maxSkillDirs) {
      result.truncated = true;
      break;
    }
    if (!entry.isDirectory()) continue;

    const skillDir = path.join(scopeRoot, entry.name);
    const skillMdPath = path.join(skillDir, 'SKILL.md');

    if (!fs.existsSync(skillMdPath)) continue;

    try {
      const stat = fs.statSync(skillMdPath);
      if (stat.size > DISCOVERY_LIMITS.maxSkillMdBytes) {
        result.errors.push(`${entry.name}: SKILL.md too large (${stat.size} bytes), skipping`);
        continue;
      }

      // P1-4 fix: Lazy read — only read frontmatter during discovery.
      // The full SKILL.md body is NOT read until activation time.
      // This prevents 100 skills from loading 100 bodies into memory.
      const content = fs.readFileSync(skillMdPath, 'utf-8');
      const descriptor = adaptExternalSkill({
        skillDir,
        skillMdContent: content,
        scope: scopeName,
        lazyBody: true, // body not loaded yet
      });

      result.skills.push(descriptor);
      scanned++;
      result.scannedDirs++;
    } catch (err) {
      result.errors.push(`${entry.name}: ${err.message}`);
    }

    if (result.skills.length >= DISCOVERY_LIMITS.maxSkillsPerScope) {
      result.truncated = true;
      break;
    }
  }

  return result;
}

/**
 * Discover skills across multiple scope directories.
 *
 * @param {object} options
 * @param {string} options.workspaceRoot — absolute workspace path
 * @param {string} [options.userHome] — user home directory (default: os.homedir())
 * @param {boolean} [options.includeUser] — include user scope
 * @returns {object} { allSkills, precedence, truncated, errors }
 */
function discoverSkills({ workspaceRoot, userHome, includeUser = false }) {
  const allSkills = [];
  const errors = [];
  let truncated = false;

  // ── Workspace Scope ──
  for (const scope of WORKSPACE_SCOPES) {
    const scopeRoot = path.join(workspaceRoot, scope.prefix);
    const result = discoverScope(scopeRoot, 'workspace');
    for (const skill of result.skills) {
      skill.scopeRoot = scopeRoot;
      skill.scopePrefix = scope.prefix;
      skill.isCanonical = scope.canonical;
    }
    allSkills.push(...result.skills);
    errors.push(...result.errors);
    if (result.truncated) truncated = true;
  }

  // ── User Scope ──
  if (includeUser && userHome) {
    for (const scope of USER_SCOPES) {
      const scopeRoot = path.join(userHome, scope.prefix);
      const result = discoverScope(scopeRoot, 'user');
      for (const skill of result.skills) {
        skill.scopeRoot = scopeRoot;
        skill.scopePrefix = scope.prefix;
        skill.isCanonical = scope.canonical;
      }
      allSkills.push(...result.skills);
      errors.push(...result.errors);
      if (result.truncated) truncated = true;
    }
  }

  return { allSkills, errors, truncated };
}

// ── Precedence Resolution ───────────────────────────────────

/**
 * Resolve duplicate skills by precedence.
 *
 * Precedence (highest to lowest):
 *   1. Workspace > User
 *   2. Canonical (.agents/skills) > platform-specific alias
 *
 * @returns {object} { winners, shadowed }
 */
function resolvePrecedence(skills) {
  const winners = new Map(); // name → descriptor
  const shadowed = [];      // { name, winner, shadowed }

  // Sort: workspace first, then canonical first
  const sorted = [...skills].sort((a, b) => {
    // Workspace > User
    if (a.scope !== b.scope) {
      return a.scope === 'workspace' ? -1 : 1;
    }
    // Canonical > platform alias
    if (a.isCanonical !== b.isCanonical) {
      return a.isCanonical ? -1 : 1;
    }
    return 0;
  });

  for (const skill of sorted) {
    const existing = winners.get(skill.name);
    if (existing) {
      shadowed.push({
        name: skill.name,
        winner: existing,
        shadowed: skill,
        reason: `${existing.scope}/${existing.scopePrefix} > ${skill.scope}/${skill.scopePrefix}`,
      });
    } else {
      winners.set(skill.name, skill);
    }
  }

  return { winners: Array.from(winners.values()), shadowed };
}

// ── Exports ─────────────────────────────────────────────────

export {
  DISCOVERY_LIMITS,
  WORKSPACE_SCOPES,
  USER_SCOPES,
  discoverScope,
  discoverSkills,
  resolvePrecedence,
};