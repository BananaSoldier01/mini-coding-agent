/**
 * tracker.js — 文件变更追踪（Run Net Diff）
 *
 * V0.3.2 修复：
 * - 使用 NON_EXISTENT sentinel 区分"文件不存在"与"空文件"
 * - record() 使用 oldContent 初始化 baseline
 * - getNetDiff() 由 baseline → current 计算净变更
 */

// ── Sentinel: 区分"文件不存在"与"空文件" ──────────────
const NON_EXISTENT = Symbol('NON_EXISTENT');

/**
 * 生成 unified diff（基于 LCS）
 */
function unifiedDiff(oldStr, newStr) {
  const oldLines = oldStr === '' ? [] : oldStr.split('\n');
  const newLines = newStr === '' ? [] : newStr.split('\n');
  const diff = [];
  const lcs = computeLCS(oldLines, newLines);

  let i = 0, j = 0;
  for (const match of lcs) {
    while (i < match.oldIdx) diff.push({ type: 'remove', content: oldLines[i++] });
    while (j < match.newIdx) diff.push({ type: 'add', content: newLines[j++] });
    i++; j++;
  }
  while (i < oldLines.length) diff.push({ type: 'remove', content: oldLines[i++] });
  while (j < newLines.length) diff.push({ type: 'add', content: newLines[j++] });

  return diff;
}

function computeLCS(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (a[i] === b[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
      else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const matches = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) { matches.push({ oldIdx: i, newIdx: j }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return matches;
}

function diffStats(diff) {
  let added = 0, removed = 0;
  for (const d of diff) {
    if (d.type === 'add') added++;
    else if (d.type === 'remove') removed++;
  }
  return { added, removed };
}

/**
 * 将内容转为可比较的字符串表示
 * NON_EXISTENT → null (表示文件不存在)
 * "" → "" (表示空文件)
 * "content" → "content"
 */
function contentKey(content) {
  if (content === NON_EXISTENT) return null;
  return content;
}

class ChangeTracker {
  constructor() {
    this.changes = [];              // 事件级记录
    this.baselineSnapshot = new Map(); // path → content | null (NON_EXISTENT)
    this.currentSnapshot = new Map();  // path → content | null (NON_EXISTENT)
  }

  /**
   * 记录文件变更
   * @param {object} change
   * @param {string} change.type - 'create' | 'modify' | 'delete'
   * @param {string} change.path
   * @param {string|symbol} change.oldContent - 修改前内容，NON_EXISTENT 表示不存在
   * @param {string|symbol} change.newContent - 修改后内容，NON_EXISTENT 表示已删除
   */
  record(change) {
    const { type, path: filePath, oldContent, newContent } = change;

    // 第一次修改此 path 时，用 oldContent 初始化 baseline
    if (!this.baselineSnapshot.has(filePath)) {
      // delete 操作：文件在 baseline 时存在（内容可能未知）
      // create/modify 操作：使用 oldContent（可能为 NON_EXISTENT 表示不存在）
      if (type === 'delete') {
        this.baselineSnapshot.set(filePath, oldContent !== undefined && oldContent !== NON_EXISTENT ? oldContent : '');
      } else {
        this.baselineSnapshot.set(filePath, oldContent !== undefined ? oldContent : NON_EXISTENT);
      }
    }

    // 更新 current
    if (type === 'delete') {
      this.currentSnapshot.set(filePath, NON_EXISTENT);
    } else {
      this.currentSnapshot.set(filePath, newContent !== undefined ? newContent : '');
    }

    this.changes.push({
      type,
      path: filePath,
      oldContent,
      newContent,
      timestamp: Date.now(),
    });
  }

  /**
   * Run 结束时计算净变更（baseline → current）
   */
  getNetDiff() {
    const allPaths = new Set([
      ...this.baselineSnapshot.keys(),
      ...this.currentSnapshot.keys(),
    ]);

    const files = [];
    for (const filePath of allPaths) {
      const oldVal = this.baselineSnapshot.get(filePath);
      const newVal = this.currentSnapshot.get(filePath);

      // oldVal === null → 文件在 baseline 时不存在
      // oldVal === '' → 文件在 baseline 时是空文件
      // newVal === null → 文件在 current 时不存在
      // newVal === '' → 文件在 current 时是空文件

      const oldExists = oldVal !== null && oldVal !== NON_EXISTENT;
      const newExists = newVal !== null && newVal !== NON_EXISTENT;

      // 两者都不存在 → 不应该发生，但跳过
      if (!oldExists && !newExists) continue;

      let type, diff, added = 0, removed = 0;

      if (!oldExists && newExists) {
        // 不存在 → 存在 = create
        type = 'create';
        added = newVal ? newVal.split('\n').length : 0;
      } else if (oldExists && !newExists) {
        // 存在 → 不存在 = delete
        type = 'delete';
        removed = oldVal ? oldVal.split('\n').length : 0;
      } else if (oldVal !== newVal) {
        // 存在 → 存在但内容不同 = modify
        type = 'modify';
        const oldStr = oldExists ? (oldVal || '') : '';
        const newStr = newExists ? (newVal || '') : '';
        diff = unifiedDiff(oldStr, newStr);
        const stats = diffStats(diff);
        added = stats.added;
        removed = stats.removed;
      } else {
        // 内容相同（包括 A→B→A 场景）→ 无净变化
        continue;
      }

      files.push({ path: filePath, type, diff, added, removed });
    }

    return { files, totalChanges: files.length };
  }

  /** Run 结束，将 current 升级为 baseline */
  commitRun() {
    this.baselineSnapshot = new Map(this.currentSnapshot);
    this.currentSnapshot.clear();
  }

  /** 获取所有变更的 diff 视图 */
  getDiff() {
    return this.changes.map((c) => ({
      type: c.type,
      path: c.path,
      timestamp: c.timestamp,
      diff: c.diff || null,
    }));
  }

  byFile() {
    const map = {};
    for (const c of this.changes) {
      if (!map[c.path]) map[c.path] = [];
      map[c.path].push(c);
    }
    return map;
  }

  clear() {
    this.changes = [];
    this.baselineSnapshot.clear();
    this.currentSnapshot.clear();
  }
}

export { ChangeTracker, unifiedDiff, diffStats, NON_EXISTENT };