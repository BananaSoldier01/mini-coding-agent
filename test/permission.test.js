import { test } from 'node:test';
import assert from 'assert';
import { mergePermission, isValidMode } from '../permission.js';

// ── V0.4.0.3 Regression: Permission Mode Matrix ───────

test('REGRESSION: Safe read_file base allow → allow', () => {
  const r = mergePermission({ mode: 'safe', baseDecision: 'allow', baseCategory: 'file_read', toolName: 'read_file' });
  assert.strictEqual(r, 'allow');
});

test('REGRESSION: Safe search_files base allow → allow', () => {
  const r = mergePermission({ mode: 'safe', baseDecision: 'allow', baseCategory: 'file_search', toolName: 'search_files' });
  assert.strictEqual(r, 'allow');
});

test('REGRESSION: Safe write_file base allow → requireApproval', () => {
  const r = mergePermission({ mode: 'safe', baseDecision: 'allow', baseCategory: 'file_write', toolName: 'write_file' });
  assert.strictEqual(r, 'requireApproval');
});

test('REGRESSION: Safe edit_file base allow → requireApproval', () => {
  const r = mergePermission({ mode: 'safe', baseDecision: 'allow', baseCategory: 'file_edit', toolName: 'edit_file' });
  assert.strictEqual(r, 'requireApproval');
});

test('REGRESSION: Safe delete_file base requireApproval → requireApproval', () => {
  const r = mergePermission({ mode: 'safe', baseDecision: 'requireApproval', baseCategory: 'file_delete', toolName: 'delete_file' });
  assert.strictEqual(r, 'requireApproval');
});

test('REGRESSION: Safe run_command base allow → requireApproval', () => {
  const r = mergePermission({ mode: 'safe', baseDecision: 'allow', baseCategory: 'shell', toolName: 'run_command' });
  assert.strictEqual(r, 'requireApproval');
});

test('REGRESSION: Standard edit_file base allow → allow', () => {
  const r = mergePermission({ mode: 'standard', baseDecision: 'allow', baseCategory: 'file_edit', toolName: 'edit_file' });
  assert.strictEqual(r, 'allow');
});

test('REGRESSION: Standard delete_file base requireApproval → requireApproval', () => {
  const r = mergePermission({ mode: 'standard', baseDecision: 'requireApproval', baseCategory: 'file_delete', toolName: 'delete_file' });
  assert.strictEqual(r, 'requireApproval');
});

test('REGRESSION: Standard hard deny → deny', () => {
  const r = mergePermission({ mode: 'standard', baseDecision: 'deny', baseCategory: 'sensitive_file', toolName: 'read_file' });
  assert.strictEqual(r, 'deny');
});

test('REGRESSION: Full Access delete_file base requireApproval → allow', () => {
  const r = mergePermission({ mode: 'full_access', baseDecision: 'requireApproval', baseCategory: 'file_delete', toolName: 'delete_file' });
  assert.strictEqual(r, 'allow');
});

test('REGRESSION: Full Access unknown shell base requireApproval → allow', () => {
  const r = mergePermission({ mode: 'full_access', baseDecision: 'requireApproval', baseCategory: 'shell_unknown', toolName: 'run_command' });
  assert.strictEqual(r, 'allow');
});

test('REGRESSION: Full Access secret read base deny → deny', () => {
  const r = mergePermission({ mode: 'full_access', baseDecision: 'deny', baseCategory: 'secret_read', toolName: 'read_file' });
  assert.strictEqual(r, 'deny');
});

test('REGRESSION: invalid mode → requireApproval (safe fallback)', () => {
  const r = mergePermission({ mode: 'unknown_mode', baseDecision: 'allow', baseCategory: 'file_edit', toolName: 'edit_file' });
  assert.strictEqual(r, 'requireApproval');
});

test('REGRESSION: isValidMode checks', () => {
  assert.strictEqual(isValidMode('safe'), true);
  assert.strictEqual(isValidMode('standard'), true);
  assert.strictEqual(isValidMode('full_access'), true);
  assert.strictEqual(isValidMode('invalid'), false);
  assert.strictEqual(isValidMode(''), false);
});