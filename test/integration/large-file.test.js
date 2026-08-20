/**
 * Integration Test: Large File Range Read
 */

import { test } from 'node:test';
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { WorkspaceFileService } from '../../fileservice.js';

const workspace = '/tmp/test-large-file';

test('1MB file range read works', () => {
  const svc = new WorkspaceFileService(workspace);
  const abs = svc.sandbox.resolve('big1mb.txt');

  const chunk = 'A'.repeat(1024);
  const lines = [];
  for (let i = 0; i < 1024; i++) {
    lines.push(`Line ${String(i).padStart(6, '0')}: ${chunk}`);
  }
  fs.writeFileSync(abs, lines.join('\n'), 'utf-8');

  const stat = fs.statSync(abs);
  assert.ok(stat.size > 1024 * 1024, 'file should be > 1MB');

  const result = svc.readFile('big1mb.txt', { startLine: 100, endLine: 120 });
  assert.ok(result.lines > 0, 'should read some lines');
  assert.ok(result.startLine >= 100, `startLine should be >= 100, got ${result.startLine}`);
  assert.ok(result.endLine >= 100, `endLine should be >= 100, got ${result.endLine}`);

  fs.unlinkSync(abs);
});

test('10MB file range read works', () => {
  const svc = new WorkspaceFileService(workspace);
  const abs = svc.sandbox.resolve('big10mb.txt');

  const chunk = 'B'.repeat(1024);
  const lines = [];
  for (let i = 0; i < 10240; i++) {
    lines.push(`Line ${String(i).padStart(6, '0')}: ${chunk}`);
  }
  fs.writeFileSync(abs, lines.join('\n'), 'utf-8');

  const stat = fs.statSync(abs);
  assert.ok(stat.size > 1024 * 1024 * 10, 'file should be > 10MB');

  const result = svc.readFile('big10mb.txt', { startLine: 5000, endLine: 5020 });
  assert.ok(result.lines > 0, 'should read some lines');
  assert.ok(result.startLine >= 5000, `startLine should be >= 5000, got ${result.startLine}`);
  assert.ok(result.endLine >= 5000, `endLine should be >= 5000, got ${result.endLine}`);

  fs.unlinkSync(abs);
});

test('file > 500KB without range throws helpful error', () => {
  const svc = new WorkspaceFileService(workspace);
  const abs = svc.sandbox.resolve('toolarge.txt');

  const chunk = 'C'.repeat(1024);
  const lines = [];
  for (let i = 0; i < 1024; i++) {
    lines.push(`Line ${String(i).padStart(6, '0')}: ${chunk}`);
  }
  fs.writeFileSync(abs, lines.join('\n'), 'utf-8');

  assert.throws(() => svc.readFile('toolarge.txt'), /过大/);

  fs.unlinkSync(abs);
});