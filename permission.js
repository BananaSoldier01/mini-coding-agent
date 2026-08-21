/**
 * permission.js — Permission Mode
 *
 * V0.4.0.1: 重构 Permission decision merge
 *
 * 合并规则（Base Policy 始终执行，不可跳过）：
 *
 * 1. Hard Deny 永远不可被 Mode 覆盖
 *    base=deny → 任何 mode 都 deny
 *
 * 2. Safe 模式：最大监督
 *    base=allow          → allow
 *    base=requireApproval → requireApproval（不可被 base allow 降级）
 *    base=deny           → deny
 *
 * 3. Standard 模式：默认
 *    base=allow          → allow
 *    base=requireApproval → requireApproval
 *    base=deny           → deny
 *
 * 4. Full Access 模式：高自主
 *    base=allow          → allow
 *    base=requireApproval → allow（降级为自动）
 *    base=deny           → deny（Hard Deny 不可覆盖）
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

/**
 * 合并 Permission Mode 与 Base Policy 决策
 *
 * @param {string} mode - Safe / Standard / Full Access
 * @param {string} baseDecision - Base Policy 的决策：allow / requireApproval / deny
 * @returns { 'allow' | 'requireApproval' | 'deny' }
 */
function mergePermission(mode, baseDecision) {
  // ── Hard Deny：永远不可被 Mode 覆盖 ────────────────
  if (baseDecision === BASE_DECISION.DENY) {
    return BASE_DECISION.DENY;
  }

  // ── Safe 模式 ──────────────────────────────────────
  if (mode === PERMISSION_MODES.SAFE) {
    // base=allow → allow
    // base=requireApproval → requireApproval（不可降级）
    return baseDecision; // allow → allow, requireApproval → requireApproval
  }

  // ── Standard 模式 ──────────────────────────────────
  if (mode === PERMISSION_MODES.STANDARD) {
    return baseDecision; // allow → allow, requireApproval → requireApproval
  }

  // ── Full Access 模式 ───────────────────────────────
  if (mode === PERMISSION_MODES.FULL_ACCESS) {
    // base=requireApproval → allow（降级为自动）
    // base=allow → allow
    if (baseDecision === BASE_DECISION.REQUIRE_APPROVAL) {
      return BASE_DECISION.ALLOW;
    }
    return baseDecision;
  }

  // 未知模式：默认 requireApproval
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

  /** 合并 Base Policy 决策 */
  merge(baseDecision) {
    return mergePermission(this.mode, baseDecision);
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