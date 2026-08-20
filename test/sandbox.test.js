import { test } from 'node:test';

/**
 * test/sandbox.test.js — Sandbox 安全测试
 */

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { Sandbox } from '../sandbox.js';

const TEST_DIR = path.join(os.tmpdir(), 'mini-agent-test-' + Date.now());

test('Sandbox: 正常路径解析', () => {
  const sb = new Sandbox(TEST_DIR);
  const abs = sb.resolve('subdir/file.txt');
  assert.ok(abs.startsWith(TEST_DIR), `路径应在 workspace 内: ${abs}`);
  assert.strictEqual(sb.relative(abs), 'subdir/file.txt');
});

test('Sandbox: 路径穿越 ../ 被拒绝', () => {
  const sb = new Sandbox(TEST_DIR);
  assert.throws(() => sb.resolve('../outside.txt'), /路径越界/);
  assert.throws(() => sb.resolve('subdir/../../outside.txt'), /路径越界/);
});

test('Sandbox: 绝对路径被拒绝', () => {
  const sb = new Sandbox(TEST_DIR);
  assert.throws(() => sb.resolve('/etc/passwd'), /路径越界/);
});

test('Sandbox: 空路径被拒绝', () => {
  const sb = new Sandbox(TEST_DIR);
  assert.throws(() => sb.resolve(''), /路径不能为空/);
  assert.throws(() => sb.resolve(null), /路径不能为空/);
});

test('Sandbox: 敏感文件名路径穿越', () => {
  const sb = new Sandbox(TEST_DIR);
  // 尝试通过编码绕过
  assert.throws(() => sb.resolve('foo/../../../etc/passwd'), /路径越界/);
});

test('Sandbox: isInside 判断', () => {
  const sb = new Sandbox(TEST_DIR);
  assert.strictEqual(sb.isInside('subdir/file.txt'), true);
  assert.strictEqual(sb.isInside('../outside.txt'), false);
  assert.strictEqual(sb.isInside('/etc/passwd'), false);
});

test('Sandbox: symlink 逃逸检测', () => {
  const sb = new Sandbox(TEST_DIR);
  const subDir = path.join(TEST_DIR, 'subdir');
  fs.mkdirSync(subDir, { recursive: true });
  const targetFile = path.join(TEST_DIR, 'real.txt');
  fs.writeFileSync(targetFile, 'real');

  // 在 workspace 内创建 symlink 指向 workspace 外
  const linkPath = path.join(subDir, 'link');
  const outsidePath = path.join(os.tmpdir(), 'outside-' + Date.now());
  fs.writeFileSync(outsidePath, 'outside');

  try {
    fs.symlinkSync(outsidePath, linkPath);
    // 通过 symlink 读取应该被拒绝
    assert.throws(() => sb.resolve('subdir/link'), /Symlink 逃逸/);
  } finally {
    try { fs.unlinkSync(linkPath); } catch {}
    try { fs.unlinkSync(outsidePath); } catch {}
  }
});

test('Sandbox: getRoot 返回绝对路径', () => {
  const sb = new Sandbox(TEST_DIR);
  assert.strictEqual(sb.getRoot(), path.resolve(TEST_DIR));
});

test('Sandbox: 自动创建根目录', () => {
  const newDir = path.join(os.tmpdir(), 'mini-agent-new-' + Date.now());
  assert.strictEqual(fs.existsSync(newDir), false);
  const sb = new Sandbox(newDir);
  assert.strictEqual(fs.existsSync(newDir), true);
  try { fs.rmSync(newDir, { recursive: true }); } catch {}
});