/**
 * test/runtime-policy.test.js — Runtime Policy Context Tests
 *
 * V0.8.3 (Pre-V0.9 Cleanup)
 * Tests for RuntimePolicyContext, POLICY_PRESETS, createPolicyContext.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  RuntimePolicyContext,
  POLICY_PRESETS,
  createPolicyContext,
} from '../agent/skill.js';

// ── Test 1: RuntimePolicyContext Basics ───────────────────

test('Policy: RuntimePolicyContext constructor sets defaults', () => {
  const ctx = new RuntimePolicyContext();
  assert.strictEqual(ctx.environment, 'development');
  assert.strictEqual(ctx.user, null);
  assert.strictEqual(ctx.workspace, null);
  assert.strictEqual(ctx.skill, null);
  assert.deepStrictEqual(ctx.allowedTools, []);
  assert.deepStrictEqual(ctx.restrictions, []);
  assert.ok(ctx.createdAt > 0);
});

test('Policy: RuntimePolicyContext accepts custom options', () => {
  const ctx = new RuntimePolicyContext({
    environment: 'production',
    user: { id: 'u1', name: 'Alice' },
    workspace: '/home/user/project',
    allowedTools: ['read_file', 'list_dir'],
  });
  assert.strictEqual(ctx.environment, 'production');
  assert.strictEqual(ctx.user.id, 'u1');
  assert.strictEqual(ctx.workspace, '/home/user/project');
  assert.deepStrictEqual(ctx.allowedTools, ['read_file', 'list_dir']);
});

// ── Test 2: Tool Permission Checks ────────────────────────

test('Policy: isToolAllowed returns true when no restrictions', () => {
  const ctx = new RuntimePolicyContext();
  assert.ok(ctx.isToolAllowed('read_file', ['read_file', 'write_file']));
});

test('Policy: isToolAllowed respects explicit deny restrictions', () => {
  const ctx = new RuntimePolicyContext();
  ctx.addRestriction({ type: 'deny', tools: ['run_shell'] });
  assert.ok(!ctx.isToolAllowed('run_shell', ['run_shell', 'read_file']));
  assert.ok(ctx.isToolAllowed('read_file', ['run_shell', 'read_file']));
});

test('Policy: isToolAllowed respects environment restrictions', () => {
  const ctx = new RuntimePolicyContext({ environment: 'production' });
  ctx.addRestriction({ type: 'deny', tools: ['run_shell'], environment: 'production' });
  assert.ok(!ctx.isToolAllowed('run_shell', ['run_shell', 'read_file']));
});

test('Policy: isToolAllowed respects skill tool list', () => {
  const skill = { id: 's1', name: 'Test', tools: ['read_file'] };
  const ctx = new RuntimePolicyContext({ skill });
  assert.ok(ctx.isToolAllowed('read_file', ['read_file', 'write_file']));
  assert.ok(!ctx.isToolAllowed('write_file', ['read_file', 'write_file']));
});

test('Policy: isToolAllowed respects allowedTools list', () => {
  const ctx = new RuntimePolicyContext({ allowedTools: ['read_file'] });
  assert.ok(ctx.isToolAllowed('read_file', ['read_file', 'write_file']));
  assert.ok(!ctx.isToolAllowed('write_file', ['read_file', 'write_file']));
});

test('Policy: isToolAllowed respects availableTools', () => {
  const ctx = new RuntimePolicyContext();
  assert.ok(ctx.isToolAllowed('read_file', ['read_file']));
  assert.ok(!ctx.isToolAllowed('write_file', ['read_file']));
});

// ── Test 3: Restriction Management ────────────────────────

test('Policy: addRestriction generates id and timestamp', () => {
  const ctx = new RuntimePolicyContext();
  ctx.addRestriction({ type: 'deny', tools: ['run_shell'] });
  assert.strictEqual(ctx.restrictions.length, 1);
  assert.ok(ctx.restrictions[0].id);
  assert.ok(ctx.restrictions[0].createdAt > 0);
});

test('Policy: multiple restrictions accumulate', () => {
  const ctx = new RuntimePolicyContext();
  ctx.addRestriction({ type: 'deny', tools: ['run_shell'] });
  ctx.addRestriction({ type: 'deny', tools: ['delete_file'] });
  assert.strictEqual(ctx.restrictions.length, 2);
  assert.ok(!ctx.isToolAllowed('run_shell', ['run_shell']));
  assert.ok(!ctx.isToolAllowed('delete_file', ['delete_file']));
});

// ── Test 4: forSkill ──────────────────────────────────────

test('Policy: forSkill creates child context with skill', () => {
  const parent = new RuntimePolicyContext({
    allowedTools: ['read_file'],
    restrictions: [{ type: 'deny', tools: ['run_shell'] }],
  });
  const skill = { id: 's1', name: 'Test', tools: ['read_file', 'write_file'] };

  const child = parent.forSkill(skill);
  assert.strictEqual(child.skill, skill);
  assert.strictEqual(child.restrictions.length, 1);
  assert.ok(child.isToolAllowed('read_file', ['read_file', 'write_file']));
  assert.ok(!child.isToolAllowed('write_file', ['read_file', 'write_file']));
  assert.ok(!child.isToolAllowed('run_shell', ['run_shell']));
});

// ── Test 5: Serialization ─────────────────────────────────

test('Policy: serialize captures all fields', () => {
  const ctx = new RuntimePolicyContext({
    environment: 'production',
    user: { id: 'u1' },
    workspace: '/proj',
    allowedTools: ['read_file'],
    restrictions: [{ type: 'deny', tools: ['run_shell'] }],
    sessionId: 'sess-1',
    runId: 'run-1',
  });

  const serialized = ctx.serialize();
  assert.strictEqual(serialized.environment, 'production');
  assert.deepStrictEqual(serialized.user, { id: 'u1' });
  assert.strictEqual(serialized.workspace, '/proj');
  assert.deepStrictEqual(serialized.allowedTools, ['read_file']);
  assert.strictEqual(serialized.restrictions.length, 1);
  assert.strictEqual(serialized.sessionId, 'sess-1');
  assert.strictEqual(serialized.runId, 'run-1');
});

test('Policy: deserialize restores context', () => {
  const data = {
    environment: 'staging',
    user: { id: 'u2' },
    workspace: '/other',
    allowedTools: ['list_dir'],
    restrictions: [{ type: 'deny', tools: ['write_file'] }],
    sessionId: 'sess-2',
    runId: 'run-2',
    createdAt: Date.now(),
  };
  const ctx = RuntimePolicyContext.deserialize(data);
  assert.strictEqual(ctx.environment, 'staging');
  assert.strictEqual(ctx.user.id, 'u2');
  assert.strictEqual(ctx.workspace, '/other');
  assert.deepStrictEqual(ctx.allowedTools, ['list_dir']);
  assert.strictEqual(ctx.restrictions.length, 1);
  assert.strictEqual(ctx.sessionId, 'sess-2');
  assert.strictEqual(ctx.runId, 'run-2');
});

test('Policy: serialize/deserialize round-trip preserves permissions', () => {
  const ctx = new RuntimePolicyContext({
    environment: 'production',
    allowedTools: ['read_file'],
    restrictions: [{ type: 'deny', tools: ['run_shell'] }],
  });

  const serialized = ctx.serialize();
  const restored = RuntimePolicyContext.deserialize(serialized);

  assert.ok(restored.isToolAllowed('read_file', ['read_file', 'run_shell']));
  assert.ok(!restored.isToolAllowed('run_shell', ['read_file', 'run_shell']));
});

// ── Test 6: Presets ───────────────────────────────────────

test('Policy: POLICY_PRESETS has development preset', () => {
  assert.ok(POLICY_PRESETS.development);
  assert.strictEqual(POLICY_PRESETS.development.environment, 'development');
});

test('Policy: POLICY_PRESETS has production preset', () => {
  assert.ok(POLICY_PRESETS.production);
  assert.strictEqual(POLICY_PRESETS.production.environment, 'production');
});

test('Policy: POLICY_PRESETS has readonly preset', () => {
  assert.ok(POLICY_PRESETS.readonly);
});

test('Policy: createPolicyContext uses preset', () => {
  const ctx = createPolicyContext('production', { runId: 'run-1' });
  assert.strictEqual(ctx.environment, 'production');
  assert.strictEqual(ctx.runId, 'run-1');
});

test('Policy: createPolicyContext defaults to development', () => {
  const ctx = createPolicyContext();
  assert.strictEqual(ctx.environment, 'development');
});

test('Policy: production preset denies run_shell', () => {
  const ctx = createPolicyContext('production');
  assert.ok(!ctx.isToolAllowed('run_shell', ['run_shell', 'read_file']));
  assert.ok(ctx.isToolAllowed('read_file', ['run_shell', 'read_file']));
});

test('Policy: readonly preset denies write operations', () => {
  const ctx = createPolicyContext('readonly');
  assert.ok(!ctx.isToolAllowed('write_file', ['write_file', 'read_file']));
  assert.ok(!ctx.isToolAllowed('run_shell', ['run_shell', 'read_file']));
  assert.ok(ctx.isToolAllowed('read_file', ['read_file', 'write_file']));
});

// ── Test 7: Integration with Skill ────────────────────────

test('Policy: forSkill restricts to skill tools only', () => {
  const parent = new RuntimePolicyContext();
  const skill = { id: 's1', name: 'Test', tools: ['git_status', 'git_diff'] };
  const ctx = parent.forSkill(skill);

  assert.ok(ctx.isToolAllowed('git_status', ['git_status', 'git_diff', 'run_shell']));
  assert.ok(ctx.isToolAllowed('git_diff', ['git_status', 'git_diff', 'run_shell']));
  assert.ok(!ctx.isToolAllowed('run_shell', ['git_status', 'git_diff', 'run_shell']));
});

test('Policy: restriction overrides skill permission', () => {
  const parent = new RuntimePolicyContext();
  parent.addRestriction({ type: 'deny', tools: ['git_status'] });
  const skill = { id: 's1', name: 'Test', tools: ['git_status', 'git_diff'] };
  const ctx = parent.forSkill(skill);

  // Even though skill allows git_status, restriction denies it
  assert.ok(!ctx.isToolAllowed('git_status', ['git_status', 'git_diff']));
  assert.ok(ctx.isToolAllowed('git_diff', ['git_status', 'git_diff']));
});