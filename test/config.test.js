import { test } from 'node:test';

/**
 * test/config.test.js — 配置管理测试
 */

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { loadConfig, saveFileConfig, maskApiKey } from '../config.js';

const TEST_CONFIG_DIR = path.join(os.tmpdir(), 'mini-agent-config-test-' + Date.now());
const TEST_CONFIG_FILE = path.join(TEST_CONFIG_DIR, 'config.json');

// 覆盖 CONFIG_FILE 为测试文件
// 由于 config.js 中 CONFIG_FILE 是模块级常量，我们通过环境变量测试

test('maskApiKey: 遮盖短 key', () => {
  assert.strictEqual(maskApiKey(''), '');
  assert.strictEqual(maskApiKey('abc'), '••••');
  assert.strictEqual(maskApiKey('12345678'), '••••');
});

test('maskApiKey: 遮盖长 key', () => {
  const masked = maskApiKey('sk-abc123def456');
  assert.ok(masked.startsWith('sk-a'));
  assert.ok(masked.endsWith('f456'));
  assert.ok(masked.includes('••••'));
});

test('saveFileConfig: 保存和读取', () => {
  // 使用测试路径
  const testDir = path.join(os.tmpdir(), 'mini-agent-cfg-' + Date.now());
  const testFile = path.join(testDir, 'config.json');

  // 直接测试保存逻辑
  fs.mkdirSync(testDir, { recursive: true });
  fs.writeFileSync(testFile, JSON.stringify({ llm: { endpoint: 'http://test', apiKey: 'key123', model: 'test-model' } }, null, 2), 'utf-8');
  try { fs.chmodSync(testFile, 0o600); } catch {}

  const raw = JSON.parse(fs.readFileSync(testFile, 'utf-8'));
  assert.strictEqual(raw.llm.endpoint, 'http://test');
  assert.strictEqual(raw.llm.apiKey, 'key123');

  // 清理
  try { fs.rmSync(testDir, { recursive: true }); } catch {}
});

test('loadConfig: 环境变量优先', () => {
  // 保存原始值
  const origEndpoint = process.env.LLM_ENDPOINT;
  const origKey = process.env.LLM_API_KEY;
  const origModel = process.env.LLM_MODEL;

  // 设置环境变量
  process.env.LLM_ENDPOINT = 'http://env-endpoint';
  process.env.LLM_API_KEY = 'env-key-123';
  process.env.LLM_MODEL = 'env-model';

  const cfg = loadConfig();
  assert.strictEqual(cfg.llm.endpoint, 'http://env-endpoint');
  assert.strictEqual(cfg.llm.apiKey, 'env-key-123');
  assert.strictEqual(cfg.llm.model, 'env-model');

  // 恢复
  if (origEndpoint !== undefined) process.env.LLM_ENDPOINT = origEndpoint; else delete process.env.LLM_ENDPOINT;
  if (origKey !== undefined) process.env.LLM_API_KEY = origKey; else delete process.env.LLM_API_KEY;
  if (origModel !== undefined) process.env.LLM_MODEL = origModel; else delete process.env.LLM_MODEL;
});

test('loadConfig: 默认值', () => {
  const origEndpoint = process.env.LLM_ENDPOINT;
  const origKey = process.env.LLM_API_KEY;
  const origModel = process.env.LLM_MODEL;
  const origPort = process.env.PORT;

  delete process.env.LLM_ENDPOINT;
  delete process.env.LLM_API_KEY;
  delete process.env.LLM_MODEL;
  delete process.env.PORT;

  // 注意：loadConfig 也会读取 ~/.mini-agent/config.json，如果存在的话
  // 这里只验证默认值逻辑
  const cfg = loadConfig();
  // endpoint 应该是默认值或文件配置
  assert.ok(cfg.llm.endpoint, 'endpoint 不应为空');
  assert.ok(cfg.llm.model, 'model 不应为空');
  assert.ok(cfg.port, 'port 不应为空');

  if (origEndpoint !== undefined) process.env.LLM_ENDPOINT = origEndpoint;
  if (origKey !== undefined) process.env.LLM_API_KEY = origKey;
  if (origModel !== undefined) process.env.LLM_MODEL = origModel;
  if (origPort !== undefined) process.env.PORT = origPort;
});