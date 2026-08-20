/**
 * shellpolicy.js — Shell Capability Policy
 *
 * 从 denylist 正则思维改为 allowlist / capability 思维。
 *
 * 三级分类：
 *   SAFE       — 明确低风险，适合 Coding Agent 自动执行
 *   APPROVAL   — 无法明确判断安全 → 需要用户确认
 *   DENY       — 明确读取 Secret / 攻击 Harness 安全边界
 *
 * 原则：
 *   Unknown shell command ≠ SAFE
 *   Unknown shell command → REQUIRE_APPROVAL
 */

// ── SAFE: 明确低风险的命令前缀 ────────────────────────
// 格式: [风险组, 命令前缀, 允许的参数模式?]
const SAFE_COMMANDS = [
  // 文件浏览
  ['file', 'pwd', null],
  ['file', 'ls', null],
  ['file', 'tree', null],
  ['file', 'stat', null],
  ['file', 'file', null],
  ['file', 'test', null],
  ['file', 'true', null],
  ['file', 'false', null],

  // 文件操作（非破坏性）
  ['file', 'cat', null],
  ['file', 'head', null],
  ['file', 'tail', null],
  ['file', 'wc', null],
  ['file', 'sort', null],
  ['file', 'uniq', null],
  ['file', 'tr', null],
  ['file', 'cut', null],
  ['file', 'diff', null],
  ['file', 'cmp', null],
  ['file', 'md5sum', null],
  ['file', 'sha1sum', null],
  ['file', 'sha256sum', null],
  ['file', 'echo', null],
  ['file', 'printf', null],
  ['file', 'mkdir', null],
  ['file', 'cp', null],
  ['file', 'mv', null],
  ['file', 'touch', null],
  ['file', 'ln', null],
  ['file', 'chmod', null],  // 注意: chmod 777 会被拦截

  // Git
  ['git', 'git', null],

  // Node.js / npm
  ['node', 'node', null],
  ['node', 'npm', null],
  ['node', 'npx', null],
  ['node', 'node', null],

  // Python
  ['python', 'python', null],
  ['python', 'python3', null],
  ['python', 'pip', null],
  ['python', 'pip3', null],

  // 构建工具
  ['build', 'make', null],
  ['build', 'cmake', null],
  ['build', 'go', null],
  ['build', 'cargo', null],
  ['build', 'rustc', null],
  ['build', 'gcc', null],
  ['build', 'g++', null],
  ['build', 'clang', null],
  ['build', 'clang++', null],

  // 压缩/归档
  ['archive', 'tar', null],
  ['archive', 'gzip', null],
  ['archive', 'gunzip', null],
  ['archive', 'zip', null],
  ['archive', 'unzip', null],

  // 搜索
  ['search', 'grep', null],
  ['search', 'rg', null],
  ['search', 'find', null],
  ['search', 'ag', null],
  ['search', 'which', null],
  ['search', 'whereis', null],
  ['search', 'type', null],

  // 环境/系统信息
  ['info', 'date', null],
  ['info', 'whoami', null],
  ['info', 'id', null],
  ['info', 'uname', null],
  ['info', 'hostname', null],
  ['info', 'df', null],
  ['info', 'du', null],
  ['info', 'free', null],
  ['info', 'uptime', null],
  ['info', 'nproc', null],

  // 文本处理
  ['text', 'sed', null],
  ['text', 'awk', null],
  ['text', 'perl', null],

  // 包管理
  ['package', 'yarn', null],
  ['package', 'pnpm', null],
  ['package', 'bun', null],

  // 其他安全工具
  ['util', 'basename', null],
  ['util', 'dirname', null],
  ['util', 'realpath', null],
  ['util', 'readlink', null],
  ['util', 'env', null],
  ['util', 'printenv', null],
  ['util', 'xargs', null],
  ['util', 'tee', null],
  ['util', 'dircolors', null],
];

// ── DENY: 明确禁止 ────────────────────────────────────
// 读取 Secret、破坏系统、逃逸 sandbox
const DENY_PATTERNS = [
  // 读取敏感环境变量
  /^\s*(printenv|env)\s+.*(KEY|TOKEN|SECRET|PASSWORD|PASSWD|API)/i,
  /echo\s+\$[A-Z_]*(KEY|TOKEN|SECRET|PASSWORD|PASSWD|API)/i,

  // 读取敏感文件
  /cat\s+.*~\/\.ssh\//i,
  /cat\s+.*\/\.ssh\//i,
  /cat\s+.*\.env/i,
  /cat\s+.*\.npmrc/i,
  /cat\s+.*\.pem/i,
  /cat\s+.*\.key/i,
  /cat\s+.*\/etc\/passwd/i,
  /cat\s+.*\/etc\/shadow/i,
  /\/etc\/passwd/i,           // 任何读取 /etc/passwd 的命令
  /\/etc\/shadow/i,           // 任何读取 /etc/shadow 的命令

  // 系统破坏
  /^\s*(shutdown|reboot|halt|init\s+0|poweroff)\b/i,
  /^\s*mkfs\b/i,
  /^\s*dd\s+.*\/dev\//i,
  /^\s*rm\s+-[a-zA-Z]*r[a-zA-Z]*f?\s+\/(\s|$)/i,  // rm -rf /
  /^\s*rm\s+-[a-zA-Z]*r[a-zA-Z]*f?\s+\*/i,         // rm -rf *

  // 管道执行
  /\|\s*(sh|bash|zsh|ksh|dash|ash)\s*$/i,
  /;\s*(shutdown|reboot|halt|mkfs|dd|rm)\b/i,
  /&&\s*(shutdown|reboot|halt|mkfs|dd|rm)\b/i,

  // 权限提升
  /sudo\b/i,
  /su\s+-/i,
  /chmod\s+777\b/i,
  /chown\s+/i,

  // 网络传输到外部（curl | sh 模式）
  /^\s*(curl|wget)\s+.*\|\s*(sh|bash|zsh)\b/i,
];

// ── 需要审批的模式 ────────────────────────────────────
const APPROVAL_PATTERNS = [
  // 破坏性文件操作
  /^\s*rm\s+-[a-zA-Z]*r[a-zA-Z]*f?\s+/i,
  /^\s*rm\s+/i,  // 任何 rm

  // 网络操作
  /^\s*(curl|wget|nc|netcat|ssh|scp|rsync|ftp)\b/i,

  // 系统修改
  /^\s*(iptables|ufw|systemctl|service)\b/i,

  // 进程管理
  /^\s*(kill|killall|pkill)\b/i,

  // 重定向/清空
  /^\s*>\s*\//i,
  />\s*\/dev\//i,

  // 压缩包操作（可能包含大量文件）
  /^\s*(tar\s+.*-x|tar\s+.*-c)\b/i,
];

/**
 * 评估 Shell 命令风险等级
 *
 * @param {string} command
 * @returns { { decision: 'allow'|'deny'|'requireApproval', category: string, reason: string } }
 */
function evaluateShell(command) {
  if (!command || typeof command !== 'string') {
    return { decision: 'deny', category: 'shell_invalid', reason: '无效的命令' };
  }

  const trimmed = command.trim();

  // ── DENY 检查（最高优先级）─────────────────────────
  for (const pat of DENY_PATTERNS) {
    if (pat.test(trimmed)) {
      return {
        decision: 'deny',
        category: 'shell_secret',
        reason: `拒绝执行: 命令可能读取敏感信息或攻击 Harness 安全边界。`,
      };
    }
  }

  // ── SAFE 检查 ──────────────────────────────────────
  const firstWord = trimmed.split(/\s+/)[0];
  // 处理完整路径，如 /bin/ls
  const baseWord = firstWord.split('/').pop();

  for (const [group, prefix, paramPattern] of SAFE_COMMANDS) {
    if (baseWord === prefix) {
      // 检查危险参数
      if (baseWord === 'chmod' && /\b777\b/.test(trimmed)) {
        return {
          decision: 'requireApproval',
          category: 'shell_destructive',
          reason: 'chmod 777 是危险权限设置，需要确认。',
        };
      }
      if (baseWord === 'rm' || baseWord === 'rmdir') {
        return {
          decision: 'requireApproval',
          category: 'shell_destructive',
          reason: 'rm 命令会删除文件，需要确认。',
        };
      }
      return {
        decision: 'allow',
        category: `shell_${group}`,
        reason: '',
      };
    }
  }

  // ── APPROVAL 检查 ──────────────────────────────────
  for (const pat of APPROVAL_PATTERNS) {
    if (pat.test(trimmed)) {
      return {
        decision: 'requireApproval',
        category: 'shell_destructive',
        reason: `命令可能产生破坏性影响，需要确认。`,
      };
    }
  }

  // ── 未知命令 → APPROVAL ────────────────────────────
  return {
    decision: 'requireApproval',
    category: 'shell_unknown',
    reason: `未知命令 "${baseWord}"，无法判断安全性，需要用户确认。`,
  };
}

export { evaluateShell, SAFE_COMMANDS, DENY_PATTERNS, APPROVAL_PATTERNS };