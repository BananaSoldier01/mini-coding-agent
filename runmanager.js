/**
 * runmanager.js — Active Run 生命周期管理
 *
 * 职责：
 *   - 管理 sessionId → activeRun 映射
 *   - 每个 Run 持有独立的 AbortController 和 child process 集合
 *   - Stop 操作：abort LLM / kill child processes / cancel pending approval / 标记 stopped
 *   - 防止孤儿进程和重复 resolve
 *
 * 跨平台 process tree kill：
 *   - Unix: kill(-pid) 杀进程组
 *   - Windows: taskkill /T /F
 */

import { registry as approvalRegistry } from './approval.js';

// ── 终止原因 ──────────────────────────────────────────
const TERMINATION_REASON = {
  COMPLETED: 'completed',
  USER_STOP: 'user_stop',
  TIMEOUT: 'timeout',
  OUTPUT_LIMIT: 'output_limit',
  SPAWN_ERROR: 'spawn_error',
};

class ActiveRun {
  constructor(sessionId) {
    this.sessionId = sessionId;
    this.runId = `run_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    this.controller = new AbortController();
    this.childProcesses = new Set();
    this.pendingApproval = null;
    this.stopped = false;
    this.stopReason = null;
    this.startTime = Date.now();
  }

  registerChild(child) {
    this.childProcesses.add(child);
    child.on('close', () => this.childProcesses.delete(child));
    child.on('error', () => this.childProcesses.delete(child));
  }

  stop(reason = 'user_stop') {
    if (this.stopped) return;
    this.stopped = true;
    this.stopReason = reason;

    try { this.controller.abort(); } catch {}

    for (const child of this.childProcesses) {
      killProcessTree(child);
    }

    approvalRegistry.cancelRun(this.runId);
    this.pendingApproval = null;
  }

  setPendingApproval(toolCallId) {
    this.pendingApproval = toolCallId;
  }

  clearPendingApproval() {
    this.pendingApproval = null;
  }

  isStopped() {
    return this.stopped || this.controller.signal.aborted;
  }
}

function killProcessTree(child) {
  if (!child || !child.pid) return;

  try {
    if (process.platform === 'win32') {
      const { execSync } = require('child_process');
      try {
        execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore', timeout: 5000 });
      } catch {}
    } else {
      try { process.kill(-child.pid, 'SIGTERM'); } catch {}
      setTimeout(() => {
        try { process.kill(-child.pid, 'SIGKILL'); } catch {}
        try { process.kill(child.pid, 'SIGKILL'); } catch {}
      }, 2000).unref();
      try { child.kill('SIGTERM'); } catch {}
    }
  } catch (err) {
    // 忽略
  }
}

class RunManager {
  constructor() {
    this.runs = new Map();
  }

  create(sessionId) {
    const existing = this.runs.get(sessionId);
    if (existing) existing.stop('replaced');

    const run = new ActiveRun(sessionId);
    this.runs.set(sessionId, run);
    return run;
  }

  get(sessionId) {
    return this.runs.get(sessionId);
  }

  stop(sessionId) {
    const run = this.runs.get(sessionId);
    if (run) {
      run.stop('user_stop');
      this.runs.delete(sessionId);
      return true;
    }
    return false;
  }

  remove(sessionId) {
    this.runs.delete(sessionId);
  }

  stopAll() {
    for (const [, run] of this.runs) {
      run.stop('server_shutdown');
    }
    this.runs.clear();
  }

  get size() {
    return this.runs.size;
  }
}

const runManager = new RunManager();

process.on('exit', () => runManager.stopAll());
process.on('SIGTERM', () => runManager.stopAll());
process.on('SIGINT', () => runManager.stopAll());

export { ActiveRun, RunManager, runManager, killProcessTree, TERMINATION_REASON };