/**
 * shellpolicy.js — Shell Operation Policy
 *
 * V0.3.1: 从 executable allowlist 升级为 operation allowlist。
 *
 * 核心原则：
 *   Allow operations, not executables.
 *   Unknown → REQUIRE_APPROVAL
 *
 * 三级分类：
 *   SAFE       — 明确低风险操作，适合 Coding Agent 自动执行
 *   APPROVAL   — 无法明确判断安全 → 需要用户确认
 *   DENY       — 明确读取 Secret / 攻击 Harness 安全边界
 */

// ── SAFE: 明确低风险的操作（按 operation，不按 executable）──
const SAFE_OPERATIONS = [
  // 文件浏览（只读）
  { op: 'pwd', match: (c) => /^\s*pwd\b/.test(c) },
  { op: 'ls', match: (c) => /^\s*ls\b/.test(c) },
  { op: 'tree', match: (c) => /^\s*tree\b/.test(c) },
  { op: 'stat', match: (c) => /^\s*stat\b/.test(c) },
  { op: 'file', match: (c) => /^\s*file\b/.test(c) },

  // Git 只读操作（仅明确 argv，不使用通配符）
  { op: 'git_status', match: (c) => /^\s*git\s+status\b/.test(c) },
  { op: 'git_diff', match: (c) => /^\s*git\s+diff\b/.test(c) },
  { op: 'git_log', match: (c) => /^\s*git\s+log\b/.test(c) },
  { op: 'git_branch_show', match: (c) => /^\s*git\s+branch\s+--show-current\b/.test(c) },
  { op: 'git_branch_list', match: (c) => /^\s*git\s+branch\b(?!.*--show-current)/.test(c) },
  { op: 'git_remote_list', match: (c) => /^\s*git\s+remote\b/.test(c) },
  { op: 'git_remote_verbose', match: (c) => /^\s*git\s+remote\s+-v\b/.test(c) },

  // 文本查看（只读，不涉及敏感路径）
  { op: 'cat_normal', match: (c) => {
    if (!/^\s*cat\b/.test(c)) return false;
    // 排除敏感路径
    if (/\.env|\.npmrc|\.pem|\.key|\.p12|\.ssh\/|\/etc\/passwd|\/etc\/shadow|id_rsa|id_ed25519/i.test(c)) return false;
    return true;
  }},

  { op: 'head', match: (c) => /^\s*head\b/.test(c) },
  { op: 'tail', match: (c) => /^\s*tail\b/.test(c) },
  { op: 'wc', match: (c) => /^\s*wc\b/.test(c) },
  { op: 'sort', match: (c) => /^\s*sort\b/.test(c) },
  { op: 'uniq', match: (c) => /^\s*uniq\b/.test(c) },
  { op: 'tr', match: (c) => /^\s*tr\b/.test(c) },
  { op: 'cut', match: (c) => /^\s*cut\b/.test(c) },
  { op: 'diff_files', match: (c) => /^\s*diff\b/.test(c) },
  { op: 'cmp', match: (c) => /^\s*cmp\b/.test(c) },
  { op: 'md5sum', match: (c) => /^\s*md5sum\b/.test(c) },
  { op: 'sha256sum', match: (c) => /^\s*sha256sum\b/.test(c) },

  // 构建/测试（项目定义的 script — 默认 REQUIRE_APPROVAL，见 APPROVAL_PATTERNS）
  // V0.3.3: Agent 可修改 package.json 后执行 npm script = 间接执行任意代码
  // 移除 SAFE 分类，全部走 APPROVAL_PATTERNS

  // 环境信息（只读）
  { op: 'date', match: (c) => /^\s*date\b/.test(c) },
  { op: 'whoami', match: (c) => /^\s*whoami\b/.test(c) },
  { op: 'id', match: (c) => /^\s*id\b/.test(c) },
  { op: 'uname', match: (c) => /^\s*uname\b/.test(c) },
  { op: 'hostname', match: (c) => /^\s*hostname\b/.test(c) },
  { op: 'df', match: (c) => /^\s*df\b/.test(c) },
  { op: 'du', match: (c) => /^\s*du\b/.test(c) },
  { op: 'free', match: (c) => /^\s*free\b/.test(c) },
  { op: 'uptime', match: (c) => /^\s*uptime\b/.test(c) },
  { op: 'nproc', match: (c) => /^\s*nproc\b/.test(c) },
  { op: 'which', match: (c) => /^\s*which\b/.test(c) },
  { op: 'whereis', match: (c) => /^\s*whereis\b/.test(c) },
  { op: 'type', match: (c) => /^\s*type\b/.test(c) },
  { op: 'basename', match: (c) => /^\s*basename\b/.test(c) },
  { op: 'dirname', match: (c) => /^\s*dirname\b/.test(c) },
  { op: 'realpath', match: (c) => /^\s*realpath\b/.test(c) },
  { op: 'readlink', match: (c) => /^\s*readlink\b/.test(c) },
  { op: 'true', match: (c) => /^\s*true\b/.test(c) },
  { op: 'false', match: (c) => /^\s*false\b/.test(c) },
  { op: 'echo_normal', match: (c) => {
    if (!/^\s*echo\b/.test(c)) return false;
    // 排除 echo secret
    if (/\$[A-Z_]*(KEY|TOKEN|SECRET|PASSWORD|PASSWD|API)/i.test(c)) return false;
    return true;
  }},
];

// ── DENY: 明确禁止 ────────────────────────────────────
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
  /\/etc\/passwd/i,
  /\/etc\/shadow/i,

  // 系统破坏
  /^\s*(shutdown|reboot|halt|init\s+0|poweroff)\b/i,
  /^\s*mkfs\b/i,
  /^\s*dd\s+.*\/dev\//i,
  /^\s*rm\s+-[a-zA-Z]*r[a-zA-Z]*f?\s+\/(\s|$)/i,
  /^\s*rm\s+-[a-zA-Z]*r[a-zA-Z]*f?\s+\*/i,

  // 管道执行
  /\|\s*(sh|bash|zsh|ksh|dash|ash)\s*$/i,
  /;\s*(shutdown|reboot|halt|mkfs|dd|rm)\b/i,
  /&&\s*(shutdown|reboot|halt|mkfs|dd|rm)\b/i,

  // 权限提升
  /sudo\b/i,
  /su\s+-/i,
  /chmod\s+777\b/i,
  /chown\s+/i,

  // 网络传输到外部
  /^\s*(curl|wget)\s+.*\|\s*(sh|bash|zsh)\b/i,
];

// ── APPROVAL: 需要确认的操作模式 ──────────────────────
const APPROVAL_PATTERNS = [
  // 任意代码执行（即使 executable 已知）
  /^\s*python[23]?\s+-c\b/i,
  /^\s*python[23]?\s+-m\b/i,
  /^\s*node\s+-e\b/i,
  /^\s*node\s+--eval\b/i,
  /^\s*perl\s+-e\b/i,
  /^\s*ruby\s+-e\b/i,

  // 包管理
  /^\s*npm\s+install\b/i,
  /^\s*npm\s+uninstall\b/i,
  /^\s*npm\s+exec\b/i,
  /^\s*npx\b/i,
  // 项目脚本（Agent 可修改 package.json 后执行 = 间接任意代码）
  /^\s*npm\s+test\b/i,
  /^\s*npm\s+run\s+(test|build|lint|typecheck|type-check)\b/i,
  /^\s*pip\s+install\b/i,
  /^\s*pip3\s+install\b/i,
  /^\s*yarn\s+add\b/i,
  /^\s*pnpm\s+add\b/i,
  /^\s*bun\s+add\b/i,

  // Git 写操作
  /^\s*git\s+reset\b/i,
  /^\s*git\s+checkout\b/i,
  /^\s*git\s+clean\b/i,
  /^\s*git\s+config\b/i,
  /^\s*git\s+commit\b/i,
  /^\s*git\s+push\b/i,
  /^\s*git\s+merge\b/i,
  /^\s*git\s+rebase\b/i,
  /^\s*git\s+tag\b/i,
  /^\s*git\s+stash\b/i,
  /^\s*git\s+restore\b/i,
  /^\s*git\s+rm\b/i,
  // Git branch 远程/删除 mutation
  /^\s*git\s+branch\s+-[a-zA-Z]*[dD]/i,
  /^\s*git\s+remote\s+(add|remove|set-url)\b/i,

  // 文件系统操作
  /^\s*rm\b/i,
  /^\s*rmdir\b/i,
  /^\s*cp\b/i,
  /^\s*mv\b/i,
  /^\s*ln\b/i,
  /^\s*chmod\b/i,
  /^\s*chown\b/i,
  /^\s*tee\b/i,

  // 网络操作
  /^\s*(curl|wget|nc|netcat|ssh|scp|rsync|ftp)\b/i,

  // 压缩/归档
  /^\s*tar\b/i,
  /^\s*gzip\b/i,
  /^\s*gunzip\b/i,
  /^\s*zip\b/i,
  /^\s*unzip\b/i,

  // 进程管理
  /^\s*(kill|killall|pkill)\b/i,

  // 重定向
  /^\s*>\s*\//i,
  />\/dev\//i,
];

// ── Shell composition 检测 ────────────────────────────
// 如果命令包含 shell composition，不能视为单一 SAFE operation
const SHELL_COMPOSITION = /(;|&&|\|\||\||>|<|\$\(|`)/;

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

  // ── Shell composition 检测 ──────────────────────────
  // 包含 ; && || | > < $() `` 的命令不是单一 operation，默认 REQUIRE_APPROVAL
  if (SHELL_COMPOSITION.test(trimmed)) {
    return {
      decision: 'requireApproval',
      category: 'shell_composite',
      reason: `命令包含 shell 组合符 (; && || | > < $() \`)，不是单一安全操作，需要确认。`,
    };
  }

  // ── SAFE 检查（operation-based）─────────────────────
  for (const { op, match } of SAFE_OPERATIONS) {
    if (match(trimmed)) {
      return {
        decision: 'allow',
        category: `shell_${op}`,
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
        reason: `命令可能产生破坏性影响或执行任意代码，需要确认。`,
      };
    }
  }

  // ── 未知命令 → APPROVAL ────────────────────────────
  const firstWord = trimmed.split(/\s+/)[0];
  const baseWord = firstWord.split('/').pop();
  return {
    decision: 'requireApproval',
    category: 'shell_unknown',
    reason: `未知命令 "${baseWord}"，无法判断安全性，需要用户确认。`,
  };
}

export { evaluateShell, SAFE_OPERATIONS, DENY_PATTERNS, APPROVAL_PATTERNS };