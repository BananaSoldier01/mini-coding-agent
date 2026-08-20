/**
 * runmanager.js — Active Run 生命周期管理
 *
 * 职责：
 *   - 管理 sessionId → activeRun 映射
 *   - 每个 Run 持有独立的 AbortController 和 child process 集合
 *   - Stop 操作：abort LLM / kill child processes / cancel pending approval / 标记 stopped
 *   - 防止孤儿进程和重复 resolve
 */

import { registry as approvalRegistry } from './approval.js';

class ActiveRun {
  constructor(sessionId) {
    this.sessionId = sessionId;
    this.controller = new AbortController();
    this.childProcesses = new Set();   // 当前活跃的 child_process
    this.pendingApproval = null;        // { toolCallId, resolve }
    this.stopped = false;
    this.startTime = Date.now();
  }

  /** 注册一个 child process，Stop 时一并 kill */
  registerChild(child) {
    this.childProcesses.add(child);
    child.on('close', () => this.childProcesses.delete(child));
    child.on('error', () => this.childProcesses.delete(child));
  }

  /** Stop：终止一切 */
  stop(reason = 'user_stop') {
    if (this.stopped) return;
    this.stopped = true;

    // 1. abort LLM request
    try { this.controller.abort(); } catch {}

    // 2. kill all child processes (process tree)
    for (const child of this.childProcesses) {
      try {
        // kill process tree: SIGTERM → 等待 → SIGKILL
        if (child.pid) {
          try { process.kill(child.pid, 'SIGTERM'); } catch {}
          // 延迟强杀
          setTimeout(() => {
            try { process.kill(child.pid, 'SIGKILL'); } catch {}
          }, 2000);
        }
        try { child.kill('SIGTERM'); } catch {}
      } catch {}
    }

    // 3. cancel pending approval
    if (this.pendingApproval) {
      try { this.pendingApproval.resolve(false); } catch {}
      this.pendingApproval = null;
    }
    approvalRegistry.cancelAll();

    this.stopReason = reason;
  }

  /** 设置 pending approval */
  setPendingApproval(toolCallId, resolve) {
    this.pendingApproval = { toolCallId, resolve };
  }

  /** 清除 pending approval */
  clearPendingApproval() {
    this.pendingApproval = null;
  }

  /** 是否已停止 */
  isStopped() {
    return this.stopped || this.controller.signal.aborted;
  }
}

class RunManager {
  constructor() {
    this.runs = new Map(); // sessionId → ActiveRun
  }

  /** 创建或替换 session 的 active run */
  create(sessionId) {
    // 如果已存在，先停止旧的
    const existing = this.runs.get(sessionId);
    if (existing) existing.stop('replaced');

    const run = new ActiveRun(sessionId);
    this.runs.set(sessionId, run);
    return run;
  }

  /** 获取 session 的 active run */
  get(sessionId) {
    return this.runs.get(sessionId);
  }

  /** 停止指定 session 的 run */
  stop(sessionId) {
    const run = this.runs.get(sessionId);
    if (run) {
      run.stop('user_stop');
      this.runs.delete(sessionId);
      return true;
    }
    return false;
  }

  /** 清理已完成的 run */
  remove(sessionId) {
    this.runs.delete(sessionId);
  }

  /** 清理所有 run */
  stopAll() {
    for (const [sessionId, run] of this.runs) {
      run.stop('server_shutdown');
    }
    this.runs.clear();
  }

  /** 活跃 run 数量 */
  get size() {
    return this.runs.size;
  }
}

// 全局单例
const runManager = new RunManager();

// 进程退出时清理
process.on('exit', () => runManager.stopAll());
process.on('SIGTERM', () => runManager.stopAll());
process.on('SIGINT', () => runManager.stopAll());

export { ActiveRun, RunManager, runManager };