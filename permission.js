/**
 * permission.js — Permission Mode
 *
 * V0.4.0: 将底层 Policy 机制包装成用户能理解的三档 Permission Mode。
 *
 * 架构：
 *   Permission Mode (Safe/Standard/Full Access)
 *         ↓
 *   Policy Layer (evaluatePermission)
 *         ↓
 *   allow / requireApproval / deny
 *         ↓
 *   Tool execution
 *
 * 底层 Policy 是统一事实源。UI Preset 与底层 Policy 解耦。
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

// ── 默认模式 ──────────────────────────────────────────
const DEFAULT_MODE = PERMISSION_MODES.STANDARD;

/**
 * PermissionMode — Session 级权限模式
 *
 * 每个 Session 保存自己的 Permission Mode。
 * 切换 Session 后恢复该 Session 的 Mode。
 * 新 Session 默认为 Standard。
 */
class PermissionMode {
  constructor(mode = DEFAULT_MODE) {
    this.mode = mode;
  }

  /** 切换模式 */
  setMode(mode) {
    if (!Object.values(PERMISSION_MODES).includes(mode)) {
      throw new Error(`无效的 Permission Mode: ${mode}`);
    }
    this.mode = mode;
  }

  /** 获取当前模式 */
  getMode() {
    return this.mode;
  }

  /** 是否为指定模式 */
  is(mode) {
    return this.mode === mode;
  }

  /** 判断某 tool 是否需要审批 */
  requiresApproval(toolName, category, risk) {
    return evaluatePermission(this.mode, toolName, category, risk) === 'requireApproval';
  }

  /** 判断某 tool 是否被拒绝 */
  isDenied(toolName, category, risk) {
    return evaluatePermission(this.mode, toolName, category, risk) === 'deny';
  }
}

/**
 * 核心：根据 Permission Mode + Tool 属性返回 Policy Decision
 *
 * @param {string} mode - Safe / Standard / Full Access
 * @param {string} toolName - 工具名称
 * @param {string} category - 工具类别（file_write / shell / git / network / delete 等）
 * @param {string} risk - 风险等级（low / medium / high）
 * @returns { 'allow' | 'requireApproval' | 'deny' }
 */
function evaluatePermission(mode, toolName, category, risk = 'medium') {
  // ── Deny：硬拒绝（所有模式下都拒绝）─────────────────
  const HARD_DENY_CATEGORIES = new Set([
    'sensitive_file',
    'secret_read',
    'system_destructive',
  ]);
  if (HARD_DENY_CATEGORIES.has(category)) {
    return 'deny';
  }

  // ── Safe 模式：最大监督 ─────────────────────────────
  if (mode === PERMISSION_MODES.SAFE) {
    // 只读操作自动允许
    const SAFE_CATEGORIES = new Set([
      'file_read', 'file_search', 'file_list', 'file_stat',
      'git_read', 'shell_read',
    ]);
    if (SAFE_CATEGORIES.has(category)) {
      return 'allow';
    }
    // 其他全部需要审批
    return 'requireApproval';
  }

  // ── Standard 模式：默认模式 ──────────────────────────
  if (mode === PERMISSION_MODES.STANDARD) {
    // 自动允许
    const AUTO_ALLOW_CATEGORIES = new Set([
      'file_read', 'file_search', 'file_list', 'file_stat',
      'file_write', 'file_edit',          // workspace 内正常写入/编辑
      'git_read',
      'shell_read',
    ]);
    if (AUTO_ALLOW_CATEGORIES.has(category)) {
      return 'allow';
    }
    // 需要审批
    const REQUIRE_APPROVAL_CATEGORIES = new Set([
      'file_delete',
      'shell', 'shell_composite', 'shell_unknown',
      'shell_destructive',
      'git_mutation',
      'network',
      'dependency_install',
      'project_script',
    ]);
    if (REQUIRE_APPROVAL_CATEGORIES.has(category)) {
      return 'requireApproval';
    }
    // 未知 → 审批
    return 'requireApproval';
  }

  // ── Full Access 模式：高自主 ─────────────────────────
  if (mode === PERMISSION_MODES.FULL_ACCESS) {
    // 几乎全部自动，仅保留极少数 Hard Deny
    return 'allow';
  }

  return 'requireApproval';
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

export {
  PermissionMode,
  PERMISSION_MODES,
  MODE_LABELS,
  MODE_DESCRIPTIONS,
  DEFAULT_MODE,
  evaluatePermission,
  getModeLabel,
  getModeDescription,
  getAvailableModes,
};