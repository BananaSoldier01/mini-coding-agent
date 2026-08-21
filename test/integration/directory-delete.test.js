import { test } from 'node:test';
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { FileTools } from '../../tools/file.js';
import { ChangeTracker, NON_EXISTENT } from '../../tracker.js';
import { WorkspaceFileService } from '../../fileservice.js';
import { Sandbox } from '../../sandbox.js';

// ── V0.4.0.3 Regression: Directory Delete ─────────────

test('REGRESSION: real directory delete → real net diff with before content', async () => {
  // 创建临时 workspace
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-dir-delete-'));
  
  try {
    // 创建测试目录和文件
    const fooDir = path.join(tmpDir, 'foo');
    fs.mkdirSync(fooDir, { recursive: true });
    fs.writeFileSync(path.join(fooDir, 'a.js'), 'const a = 1;\n');
    fs.writeFileSync(path.join(fooDir, 'b.js'), 'const b = 2;\n');
    
    // 创建 WorkspaceFileService + FileTools
    const fileTools = new FileTools(tmpDir);
    const tracker = new ChangeTracker();

    // 1. 直接设置 baseline（模拟文件在 Run 开始前已存在）
    tracker.baselineSnapshot.set('foo/a.js', 'const a = 1;\n');
    tracker.baselineSnapshot.set('foo/b.js', 'const b = 2;\n');

    // 2. 真实删除目录
    const deleteResult = await fileTools.deleteFile({ path: 'foo' });

    // 验证：filesystem 上目录已不存在
    assert.ok(!fs.existsSync(fooDir), 'foo directory should not exist after delete');

    // 验证：Tool 结果不包含 bookkeeping error
    assert.ok(!deleteResult.error, 'delete should not return error, got: ' + (deleteResult.error || 'none'));
    assert.strictEqual(deleteResult.action, 'deleted');
    assert.strictEqual(deleteResult.wasDirectory, true);

    // 验证：deletedFiles 包含子文件及真实 before content
    assert.ok(deleteResult.deletedFiles, 'deletedFiles should exist');
    assert.ok(deleteResult.deletedFiles.length >= 2, 'should have at least 2 deleted files');

    const aFile = deleteResult.deletedFiles.find(f => f.path === 'foo/a.js');
    const bFile = deleteResult.deletedFiles.find(f => f.path === 'foo/b.js');
    assert.ok(aFile, 'foo/a.js should be in deletedFiles');
    assert.ok(bFile, 'foo/b.js should be in deletedFiles');
    assert.ok(aFile.before && aFile.before.includes('const a = 1;'), 'a.js before should have real content');
    assert.ok(bFile.before && bFile.before.includes('const b = 2;'), 'b.js before should have real content');

    // 4. Agent tracking：记录子文件删除（使用真实 before content）
    for (const sub of deleteResult.deletedFiles) {
      tracker.record({
        type: 'delete',
        path: sub.path,
        oldContent: sub.before,
        newContent: NON_EXISTENT,
      });
    }

    // 5. 验证 Net Diff
    const netDiff = tracker.getNetDiff();

    // 应该有 2 个文件的删除
    assert.ok(netDiff.totalChanges >= 2, 'should have at least 2 changes, got: ' + netDiff.totalChanges);

    const aDiff = netDiff.files.find(f => f.path === 'foo/a.js');
    const bDiff = netDiff.files.find(f => f.path === 'foo/b.js');

    assert.ok(aDiff, 'foo/a.js should be in net diff');
    assert.strictEqual(aDiff.type, 'delete', 'a.js should be delete type');
    assert.ok(aDiff.removed > 0, 'a.js removed lines should be > 0, got: ' + aDiff.removed);

    assert.ok(bDiff, 'foo/b.js should be in net diff');
    assert.strictEqual(bDiff.type, 'delete', 'b.js should be delete type');
    assert.ok(bDiff.removed > 0, 'b.js removed lines should be > 0, got: ' + bDiff.removed);
    
  } finally {
    // 清理
    try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
  }
});

test('REGRESSION: directory delete with empty sub-files', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-dir-empty-'));
  
  try {
    const fooDir = path.join(tmpDir, 'emptydir');
    fs.mkdirSync(fooDir, { recursive: true });
    fs.writeFileSync(path.join(fooDir, 'empty.js'), '');
    
    const fileTools = new FileTools(tmpDir);
    const tracker = new ChangeTracker();

    // 建立 baseline（直接设置，模拟空文件在 Run 开始前已存在）
    tracker.baselineSnapshot.set('emptydir/empty.js', '');

    // 删除
    const deleteResult = await fileTools.deleteFile({ path: 'emptydir' });
    assert.ok(!deleteResult.error, 'delete should not error');

    // tracking
    for (const sub of deleteResult.deletedFiles) {
      tracker.record({
        type: 'delete',
        path: sub.path,
        oldContent: sub.before,
        newContent: NON_EXISTENT,
      });
    }

    const netDiff = tracker.getNetDiff();
    const emptyDiff = netDiff.files.find(f => f.path === 'emptydir/empty.js');
    assert.ok(emptyDiff, 'empty.js should be in net diff');
    assert.strictEqual(emptyDiff.type, 'delete');
    // empty file has 0 lines, so removed can be 0 — just verify it's tracked as delete
    assert.ok(emptyDiff.removed >= 0, 'empty.js removed should be >= 0');
    
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
  }
});