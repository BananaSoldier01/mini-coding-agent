/**
 * rollback.js — V1.4.0: Safe Workspace Rollback
 *
 * Pure function module. No Git dependency. No transactional semantics.
 * Per-file safety check + best-effort safe rollback.
 *
 * Evidence source: runObservation.changes (from ChangeTracker.getNetDiff())
 * which preserves baseline before/after content for every file the Run touched.
 */

import crypto from 'node:crypto';
import fs from 'fs';
import path from 'path';

// ── Hash ─────────────────────────────────────────────────

export function hashContent(content) {
  if (content === null || content === undefined) return null;
  return crypto.createHash('sha256').update(content).digest('hex');
}

// ── Safety Check ─────────────────────────────────────────

/**
 * Check whether a single file can be safely reverted.
 *
 * V1.4.0-fix P0-3: for `create` type, we now also verify that the current
 * content matches change.after. Without this, a user who edits a file
 * that the Agent created would have their changes silently deleted.
 *
 * @param {object} change  — { path, type, before, after } from runObservation.changes
 * @param {string|null} currentContent — current file content (null = does not exist)
 * @returns {{ ok: true }} | {{ ok: false, reason: string }}
 */
export function checkRevertible(change, currentContent) {
  if (!change || !change.path) {
    return { ok: false, reason: 'invalid_change' };
  }

  switch (change.type) {
    case 'modify':
      // current must match the Run's final state (change.after).
      // If it doesn't, the file was modified after the Run and must NOT be overwritten.
      if (currentContent === null) {
        return { ok: false, reason: 'file_missing' };
      }
      if (currentContent !== change.after) {
        return { ok: false, reason: 'workspace_changed_after_run' };
      }
      return { ok: true };

    case 'create':
      // The Run created this file. It must still exist AND its content
      // must match what the Run wrote (change.after). If the user edited
      // it after the Run, we must NOT delete it.
      // V1.4.0-fix P0-3: previously only checked existence, not content.
      if (currentContent === null) {
        return { ok: false, reason: 'file_already_deleted' };
      }
      if (currentContent !== change.after) {
        return { ok: false, reason: 'workspace_changed_after_run' };
      }
      return { ok: true };

    case 'delete':
      // The Run deleted this file. It must NOT exist to be restorable.
      if (currentContent !== null) {
        return { ok: false, reason: 'file_restored_after_run' };
      }
      return { ok: true };

    default:
      return { ok: false, reason: 'unknown_change_type' };
  }
}

// ── Apply Revert ──────────────────────────────────────────

/**
 * Apply a single-file revert. Caller must have verified checkRevertible() first.
 *
 * @param {object} change  — { path, type, before }
 * @param {object} fileService  — WorkspaceFileService instance
 * @returns {{ path: string, reverted: true }}
 */
export function applyRevert(change, fileService) {
  switch (change.type) {
    case 'modify':
      fileService.writeFile(change.path, change.before || '');
      return { path: change.path, reverted: true };

    case 'create':
      fileService.deleteFile(change.path);
      return { path: change.path, reverted: true };

    case 'delete':
      fileService.writeFile(change.path, change.before || '');
      return { path: change.path, reverted: true };

    default:
      throw new Error(`Unknown change type: ${change.type}`);
  }
}

// ── Run-Level Rollback ────────────────────────────────────

/**
 * Revert all safe files from a Run's changes.
 *
 * @param {object} observation  — runObservation with .changes (array of change objects)
 * @param {object} fileService   — WorkspaceFileService instance
 * @param {string[]} [paths]     — optional subset of paths to revert
 * @returns {{ revertedFiles: string[], conflicts: [], failedFiles: [] }}
 */
export function revertRun(observation, fileService, paths = null) {
  const changes = observation?.changes?.files || [];
  const targets = paths
    ? changes.filter(c => paths.includes(c.path))
    : changes;

  const revertedFiles = [];
  const conflicts = [];
  const failedFiles = [];

  for (const change of targets) {
    // Read current file content (null = does not exist)
    let currentContent = null;
    try {
      const result = fileService.readFile(change.path);
      currentContent = result.content;
    } catch (err) {
      // File doesn't exist or is binary — treat as null
      currentContent = null;
    }

    const check = checkRevertible(change, currentContent);
    if (!check.ok) {
      conflicts.push({
        path: change.path,
        reason: check.reason,
        changeType: change.type,
      });
      continue;
    }

    try {
      applyRevert(change, fileService);
      revertedFiles.push(change.path);
    } catch (err) {
      failedFiles.push({
        path: change.path,
        error: err.message,
      });
    }
  }

  return {
    revertedFiles,
    conflicts,
    failedFiles,
    totalRequested: targets.length,
  };
}

// ── Re-compute Net Diff (V1.4.0-fix P1-1) ─────────────────

/**
 * After a rollback, re-compute the Net Diff between the Run's baseline
 * and the current Workspace state.
 *
 * This ensures the Changes panel reflects reality: files that were
 * reverted no longer appear as changed.
 *
 * @param {object} observation — runObservation with .changes (baseline evidence)
 * @param {object} fileService  — WorkspaceFileService instance
 * @returns {{ files: array, totalChanges: number }} — updated Net Diff
 */
export function recomputeNetDiff(observation, fileService) {
  const baselineFiles = observation?.changes?.files || [];
  const changedFiles = [];

  for (const change of baselineFiles) {
    // Read current file content
    let currentContent = null;
    try {
      const result = fileService.readFile(change.path);
      currentContent = result.content;
    } catch {
      currentContent = null;
    }

    // Determine the current state relative to baseline
    const beforeExists = change.before && change.before !== '';
    const currentExists = currentContent !== null;

    // If current matches baseline, the file is no longer changed
    const beforeKey = beforeExists ? change.before : null;
    const currentKey = currentExists ? currentContent : null;

    if (beforeKey === currentKey) {
      // File is back to baseline — no longer a change
      continue;
    }

    // Determine the change type
    let type;
    if (!beforeExists && currentExists) {
      type = 'create';
    } else if (beforeExists && !currentExists) {
      type = 'delete';
    } else {
      type = 'modify';
    }

    changedFiles.push({
      path: change.path,
      type,
      before: change.before || '',
      after: currentContent || '',
      added: type === 'create' ? (currentContent ? currentContent.split('\n').length : 0) : 0,
      removed: type === 'delete' ? (change.before ? change.before.split('\n').length : 0) : 0,
    });
  }

  return {
    files: changedFiles,
    totalChanges: changedFiles.length,
  };
}