/**
 * agent/skill/resource-service.js — Skill Resource Security Service
 *
 * V1.6.0: Securely reads resources from external Skill packages.
 * Enforces containment within skillRoot, prevents path traversal,
 * symlink escape, and absolute path escape.
 *
 * Resource types:
 *   references/* — read-only documents
 *   assets/*     — read-only binary/media files
 *   scripts/*    — NOT auto-executed; must go through run_command pipeline
 */

import fs from 'fs';
import path from 'path';

// ── Resource Limits ─────────────────────────────────────────

const RESOURCE_LIMITS = {
  maxFileSize: 1024 * 1024,    // 1MB per file
  maxTotalBytes: 1024 * 1024 * 5, // 5MB total per activation
  maxReferences: 20,           // max references per load
  maxScripts: 10,               // max scripts in manifest
};

// ── Containment Check ───────────────────────────────────────

/**
 * Resolve and verify a path is contained within skillRoot.
 * Blocks ../ traversal, absolute path escape, symlink escape.
 *
 * @returns {string|null} — resolved safe path, or null if blocked
 */
function resolveSafePath(skillRoot, relativePath) {
  if (!skillRoot || !relativePath) return null;

  // Block absolute paths
  if (path.isAbsolute(relativePath)) return null;

  // Block path traversal
  if (relativePath.includes('..')) return null;

  const safeRoot = fs.realpathSync(skillRoot);
  const resolved = path.resolve(safeRoot, relativePath);
  const realResolved = fs.realpathSync(resolved);

  // Containment check
  if (!realResolved.startsWith(safeRoot + path.sep) && realResolved !== safeRoot) {
    return null;
  }

  return realResolved;
}

// ── Resource Service ────────────────────────────────────────

class SkillResourceService {
  constructor(options = {}) {
    this.skillRoot = options.skillRoot || null;
    this.totalLoadedBytes = 0;
    this.maxTotalBytes = options.maxTotalBytes || RESOURCE_LIMITS.maxTotalBytes;
  }

  /**
   * Read a reference file safely.
   */
  readReference(relativePath) {
    const safePath = resolveSafePath(this.skillRoot, relativePath);
    if (!safePath) {
      return { error: 'Path traversal blocked', path: relativePath };
    }

    // P1-5 fix: enforce total budget before reading
    if (this.maxTotalBytes && this.totalLoadedBytes >= this.maxTotalBytes) {
      return {
        error: 'Resource budget exhausted',
        path: relativePath,
        loaded: this.totalLoadedBytes,
        max: this.maxTotalBytes,
      };
    }

    try {
      const stat = fs.statSync(safePath);
      if (!stat.isFile()) {
        return { error: 'Not a file', path: relativePath };
      }
      if (stat.size > RESOURCE_LIMITS.maxFileSize) {
        return { error: 'File too large', path: relativePath, size: stat.size };
      }
      // P1-5 fix: check budget after stat (before read)
      if (this.maxTotalBytes && this.totalLoadedBytes + stat.size > this.maxTotalBytes) {
        return {
          error: 'File would exceed resource budget',
          path: relativePath,
          size: stat.size,
          loaded: this.totalLoadedBytes,
          max: this.maxTotalBytes,
        };
      }

      const content = fs.readFileSync(safePath, 'utf-8');
      this.totalLoadedBytes += stat.size;

      return {
        path: relativePath,
        safePath,
        size: stat.size,
        content,
      };
    } catch (err) {
      return { error: err.message, path: relativePath };
    }
  }

  /**
   * Read an asset file (binary-safe, returns buffer).
   */
  readAsset(relativePath) {
    const safePath = resolveSafePath(this.skillRoot, relativePath);
    if (!safePath) {
      return { error: 'Path traversal blocked', path: relativePath };
    }

    // P1-5 fix: enforce total budget before reading
    if (this.maxTotalBytes && this.totalLoadedBytes >= this.maxTotalBytes) {
      return {
        error: 'Resource budget exhausted',
        path: relativePath,
        loaded: this.totalLoadedBytes,
        max: this.maxTotalBytes,
      };
    }

    try {
      const stat = fs.statSync(safePath);
      if (!stat.isFile()) {
        return { error: 'Not a file', path: relativePath };
      }
      if (stat.size > RESOURCE_LIMITS.maxFileSize) {
        return { error: 'File too large', path: relativePath, size: stat.size };
      }
      // P1-5 fix: check budget after stat (before read)
      if (this.maxTotalBytes && this.totalLoadedBytes + stat.size > this.maxTotalBytes) {
        return {
          error: 'File would exceed resource budget',
          path: relativePath,
          size: stat.size,
          loaded: this.totalLoadedBytes,
          max: this.maxTotalBytes,
        };
      }

      const buffer = fs.readFileSync(safePath);
      this.totalLoadedBytes += stat.size;

      return {
        path: relativePath,
        safePath,
        size: stat.size,
        buffer,
        encoding: 'base64',
      };
    } catch (err) {
      return { error: err.message, path: relativePath };
    }
  }

  /**
   * Check if a script exists (does NOT execute).
   */
  getScriptManifest() {
    const scriptsDir = path.join(this.skillRoot, 'scripts');
    const manifest = [];

    try {
      if (!fs.existsSync(scriptsDir)) return manifest;

      const entries = fs.readdirSync(scriptsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (!/\.(sh|bash|js|mjs|py)$/.test(entry.name)) continue;

        manifest.push({
          name: entry.name,
          path: path.join('scripts', entry.name),
          size: fs.statSync(path.join(scriptsDir, entry.name)).size,
        });
      }
    } catch { /* skip */ }

    return manifest.slice(0, RESOURCE_LIMITS.maxScripts);
  }

  /**
   * Check containment for a path (test helper).
   */
  checkContainment(relativePath) {
    return resolveSafePath(this.skillRoot, relativePath) !== null;
  }
}

// ── Exports ─────────────────────────────────────────────────

export {
  SkillResourceService,
  RESOURCE_LIMITS,
  resolveSafePath,
};