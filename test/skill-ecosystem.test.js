/**
 * test/skill-ecosystem.test.js — V1.6.0 Skill Ecosystem Unit Tests
 *
 * Tests: compatibility adapter, discovery, catalog, resource service
 */

import assert from 'node:assert';
import { test } from 'node:test';
import fs from 'fs';
import path from 'path';
import os from 'os';

import {
  parseFrontmatter,
  detectFormat,
  scanResources,
  createDescriptor,
  adaptCommon,
  adaptClaude,
  adaptCodex,
  adaptGemini,
  adaptExternalSkill,
  COMPATIBILITY_STATUS,
  CLAUDE_TOOL_MAP,
} from '../agent/skill/compatibility.js';

import {
  SkillCatalog,
} from '../agent/skill/catalog.js';

import {
  SkillResourceService,
  resolveSafePath,
} from '../agent/skill/resource-service.js';

import {
  buildCatalogContext,
  buildActivatedSkillContext,
} from '../context/skill-catalog.js';

import {
  SkillTools,
  TOOL_DEFS,
  parseExplicitInvocation,
} from '../tools/skill.js';

// ── Helpers ─────────────────────────────────────────────────

let testDir;

test.beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-eco-test-'));
});

test.afterEach(() => {
  fs.rmSync(testDir, { recursive: true, force: true });
});

function writeSkill(dir, name, frontmatter = {}, body = '# Instructions\nDo something.') {
  const skillDir = path.join(dir, name);
  fs.mkdirSync(skillDir, { recursive: true });
  const fm = Object.entries(frontmatter).map(([k, v]) => {
    if (Array.isArray(v)) return `${k}:\n${v.map(item => `  - ${item}`).join('\n')}`;
    return `${k}: ${v}`;
  }).join('\n');
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---\n${fm}\n---\n${body}`);
  return skillDir;
}

// ═══════════════════════════════════════════════════════════════
// Compatibility Adapter Tests
// ═══════════════════════════════════════════════════════════════

test('compatibility: parseFrontmatter extracts name and description', () => {
  const content = `---
name: code-review
description: Review code changes.
---
# Body here`;
  const { frontmatter, body } = parseFrontmatter(content);
  assert.strictEqual(frontmatter.name, 'code-review');
  assert.strictEqual(frontmatter.description, 'Review code changes.');
  assert.ok(body.includes('# Body here'));
});

test('compatibility: parseFrontmatter handles missing frontmatter', () => {
  const content = '# Just markdown, no frontmatter';
  const { frontmatter, body } = parseFrontmatter(content);
  assert.deepStrictEqual(frontmatter, {});
  assert.strictEqual(body, content);
});

test('compatibility: parseFrontmatter handles array values', () => {
  const content = `---
name: test
allowed-tools:
  - Read
  - Write
---
body`;
  const { frontmatter } = parseFrontmatter(content);
  assert.ok(Array.isArray(frontmatter['allowed-tools']));
  assert.ok(frontmatter['allowed-tools'].includes('Read'));
});

test('compatibility: detectFormat identifies .agents/skills as common', () => {
  const skillRoot = path.join(testDir, '.agents', 'skills', 'my-skill');
  fs.mkdirSync(skillRoot, { recursive: true });
  assert.strictEqual(detectFormat(skillRoot), 'common');
});

test('compatibility: detectFormat identifies .claude/skills as claude', () => {
  const skillRoot = path.join(testDir, '.claude', 'skills', 'my-skill');
  fs.mkdirSync(skillRoot, { recursive: true });
  assert.strictEqual(detectFormat(skillRoot), 'claude');
});

test('compatibility: detectFormat identifies .gemini/skills as gemini', () => {
  const skillRoot = path.join(testDir, '.gemini', 'skills', 'my-skill');
  fs.mkdirSync(skillRoot, { recursive: true });
  assert.strictEqual(detectFormat(skillRoot), 'gemini');
});

test('compatibility: detectFormat identifies agents/openai.yaml as codex', () => {
  const skillRoot = path.join(testDir, '.agents', 'skills', 'my-skill');
  fs.mkdirSync(path.join(skillRoot, 'agents'), { recursive: true });
  fs.writeFileSync(path.join(skillRoot, 'agents', 'openai.yaml'), 'policy:\n  allow_implicit_invocation: true\n');
  assert.strictEqual(detectFormat(skillRoot), 'codex');
});

test('compatibility: adaptCommon creates valid descriptor', () => {
  const skillDir = writeSkill(testDir, 'test-skill', {
    name: 'test-skill',
    description: 'A test skill',
  }, 'Do test things.');

  const content = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');
  const { frontmatter, body } = parseFrontmatter(content);
  const descriptor = adaptCommon(frontmatter, body, path.join(skillDir, 'SKILL.md'), skillDir, 'workspace');

  assert.strictEqual(descriptor.name, 'test-skill');
  assert.strictEqual(descriptor.description, 'A test skill');
  assert.strictEqual(descriptor.instructions, 'Do test things.');
  assert.strictEqual(descriptor.compatibilityStatus, COMPATIBILITY_STATUS.NATIVE);
  assert.ok(descriptor.internalId.startsWith('skill_'));
});

test('compatibility: adaptClaude maps disable-model-invocation to implicitAllowed=false', () => {
  const descriptor = adaptClaude(
    { name: 'release', description: 'Release skill', 'disable-model-invocation': true, 'user-invocable': true },
    'Release instructions',
    '/fake/SKILL.md', '/fake', 'workspace'
  );
  assert.strictEqual(descriptor.invocation.implicitAllowed, false);
  assert.strictEqual(descriptor.invocation.explicitAllowed, true);
  assert.strictEqual(descriptor.sourceFormat, 'claude');
});

test('compatibility: adaptClaude maps allowed-tools to toolPolicy allowlist', () => {
  const descriptor = adaptClaude(
    { name: 'review', description: 'Review code', 'allowed-tools': ['Read', 'Grep', 'Bash'] },
    'Review instructions',
    '/fake/SKILL.md', '/fake', 'workspace'
  );
  assert.strictEqual(descriptor.toolPolicy.mode, 'allowlist');
  assert.ok(descriptor.toolPolicy.tools.includes('read_file'));
  assert.ok(descriptor.toolPolicy.tools.includes('search_files'));
  assert.ok(descriptor.toolPolicy.tools.includes('run_command'));
});

test('compatibility: adaptClaude marks unsupported fields as partial', () => {
  const descriptor = adaptClaude(
    { name: 'test', description: 'Test', model: 'claude-3', hooks: { pre: 'do something' } },
    'Test instructions',
    '/fake/SKILL.md', '/fake', 'workspace'
  );
  assert.strictEqual(descriptor.compatibilityStatus, COMPATIBILITY_STATUS.PARTIAL);
  assert.ok(descriptor.compatibilityWarnings.some(w => w.includes('Unsupported')));
  assert.ok(descriptor.rawMetadata.model);
  assert.ok(descriptor.rawMetadata.hooks);
});

test('compatibility: adaptExternalSkill handles common skill end-to-end', () => {
  const skillDir = writeSkill(path.join(testDir, '.agents', 'skills'), 'my-skill', {
    name: 'my-skill',
    description: 'Does something useful',
  }, 'Instructions here');

  const content = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');
  const descriptor = adaptExternalSkill({ skillDir, skillMdContent: content, scope: 'workspace' });

  assert.strictEqual(descriptor.name, 'my-skill');
  assert.strictEqual(descriptor.sourceFormat, 'common');
  assert.strictEqual(descriptor.scope, 'workspace');
  assert.strictEqual(descriptor.compatibilityStatus, COMPATIBILITY_STATUS.NATIVE);
});

test('compatibility: scanResources finds scripts/references/assets', () => {
  const skillDir = path.join(testDir, 'skill-with-resources');
  fs.mkdirSync(path.join(skillDir, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(skillDir, 'references'), { recursive: true });
  fs.mkdirSync(path.join(skillDir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'scripts', 'setup.sh'), '#!/bin/sh\necho hi');
  fs.writeFileSync(path.join(skillDir, 'references', 'guide.md'), '# Guide');
  fs.writeFileSync(path.join(skillDir, 'assets', 'logo.png'), 'fakepng');

  const resources = scanResources(skillDir);
  assert.ok(resources.scripts.includes('setup.sh'));
  assert.ok(resources.references.includes('guide.md'));
  assert.ok(resources.assets.includes('logo.png'));
});

// ═══════════════════════════════════════════════════════════════
// Discovery + Catalog Tests
// ═══════════════════════════════════════════════════════════════

test('catalog: scan discovers skills in .agents/skills', () => {
  writeSkill(path.join(testDir, '.agents', 'skills'), 'skill-a', {
    name: 'skill-a', description: 'Skill A',
  }, 'Do A');
  writeSkill(path.join(testDir, '.agents', 'skills'), 'skill-b', {
    name: 'skill-b', description: 'Skill B',
  }, 'Do B');

  const catalog = new SkillCatalog({ workspaceRoot: testDir });
  catalog.scan();

  assert.strictEqual(catalog.count(), 2);
  assert.ok(catalog.has('skill-a'));
  assert.ok(catalog.has('skill-b'));
});

test('catalog: scan discovers skills in .claude/skills', () => {
  writeSkill(path.join(testDir, '.claude', 'skills'), 'claude-skill', {
    name: 'claude-skill', description: 'Claude skill',
  }, 'Claude instructions');

  const catalog = new SkillCatalog({ workspaceRoot: testDir });
  catalog.scan();

  assert.strictEqual(catalog.count(), 1);
  const skill = catalog.getByName('claude-skill');
  assert.strictEqual(skill.sourceFormat, 'claude');
});

test('catalog: scan discovers skills in .gemini/skills', () => {
  writeSkill(path.join(testDir, '.gemini', 'skills'), 'gemini-skill', {
    name: 'gemini-skill', description: 'Gemini skill',
  }, 'Gemini instructions');

  const catalog = new SkillCatalog({ workspaceRoot: testDir });
  catalog.scan();

  assert.strictEqual(catalog.count(), 1);
  const skill = catalog.getByName('gemini-skill');
  assert.strictEqual(skill.sourceFormat, 'gemini');
});

test('catalog: workspace wins over user in precedence', () => {
  // Create user skill
  const userHome = fs.mkdtempSync(path.join(os.tmpdir(), 'user-home-'));
  writeSkill(path.join(userHome, '.agents', 'skills'), 'dup-skill', {
    name: 'dup-skill', description: 'User version',
  }, 'User instructions');

  // Create workspace skill with same name
  writeSkill(path.join(testDir, '.agents', 'skills'), 'dup-skill', {
    name: 'dup-skill', description: 'Workspace version',
  }, 'Workspace instructions');

  const catalog = new SkillCatalog({
    workspaceRoot: testDir,
    userHome,
    includeUser: true,
  });
  catalog.scan();

  assert.strictEqual(catalog.count(), 1, 'should deduplicate to 1');
  const skill = catalog.getByName('dup-skill');
  assert.strictEqual(skill.scope, 'workspace', 'workspace should win');
  assert.strictEqual(catalog.getShadowed().length, 1, 'should have 1 shadowed');
  assert.strictEqual(catalog.getShadowed()[0].shadowed.scope, 'user');

  fs.rmSync(userHome, { recursive: true, force: true });
});

test('catalog: canonical .agents/skills wins over platform alias', () => {
  writeSkill(path.join(testDir, '.agents', 'skills'), 'shared-skill', {
    name: 'shared-skill', description: 'Canonical',
  }, 'Canonical instructions');

  writeSkill(path.join(testDir, '.claude', 'skills'), 'shared-skill', {
    name: 'shared-skill', description: 'Claude alias',
  }, 'Claude instructions');

  const catalog = new SkillCatalog({ workspaceRoot: testDir });
  catalog.scan();

  assert.strictEqual(catalog.count(), 1);
  const skill = catalog.getByName('shared-skill');
  assert.strictEqual(skill.scopePrefix, '.agents/skills');
  assert.strictEqual(catalog.getShadowed().length, 1);
});

test('catalog: enable/disable works', () => {
  writeSkill(path.join(testDir, '.agents', 'skills'), 'toggle-skill', {
    name: 'toggle-skill', description: 'Toggle me',
  }, 'Toggle instructions');

  const catalog = new SkillCatalog({ workspaceRoot: testDir });
  catalog.scan();

  assert.strictEqual(catalog.count(), 1);
  catalog.disable('toggle-skill');
  assert.strictEqual(catalog.count(), 0);
  assert.ok(!catalog.has('toggle-skill'));

  catalog.enable('toggle-skill');
  assert.strictEqual(catalog.count(), 1);
  assert.ok(catalog.has('toggle-skill'));
});

test('catalog: getCatalogMetadata returns compact list', () => {
  writeSkill(path.join(testDir, '.agents', 'skills'), 'meta-skill', {
    name: 'meta-skill', description: 'For metadata testing',
  }, 'Body content that should NOT appear here');

  const catalog = new SkillCatalog({ workspaceRoot: testDir });
  catalog.scan();

  const ctx = buildCatalogContext(catalog);
  assert.ok(ctx.context.includes('meta-skill'));
  assert.ok(ctx.context.includes('For metadata testing'));
  // Body must NOT be in catalog metadata
  assert.ok(!ctx.context.includes('Body content that should NOT appear here'),
    'SKILL.md body must not appear in catalog metadata');
  assert.ok(ctx.context.includes('activate_skill'));
});

test('catalog: getCatalogMetadata respects budget', () => {
  for (let i = 0; i < 10; i++) {
    writeSkill(path.join(testDir, '.agents', `skills`), `budget-skill-${i}`, {
      name: `budget-skill-${i}`,
      description: `Skill number ${i} with a reasonably long description to fill space`,
    }, `Body ${i}`.repeat(100));
  }

  const catalog = new SkillCatalog({ workspaceRoot: testDir });
  catalog.scan();
  const ctx = buildCatalogContext(catalog, 500); // small budget

  assert.ok(ctx.truncated || ctx.charCount <= 600,
    `catalog should respect budget, got ${ctx.charCount} chars`);
  assert.ok(ctx.omittedCount >= 0);
});

// ═══════════════════════════════════════════════════════════════
// Resource Security Tests
// ═══════════════════════════════════════════════════════════════

test('resource: resolveSafePath blocks absolute paths', () => {
  const skillRoot = path.join(testDir, 'safe-skill');
  fs.mkdirSync(skillRoot, { recursive: true });
  const result = resolveSafePath(skillRoot, '/etc/passwd');
  assert.strictEqual(result, null, 'absolute path should be blocked');
});

test('resource: resolveSafePath blocks .. traversal', () => {
  const skillRoot = path.join(testDir, 'safe-skill');
  fs.mkdirSync(skillRoot, { recursive: true });
  const result = resolveSafePath(skillRoot, '../../../etc/passwd');
  assert.strictEqual(result, null, 'traversal should be blocked');
});

test('resource: resolveSafePath allows valid relative paths', () => {
  const skillRoot = path.join(testDir, 'safe-skill');
  fs.mkdirSync(path.join(skillRoot, 'references'), { recursive: true });
  fs.writeFileSync(path.join(skillRoot, 'references', 'guide.md'), '# Guide');
  const result = resolveSafePath(skillRoot, 'references/guide.md');
  assert.ok(result, 'valid path should be allowed');
  assert.ok(result.includes('guide.md'));
});

test('resource: SkillResourceService readReference works', () => {
  const skillRoot = path.join(testDir, 'res-skill');
  fs.mkdirSync(path.join(skillRoot, 'references'), { recursive: true });
  fs.writeFileSync(path.join(skillRoot, 'references', 'data.md'), 'Reference data');

  const svc = new SkillResourceService({ skillRoot });
  const result = svc.readReference('references/data.md');
  assert.ok(!result.error, `should not error: ${result.error}`);
  assert.strictEqual(result.content, 'Reference data');
});

test('resource: SkillResourceService blocks traversal', () => {
  const skillRoot = path.join(testDir, 'res-skill-2');
  fs.mkdirSync(skillRoot, { recursive: true });
  const svc = new SkillResourceService({ skillRoot });
  const result = svc.readReference('../outside.md');
  assert.ok(result.error, 'traversal should be blocked');
});

// ═══════════════════════════════════════════════════════════════
// SkillTools Tests
// ═══════════════════════════════════════════════════════════════

test('skill-tools: activate_skill tool def exists', () => {
  assert.ok(TOOL_DEFS.activate_skill);
  assert.strictEqual(TOOL_DEFS.activate_skill.name, 'activate_skill');
  assert.ok(TOOL_DEFS.activate_skill.input_schema.required.includes('name'));
});

test('skill-tools: activate_skill activates by name', () => {
  const catalog = new SkillCatalog({ workspaceRoot: testDir });
  writeSkill(path.join(testDir, '.agents', 'skills'), 'activate-me', {
    name: 'activate-me', description: 'Activate this',
  }, 'Activated instructions');

  catalog.scan();
  const tools = new SkillTools(catalog);

  const result = tools.activateSkill({ name: 'activate-me' });
  assert.ok(!result.error, `should not error: ${result.error}`);
  assert.strictEqual(result.name, 'activate-me');
  assert.strictEqual(result.instructions, 'Activated instructions');
  assert.ok(tools.isActivated('activate-me'));
});

test('skill-tools: activate_skill returns error for unknown skill', () => {
  const catalog = new SkillCatalog({ workspaceRoot: testDir });
  const tools = new SkillTools(catalog);

  const result = tools.activateSkill({ name: 'nonexistent' });
  assert.ok(result.error);
  assert.ok(result.availableSkills);
});

test('skill-tools: parseExplicitInvocation detects $skill-name', () => {
  const catalog = new SkillCatalog({ workspaceRoot: testDir });
  writeSkill(path.join(testDir, '.agents', 'skills'), 'my-review', {
    name: 'my-review', description: 'Review',
  }, 'Review instructions');
  catalog.scan();

  const result = parseExplicitInvocation('$my-review review this change', catalog);
  assert.ok(result, 'should detect explicit invocation');
  assert.strictEqual(result.skillName, 'my-review');
  assert.strictEqual(result.args, 'review this change');
});

test('skill-tools: parseExplicitInvocation returns null for non-skill input', () => {
  const catalog = new SkillCatalog({ workspaceRoot: testDir });
  const result = parseExplicitInvocation('fix the bug', catalog);
  assert.strictEqual(result, null);
});

test('skill-tools: parseExplicitInvocation returns null for unknown skill', () => {
  const catalog = new SkillCatalog({ workspaceRoot: testDir });
  const result = parseExplicitInvocation('$unknown-skill do something', catalog);
  assert.strictEqual(result, null, 'unknown skill name should not match');
});

// ═══════════════════════════════════════════════════════════════
// Context Builder Tests
// ═══════════════════════════════════════════════════════════════

test('context: buildCatalogContext excludes body', () => {
  const catalog = new SkillCatalog({ workspaceRoot: testDir });
  writeSkill(path.join(testDir, '.agents', 'skills'), 'body-check', {
    name: 'body-check', description: 'Body check',
  }, 'SECRET_BODY_CONTENT_12345');
  catalog.scan();

  const ctx = buildCatalogContext(catalog);
  assert.ok(!ctx.context.includes('SECRET_BODY_CONTENT_12345'),
    'body must not appear in catalog context');
});

test('context: buildActivatedSkillContext includes body', () => {
  const descriptor = createDescriptor({
    name: 'test-skill',
    description: 'Test',
    body: 'ACTIVATED_BODY_MARKER',
    sourcePath: '/fake/SKILL.md',
    skillRoot: '/fake',
    sourceFormat: 'common',
    scope: 'workspace',
  });

  const ctx = buildActivatedSkillContext(descriptor);
  assert.ok(ctx.context.includes('ACTIVATED_BODY_MARKER'),
    'body should appear in activated skill context');
  assert.ok(ctx.context.includes('advisory'));
  assert.ok(ctx.context.includes('must not override'));
});

// ═══════════════════════════════════════════════════════════════
// Tool Policy Tests
// ═══════════════════════════════════════════════════════════════

test('tool-policy: CLAUDE_TOOL_MAP maps common tools', () => {
  assert.strictEqual(CLAUDE_TOOL_MAP['Read'], 'read_file');
  assert.strictEqual(CLAUDE_TOOL_MAP['Write'], 'write_file');
  assert.strictEqual(CLAUDE_TOOL_MAP['Edit'], 'edit_file');
  assert.strictEqual(CLAUDE_TOOL_MAP['Grep'], 'search_files');
  assert.strictEqual(CLAUDE_TOOL_MAP['Bash'], 'run_command');
});

test('tool-policy: missing allowed-tools inherits (mode=inherit)', () => {
  const descriptor = adaptClaude(
    { name: 'minimal', description: 'Minimal skill' },
    'Just instructions',
    '/fake/SKILL.md', '/fake', 'workspace'
  );
  assert.strictEqual(descriptor.toolPolicy.mode, 'inherit');
  assert.strictEqual(descriptor.toolPolicy.tools.length, 0);
});

test('tool-policy: allowlist only restricts, never expands', () => {
  const baseTools = new Set(['read_file', 'write_file', 'edit_file', 'search_files', 'list_directory']);
  const descriptor = adaptClaude(
    { name: 'restricted', description: 'Restricted', 'allowed-tools': ['Read', 'Grep'] },
    'Restrict',
    '/fake/SKILL.md', '/fake', 'workspace'
  );

  // Effective = Base ∩ Allowlist
  const allowlist = new Set(descriptor.toolPolicy.tools);
  const effective = [...baseTools].filter(t => allowlist.has(t));

  assert.ok(effective.includes('read_file'));
  assert.ok(effective.includes('search_files'));
  assert.ok(!effective.includes('write_file'), 'write should be excluded');
  assert.ok(!effective.includes('run_command'), 'bash should not be expanded');
});