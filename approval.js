/**
 * approval.js — 审批注册表
 *
 * 解耦 Agent 的等待逻辑与 HTTP 审批接口。
 * Agent 创建待审批请求 → 存入 registry → 前端展示 → 用户审批 → HTTP 接口 resolve。
 */

class ApprovalRegistry {
  constructor() {
    this.pending = new Map(); // toolCallId -> { resolve, timeout }
  }

  /** 注册一个待审批请求，返回 Promise<approved: boolean> */
  register(toolCallId, timeoutMs = 5 * 60 * 1000) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      this.pending.set(toolCallId, { resolve, timer });
    });
  }

  /** 提交审批结果 */
  resolve(toolCallId, approved) {
    const entry = this.pending.get(toolCallId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pending.delete(toolCallId);
    entry.resolve(approved === true);
    return true;
  }

  /** 取消所有待审批请求 */
  cancelAll() {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.resolve(false);
    }
    this.pending.clear();
  }

  /** 当前待审批数量 */
  get size() {
    return this.pending.size;
  }
}

// 全局单例
const registry = new ApprovalRegistry();

export { ApprovalRegistry, registry };