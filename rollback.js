/**
 * rollback.js — V1.4.0: Safe Workspace Rollback
 *
 * Pure function module. No Git dependency. No transactional semantics.
 * Per-file safety check + best-effort safe rollback.
 *
 * Architecture (V1.4.0-fix):
 *   observation.changes        — IMMUTABLE Run evidence (baseline before/after).
 *                                 Never modified. checkRevertible() always
 *                                 reads from here.
 *   observation.currentChanges — DERIVED projection (current Workspace vs
 *                                 baseline). Recomputed after each rollback.
 *                                 UI renders from here.
 */

import crypto from 'node:crypto';

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
 * V1.4.0-fix: always reads from observation.changes (immutable evidence),
 * never from the derived currentChanges projection.
 *
 * @param {object} change  — { path, type, before, after } from immutable evidence
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
 * @param {object} change  — { path, type, before } from immutable evidence
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
 * V1.4.0-fix: always reads from observation.changes (immutable evidence),
 * never from the derived currentChanges.
 *
 * @param {object} observation  — runObservation
 * @param {object} fileService   — WorkspaceFileService instance
 * @param {string[]} [paths]     — optional subset of paths to revert
 * @returns {{ revertedFiles: string[], conflicts: [], failedFiles: [] }}
 */
export function revertRun(observation, fileService, paths = null) {
  // V1.4.0-fix P0-1: always use immutable evidence (observation.changes),
  // never the derived currentChanges projection.
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

// ── Re-compute Current Net Diff (DERIVED projection) ─────

/**
 * Re-compute the current Net Diff between the Run's immutable baseline
 * and the current Workspace state.
 *
 * V1.4.0-fix P0-1: this is a DERIVED projection stored in
 * observation.currentChanges. It NEVER overwrites observation.changes
 * (the immutable rollback evidence).
 *
 * V1.4.0-fix P0-2: uses the original change.type to determine existence,
 * not content emptiness. An empty file that existed before the Run is
 * still "before exists" — its type would be 'modify', not 'create'.
 *
 * @param {object} observation — runObservation with .changes (immutable evidence)
 * @param {object} fileService  — WorkspaceFileService instance
 * @returns {{ files: array, totalChanges: number }} — derived current Net Diff
 */
export function recomputeCurrentChanges(observation, fileService) {
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

    // V1.4.0-fix P0-2: determine existence from the immutable change.type,
    // NOT from whether the content string is empty.
    //   create → before did NOT exist
    //   modify → before existed
    //   delete → before existed
    const beforeExists = change.type !== 'create';
    const currentExists = currentContent !== null;

    // If current matches baseline, the file is no longer changed
    if (beforeExists === currentExists) {
      // Both exist or both don't exist — check content
      if (beforeExists && currentExists && currentContent === (change.before || '')) {
        // File content matches baseline — no longer a change
        continue;
      }
      if (!beforeExists && !currentExists) {
        // Both don't exist — no change
        continue;
      }
    }

    // Determine the current change type relative to baseline
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
      before: beforeExists ? (change.before || '') : '',
      after: currentExists ? (currentContent || '') : '',
      added: type === 'create' ? (currentContent ? currentContent.split('\n').length : 0) : 0,
      removed: type === 'delete' ? (change.before ? change.before.split('\n').length : 0) : 0,
    });
  }

  return {
    files: changedFiles,
    totalChanges: changedFiles.length,
  };
}