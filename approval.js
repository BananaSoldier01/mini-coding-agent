/**
 * approval.js — 审批注册表（支持 Run 隔离）
 *
 * 每个 ActiveRun 有独立的 approval scope。
 * Stop A 只取消 A 的 pending approval，不影响 B。
 */

class ApprovalScope {
  constructor(runId) {
    this.runId = runId;
    this.pending = new Map(); // toolCallId -> { resolve, timer }
  }

  register(toolCallId, timeoutMs = 5 * 60 * 1000) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        // timeout 后清理 pending entry，防止残留
        this.pending.delete(toolCallId);
        resolve(false);
      }, timeoutMs);
      this.pending.set(toolCallId, { resolve, timer });
    });
  }

  resolve(toolCallId, approved) {
    const entry = this.pending.get(toolCallId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pending.delete(toolCallId);
    entry.resolve(approved === true);
    return true;
  }

  cancelAll() {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.resolve(false);
    }
    this.pending.clear();
  }

  get size() {
    return this.pending.size;
  }
}

class ApprovalRegistry {
  constructor() {
    this.scopes = new Map(); // runId → ApprovalScope
  }

  /** 获取或创建 run 的 approval scope */
  getScope(runId) {
    if (!this.scopes.has(runId)) {
      this.scopes.set(runId, new ApprovalScope(runId));
    }
    return this.scopes.get(runId);
  }

  /** 注册审批请求（指定 run） */
  register(runId, toolCallId, timeoutMs) {
    const scope = this.getScope(runId);
    return scope.register(toolCallId, timeoutMs);
  }

  /** 提交审批结果（指定 run） */
  resolve(runId, toolCallId, approved) {
    const scope = this.scopes.get(runId);
    if (!scope) return false;
    return scope.resolve(toolCallId, approved);
  }

  /** 取消指定 run 的所有审批 */
  cancelRun(runId) {
    const scope = this.scopes.get(runId);
    if (scope) {
      scope.cancelAll();
      this.scopes.delete(runId);
    }
  }

  /** 取消所有审批（用于全局停止） */
  cancelAll() {
    for (const [, scope] of this.scopes) {
      scope.cancelAll();
    }
    this.scopes.clear();
  }

  /** 清理完成的 run */
  removeRun(runId) {
    this.scopes.delete(runId);
  }

  /** 活跃 scope 数量 */
  get size() {
    return this.scopes.size;
  }
}

// 全局单例
const registry = new ApprovalRegistry();

export { ApprovalRegistry, ApprovalScope, registry };