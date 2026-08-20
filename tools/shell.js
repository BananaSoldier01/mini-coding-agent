/**
 * tools/shell.js — Shell 命令执行工具
 *
 * 在 workspace 内执行命令，返回 stdout/stderr/exitCode。
 * 限制：timeout、输出大小、工作目录为 workspace。
 * 危险命令列表需要用户确认。
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

/** 危险命令模式 — 命中即需用户确认 */
const DANGEROUS_PATTERNS = [
  /^\s*rm\s+-rf?\s+\//,           // rm -rf /
  /^\s*rm\s+-rf?\s+\*/,           // rm -rf *
  /^\s*dd\s+/,                   // dd
  /^\s*mkfs/,                    // mkfs
  /^\s*:>\s*\*/,                 // :> *  清空
  /^\s*shutdown/,                // shutdown
  /^\s*reboot/,                  // reboot
  /^\s*halt/,                    // halt
  /^\s*init\s+0/,                // init 0
  /;\s*rm\s+-rf/,                // ; rm -rf
  /&&\s*rm\s+-rf/,               // && rm -rf
  /^\s*curl.*\|\s*sh/,           // curl | sh
  /^\s*wget.*\|\s*sh/,           // wget | sh
  /^\s*chmod\s+777/,             // chmod 777
  /^\s*chown\s+/,                // chown
];

/** 允许的命令白名单前缀（宽松模式下限制） */
const ALLOWED_COMMANDS = new Set([
  'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'find', 'pwd', 'echo',
  'mkdir', 'cp', 'mv', 'touch', 'rm', 'rmdir',
  'node', 'npm', 'pnpm', 'python', 'python3', 'pip', 'pip3',
  'git', 'go', 'rustc', 'cargo', 'java', 'javac', 'make', 'cmake',
  'gcc', 'g++', 'clang', 'clang++',
  'date', 'whoami', 'id', 'uname', 'df', 'du', 'env', 'printenv',
  'sort', 'uniq', 'tr', 'sed', 'awk', 'cut', 'diff', 'patch',
  'tar', 'gzip', 'gunzip', 'zip', 'unzip',
  'curl', 'wget',
  'stat', 'file', 'test', 'true', 'false',
  'npm', 'npx', 'yarn', 'bun',
]);

function isDangerous(cmd) {
  for (const pat of DANGEROUS_PATTERNS) {
    if (pat.test(cmd)) return true;
  }
  return false;
}

function isAllowed(cmd) {
  const first = cmd.trim().split(/\s+/)[0];
  // 处理完整路径，如 /bin/ls
  const base = first.split('/').pop();
  return ALLOWED_COMMANDS.has(base);
}

/**
 * run_command — 执行 shell 命令
 */
async function runCommand(input, ctx) {
  const { sandbox, workspace } = ctx;
  const { command, timeout = 30000, cwd } = input;
  if (!command) throw new Error('run_command 缺少 command 参数');

  const workdir = cwd ? sandbox.resolve(cwd) : workspace;

  // 安全检查
  if (isDangerous(command)) {
    const err = new Error(`危险命令，需要用户确认: ${command}`);
    err.requiresApproval = true;
    err.command = command;
    throw err;
  }

  // 宽松白名单检查（仅在明确模式下启用，此处作为提示）
  if (!isAllowed(command)) {
    console.warn(`[shell] 命令未在白名单中: ${command}`);
  }

  // 限制输出大小
  const MAX_OUTPUT = 200 * 1024; // 200KB

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let killed = false;

    const child = spawn(command, [], {
      cwd: workdir,
      shell: true,
      env: { ...process.env },
    });

    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGTERM');
    }, timeout);

    child.stdout.on('data', (data) => {
      stdout += data.toString();
      if (stdout.length > MAX_OUTPUT) {
        stdout = stdout.slice(0, MAX_OUTPUT) + '\n...[输出已截断]';
        child.kill('SIGTERM');
      }
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
      if (stderr.length > MAX_OUTPUT) {
        stderr = stderr.slice(0, MAX_OUTPUT) + '\n...[输出已截断]';
        child.kill('SIGTERM');
      }
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        command,
        cwd: sandbox.relative(workdir),
        exitCode: code,
        signal: signal || null,
        stdout: stdout.slice(0, MAX_OUTPUT),
        stderr: stderr.slice(0, MAX_OUTPUT),
        timedOut: killed,
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
      });
    });
  });
}

const shellTools = {
  run_command: {
    description:
      '在 workspace 内执行 shell 命令。用于运行测试、安装依赖、构建项目、检查环境等。命令在 workspace 目录下执行，有超时和输出大小限制。危险命令（如 rm -rf /）需要用户确认。',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的 shell 命令' },
        timeout: { type: 'number', description: '超时毫秒数，默认 30000' },
        cwd: { type: 'string', description: '工作目录，默认为 workspace 根目录' },
      },
      required: ['command'],
    },
    execute: runCommand,
    dangerous: false, // 部分命令可能危险，运行时检查
  },
};

export { shellTools, isDangerous, isAllowed };