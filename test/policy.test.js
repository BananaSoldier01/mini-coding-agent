import { test } from 'node:test';

/**
 * test/policy.test.js — Tool Policy & Approval 测试
 */

import assert from 'assert';
import { evaluate, RISK, RISK_CATEGORY, safeEnv, clampTimeout, isSensitiveFilePath } from '../policy.js';
import { registry, ApprovalRegistry } from '../approval.js';

// ── Policy evaluate ──────────────────────────────────

test('Policy: list_directory 允许', () => {
  const r = evaluate({ name: 'list_directory' }, { path: '.' }, {});
  assert.strictEqual(r.decision, RISK.SAFE);
});

test('Policy: search_files 允许', () => {
  const r = evaluate({ name: 'search_files' }, { pattern: 'test' }, {});
  assert.strictEqual(r.decision, RISK.SAFE);
});

test('Policy: read_file 允许（非敏感文件）', () => {
  const r = evaluate({ name: 'read_file' }, { path: 'index.html' }, {});
  assert.strictEqual(r.decision, RISK.SAFE);
});

test('Policy: read_file 拒绝敏感文件', () => {
  const r = evaluate({ name: 'read_file' }, { path: '.env' }, {});
  assert.strictEqual(r.decision, RISK.DENY);
  assert.ok(r.reason.includes('.env'));
});

test('Policy: write_file 允许（非敏感文件）', () => {
  const r = evaluate({ name: 'write_file' }, { path: 'README.md', content: 'test' }, {});
  assert.strictEqual(r.decision, RISK.SAFE);
});

test('Policy: write_file 拒绝敏感文件', () => {
  const r = evaluate({ name: 'write_file' }, { path: '.env', content: 'SECRET=xxx' }, {});
  assert.strictEqual(r.decision, RISK.DENY);
});

test('Policy: edit_file 允许', () => {
  const r = evaluate({ name: 'edit_file' }, { path: 'app.js', oldString: 'a', newString: 'b' }, {});
  assert.strictEqual(r.decision, RISK.SAFE);
});

test('Policy: delete_file 必须审批', () => {
  const r = evaluate({ name: 'delete_file' }, { path: 'test.txt' }, {});
  assert.strictEqual(r.decision, RISK.REQUIRE_APPROVAL);
  assert.strictEqual(r.category, RISK_CATEGORY.FILE_DESTRUCTIVE);
});

test('Policy: run_command 安全命令允许', () => {
  const r = evaluate({ name: 'run_command' }, { command: 'ls -la' }, {});
  assert.strictEqual(r.decision, RISK.SAFE);
});

test('Policy: run_command 破坏性命令需审批', () => {
  const r = evaluate({ name: 'run_command' }, { command: 'rm -rf /' }, {});
  assert.strictEqual(r.decision, RISK.REQUIRE_APPROVAL);
  assert.strictEqual(r.category, RISK_CATEGORY.SHELL_DESTRUCTIVE);
});

test('Policy: run_command 读取敏感变量被拒绝', () => {
  const r = evaluate({ name: 'run_command' }, { command: 'printenv LLM_API_KEY' }, {});
  assert.strictEqual(r.decision, RISK.DENY);
  assert.strictEqual(r.category, RISK_CATEGORY.SHELL_SECRET);
});

test('Policy: run_command 网络命令需审批', () => {
  const r = evaluate({ name: 'run_command' }, { command: 'curl http://example.com' }, {});
  assert.strictEqual(r.decision, RISK.REQUIRE_APPROVAL);
  assert.strictEqual(r.category, RISK_CATEGORY.SHELL_NETWORK);
});

test('Policy: run_command 系统命令需审批', () => {
  const r = evaluate({ name: 'run_command' }, { command: 'shutdown -h now' }, {});
  assert.strictEqual(r.decision, RISK.REQUIRE_APPROVAL);
  assert.strictEqual(r.category, RISK_CATEGORY.SHELL_SYSTEM);
});

test('Policy: 未知工具拒绝', () => {
  const r = evaluate({ name: 'nonexistent_tool' }, {}, {});
  assert.strictEqual(r.decision, RISK.DENY);
});

// ── safeEnv ──────────────────────────────────────────

test('safeEnv: 不包含 LLM_API_KEY', () => {
  // 保存原始值
  const orig = process.env.LLM_API_KEY;
  process.env.LLM_API_KEY = 'sk-test-12345';
  const env = safeEnv();
  assert.ok(!('LLM_API_KEY' in env), 'safeEnv 不应包含 LLM_API_KEY');
  if (orig !== undefined) process.env.LLM_API_KEY = orig;
  else delete process.env.LLM_API_KEY;
});

test('safeEnv: 包含 PATH', () => {
  const env = safeEnv();
  assert.ok('PATH' in env, 'safeEnv 应包含 PATH');
});

// ── clampTimeout ─────────────────────────────────────

test('clampTimeout: 默认值', () => {
  assert.strictEqual(clampTimeout(undefined), 30000);
  assert.strictEqual(clampTimeout(null), 30000);
});

test('clampTimeout: 最小值', () => {
  assert.strictEqual(clampTimeout(100), 1000);
});

test('clampTimeout: 最大值', () => {
  assert.strictEqual(clampTimeout(999999), 120000);
});

test('clampTimeout: 正常值', () => {
  assert.strictEqual(clampTimeout(5000), 5000);
});

// ── isSensitiveFilePath ──────────────────────────────

test('isSensitiveFilePath: .env 被识别', () => {
  assert.strictEqual(isSensitiveFilePath('.env'), true);
  assert.strictEqual(isSensitiveFilePath('config/.env'), true);
});

test('isSensitiveFilePath: 普通文件不被识别', () => {
  assert.strictEqual(isSensitiveFilePath('index.html'), false);
  assert.strictEqual(isSensitiveFilePath('README.md'), false);
});

// ── ApprovalRegistry ──────────────────────────────────

test('ApprovalRegistry: 注册和解析', async () => {
  const reg = new ApprovalRegistry();
  const promise = reg.register('test-id', 5000);
  // resolve 之前
  assert.strictEqual(reg.size, 1);
  const result = await promise;
  // 超时自动拒绝
  assert.strictEqual(result, false);
});

test('ApprovalRegistry: 手动 resolve', async () => {
  const reg = new ApprovalRegistry();
  const promise = reg.register('test-id-2', 5000);
  const ok = reg.resolve('test-id-2', true);
  assert.strictEqual(ok, true);
  const result = await promise;
  assert.strictEqual(result, true);
});

test('ApprovalRegistry: 拒绝后不执行', async () => {
  const reg = new ApprovalRegistry();
  const promise = reg.register('test-id-3', 5000);
  reg.resolve('test-id-3', false);
  const result = await promise;
  assert.strictEqual(result, false);
});

test('ApprovalRegistry: 重复 resolve 无效', async () => {
  const reg = new ApprovalRegistry();
  const promise = reg.register('test-id-4', 5000);
  const ok1 = reg.resolve('test-id-4', true);
  const ok2 = reg.resolve('test-id-4', true);
  assert.strictEqual(ok1, true);
  assert.strictEqual(ok2, false); // 第二次 resolve 失败
  const result = await promise;
  assert.strictEqual(result, true);
});

test('ApprovalRegistry: cancelAll 清理所有', async () => {
  const reg = new ApprovalRegistry();
  reg.register('a', 5000);
  reg.register('b', 5000);
  assert.strictEqual(reg.size, 2);
  reg.cancelAll();
  assert.strictEqual(reg.size, 0);
});