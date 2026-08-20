/**
 * tracker.js — 文件变更追踪（Run Net Diff）
 *
 * V0.3 升级：从 event diff 升级为 run net diff。
 *
 * 每个 Run 维护：
 *   baselineSnapshot[path] → 上一个 Run 结束时的状态
 *   currentSnapshot[path] → 当前 Run 的当前状态
 *
 * Run 结束时由 baseline → current 计算净变更。
 * A → B → A 最终显示 No net change。
 */

/**
 * 生成 unified diff（基于 LCS）
 */
function unifiedDiff(oldStr, newStr) {
  const oldLines = oldStr ? oldStr.split('\n') : [];
  const newLines = newStr ? newStr.split('\n') : [];
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
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
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

class ChangeTracker {
  constructor() {
    this.changes = [];              // 事件级记录
    this.baselineSnapshot = new Map(); // path → content (上一个 Run 结束时)
    this.currentSnapshot = new Map();  // path → content (当前 Run)
  }

  /** 记录文件变更（运行时调用） */
  record(change) {
    const { type, path: filePath, oldContent, newContent } = change;

    if (type === 'delete') {
      this.currentSnapshot.delete(filePath);
    } else {
      this.currentSnapshot.set(filePath, newContent);
    }

    this.changes.push({
      type,
      path: filePath,
      oldContent,
      newContent,
      timestamp: Date.now(),
    });
  }

  /** Run 结束时计算净变更（baseline → current） */
  getNetDiff() {
    const allPaths = new Set([
      ...this.baselineSnapshot.keys(),
      ...this.currentSnapshot.keys(),
    ]);

    const files = [];
    for (const filePath of allPaths) {
      const oldContent = this.baselineSnapshot.get(filePath);
      const newContent = this.currentSnapshot.get(filePath);

      if (oldContent === undefined && newContent === undefined) continue;

      let type, diff, added = 0, removed = 0;

      if (oldContent === undefined && newContent !== undefined) {
        type = 'create';
        added = newContent ? newContent.split('\n').length : 0;
      } else if (oldContent !== undefined && newContent === undefined) {
        type = 'delete';
        removed = oldContent ? oldContent.split('\n').length : 0;
      } else if (oldContent !== newContent) {
        type = 'modify';
        diff = unifiedDiff(oldContent, newContent);
        const stats = diffStats(diff);
        added = stats.added;
        removed = stats.removed;
      } else {
        // A → B → A: 无净变化
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

  /** 获取所有变更的 diff 视图（兼容旧接口） */
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

export { ChangeTracker, unifiedDiff, diffStats };