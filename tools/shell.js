/**
 * tools/shell.js — Shell 命令执行工具
 *
 * 在 workspace 内执行命令，返回 stdout/stderr/exitCode。
 *
 * 安全模型（诚实且可靠）：
 *   - 文件 Tool：严格 workspace scoped，经 Sandbox 路径校验
 *   - Shell：默认高权限工具，使用：
 *     - Secret scrubbing：不继承 LLM_API_KEY 等敏感环境变量
 *     - Risk classification：由 policy.js 统一评估
 *     - Approval：高风险命令需用户确认
 *     - Timeout：合理上下限
 *     - Process tree kill：Stop 时终止整个进程树
 *
 * 注意：cwd 在 workspace 内不代表命令只能访问 workspace。
 * 这是 OS 级限制，当前不做 filesystem-level sandbox。
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { safeEnv, clampTimeout } from '../policy.js';

// ── 风险分类（由 policy.js 统一管理，此处保留兼容）────
// 实际评估由 policy.js 的 evaluate() 完成

/**
 * run_command — 执行 shell 命令
 *
 * @param {object} input - { command, timeout, cwd }
 * @param {object} ctx - { sandbox, tracker, workspace, run, config }
 */
async function runCommand(input, ctx) {
  const { sandbox, workspace, run } = ctx;
  const { command, cwd } = input;
  if (!command) throw new Error('run_command 缺少 command 参数');

  // timeout 合理化
  const timeout = clampTimeout(input.timeout);

  const workdir = cwd ? sandbox.resolve(cwd) : workspace;

  // 构建安全环境变量：剔除敏感 key
  const env = safeEnv();

  // 限制输出大小
  const MAX_OUTPUT = 200 * 1024; // 200KB

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let killed = false;
    let startTime = Date.now();

    const child = spawn(command, [], {
      cwd: workdir,
      shell: true,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // 注册到 run manager（用于 Stop 时 kill）
    if (run) run.registerChild(child);

    const timer = setTimeout(() => {
      killed = true;
      killProcessTree(child, 'SIGTERM');
      // 2 秒后强杀
      const forceTimer = setTimeout(() => {
        killProcessTree(child, 'SIGKILL');
      }, 2000);
      // 确保定时器不会阻止进程退出
      forceTimer.unref();
    }, timeout);
    timer.unref();

    child.stdout.on('data', (data) => {
      stdout += data.toString();
      if (stdout.length > MAX_OUTPUT) {
        stdout = stdout.slice(0, MAX_OUTPUT) + '\n...[输出已截断]';
        if (!killed) {
          killed = true;
          killProcessTree(child, 'SIGTERM');
        }
      }
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
      if (stderr.length > MAX_OUTPUT) {
        stderr = stderr.slice(0, MAX_OUTPUT) + '\n...[输出已截断]';
        if (!killed) {
          killed = true;
          killProcessTree(child, 'SIGTERM');
        }
      }
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const duration = Date.now() - startTime;
      resolve({
        command,
        cwd: sandbox.relative(workdir),
        exitCode: code,
        signal: signal || null,
        stdout: stdout.slice(0, MAX_OUTPUT),
        stderr: stderr.slice(0, MAX_OUTPUT),
        timedOut: killed,
        duration,
        stopped: signal === 'SIGTERM' || signal === 'SIGKILL',
      });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        command,
        cwd: sandbox.relative(workdir),
        exitCode: -1,
        stdout: '',
        stderr: err.message,
        error: err.message,
        duration: Date.now() - startTime,
      });
    });
  });
}

/**
 * 终止进程树（含子进程）
 */
function killProcessTree(child, signal) {
  if (!child || !child.pid) return;
  try {
    // 先尝试 kill 进程组
    if (process.platform === 'win32') {
      // Windows: taskkill
      const { execSync } = require('child_process');
      try { execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore' }); } catch {}
    } else {
      // Unix: kill 进程组
      try { process.kill(-child.pid, signal); } catch {}
      // 兜底：直接 kill
      try { process.kill(child.pid, signal); } catch {}
    }
  } catch (err) {
    // 忽略
  }
}

const shellTools = {
  run_command: {
    description:
      '在 workspace 内执行 shell 命令。用于运行测试、安装依赖、构建项目、检查环境等。' +
      '命令在 workspace 目录下执行，有超时和输出大小限制。' +
      '高风险命令（破坏性、网络、系统级）需要用户确认。',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的 shell 命令' },
        timeout: { type: 'number', description: '超时毫秒数，默认 30000（范围 1000-120000）' },
        cwd: { type: 'string', description: '工作目录，默认为 workspace 根目录' },
      },
      required: ['command'],
    },
    execute: runCommand,
    dangerous: false, // 风险由 policy.js 统一评估
  },
};

export { shellTools, killProcessTree };