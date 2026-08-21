import { test } from 'node:test';
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { WorkspaceFileService } from '../fileservice.js';

// ── V0.4.1 Regression: Binary Detection ─────────────

test('REGRESSION: small text file → not binary', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bintest-'));
  try {
    fs.writeFileSync(path.join(tmpDir, 'hello.js'), "const hello = 'world';");
    const svc = new WorkspaceFileService(tmpDir);
    assert.strictEqual(svc.isBinary('hello.js'), false, 'small text should not be binary');
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
  }
});

test('REGRESSION: binary extension → binary', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bintest-'));
  try {
    fs.writeFileSync(path.join(tmpDir, 'image.png'), Buffer.from([0x89, 0x50, 0x4E, 0x47]));
    const svc = new WorkspaceFileService(tmpDir);
    assert.strictEqual(svc.isBinary('image.png'), true, 'binary extension should be binary');
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
  }
});

test('REGRESSION: null byte no extension → binary', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bintest-'));
  try {
    fs.writeFileSync(path.join(tmpDir, 'artifact'), Buffer.from([0x00, 0x01, 0x02]));
    const svc = new WorkspaceFileService(tmpDir);
    assert.strictEqual(svc.isBinary('artifact'), true, 'null byte file should be binary');
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
  }
});

test('REGRESSION: relative path contract for isBinary', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bintest-'));
  try {
    fs.writeFileSync(path.join(tmpDir, 'test.txt'), 'hello');
    const svc = new WorkspaceFileService(tmpDir);
    // isBinary should accept workspace-relative path
    assert.strictEqual(svc.isBinary('test.txt'), false);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
  }
});

test('REGRESSION: sensitive file remains denied', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bintest-'));
  try {
    fs.writeFileSync(path.join(tmpDir, '.env'), 'SECRET=xxx');
    const svc = new WorkspaceFileService(tmpDir);
    assert.strictEqual(svc.isSensitive('.env'), true, '.env should be sensitive');
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
  }
});