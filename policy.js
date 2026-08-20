/**
 * policy.js — 统一 Tool Execution Policy
 *
 * 职责：
 *   对每个 tool call 进行策略评估，返回 allow / deny / requireApproval。
 *   不再由各 Tool 自行抛特殊 Error 决定审批。
 *
 * Policy 评估维度：
 *   - tool 级别风险（delete_file 等）
 *   - 参数级风险（路径、命令内容）
 *   - 风险分类：file_destructive / shell_destructive / shell_network / shell_secret
 */

import path from 'path';

// ── 风险等级 ──────────────────────────────────────────
const RISK = {
  SAFE: 'safe',                  // 直接执行
  REQUIRE_APPROVAL: 'approval',  // 需要用户确认
  DENY: 'deny',                  // 拒绝执行
};

// ── 风险分类 ──────────────────────────────────────────
const RISK_CATEGORY = {
  FILE_READ: 'file_read',
  FILE_WRITE: 'file_write',
  FILE_DESTRUCTIVE: 'file_destructive',
  SHELL_SAFE: 'shell_safe',
  SHELL_DESTRUCTIVE: 'shell_destructive',
  SHELL_NETWORK: 'shell_network',
  SHELL_SECRET: 'shell_secret',
  SHELL_SYSTEM: 'shell_system',
};

// ── 敏感环境变量名（Agent Shell 不得继承）────────────
const SECRET_ENV_KEYS = new Set([
  'LLM_API_KEY', 'LLM_ENDPOINT', 'LLM_MODEL',
  'ANTHROPIC_API_KEY', 'OPENAI_API_KEY',
  'API_KEY', 'APIKEY', 'SECRET', 'PASSWORD', 'PASSWD',
  'TOKEN', 'AUTH_TOKEN', 'ACCESS_TOKEN',
  'PRIVATE_KEY', 'SSH_KEY', 'GITHUB_TOKEN',
  'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY',
  'GCP_SERVICE_ACCOUNT_KEY', 'AZURE_CLIENT_SECRET',
]);

// ── 网络命令特征 ──────────────────────────────────────
const NETWORK_COMMAND_RE = /^\s*(curl|wget|nc|netcat|ssh|scp|rsync|ftp|http|https)\b/i;
const PIPE_TO_SHELL_RE = /\|\s*(sh|bash|zsh|ksh|dash)\b/;

// ── 破坏性命令特征 ────────────────────────────────────
const DESTRUCTIVE_PATTERNS = [
  /^\s*rm\s+-[a-zA-Z]*r[a-zA-Z]*f?\s+\//,     // rm -rf /
  /^\s*rm\s+-[a-zA-Z]*r[a-zA-Z]*f?\s+\*/,     // rm -rf *
  /^\s*dd\s+/,                                // dd
  /^\s*mkfs/,                                 // mkfs
  /^\s*shutdown/,                             // shutdown
  /^\s*reboot/,                               // reboot
  /^\s*halt/,                                 // halt
  /^\s*init\s+0/,                             // init 0
  /^\s*:>\s*\*/,                              // :> *
  /;\s*rm\s+-rf/,                             // ; rm -rf
  /&&\s*rm\s+-rf/,                            // && rm -rf
  /^\s*chmod\s+777/,                          // chmod 777
  /^\s*chown\s+/,                             // chown
  /^\s*iptables/,                             // iptables
  /^\s*ufw\s/,                                // ufw
];

// ── 系统级命令特征 ────────────────────────────────────
const SYSTEM_COMMAND_RE = /^\s*(shutdown|reboot|halt|init\s+0|mkfs|dd\s+\/dev)\b/i;

/**
 * 判断 Shell 命令的风险分类
 */
function classifyShell(command) {
  if (!command || typeof command !== 'string') return RISK_CATEGORY.SHELL_SAFE;

  const trimmed = command.trim();

  // 系统级
  if (SYSTEM_COMMAND_RE.test(trimmed)) return RISK_CATEGORY.SHELL_SYSTEM;

  // 破坏性
  for (const pat of DESTRUCTIVE_PATTERNS) {
    if (pat.test(trimmed)) return RISK_CATEGORY.SHELL_DESTRUCTIVE;
  }

  // 管道执行
  if (PIPE_TO_SHELL_RE.test(trimmed)) return RISK_CATEGORY.SHELL_DESTRUCTIVE;

  // 网络
  if (NETWORK_COMMAND_RE.test(trimmed)) return RISK_CATEGORY.SHELL_NETWORK;

  return RISK_CATEGORY.SHELL_SAFE;
}

/**
 * 判断命令是否包含敏感环境变量读取
 */
function readsSecrets(command) {
  if (!command) return false;
  return /printenv\s+|echo\s+\$[A-Z_]*KEY|echo\s+\$[A-Z_]*TOKEN|echo\s+\$[A-Z_]*SECRET/i.test(command);
}

/**
 * Tool Policy — 统一评估 tool call
 *
 * @param {object} toolDef - 工具定义 { name, description, input_schema, execute, dangerous }
 * @param {object} args - 工具参数
 * @param {object} ctx - 执行上下文 { sandbox, tracker, workspace, config }
 * @returns { { decision: 'allow'|'deny'|'requireApproval', category: string, reason: string } }
 */
function evaluate(toolDef, args, ctx) {
  const toolName = toolDef.name;

  // ── File tools ──────────────────────────────────────
  if (toolName === 'list_directory' || toolName === 'search_files') {
    return {
      decision: RISK.SAFE,
      category: RISK_CATEGORY.FILE_READ,
      reason: '',
    };
  }

  if (toolName === 'delete_file') {
    return {
      decision: RISK.REQUIRE_APPROVAL,
      category: RISK_CATEGORY.FILE_DESTRUCTIVE,
      reason: 'delete_file 会永久删除文件或目录，需要确认。',
    };
  }

  if (toolName === 'write_file' || toolName === 'edit_file') {
    // 检查是否试图写入敏感文件
    const targetPath = args.path || '';
    if (isSensitiveFilePath(targetPath)) {
      return {
        decision: RISK.DENY,
        category: RISK_CATEGORY.FILE_DESTRUCTIVE,
        reason: `拒绝写入敏感文件: ${targetPath}。Agent 不应修改 .env、密钥等敏感文件。`,
      };
    }
    return {
      decision: RISK.SAFE,
      category: RISK_CATEGORY.FILE_WRITE,
      reason: '',
    };
  }

  if (toolName === 'read_file') {
    const targetPath = args.path || '';
    if (isSensitiveFilePath(targetPath)) {
      return {
        decision: RISK.DENY,
        category: RISK_CATEGORY.FILE_READ,
        reason: `拒绝读取敏感文件: ${targetPath}。`,
      };
    }
    return {
      decision: RISK.SAFE,
      category: RISK_CATEGORY.FILE_READ,
      reason: '',
    };
  }

  // ── Shell tools ─────────────────────────────────────
  if (toolName === 'run_command') {
    const command = args.command || '';

    // 读取敏感环境变量
    if (readsSecrets(command)) {
      return {
        decision: RISK.DENY,
        category: RISK_CATEGORY.SHELL_SECRET,
        reason: `拒绝执行读取敏感环境变量的命令: ${command}。`,
      };
    }

    const category = classifyShell(command);

    switch (category) {
      case RISK_CATEGORY.SHELL_SYSTEM:
        return {
          decision: RISK.REQUIRE_APPROVAL,
          category,
          reason: `系统级命令，可能影响主机: ${command}。需要确认。`,
        };
      case RISK_CATEGORY.SHELL_DESTRUCTIVE:
        return {
          decision: RISK.REQUIRE_APPROVAL,
          category,
          reason: `破坏性命令: ${command}。需要确认。`,
        };
      case RISK_CATEGORY.SHELL_NETWORK:
        return {
          decision: RISK.REQUIRE_APPROVAL,
          category,
          reason: `网络命令，可能访问外部资源: ${command}。需要确认。`,
        };
      case RISK_CATEGORY.SHELL_SAFE:
      default:
        return {
          decision: RISK.SAFE,
          category,
          reason: '',
        };
    }
  }

  // ── 未知工具 ────────────────────────────────────────
  return {
    decision: RISK.DENY,
    category: 'unknown',
    reason: `未知工具: ${toolName}。`,
  };
}

/**
 * 判断路径是否敏感（.env、密钥文件等）
 */
/**
 * 判断路径是否敏感（.env、密钥文件等）
 * 使用 basename / extension / path component 精确匹配，而非简单的 includes。
 */
function isSensitiveFilePath(p) {
  if (!p) return false;
  const normalized = p.replace(/\\/g, '/').toLowerCase();
  const parts = normalized.split('/').filter(Boolean);
  const basename = parts.length > 0 ? parts[parts.length - 1] : '';
  const ext = path.extname(basename).toLowerCase();

  // 精确 basename 匹配
  const sensitiveBasenames = new Set([
    '.env', '.env.local', '.env.development', '.env.production',
    '.env.staging', '.env.test', '.npmrc', '.git-credentials',
    '.dockerenv', '.netrc',
  ]);
  if (sensitiveBasenames.has(basename)) return true;

  // .env 前缀变体
  if (basename.startsWith('.env')) return true;

  // 密钥/证书扩展名
  const sensitiveExtensions = new Set([
    '.pem', '.key', '.p12', '.pfx', '.jks', '.keystore',
    '.crt', '.cer', '.der', '.csr', '.srl',
  ]);
  if (sensitiveExtensions.has(ext)) return true;

  // 密钥文件名模式
  const keyNamePatterns = [
    /^id_(rsa|ed25519|ec|dsa)$/i,
    /^.*_(private|secret|credentials)$/i,
  ];
  for (const pat of keyNamePatterns) {
    if (pat.test(basename)) return true;
  }

  // 敏感目录 component
  const sensitiveDirs = new Set(['.ssh', '.aws', '.gcp', '.azure', '.kube']);
  for (const part of parts) {
    if (sensitiveDirs.has(part)) return true;
  }

  // 特殊文件名
  if (basename === 'credentials' || basename === 'secrets' ||
      basename === 'service-account.json' || basename === 'authorized_keys') {
    return true;
  }

  return false;
}

/**
 * 构建安全的 Shell 环境变量（剔除敏感 key）
 */
function safeEnv(extraEnv = {}) {
  const safe = {};
  const allowedKeys = [
    'PATH', 'HOME', 'USER', 'SHELL',
    'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM',
    'TMPDIR', 'TEMP', 'TMP',
    'PWD', 'OLDPWD',
    'NODE_ENV', 'NODE_PATH',
    'npm_config_prefix', 'npm_config_registry',
    'EDITOR', 'VISUAL',
    'LANG', 'COLOR', 'NO_COLOR',
    'CI', 'CONTINUOUS_INTEGRATION',
    'FORCE_COLOR', 'TERM_PROGRAM',
    'TERM_PROGRAM_VERSION', 'TERM_SESSION_ID',
    'SHLVL', '_', 'PWD',
    // 项目相关
    'PORT', 'WORKSPACE',
  ];

  for (const key of allowedKeys) {
    if (key in process.env) {
      safe[key] = process.env[key];
    }
  }

  // 合并额外环境变量（由调用方显式传入）
  for (const [k, v] of Object.entries(extraEnv)) {
    safe[k] = v;
  }

  return safe;
}

/**
 * 验证 timeout 在合理范围
 */
function clampTimeout(timeout) {
  const min = 1000;     // 最小 1 秒
  const max = 120000;   // 最大 2 分钟
  if (typeof timeout !== 'number' || isNaN(timeout)) return 30000;
  return Math.min(Math.max(timeout, min), max);
}

export {
  RISK,
  RISK_CATEGORY,
  SECRET_ENV_KEYS,
  evaluate,
  classifyShell,
  readsSecrets,
  safeEnv,
  clampTimeout,
  isSensitiveFilePath,
};