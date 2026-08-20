import { test } from 'node:test';

/**
 * test/tracker.test.js — ChangeTracker & Diff 测试
 */

import assert from 'assert';
import { ChangeTracker, unifiedDiff, diffStats } from '../tracker.js';

// ── unifiedDiff ──────────────────────────────────────

test('unifiedDiff: 修改单行', () => {
  const oldStr = 'line1\nline2\nline3';
  const newStr = 'line1\nline2 MODIFIED\nline3';
  const diff = unifiedDiff(oldStr, newStr);
  const stats = diffStats(diff);
  assert.strictEqual(stats.added, 1);
  assert.strictEqual(stats.removed, 1);
});

test('unifiedDiff: 中部插入行', () => {
  const oldStr = 'line1\nline3';
  const newStr = 'line1\nline2 INSERTED\nline3';
  const diff = unifiedDiff(oldStr, newStr);
  const stats = diffStats(diff);
  assert.strictEqual(stats.added, 1);
  assert.strictEqual(stats.removed, 0);
});

test('unifiedDiff: 删除行', () => {
  const oldStr = 'line1\nline2\nline3';
  const newStr = 'line1\nline3';
  const diff = unifiedDiff(oldStr, newStr);
  const stats = diffStats(diff);
  assert.strictEqual(stats.added, 0);
  assert.strictEqual(stats.removed, 1);
});

test('unifiedDiff: 新建文件', () => {
  const oldStr = '';
  const newStr = 'line1\nline2';
  const diff = unifiedDiff(oldStr, newStr);
  const stats = diffStats(diff);
  assert.strictEqual(stats.added, 2);
  assert.strictEqual(stats.removed, 0);
});

test('unifiedDiff: 删除文件', () => {
  const oldStr = 'line1\nline2';
  const newStr = '';
  const diff = unifiedDiff(oldStr, newStr);
  const stats = diffStats(diff);
  assert.strictEqual(stats.added, 0);
  assert.strictEqual(stats.removed, 2);
});

test('unifiedDiff: 大量插入不误判', () => {
  // 模拟在文件中部插入一行，后面内容不变
  const oldLines = [];
  const newLines = [];
  for (let i = 0; i < 100; i++) oldLines.push(`line ${i}`);
  for (let i = 0; i < 50; i++) newLines.push(`line ${i}`);
  newLines.push('INSERTED LINE');
  for (let i = 50; i < 100; i++) newLines.push(`line ${i}`);

  const diff = unifiedDiff(oldLines.join('\n'), newLines.join('\n'));
  const stats = diffStats(diff);
  assert.strictEqual(stats.added, 1, `插入一行应只新增 1 行，实际新增 ${stats.added}`);
  assert.strictEqual(stats.removed, 0);
});

// ── ChangeTracker ────────────────────────────────────

test('ChangeTracker: 记录 create', () => {
  const ct = new ChangeTracker();
  ct.record({ type: 'create', path: 'new.txt', oldContent: null, newContent: 'hello' });
  const net = ct.getNetDiff();
  assert.strictEqual(net.totalChanges, 1);
  assert.strictEqual(net.files[0].type, 'create');
  assert.strictEqual(net.files[0].added, 1); // 'hello' = 1 line
});

test('ChangeTracker: 记录 modify', () => {
  const ct = new ChangeTracker();
  ct.baselineSnapshot.set('app.js', 'const a = 1;');
  ct.record({
    type: 'modify',
    path: 'app.js',
    oldContent: 'const a = 1;',
    newContent: 'const a = 2;',
  });
  const net = ct.getNetDiff();
  assert.strictEqual(net.files.length, 1);
  assert.strictEqual(net.files[0].type, 'modify');
  assert.ok(net.files[0].added > 0);
  assert.ok(net.files[0].removed > 0);
});

test('ChangeTracker: 记录 delete', () => {
  const ct = new ChangeTracker();
  // Set baseline so delete is a net change
  ct.baselineSnapshot.set('old.txt', 'content');
  ct.record({ type: 'delete', path: 'old.txt', oldContent: 'content', newContent: null });
  const net = ct.getNetDiff();
  assert.strictEqual(net.files[0].type, 'delete');
  assert.strictEqual(net.files[0].removed, 1);
});

test('ChangeTracker: byFile 分组', () => {
  const ct = new ChangeTracker();
  ct.record({ type: 'create', path: 'a.txt', oldContent: null, newContent: 'a' });
  ct.record({ type: 'modify', path: 'a.txt', oldContent: 'a', newContent: 'b' });
  ct.record({ type: 'create', path: 'b.txt', oldContent: null, newContent: 'c' });
  const byFile = ct.byFile();
  assert.strictEqual(Object.keys(byFile).length, 2);
  assert.strictEqual(byFile['a.txt'].length, 2);
  assert.strictEqual(byFile['b.txt'].length, 1);
});

test('ChangeTracker: clear 清空', () => {
  const ct = new ChangeTracker();
  ct.record({ type: 'create', path: 'a.txt', oldContent: null, newContent: 'a' });
  ct.record({ type: 'create', path: 'b.txt', oldContent: null, newContent: 'b' });
  assert.strictEqual(ct.changes.length, 2);
  ct.clear();
  assert.strictEqual(ct.changes.length, 0);
});