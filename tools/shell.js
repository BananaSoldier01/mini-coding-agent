/**
 * tools/shell.js — Shell 命令执行工具
 *
 * V0.3: 使用 capability-based Shell Policy（shellpolicy.js）
 * 替代旧的 denylist 正则。
 */

import { safeEnv, clampTimeout } from '../policy.js';
import { killProcessTree, spawnDetached, TERMINATION_REASON } from '../runmanager.js';

const MAX_OUTPUT = 200 * 1024;

async function runCommand(input, ctx) {
  const { sandbox, workspace, run } = ctx;
  const { command, cwd } = input;
  if (!command) throw new Error('run_command 缺少 command 参数');

  const timeout = clampTimeout(input.timeout);
  const workdir = cwd ? sandbox.resolve(cwd) : workspace;
  const env = safeEnv();

  return new Promise((resolve) => {
    let stdout = '', stderr = '';
    let terminationReason = TERMINATION_REASON.COMPLETED;
    const startTime = Date.now();

    const child = spawnDetached(command, [], {
      cwd: workdir, shell: true, env,
    });

    if (run) run.registerChild(child);

    const timer = setTimeout(() => {
      terminationReason = TERMINATION_REASON.TIMEOUT;
      killProcessTree(child);
      const forceTimer = setTimeout(() => killProcessTree(child), 2000);
      forceTimer.unref();
    }, timeout);
    timer.unref();

    child.stdout.on('data', (data) => {
      stdout += data.toString();
      if (stdout.length > MAX_OUTPUT) {
        stdout = stdout.slice(0, MAX_OUTPUT) + '\n...[输出已截断]';
        if (terminationReason === TERMINATION_REASON.COMPLETED) {
          terminationReason = TERMINATION_REASON.OUTPUT_LIMIT;
          killProcessTree(child);
        }
      }
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
      if (stderr.length > MAX_OUTPUT) {
        stderr = stderr.slice(0, MAX_OUTPUT) + '\n...[输出已截断]';
        if (terminationReason === TERMINATION_REASON.COMPLETED) {
          terminationReason = TERMINATION_REASON.OUTPUT_LIMIT;
          killProcessTree(child);
        }
      }
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const duration = Date.now() - startTime;

      if (run && run.isStopped() && terminationReason === TERMINATION_REASON.COMPLETED) {
        terminationReason = TERMINATION_REASON.USER_STOP;
      }

      resolve({
        command,
        cwd: sandbox.relative(workdir),
        exitCode: code,
        signal: signal || null,
        stdout: stdout.slice(0, MAX_OUTPUT),
        stderr: stderr.slice(0, MAX_OUTPUT),
        terminationReason,
        duration,
        stopped: terminationReason === TERMINATION_REASON.USER_STOP,
        timedOut: terminationReason === TERMINATION_REASON.TIMEOUT,
        outputLimited: terminationReason === TERMINATION_REASON.OUTPUT_LIMIT,
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
        terminationReason: TERMINATION_REASON.SPAWN_ERROR,
        duration: Date.now() - startTime,
      });
    });
  });
}

const shellToolDef = {
  run_command: {
    description:
      '在 workspace 内执行 shell 命令。安全命令自动执行，未知命令需要用户确认，危险命令被拒绝。',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        timeout: { type: 'number' },
        cwd: { type: 'string' },
      },
      required: ['command'],
    },
    execute: runCommand,
  },
};

export { shellToolDef, runCommand };