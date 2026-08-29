/**
 * test/rollback.test.js — V1.4.0: Rollback Unit Tests
 *
 * Covers checkRevertible / applyRevert / revertRun for all change types
 * and conflict scenarios.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkRevertible, applyRevert, revertRun, recomputeCurrentChanges, hashContent } from '../rollback.js';

// ── Mock FileService ────────────────────────────────────

class MockFileService {
  constructor(files = {}) {
    this.files = new Map(Object.entries(files));
    this.writes = [];
    this.deletes = [];
  }

  writeFile(relPath, content) {
    this.files.set(relPath, content);
    this.writes.push({ path: relPath, content });
    return { path: relPath, action: 'written' };
  }

  deleteFile(relPath) {
    const existed = this.files.has(relPath);
    this.files.delete(relPath);
    this.deletes.push({ path: relPath, existed });
    return { path: relPath, action: 'deleted' };
  }

  readFile(relPath) {
    if (!this.files.has(relPath)) throw new Error(`文件不存在: ${relPath}`);
    return { path: relPath, content: this.files.get(relPath) };
  }
}

// ── hashContent ─────────────────────────────────────────

test('hashContent: returns null for null/undefined', () => {
  assert.equal(hashContent(null), null);
  assert.equal(hashContent(undefined), null);
});

test('hashContent: returns hash for string content', () => {
  const h = hashContent('hello');
  assert.ok(typeof h === 'string' && h.length === 64);
});

test('hashContent: same content → same hash', () => {
  assert.equal(hashContent('abc'), hashContent('abc'));
});

test('hashContent: different content → different hash', () => {
  assert.notEqual(hashContent('abc'), hashContent('abd'));
});

// ── checkRevertible: Modify ─────────────────────────────

test('checkRevertible modify: current matches after → ok', () => {
  const change = { path: 'a.txt', type: 'modify', before: 'old', after: 'new' };
  const result = checkRevertible(change, 'new');
  assert.equal(result.ok, true);
});

test('checkRevertible modify: current differs from after → conflict', () => {
  const change = { path: 'a.txt', type: 'modify', before: 'old', after: 'new' };
  const result = checkRevertible(change, 'user-changed');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'workspace_changed_after_run');
});

test('checkRevertible modify: file missing → conflict', () => {
  const change = { path: 'a.txt', type: 'modify', before: 'old', after: 'new' };
  const result = checkRevertible(change, null);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'file_missing');
});

// ── checkRevertible: Create ─────────────────────────────

test('checkRevertible create: file exists → ok', () => {
  const change = { path: 'new.txt', type: 'create', before: '', after: 'content' };
  const result = checkRevertible(change, 'content');
  assert.equal(result.ok, true);
});

test('checkRevertible create: file already deleted → conflict', () => {
  const change = { path: 'new.txt', type: 'create', before: '', after: 'content' };
  const result = checkRevertible(change, null);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'file_already_deleted');
});

// V1.4.0-fix P0-3: create type must also verify content matches after

test('checkRevertible create: content matches after → ok', () => {
  const change = { path: 'new.txt', type: 'create', before: '', after: 'agent-content' };
  const result = checkRevertible(change, 'agent-content');
  assert.equal(result.ok, true);
});

test('checkRevertible create: content differs from after (user edited) → conflict', () => {
  const change = { path: 'new.txt', type: 'create', before: '', after: 'agent-content' };
  const result = checkRevertible(change, 'user-edited-content');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'workspace_changed_after_run');
});

// ── checkRevertible: Delete ─────────────────────────────

test('checkRevertible delete: file missing → ok', () => {
  const change = { path: 'old.txt', type: 'delete', before: 'hello', after: '' };
  const result = checkRevertible(change, null);
  assert.equal(result.ok, true);
});

test('checkRevertible delete: file restored → conflict', () => {
  const change = { path: 'old.txt', type: 'delete', before: 'hello', after: '' };
  const result = checkRevertible(change, 'restored');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'file_restored_after_run');
});

// ── checkRevertible: Edge cases ─────────────────────────

test('checkRevertible: null change → invalid', () => {
  const result = checkRevertible(null, 'content');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'invalid_change');
});

test('checkRevertible: unknown type → conflict', () => {
  const change = { path: 'a.txt', type: 'rename', before: 'old', after: 'new' };
  const result = checkRevertible(change, 'new');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unknown_change_type');
});

// ── applyRevert ─────────────────────────────────────────

test('applyRevert modify: restores before content', () => {
  const fs = new MockFileService({ 'a.txt': 'current' });
  const change = { path: 'a.txt', type: 'modify', before: 'original', after: 'current' };
  const result = applyRevert(change, fs);
  assert.equal(result.reverted, true);
  assert.equal(fs.files.get('a.txt'), 'original');
});

test('applyRevert create: deletes file', () => {
  const fs = new MockFileService({ 'new.txt': 'content' });
  const change = { path: 'new.txt', type: 'create', before: '', after: 'content' };
  const result = applyRevert(change, fs);
  assert.equal(result.reverted, true);
  assert.equal(fs.files.has('new.txt'), false);
});

test('applyRevert delete: restores file', () => {
  const fs = new MockFileService({});
  const change = { path: 'old.txt', type: 'delete', before: 'hello', after: '' };
  const result = applyRevert(change, fs);
  assert.equal(result.reverted, true);
  assert.equal(fs.files.get('old.txt'), 'hello');
});

// ── revertRun ───────────────────────────────────────────

test('revertRun: full revert of modify/create/delete', () => {
  const files = { 'a.txt': 'agent-changed', 'new.txt': 'new-content' };
  const fs = new MockFileService(files);
  const observation = {
    changes: {
      files: [
        { path: 'a.txt', type: 'modify', before: 'original', after: 'agent-changed' },
        { path: 'new.txt', type: 'create', before: '', after: 'new-content' },
        { path: 'old.txt', type: 'delete', before: 'deleted-content', after: '' },
      ],
    },
  };

  const result = revertRun(observation, fs);
  assert.equal(result.revertedFiles.length, 3);
  assert.equal(result.conflicts.length, 0);
  assert.equal(result.failedFiles.length, 0);
  assert.equal(fs.files.get('a.txt'), 'original');
  assert.equal(fs.files.has('new.txt'), false);
  assert.equal(fs.files.get('old.txt'), 'deleted-content');
});

test('revertRun: conflict on modified-after-run file', () => {
  const fs = new MockFileService({ 'a.txt': 'user-changed' });
  const observation = {
    changes: {
      files: [
        { path: 'a.txt', type: 'modify', before: 'original', after: 'agent-changed' },
      ],
    },
  };

  const result = revertRun(observation, fs);
  assert.equal(result.revertedFiles.length, 0);
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].reason, 'workspace_changed_after_run');
  // File must NOT be overwritten
  assert.equal(fs.files.get('a.txt'), 'user-changed');
});

test('revertRun: partial — safe files revert, conflict files skip', () => {
  const fs = new MockFileService({
    'a.txt': 'agent-changed',  // matches after → safe
    'b.txt': 'user-changed',   // differs from after → conflict
    'new.txt': 'new-content',  // create → safe
  });
  const observation = {
    changes: {
      files: [
        { path: 'a.txt', type: 'modify', before: 'original', after: 'agent-changed' },
        { path: 'b.txt', type: 'modify', before: 'orig-b', after: 'agent-b' },
        { path: 'new.txt', type: 'create', before: '', after: 'new-content' },
      ],
    },
  };

  const result = revertRun(observation, fs);
  assert.equal(result.revertedFiles.length, 2);
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].path, 'b.txt');
  assert.equal(fs.files.get('a.txt'), 'original');
  assert.equal(fs.files.has('new.txt'), false);
  // b.txt must NOT be changed
  assert.equal(fs.files.get('b.txt'), 'user-changed');
});

test('revertRun: subset paths only', () => {
  const fs = new MockFileService({
    'a.txt': 'agent-a', 'b.txt': 'agent-b',
  });
  const observation = {
    changes: {
      files: [
        { path: 'a.txt', type: 'modify', before: 'orig-a', after: 'agent-a' },
        { path: 'b.txt', type: 'modify', before: 'orig-b', after: 'agent-b' },
      ],
    },
  };

  const result = revertRun(observation, fs, ['a.txt']);
  assert.equal(result.revertedFiles.length, 1);
  assert.equal(result.revertedFiles[0], 'a.txt');
  assert.equal(fs.files.get('a.txt'), 'orig-a');
  // b.txt untouched
  assert.equal(fs.files.get('b.txt'), 'agent-b');
});

test('revertRun: empty changes → no-op', () => {
  const fs = new MockFileService();
  const observation = { changes: { files: [] } };
  const result = revertRun(observation, fs);
  assert.equal(result.revertedFiles.length, 0);
  assert.equal(result.conflicts.length, 0);
});

test('revertRun: missing observation → no-op', () => {
  const fs = new MockFileService();
  const result = revertRun(null, fs);
  assert.equal(result.revertedFiles.length, 0);
});

// ── recomputeCurrentChanges ──────────────────────────────

test('recomputeCurrentChanges: reverted file no longer appears', () => {
  const fs = new MockFileService({ 'a.txt': 'original' });
  const observation = {
    changes: {
      files: [
        { path: 'a.txt', type: 'modify', before: 'original', after: 'agent-changed' },
      ],
    },
  };
  const result = recomputeCurrentChanges(observation, fs);
  assert.equal(result.totalChanges, 0, 'reverted file should not appear');
});

test('recomputeCurrentChanges: unreverted file still appears', () => {
  const fs = new MockFileService({ 'a.txt': 'user-changed' });
  const observation = {
    changes: {
      files: [
        { path: 'a.txt', type: 'modify', before: 'original', after: 'agent-changed' },
      ],
    },
  };
  const result = recomputeCurrentChanges(observation, fs);
  assert.equal(result.totalChanges, 1);
  assert.equal(result.files[0].path, 'a.txt');
  assert.equal(result.files[0].type, 'modify');
});

test('recomputeCurrentChanges: empty file baseline is NOT misidentified', () => {
  // V1.4.0-fix P0-2: an empty file that existed before the Run must not
  // be treated as "create" after recompute.
  const fs = new MockFileService({ 'empty.txt': 'hello' });
  const observation = {
    changes: {
      files: [
        { path: 'empty.txt', type: 'modify', before: '', after: 'hello' },
      ],
    },
  };
  const result = recomputeCurrentChanges(observation, fs);
  // Current = 'hello', baseline = '' (empty file existed).
  // Since current != baseline, there IS a change.
  // Type must be 'modify' (not 'create'), because before existed.
  assert.equal(result.totalChanges, 1);
  assert.equal(result.files[0].type, 'modify',
    'empty baseline file should still be modify, not create');
});

test('recomputeCurrentChanges: empty file restored to empty is no change', () => {
  const fs = new MockFileService({ 'empty.txt': '' });
  const observation = {
    changes: {
      files: [
        { path: 'empty.txt', type: 'modify', before: '', after: 'hello' },
      ],
    },
  };
  const result = recomputeCurrentChanges(observation, fs);
  // Current = '' matches baseline = '' → no change
  assert.equal(result.totalChanges, 0);
});

test('recomputeCurrentChanges: does NOT overwrite immutable observation.changes', () => {
  // V1.4.0-fix P0-1: recomputeCurrentChanges returns a NEW object.
  // It must not mutate observation.changes.
  const fs = new MockFileService({ 'a.txt': 'original' });
  const observation = {
    changes: {
      files: [
        { path: 'a.txt', type: 'modify', before: 'original', after: 'agent-changed' },
      ],
    },
  };
  const originalChanges = observation.changes;
  const result = recomputeCurrentChanges(observation, fs);
  // The function returns a new object, doesn't mutate
  assert.notEqual(result, observation.changes);
  assert.equal(observation.changes, originalChanges, 'immutable evidence must not be mutated');
  assert.equal(observation.changes.files[0].after, 'agent-changed',
    'immutable evidence after field must be preserved');
});

test('recomputeCurrentChanges: create type correctly identified', () => {
  const fs = new MockFileService({ 'new.txt': 'content' });
  const observation = {
    changes: {
      files: [
        { path: 'new.txt', type: 'create', before: '', after: 'content' },
      ],
    },
  };
  const result = recomputeCurrentChanges(observation, fs);
  assert.equal(result.totalChanges, 1);
  assert.equal(result.files[0].type, 'create');
});

test('recomputeCurrentChanges: delete type correctly identified', () => {
  const fs = new MockFileService({});
  const observation = {
    changes: {
      files: [
        { path: 'old.txt', type: 'delete', before: 'hello', after: '' },
      ],
    },
  };
  const result = recomputeCurrentChanges(observation, fs);
  assert.equal(result.totalChanges, 1);
  assert.equal(result.files[0].type, 'delete');
});