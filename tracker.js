/**
 * tracker.js — 文件变更追踪
 *
 * 记录 Agent 对 workspace 文件的所有修改，用于 diff 展示和回滚。
 */

class ChangeTracker {
  constructor() {
    this.changes = [];
  }

  record(change) {
    this.changes.push({
      ...change,
      timestamp: Date.now(),
    });
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

export { ChangeTracker };