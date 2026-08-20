/**
 * Integration Test: File API
 */

import { test } from 'node:test';
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { WorkspaceFileService } from '../../fileservice.js';

const workspace = '/tmp/test-file-api';

test('list files returns tree structure', () => {
  const svc = new WorkspaceFileService(workspace);
  const tree = svc.buildTree('.');
  assert.ok(tree, 'tree should exist');
  assert.strictEqual(tree.type, 'directory');
  assert.ok(tree.children, 'tree should have children');
});

test('read normal file returns content', () => {
  const svc = new WorkspaceFileService(workspace);
  const abs = svc.sandbox.resolve('test-read.txt');
  fs.writeFileSync(abs, 'hello world\nline 2\nline 3');

  const result = svc.readFile('test-read.txt');
  assert.ok(result.content.includes('hello world'));
  assert.ok(result.totalLines >= 3);

  fs.unlinkSync(abs);
});

test('sensitive file .env is denied', () => {
  const svc = new WorkspaceFileService(workspace);
  assert.throws(() => svc.readFile('.env'), /敏感文件/);
});

test('sensitive file .env.local is denied', () => {
  const svc = new WorkspaceFileService(workspace);
  assert.throws(() => svc.readFile('.env.local'), /敏感文件/);
});

test('sensitive file server.pem is denied', () => {
  const svc = new WorkspaceFileService(workspace);
  assert.throws(() => svc.readFile('server.pem'), /敏感文件/);
});

test('sensitive file private.key is denied', () => {
  const svc = new WorkspaceFileService(workspace);
  assert.throws(() => svc.readFile('private.key'), /敏感文件/);
});

test('sensitive file certificate.p12 is denied', () => {
  const svc = new WorkspaceFileService(workspace);
  assert.throws(() => svc.readFile('certificate.p12'), /敏感文件/);
});

test('sensitive file .git-credentials is denied', () => {
  const svc = new WorkspaceFileService(workspace);
  assert.throws(() => svc.readFile('.git-credentials'), /敏感文件/);
});

test('sensitive file .npmrc is denied', () => {
  const svc = new WorkspaceFileService(workspace);
  assert.throws(() => svc.readFile('.npmrc'), /敏感文件/);
});

test('sensitive file in subdirectory .env.production is denied', () => {
  const svc = new WorkspaceFileService(workspace);
  assert.throws(() => svc.readFile('foo/.env.production'), /敏感/);
});

test('normal dotfiles like .gitignore are NOT denied', () => {
  const svc = new WorkspaceFileService(workspace);
  assert.strictEqual(svc.isSensitive('.gitignore'), false);
  assert.strictEqual(svc.isSensitive('.prettierrc'), false);
  assert.strictEqual(svc.isSensitive('.eslintrc'), false);
});

test('path traversal is denied', () => {
  const svc = new WorkspaceFileService(workspace);
  assert.throws(() => svc.readFile('../outside.txt'));
  assert.throws(() => svc.readFile('../../etc/passwd'));
});

test('absolute path is denied', () => {
  const svc = new WorkspaceFileService(workspace);
  assert.throws(() => svc.readFile('/etc/passwd'));
});

test('symlink escape is detected', () => {
  const svc = new WorkspaceFileService(workspace);
  const abs = svc.sandbox.resolve('link');
  try { fs.symlinkSync('/etc/passwd', abs); } catch {}

  assert.throws(() => svc.readFile('link'), /逃逸/);

  // Cleanup
  try { fs.unlinkSync(abs); } catch {}
});