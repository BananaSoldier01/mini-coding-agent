/**
 * runmanager.js — Active Run 生命周期管理
 *
 * V0.3.1 修复：
 * - Run identity-based remove/stop（防止 stale-finalizer race）
 * - 跨平台 process tree kill（Unix: process group / Windows: taskkill）
 * - 完整 lifecycle cleanup（children + approvals + active run）
 * - spawn 时设置 detached 创建独立 process group
 */

import { registry as approvalRegistry } from './approval.js';
import { spawn as spawnProcess, execSync } from 'child_process';

// ── 终止原因 ──────────────────────────────────────────
const TERMINATION_REASON = {
  COMPLETED: 'completed',
  USER_STOP: 'user_stop',
  REPLACED: 'replaced',
  TIMEOUT: 'timeout',
  OUTPUT_LIMIT: 'output_limit',
  SPAWN_ERROR: 'spawn_error',
  SERVER_SHUTDOWN: 'server_shutdown',
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
    this.finished = false;
  }

  /** 注册 child process（使用 detached 创建独立进程组） */
  registerChild(child) {
    this.childProcesses.add(child);
    child.on('close', () => this.childProcesses.delete(child));
    child.on('error', () => this.childProcesses.delete(child));
  }

  /** Stop：终止一切 */
  stop(reason = 'user_stop') {
    if (this.stopped) return;
    this.stopped = true;
    this.stopReason = reason;

    try { this.controller.abort(); } catch {}

    for (const child of this.childProcesses) {
      killProcessTree(child);
    }

    this._cleanupApprovals();
    this.pendingApproval = null;
  }

  /** 标记完成（正常结束） */
  finish() {
    this.finished = true;
    this._cleanupApprovals();
  }

  _cleanupApprovals() {
    approvalRegistry.cancelRun(this.runId);
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

/**
 * 跨平台进程树终止
 *
 * Unix: kill(-pid) 杀进程组（需 spawn 时 detached=true）
 * Windows: taskkill /T /F
 */
function killProcessTree(child) {
  if (!child || !child.pid) return;

  try {
    if (process.platform === 'win32') {
      // Windows: taskkill /T /F 杀进程树（ESM-compatible）
      try {
        execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore', timeout: 5000 });
      } catch {}
      // 兜底：直接 kill
      try { child.kill('SIGTERM'); } catch {}
      try { child.kill('SIGKILL'); } catch {}
    } else {
      // Unix: 先杀进程组（-pid），再杀进程本身
      try { process.kill(-child.pid, 'SIGTERM'); } catch {}
      // 2 秒后强杀
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

/**
 * 创建 detached 子进程（独立进程组，支持 process tree kill）
 */
function spawnDetached(command, args, opts = {}) {
  return spawnProcess(command, args, {
    ...opts,
    detached: true,   // Unix: 创建新 process group
    stdio: opts.stdio || ['ignore', 'pipe', 'pipe'],
  });
}

class RunManager {
  constructor() {
    this.runs = new Map(); // sessionId → ActiveRun
  }

  /** 创建新 run，自动停止同 session 的旧 run */
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

  /**
   * V1.3.0-fix: Look up an ActiveRun by runId (not sessionId).
   * The /api/approve handler receives runId from the client, but
   * this.runs is keyed by sessionId. Without this, runManager.get(runId)
   * returns undefined and approval_result never reaches trackEvent().
   */
  getByRunId(runId) {
    for (const [, run] of this.runs) {
      if (run.runId === runId) return run;
    }
    return null;
  }

  /**
   * Stop — 仅当当前 run 匹配 expectedRun 时才执行
   * 防止 stale-finalizer race
   */
  stop(sessionId, expectedRun) {
    const run = this.runs.get(sessionId);
    if (!run) return false;
    if (expectedRun && run.runId !== expectedRun.runId) return false;
    run.stop('user_stop');
    this.runs.delete(sessionId);
    return true;
  }

  /**
   * Remove — 仅当当前 run 匹配 expectedRun 时才删除
   * 防止 run1 的 finally 删除 run2
   */
  remove(sessionId, expectedRun) {
    const run = this.runs.get(sessionId);
    if (!run) return false;
    if (expectedRun && run.runId !== expectedRun.runId) return false;
    // 标记完成并清理
    if (run && !run.stopped) run.finish();
    this.runs.delete(sessionId);
    return true;
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

export { ActiveRun, RunManager, runManager, killProcessTree, spawnDetached, TERMINATION_REASON };