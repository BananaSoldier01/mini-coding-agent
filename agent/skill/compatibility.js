/**
 * agent/skill/compatibility.js — External Skill Compatibility Adapter
 *
 * V1.6.0: Normalizes external SKILL.md from multiple ecosystems
 * (Agent Skills common / Codex / Claude Code / Gemini) into a
 * single Normalized Skill Descriptor.
 *
 * Design:
 *   External SKILL.md + platform metadata
 *        ↓
 *   Platform Adapter (Claude / Codex / Gemini / Common)
 *        ↓
 *   Normalized Skill Descriptor
 *        ↓
 *   Existing SkillCatalog / ContextBuilder / SkillRuntime
 *
 * Principles:
 *   - Reuse > Extend > Adapt > Refactor
 *   - External Skill is an instruction package, NOT a Plan Step
 *   - Missing fields degrade gracefully, never throw
 *   - Platform-specific metadata maps to normalized fields;
 *     unsupported fields go to rawMetadata + compatibilityWarnings
 */

import fs from 'fs';
import path from 'path';

// ── Compatibility Status ────────────────────────────────────

const COMPATIBILITY_STATUS = {
  NATIVE: 'native',       // Common SKILL.md, full functionality
  COMPATIBLE: 'compatible', // Platform-specific, all semantics mappable
  PARTIAL: 'partial',     // Usable but with limitations
  UNSUPPORTED: 'unsupported', // Core semantics cannot safely run
};

// ── Tool Name Mapping (Claude → internal) ───────────────────

const CLAUDE_TOOL_MAP = {
  'Read': 'read_file',
  'Write': 'write_file',
  'Edit': 'edit_file',
  'Grep': 'search_files',
  'Glob': 'search_files',
  'Bash': 'run_command',
  'LS': 'list_directory',
  'Glob': 'search_files',
};

// ── Frontmatter Parser ──────────────────────────────────────

/**
 * Parse YAML frontmatter from SKILL.md content.
 * Simple parser — handles key: value pairs and array values.
 * Returns { frontmatter, body }.
 */
function parseFrontmatter(content) {
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!fmMatch) return { frontmatter: {}, body: content };

  const fmText = fmMatch[1];
  const body = fmMatch[2];
  const frontmatter = {};

  let currentKey = null;
  let currentArray = null;

  for (const line of fmText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Array item: "  - value"
    const arrMatch = trimmed.match(/^-\s+(.+)$/);
    if (arrMatch && currentArray) {
      currentArray.push(arrMatch[1].trim().replace(/^["']|["']$/g, ''));
      continue;
    }

    // Key: value
    const kvMatch = trimmed.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (kvMatch) {
      const key = kvMatch[1];
      let value = kvMatch[2].trim().replace(/^["']|["']$/g, '');

      // P1-2 fix: convert boolean strings to actual booleans
      // Claude's disable-model-invocation/user-invocable are YAML booleans
      if (value === 'true') value = true;
      if (value === 'false') value = false;

      // If value is a boolean, store directly (no array/empty checks needed)
      if (typeof value === 'boolean') {
        frontmatter[key] = value;
        currentArray = null;
      } else if (value === '' || value === '[]' || value === '{}') {
        // Might be start of array or empty
        currentArray = [];
        frontmatter[key] = currentArray;
      } else if (value.startsWith('[') && value.endsWith(']')) {
        // Inline array
        frontmatter[key] = value.slice(1, -1).split(',').map(s => s.trim().replace(/^["']|["']$/g, ''));
        currentArray = null;
      } else {
        frontmatter[key] = value;
        currentArray = null;
      }
    }
  }

  return { frontmatter, body };
}

// ── Normalized Descriptor Factory ────────────────────────────

/**
 * Create a Normalized Skill Descriptor from parsed components.
 */
function createDescriptor(options) {
  const {
    name, description, body, sourcePath, skillRoot,
    sourceFormat, scope, frontmatter, platformMeta,
    explicitAllowed = true, implicitAllowed = true,
    toolPolicy = { mode: 'inherit', tools: [] },
    compatibilityStatus = COMPATIBILITY_STATUS.NATIVE,
    compatibilityWarnings = [],
    rawMetadata = {},
  } = options;

  return {
    internalId: generateInternalId(sourcePath, name),
    name: name || path.basename(sourcePath),
    description: description || '',
    sourcePath,
    skillRoot,
    sourceFormat: sourceFormat || 'common',
    scope: scope || 'workspace',
    instructionsLoaded: false,
    instructions: body || '',
    resources: {
      scripts: [],
      references: [],
      assets: [],
    },
    invocation: {
      explicitAllowed,
      implicitAllowed,
    },
    toolPolicy,
    compatibilityStatus,
    compatibilityWarnings,
    rawMetadata: {
      ...rawMetadata,
      frontmatter,
      platform: platformMeta,
    },
    enabled: true,
    createdAt: Date.now(),
  };
}

function generateInternalId(sourcePath, name) {
  // Use name as primary key (unique after precedence resolution) + path suffix
  // to avoid collisions when paths share a long common prefix.
  const pathSuffix = sourcePath.split('/').slice(-2).join('/');
  const input = `${name}::${pathSuffix}`;
  const hash = Buffer.from(input).toString('base64').slice(0, 16);
  return `skill_${hash}`;
}

// ── Platform Adapters ───────────────────────────────────────

/**
 * Common Adapter — baseline for all platforms.
 * Extracts name, description, body from SKILL.md.
 */
function adaptCommon(frontmatter, body, sourcePath, skillRoot, scope) {
  const warnings = [];
  const name = frontmatter.name || path.basename(skillRoot);
  const description = frontmatter.description || '';

  if (!frontmatter.name) {
    warnings.push('Missing "name" in frontmatter; using directory name');
  }
  if (!frontmatter.description) {
    warnings.push('Missing "description" in frontmatter');
  }

  return createDescriptor({
    name, description, body,
    sourcePath, skillRoot,
    sourceFormat: 'common',
    scope,
    frontmatter,
    compatibilityStatus: COMPATIBILITY_STATUS.NATIVE,
    compatibilityWarnings: warnings,
    rawMetadata: { frontmatter },
  });
}

/**
 * Claude Code Adapter.
 * Maps: allowed-tools, user-invocable, disable-model-invocation, argument-hint
 */
function adaptClaude(frontmatter, body, sourcePath, skillRoot, scope) {
  const base = adaptCommon(frontmatter, body, sourcePath, skillRoot, scope);
  const warnings = [...base.compatibilityWarnings];
  const rawMeta = { ...base.rawMetadata, platform: 'claude' };

  // disable-model-invocation → implicitAllowed
  if (frontmatter['disable-model-invocation'] === true) {
    base.invocation.implicitAllowed = false;
    rawMeta.disableModelInvocation = true;
  }

  // user-invocable → explicitAllowed
  if (frontmatter['user-invocable'] === false) {
    base.invocation.explicitAllowed = false;
    rawMeta.userInvocable = false;
  }

  // argument-hint
  if (frontmatter['argument-hint']) {
    rawMeta.argumentHint = frontmatter['argument-hint'];
  }

  // allowed-tools → toolPolicy
  if (frontmatter['allowed-tools']) {
    const tools = Array.isArray(frontmatter['allowed-tools'])
      ? frontmatter['allowed-tools']
      : String(frontmatter['allowed-tools']).split(',').map(s => s.trim());

    const mappedTools = tools
      .map(t => CLAUDE_TOOL_MAP[t] || t.toLowerCase().replace('-', '_'))
      .filter(Boolean);

    base.toolPolicy = {
      mode: 'allowlist',
      tools: mappedTools,
      raw: tools,
    };
    rawMeta.allowedTools = tools;
  } else {
    base.toolPolicy = { mode: 'inherit', tools: [] };
  }

  // Unsupported Claude fields → rawMetadata + warnings
  const unsupportedFields = ['model', 'context', 'agent', 'hooks'];
  for (const field of unsupportedFields) {
    if (frontmatter[field] !== undefined) {
      rawMeta[field] = frontmatter[field];
      warnings.push(`Unsupported Claude field "${field}": stored in rawMetadata, not functional`);
    }
  }

  base.compatibilityStatus = warnings.some(w => w.includes('Unsupported'))
    ? COMPATIBILITY_STATUS.PARTIAL
    : COMPATIBILITY_STATUS.COMPATIBLE;
  base.compatibilityWarnings = warnings;
  base.rawMetadata = rawMeta;
  base.sourceFormat = 'claude';

  return base;
}

/**
 * Codex Adapter.
 * Reads agents/openai.yaml for policy.allow_implicit_invocation, dependencies.
 */
function adaptCodex(frontmatter, body, sourcePath, skillRoot, scope, openaiYaml) {
  const base = adaptCommon(frontmatter, body, sourcePath, skillRoot, scope);
  const warnings = [...base.compatibilityWarnings];
  const rawMeta = { ...base.rawMetadata, platform: 'codex' };

  if (openaiYaml) {
    rawMeta.openaiYaml = openaiYaml;

    // policy.allow_implicit_invocation
    const policy = openaiYaml.policy || {};
    if (policy.allow_implicit_invocation === false) {
      base.invocation.implicitAllowed = false;
    }

    // dependencies (declaration only, not auto-installed)
    if (openaiYaml.dependencies) {
      rawMeta.dependencies = openaiYaml.dependencies;
      warnings.push('External dependencies declared but NOT auto-installed (V1.6.0 policy)');
      base.compatibilityStatus = COMPATIBILITY_STATUS.PARTIAL;
    }

    // interface metadata
    if (openaiYaml.interface) {
      rawMeta.interface = openaiYaml.interface;
    }
  }

  base.compatibilityWarnings = warnings;
  base.rawMetadata = rawMeta;
  base.sourceFormat = 'codex';

  return base;
}

/**
 * Gemini Adapter.
 * Supports .gemini/skills/ with common SKILL.md format.
 */
function adaptGemini(frontmatter, body, sourcePath, skillRoot, scope) {
  const base = adaptCommon(frontmatter, body, sourcePath, skillRoot, scope);
  base.rawMetadata = { ...base.rawMetadata, platform: 'gemini' };
  base.sourceFormat = 'gemini';
  return base;
}

// ── Platform Detection ──────────────────────────────────────

/**
 * Detect source format from directory path and metadata files.
 */
function detectFormat(skillRoot) {
  const dirName = path.basename(path.dirname(skillRoot));
  const parentName = path.basename(path.dirname(path.dirname(skillRoot)));

  if (parentName === '.claude' || dirName === '.claude') return 'claude';
  if (parentName === '.gemini' || dirName === '.gemini') return 'gemini';
  if (parentName === 'openai' || dirName === 'openai') return 'codex';

  // Check for agents/openai.yaml
  try {
    if (fs.existsSync(path.join(skillRoot, 'agents', 'openai.yaml'))) {
      return 'codex';
    }
  } catch { /* skip */ }

  return 'common';
}

/**
 * Parse a simple YAML value (for openai.yaml — limited subset).
 */
function parseSimpleYaml(content) {
  const result = {};
  let currentSection = result;
  let sectionPath = [];

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const indent = line.length - line.trimStart().length;

    // Section header: "key:"
    const sectionMatch = trimmed.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*$/);
    if (sectionMatch) {
      const key = sectionMatch[1];
      if (indent === 0) {
        currentSection = {};
        result[key] = currentSection;
        sectionPath = [key];
      }
      continue;
    }

    // Key: value
    const kvMatch = trimmed.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.+)$/);
    if (kvMatch) {
      const key = kvMatch[1];
      let value = kvMatch[2].trim().replace(/^["']|["']$/g, '');

      // Boolean
      if (value === 'true') value = true;
      if (value === 'false') value = false;

      currentSection[key] = value;
    }
  }

  return result;
}

// ── Main Adapter ────────────────────────────────────────────

/**
 * Adapt an external SKILL.md to a Normalized Descriptor.
 *
 * @param {object} options
 * @param {string} options.skilledir — absolute path to skill directory
 * @param {string} options.skillMdContent — content of SKILL.md
 * @param {string} options.scope — 'workspace' | 'user'
 * @returns {object} Normalized Skill Descriptor
 */
function adaptExternalSkill({ skillDir, skillMdContent, scope = 'workspace', lazyBody = false }) {
  const skillRoot = path.resolve(skillDir);
  const sourceFormat = detectFormat(skillRoot);

  // Parse SKILL.md frontmatter
  const { frontmatter, body } = parseFrontmatter(skillMdContent);

  // P1-4 fix: Lazy body loading.
  // When lazyBody is true (discovery phase), the body is NOT stored in the
  // descriptor. It will be loaded on demand at activation time.
  // This prevents 100 skills from loading 100 bodies into memory.
  const instructions = lazyBody ? '' : (body || '');

  // Read platform metadata
  let platformMeta = {};
  if (sourceFormat === 'codex') {
    const openaiYamlPath = path.join(skillRoot, 'agents', 'openai.yaml');
    try {
      if (fs.existsSync(openaiYamlPath)) {
        const yamlContent = fs.readFileSync(openaiYamlPath, 'utf-8');
        platformMeta = parseSimpleYaml(yamlContent);
      }
    } catch { /* skip */ }
  }

  // Scan for resource directories
  const resources = scanResources(skillRoot);

  // Dispatch to platform adapter
  let descriptor;
  switch (sourceFormat) {
    case 'claude':
      descriptor = adaptClaude(frontmatter, body, path.join(skillRoot, 'SKILL.md'), skillRoot, scope);
      break;
    case 'codex':
      descriptor = adaptCodex(frontmatter, body, path.join(skillRoot, 'SKILL.md'), skillRoot, scope, platformMeta);
      break;
    case 'gemini':
      descriptor = adaptGemini(frontmatter, body, path.join(skillRoot, 'SKILL.md'), skillRoot, scope);
      break;
    default:
      descriptor = adaptCommon(frontmatter, body, path.join(skillRoot, 'SKILL.md'), skillRoot, scope);
  }

  // Attach resource manifest
  descriptor.resources = resources;

  return descriptor;
}

/**
 * Scan for resource directories within a skill root.
 */
function scanResources(skillRoot) {
  const resources = { scripts: [], references: [], assets: [] };

  const scanDir = (dir, category) => {
    try {
      if (!fs.existsSync(dir)) return;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile()) {
          resources[category].push(entry.name);
        }
      }
    } catch { /* skip */ }
  };

  scanDir(path.join(skillRoot, 'scripts'), 'scripts');
  scanDir(path.join(skillRoot, 'references'), 'references');
  scanDir(path.join(skillRoot, 'assets'), 'assets');

  return resources;
}

/**
 * P1-4 fix: Load SKILL.md body on demand at activation time.
 * Reads the full SKILL.md from disk and returns the body content.
 * This is called during activation (Progressive Disclosure Level 2),
 * NOT during discovery.
 *
 * @param {string} skillDir — absolute path to skill directory
 * @returns {string} SKILL.md body content
 */
function loadSkillBody(skillDir) {
  const skillMdPath = path.join(skillDir, 'SKILL.md');
  try {
    if (!fs.existsSync(skillMdPath)) return '';
    const content = fs.readFileSync(skillMdPath, 'utf-8');
    const { body } = parseFrontmatter(content);
    return body || '';
  } catch {
    return '';
  }
}

// ── Exports ─────────────────────────────────────────────────

export {
  COMPATIBILITY_STATUS,
  CLAUDE_TOOL_MAP,
  parseFrontmatter,
  parseSimpleYaml,
  detectFormat,
  scanResources,
  loadSkillBody,
  createDescriptor,
  adaptCommon,
  adaptClaude,
  adaptCodex,
  adaptGemini,
  adaptExternalSkill,
};