/**
 * agent/runtime/sandbox.js — Runtime Sandbox Boundary
 *
 * V0.9.9
 * - Workspace path restrictions
 * - Runtime-level execution boundary (NOT OS-level sandbox)
 * - Path validation, command filtering
 *
 * Design:
 *   Sandbox prevents Agent from operating outside workspace.
 *   It is a Runtime-level check, not an OS-level isolation.
 */

// ── Sandbox Boundary ──────────────────────────────────────

class RuntimeSandbox {
  constructor(options = {}) {
    this.workspaceRoot = options.workspaceRoot || '/workspace';
    this.allowedPaths = options.allowedPaths || [this.workspaceRoot];
    this.blockedPaths = options.blockedPaths || [];
    this.allowSubdirectories = options.allowSubdirectories !== false;
  }

  /**
   * V0.9.9: Check if a path is within allowed boundaries.
   */
  isPathAllowed(path) {
    if (!path) return false;

    // Normalize path
    const normalized = this._normalize(path);

    // Check blocked paths first
    for (const blocked of this.blockedPaths) {
      if (normalized.startsWith(this._normalize(blocked))) {
        return false;
      }
    }

    // Check allowed paths
    for (const allowed of this.allowedPaths) {
      const normalizedAllowed = this._normalize(allowed);
      if (normalized === normalizedAllowed) return true;
      if (this.allowSubdirectories && normalized.startsWith(normalizedAllowed + '/')) {
        return true;
      }
    }

    return false;
  }

  /**
   * V0.9.9: Validate a path, throwing if not allowed.
   */
  validatePath(path) {
    if (!this.isPathAllowed(path)) {
      throw new Error(`Path ${path} is outside workspace boundary`);
    }
    return true;
  }

  /**
   * V0.9.9: Check if a command is allowed.
   */
  isCommandAllowed(command) {
    if (!command) return false;

    // Block dangerous commands
    const dangerous = [
      'rm -rf /',
      'dd if=',
      'mkfs.',
      ':() { :; }; :',
      'curl | sh',
      'wget | sh',
    ];

    for (const pattern of dangerous) {
      if (command.includes(pattern)) return false;
    }

    return true;
  }

  /**
   * V0.9.9: Validate command, throwing if not allowed.
   */
  validateCommand(command) {
    if (!this.isCommandAllowed(command)) {
      throw new Error(`Command contains dangerous pattern: ${command}`);
    }
    return true;
  }

  /**
   * V0.9.9: Get sandbox info.
   */
  getInfo() {
    return {
      workspaceRoot: this.workspaceRoot,
      allowedPaths: [...this.allowedPaths],
      blockedPaths: [...this.blockedPaths],
      allowSubdirectories: this.allowSubdirectories,
    };
  }

  /**
   * V0.9.9: Normalize path for comparison.
   */
  _normalize(path) {
    return path.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
  }
}

// ── Factory ───────────────────────────────────────────────

/**
 * V0.9.9: Create a RuntimeSandbox.
 */
function createSandbox(options) {
  return new RuntimeSandbox(options);
}

/**
 * V0.9.9: Default sandbox for workspace.
 */
function createDefaultSandbox(workspaceRoot) {
  return new RuntimeSandbox({
    workspaceRoot: workspaceRoot || '/workspace',
    allowedPaths: [workspaceRoot || '/workspace'],
  });
}

export {
  RuntimeSandbox,
  createSandbox,
  createDefaultSandbox,
};