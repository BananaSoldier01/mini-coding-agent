/**
 * config.js — 全局配置
 *
 * 敏感配置（API Key、Endpoint）从环境变量读取，不硬编码。
 * 支持本地 ~/.mini-agent/config.json 作为持久化配置。
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

const CONFIG_DIR = path.join(os.homedir(), '.mini-agent');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

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

/** 从环境变量读取 LLM 配置 */
function envConfig() {
  return {
    llm: {
      endpoint: process.env.LLM_ENDPOINT || 'https://api.openai.com/v1',
      apiKey: process.env.LLM_API_KEY || '',
      model: process.env.LLM_MODEL || 'gpt-4o-mini',
    },
    port: parseInt(process.env.PORT, 10) || 38212,
    workspace: process.env.WORKSPACE || path.join(process.cwd(), 'test-workspace'),
  };
}

/** 加载本地持久化配置（与环境变量合并，环境变量优先） */
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

/** 保存配置到本地文件（用于前端修改 API Key 等） */
function saveFileConfig(cfg) {
  try {
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf-8');
    return true;
  } catch (err) {
    console.warn('[config] 保存配置失败:', err.message);
    return false;
  }
}

/** 遮盖 API Key 用于前端展示 */
function maskApiKey(key) {
  if (!key) return '';
  if (key.length <= 8) return '••••';
  return key.slice(0, 4) + '••••••••••' + key.slice(-4);
}

/** 合并配置：本地文件为底，环境变量覆盖 */
function loadConfig() {
  const fileCfg = loadFileConfig();
  const env = envConfig();
  return {
    llm: {
      endpoint: env.llm.endpoint || fileCfg.llm?.endpoint || '',
      apiKey: env.llm.apiKey || fileCfg.llm?.apiKey || '',
      model: env.llm.model || fileCfg.llm?.model || 'gpt-4o-mini',
    },
    port: env.port,
    workspace: env.workspace || fileCfg.workspace || path.join(process.cwd(), 'test-workspace'),
  };
}

export { loadConfig, saveFileConfig, maskApiKey, CONFIG_FILE };