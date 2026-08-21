/**
 * permission.js — Permission Mode
 *
 * V0.4.0.2: 真正实现 Safe / Standard / Full Access 三档差异
 *
 * Safe = 最大监督：只读自动，修改/执行全部需要审批
 * Standard = 日常默认：按 Base Policy 执行
 * Full Access = 高自主：减少审批，但 Hard Deny 不可覆盖
 *
 * 合并规则：
 * 1. Hard Deny 永远不可被 Mode 覆盖
 * 2. Safe: write/edit/delete/shell → requireApproval（即使 base=allow）
 * 3. Standard: 按 base 决策
 * 4. Full Access: requireApproval → allow
 */

// ── Permission Modes ──────────────────────────────────
const PERMISSION_MODES = {
  SAFE: 'safe',
  STANDARD: 'standard',
  FULL_ACCESS: 'full_access',
};

const MODE_LABELS = {
  [PERMISSION_MODES.SAFE]: 'Safe',
  [PERMISSION_MODES.STANDARD]: 'Standard',
  [PERMISSION_MODES.FULL_ACCESS]: 'Full Access',
};

const MODE_DESCRIPTIONS = {
  [PERMISSION_MODES.SAFE]: '最大监督，适合陌生项目或重要 Workspace',
  [PERMISSION_MODES.STANDARD]: '日常使用默认模式，在效率和控制之间平衡',
  [PERMISSION_MODES.FULL_ACCESS]: '高自主权限，减少 Approval interruption',
};

const DEFAULT_MODE = PERMISSION_MODES.STANDARD;

// ── Base Policy Decisions ─────────────────────────────
const BASE_DECISION = {
  ALLOW: 'allow',
  REQUIRE_APPROVAL: 'requireApproval',
  DENY: 'deny',
};

// ── Tool Categories that Safe mode always requires approval for ──
const SAFE_REQUIRE_APPROVAL_CATEGORIES = new Set([
  'file_write',
  'file_edit',
  'file_delete',
  'shell', 'shell_composite', 'shell_unknown', 'shell_destructive',
  'shell_git_mutation',
  'network',
  'dependency_install',
  'project_script',
  'git_mutation',
]);

/**
 * 合并 Permission Mode 与 Base Policy 决策
 *
 * @param {object} opts
 * @param {string} opts.mode - Safe / Standard / Full Access
 * @param {string} opts.baseDecision - Base Policy: allow / requireApproval / deny
 * @param {string} opts.baseCategory - 工具类别
 * @param {string} opts.toolName - 工具名称
 * @returns { 'allow' | 'requireApproval' | 'deny' }
 */
function mergePermission({ mode, baseDecision, baseCategory, toolName }) {
  // ── Hard Deny：永远不可被 Mode 覆盖 ────────────────
  if (baseDecision === BASE_DECISION.DENY) {
    return BASE_DECISION.DENY;
  }

  // ── Safe 模式：最大监督 ────────────────────────────
  if (mode === PERMISSION_MODES.SAFE) {
    // 只读操作：允许
    const SAFE_ALLOW_CATEGORIES = new Set([
      'file_read', 'file_search', 'file_list', 'file_stat',
      'git_read',
    ]);
    if (SAFE_ALLOW_CATEGORIES.has(baseCategory)) {
      return BASE_DECISION.ALLOW;
    }
    // 修改/执行操作：全部需要审批（即使 base=allow）
    return BASE_DECISION.REQUIRE_APPROVAL;
  }

  // ── Standard 模式：日常默认 ─────────────────────────
  if (mode === PERMISSION_MODES.STANDARD) {
    return baseDecision; // allow → allow, requireApproval → requireApproval
  }

  // ── Full Access 模式：高自主 ───────────────────────
  if (mode === PERMISSION_MODES.FULL_ACCESS) {
    if (baseDecision === BASE_DECISION.REQUIRE_APPROVAL) {
      return BASE_DECISION.ALLOW; // 降级为自动
    }
    return baseDecision;
  }

  return BASE_DECISION.REQUIRE_APPROVAL;
}

/**
 * PermissionMode — Session 级权限模式
 */
class PermissionMode {
  constructor(mode = DEFAULT_MODE) {
    this.mode = mode;
  }

  setMode(mode) {
    if (!Object.values(PERMISSION_MODES).includes(mode)) {
      throw new Error(`无效的 Permission Mode: ${mode}`);
    }
    this.mode = mode;
  }

  getMode() {
    return this.mode;
  }

  is(mode) {
    return this.mode === mode;
  }

  merge(baseDecision, baseCategory, toolName) {
    return mergePermission({ mode: this.mode, baseDecision, baseCategory, toolName });
  }
}

/** 获取模式的 UI 标签 */
function getModeLabel(mode) {
  return MODE_LABELS[mode] || mode;
}

/** 获取模式的 UI 描述 */
function getModeDescription(mode) {
  return MODE_DESCRIPTIONS[mode] || '';
}

/** 获取所有可用模式 */
function getAvailableModes() {
  return Object.values(PERMISSION_MODES);
}

/** 校验 mode 是否合法 */
function isValidMode(mode) {
  return Object.values(PERMISSION_MODES).includes(mode);
}

export {
  PermissionMode,
  PERMISSION_MODES,
  MODE_LABELS,
  MODE_DESCRIPTIONS,
  DEFAULT_MODE,
  BASE_DECISION,
  mergePermission,
  getModeLabel,
  getModeDescription,
  getAvailableModes,
  isValidMode,
};