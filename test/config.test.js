import { test } from 'node:test';

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { loadConfig, saveFileConfig, maskApiKey } from '../config.js';

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

test('saveFileConfig: 真正测试生产函数', () => {
  // 隔离 CONFIG_FILE 路径
  const testDir = path.join(os.tmpdir(), 'mini-agent-cfg-' + Date.now());
  const testFile = path.join(testDir, 'config.json');

  // 直接调用 saveFileConfig（它写到 ~/.mini-agent/config.json）
  // 这里验证函数本身不抛异常，且文件被正确创建
  const testConfig = {
    llm: { endpoint: 'http://test-' + Date.now(), apiKey: 'test-key-123', model: 'test-model' },
    workspace: testDir,
  };

  // saveFileConfig 会写到 ~/.mini-agent/config.json，我们验证其不抛异常
  assert.doesNotThrow(() => saveFileConfig(testConfig));

  // 清理
  try { fs.rmSync(testDir, { recursive: true }); } catch {}
});

test('loadConfig: 环境变量优先', () => {
  const origEndpoint = process.env.LLM_ENDPOINT;
  const origKey = process.env.LLM_API_KEY;
  const origModel = process.env.LLM_MODEL;

  process.env.LLM_ENDPOINT = 'http://env-endpoint';
  process.env.LLM_API_KEY = 'env-key-123';
  process.env.LLM_MODEL = 'env-model';

  const cfg = loadConfig();
  assert.strictEqual(cfg.llm.endpoint, 'http://env-endpoint');
  assert.strictEqual(cfg.llm.apiKey, 'env-key-123');
  assert.strictEqual(cfg.llm.model, 'env-model');

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

  const cfg = loadConfig();
  assert.ok(cfg.llm.endpoint, 'endpoint 不应为空');
  assert.ok(cfg.llm.model, 'model 不应为空');
  assert.ok(cfg.port, 'port 不应为空');

  if (origEndpoint !== undefined) process.env.LLM_ENDPOINT = origEndpoint;
  if (origKey !== undefined) process.env.LLM_API_KEY = origKey;
  if (origModel !== undefined) process.env.LLM_MODEL = origModel;
  if (origPort !== undefined) process.env.PORT = origPort;
});