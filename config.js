/**
 * config.js — 全局配置
 *
 * 敏感配置（API Key、Endpoint）从环境变量读取，不硬编码。
 * 支持本地 ~/.mini-agent/config.json 作为持久化配置。
 *
 * 配置优先级：
 *   显式环境变量 > 用户持久化配置 > 程序默认值
 *
 * "显式环境变量"指用户真正 export 的变量，不是 .env 加载的默认值。
 * 但 .env 是用户主动放置的配置文件，视为用户显式配置。
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

const CONFIG_DIR = path.join(os.homedir(), '.mini-agent');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

// ── .env 加载 ────────────────────────────────────────
/** 加载 .env 文件（从项目根目录），注入 process.env */
function loadDotEnv() {
  const envPath = path.join(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;
  try {
    const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim();
      if (key && !(key in process.env)) {
        process.env[key] = val;
      }
    }
  } catch (err) {
    console.warn('[config] .env 加载失败:', err.message);
  }
}
loadDotEnv();

// ── 默认值 ───────────────────────────────────────────
const DEFAULTS = {
  endpoint: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
  port: 38212,
};

// ── 环境变量读取 ──────────────────────────────────────
/** 从环境变量读取 LLM 配置（仅返回用户真正设置的值） */
function envConfig() {
  const result = {};
  if (process.env.LLM_ENDPOINT) result.endpoint = process.env.LLM_ENDPOINT;
  if (process.env.LLM_API_KEY) result.apiKey = process.env.LLM_API_KEY;
  if (process.env.LLM_MODEL) result.model = process.env.LLM_MODEL;
  if (process.env.PORT) result.port = parseInt(process.env.PORT, 10);
  if (process.env.WORKSPACE) result.workspace = process.env.WORKSPACE;
  return result;
}

// ── 文件配置 ─────────────────────────────────────────
/** 加载本地持久化配置 */
function loadFileConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
      return raw;
    }
  } catch (err) {
    console.warn('[config] 本地配置加载失败:', err.message);
  }
  return {};
}

/** 保存配置到本地文件 */
function saveFileConfig(cfg) {
  try {
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }
    // 设置文件权限为 0600（仅所有者读写）
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf-8');
    try { fs.chmodSync(CONFIG_FILE, 0o600); } catch {}
    return true;
  } catch (err) {
    console.warn('[config] 保存配置失败:', err.message);
    return false;
  }
}

// ── 遮盖工具 ─────────────────────────────────────────
/** 遮盖 API Key 用于前端展示 */
function maskApiKey(key) {
  if (!key) return '';
  if (key.length <= 8) return '••••';
  return key.slice(0, 4) + '••••••••••' + key.slice(-4);
}

// ── 合并配置 ─────────────────────────────────────────
/**
 * 合并配置：显式环境变量 > 用户持久化配置 > 程序默认值
 */
function loadConfig() {
  const fileCfg = loadFileConfig();
  const env = envConfig();

  return {
    llm: {
      endpoint: env.endpoint || fileCfg.llm?.endpoint || DEFAULTS.endpoint,
      apiKey: env.apiKey || fileCfg.llm?.apiKey || '',
      model: env.model || fileCfg.llm?.model || DEFAULTS.model,
    },
    port: env.port || fileCfg.port || DEFAULTS.port,
    workspace: env.workspace || fileCfg.workspace || path.join(process.cwd(), 'test-workspace'),
  };
}

export { loadConfig, saveFileConfig, maskApiKey, CONFIG_FILE, loadDotEnv };