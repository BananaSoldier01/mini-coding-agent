/**
 * tracker.js — 文件变更追踪
 *
 * 记录 Agent 对 workspace 文件的所有修改。
 * 提供准确的 create / modify / delete 记录和 unified diff。
 *
 * 注意：V0.2 不提供 rollback 功能。此模块仅用于 diff 展示和变更统计。
 */

/**
 * 生成 unified diff（简化版，非完整算法）
 * 基于 LCS 的最小 diff，保证准确性。
 */
function unifiedDiff(oldStr, newStr, path = '') {
  const oldLines = oldStr ? oldStr.split('\n') : [];
  const newLines = newStr ? newStr.split('\n') : [];

  // 构建 diff 片段
  const diff = [];
  const maxLen = Math.max(oldLines.length, newLines.length);

  // 简化策略：逐行比较，标记变更
  // 对于插入/删除导致的行号偏移，使用 LCS 对齐
  const lcs = computeLCS(oldLines, newLines);

  let i = 0, j = 0;
  let oldLineNo = 1, newLineNo = 1;

  for (const match of lcs) {
    // 输出 old 中非匹配的行（删除）
    while (i < match.oldIdx) {
      diff.push({ type: 'remove', oldLine: oldLineNo++, content: oldLines[i++] });
    }
    // 输出 new 中非匹配的行（添加）
    while (j < match.newIdx) {
      diff.push({ type: 'add', newLine: newLineNo++, content: newLines[j++] });
    }
    // 匹配的行
    i++; j++;
    oldLineNo++; newLineNo++;
  }

  // 剩余行
  while (i < oldLines.length) {
    diff.push({ type: 'remove', oldLine: oldLineNo++, content: oldLines[i++] });
  }
  while (j < newLines.length) {
    diff.push({ type: 'add', newLine: newLineNo++, content: newLines[j++] });
  }

  return diff;
}

/**
 * 计算最长公共子序列（LCS），返回匹配位置
 */
function computeLCS(a, b) {
  const m = a.length, n = b.length;
  // DP table
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (a[i] === b[j]) {
        dp[i][j] = dp[i + 1][j + 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }
  // 回溯
  const matches = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      matches.push({ oldIdx: i, newIdx: j });
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return matches;
}

/**
 * 统计 diff 的增删行数
 */
function diffStats(diff) {
  let added = 0, removed = 0;
  for (const line of diff) {
    if (line.type === 'add') added++;
    else if (line.type === 'remove') removed++;
  }
  return { added, removed };
}

class ChangeTracker {
  constructor() {
    this.changes = [];
  }

  record(change) {
    const entry = {
      type: change.type,          // 'create' | 'modify' | 'delete'
      path: change.path,
      oldContent: change.oldContent || null,
      newContent: change.newContent || null,
      timestamp: Date.now(),
      taskId: change.taskId || null,
      runId: change.runId || null,
    };

    // 生成真实 diff
    if (entry.type === 'modify' && entry.oldContent !== null && entry.newContent !== null) {
      entry.diff = unifiedDiff(entry.oldContent, entry.newContent, entry.path);
      const stats = diffStats(entry.diff);
      entry.added = stats.added;
      entry.removed = stats.removed;
    } else if (entry.type === 'create') {
      entry.diff = null;
      entry.added = entry.newContent ? entry.newContent.split('\n').length : 0;
      entry.removed = 0;
    } else if (entry.type === 'delete') {
      entry.diff = null;
      entry.added = 0;
      entry.removed = entry.oldContent ? entry.oldContent.split('\n').length : 0;
    }

    this.changes.push(entry);
  }

  /** 获取所有变更摘要 */
  getSummary() {
    const byFile = this.byFile();
    const files = [];
    for (const [path, changes] of Object.entries(byFile)) {
      const last = changes[changes.length - 1];
      let added = 0, removed = 0;
      for (const c of changes) {
        added += c.added || 0;
        removed += c.removed || 0;
      }
      files.push({
        path,
        type: last.type,
        added,
        removed,
        changeCount: changes.length,
      });
    }
    return { files, totalChanges: this.changes.length };
  }

  /** 获取所有变更的 diff 视图 */
  getDiff() {
    return this.changes.map((c) => ({
      type: c.type,
      path: c.path,
      timestamp: c.timestamp,
      diff: c.diff || null,
      added: c.added || 0,
      removed: c.removed || 0,
    }));
  }

  /** 获取最后 N 条变更 */
  recent(n = 10) {
    return this.changes.slice(-n);
  }

  /** 清空 */
  clear() {
    this.changes = [];
  }

  /** 按文件分组 */
  byFile() {
    const map = {};
    for (const c of this.changes) {
      if (!map[c.path]) map[c.path] = [];
      map[c.path].push(c);
    }
    return map;
  }
}

export { ChangeTracker, unifiedDiff, diffStats };