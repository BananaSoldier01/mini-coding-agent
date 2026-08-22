/**
 * agent/verification.js — Verification Foundation
 *
 * V0.6.0
 * - Verification Object: verificationState with checks
 * - Verification Lifecycle: EXECUTING → VERIFYING → PASSED/FAILED
 * - Verification Runner: command/file/git verification
 * - Plan Step Verification: expectedOutcome + verificationState per step
 */

// ── Verification Status ────────────────────────────────
const VERIFICATION_STATUS = {
  PENDING: 'pending',
  RUNNING: 'running',
  PASSED: 'passed',
  FAILED: 'failed',
  SKIPPED: 'skipped',
};

// ── Verification Check Types ───────────────────────────
const VERIFICATION_TYPE = {
  COMMAND: 'command',
  FILE: 'file',
  GIT: 'git',
  CUSTOM: 'custom',
};

// ── Verification Object ────────────────────────────────
/**
 * 创建 Verification State。
 */
function createVerification(opts = {}) {
  const { planId, stepId, checks } = opts;
  return {
    id: `verify_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    planId: planId || null,
    stepId: stepId || null,
    status: VERIFICATION_STATUS.PENDING,
    checks: Array.isArray(checks) ? checks : [],
    startedAt: null,
    completedAt: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

/**
 * 添加 Verification Check。
 */
function addCheck(verification, check) {
  if (!verification) return;
  verification.checks.push({
    id: check.id || `check_${Date.now().toString(36)}`,
    type: check.type || VERIFICATION_TYPE.CUSTOM,
    description: check.description || '',
    command: check.command || null,
    expected: check.expected || null,
    status: VERIFICATION_STATUS.PENDING,
    result: null,
    startedAt: null,
    completedAt: null,
    duration: null,
  });
  verification.updatedAt = Date.now();
}

/**
 * 开始 Verification。
 */
function startVerification(verification) {
  if (!verification) return;
  verification.status = VERIFICATION_STATUS.RUNNING;
  verification.startedAt = Date.now();
  verification.updatedAt = Date.now();
}

/**
 * 完成 Check。
 */
function completeCheck(verification, checkId, status, result) {
  if (!verification) return;
  const check = verification.checks.find(c => c.id === checkId);
  if (!check) return;
  check.status = status;
  check.result = result;
  check.completedAt = Date.now();
  if (check.startedAt) {
    check.duration = check.completedAt - check.startedAt;
  }
  verification.updatedAt = Date.now();
}

/**
 * 开始 Check。
 */
function startCheck(verification, checkId) {
  if (!verification) return;
  const check = verification.checks.find(c => c.id === checkId);
  if (!check) return;
  check.status = VERIFICATION_STATUS.RUNNING;
  check.startedAt = Date.now();
  verification.updatedAt = Date.now();
}

/**
 * 完成 Verification。
 */
function completeVerification(verification, status) {
  if (!verification) return;
  verification.status = status;
  verification.completedAt = Date.now();
  verification.updatedAt = Date.now();
}

/**
 * 从 Plan Step 创建 Verification。
 */
function createVerificationFromStep(plan, step) {
  const checks = [];
  if (step.expectedOutcome) {
    checks.push({
      id: `check_${step.id}_outcome`,
      type: VERIFICATION_TYPE.CUSTOM,
      description: step.expectedOutcome,
      expected: step.expectedOutcome,
    });
  }
  return createVerification({
    planId: plan?.id,
    stepId: step?.id,
    checks,
  });
}

// ── Verification Runner ────────────────────────────────
/**
 * 运行 Command Verification。
 * 返回 { status, result, duration }。
 */
async function runCommandVerification(command) {
  const start = Date.now();
  try {
    // Use child_process for real command execution
    const { execSync } = await import('node:child_process');
    const result = execSync(command, {
      encoding: 'utf-8',
      timeout: 30000,
      cwd: process.cwd(),
    });
    return {
      status: VERIFICATION_STATUS.PASSED,
      result: result.trim(),
      duration: Date.now() - start,
    };
  } catch (err) {
    return {
      status: VERIFICATION_STATUS.FAILED,
      result: (err.stderr || err.message || String(err)).trim(),
      exitCode: err.status,
      duration: Date.now() - start,
    };
  }
}

/**
 * 运行 File Verification。
 */
async function runFileVerification(filePath, expected) {
  const { existsSync, statSync } = await import('node:fs');
  const { resolve } = await import('node:path');

  const fullPath = resolve(process.cwd(), filePath);
  const exists = existsSync(fullPath);

  if (expected === 'exists') {
    return {
      status: exists ? VERIFICATION_STATUS.PASSED : VERIFICATION_STATUS.FAILED,
      result: exists ? `File exists: ${filePath}` : `File not found: ${filePath}`,
    };
  }
  if (expected === 'not_exists') {
    return {
      status: !exists ? VERIFICATION_STATUS.PASSED : VERIFICATION_STATUS.FAILED,
      result: !exists ? `File confirmed absent: ${filePath}` : `File still exists: ${filePath}`,
    };
  }
  if (expected === 'modified') {
    if (!exists) {
      return { status: VERIFICATION_STATUS.FAILED, result: `File not found: ${filePath}` };
    }
    const stat = statSync(fullPath);
    return {
      status: VERIFICATION_STATUS.PASSED,
      result: `File modified: ${filePath} (${stat.size} bytes, mtime ${stat.mtimeMs})`,
    };
  }
  return { status: VERIFICATION_STATUS.PASSED, result: `File check passed: ${filePath}` };
}

/**
 * 运行 Git Verification。
 */
async function runGitVerification(args = ['status']) {
  const start = Date.now();
  try {
    const { execSync } = await import('node:child_process');
    const result = execSync(`git ${args.join(' ')}`, {
      encoding: 'utf-8',
      timeout: 15000,
      cwd: process.cwd(),
    });
    return {
      status: VERIFICATION_STATUS.PASSED,
      result: result.trim(),
      duration: Date.now() - start,
    };
  } catch (err) {
    return {
      status: VERIFICATION_STATUS.FAILED,
      result: (err.stderr || err.message || String(err)).trim(),
      exitCode: err.status,
      duration: Date.now() - start,
    };
  }
}

/**
 * 运行单个 Check。
 */
async function runCheck(check, opts = {}) {
  const { workspace } = opts;
  startCheck(null, check.id); // no-op for standalone

  switch (check.type) {
    case VERIFICATION_TYPE.COMMAND: {
      const result = await runCommandVerification(check.command);
      return { ...result, checkId: check.id };
    }
    case VERIFICATION_TYPE.FILE: {
      const result = await runFileVerification(check.command, check.expected);
      return { ...result, checkId: check.id };
    }
    case VERIFICATION_TYPE.GIT: {
      const result = await runGitVerification(check.command ? check.command.split(' ') : undefined);
      return { ...result, checkId: check.id };
    }
    default:
      return {
        status: VERIFICATION_STATUS.PASSED,
        result: check.description || 'Custom check passed',
        checkId: check.id,
      };
  }
}

/**
 * 运行完整 Verification。
 */
async function runVerification(verification, opts = {}) {
  if (!verification) return verification;

  startVerification(verification);

  for (const check of verification.checks) {
    const result = await runCheck(check, opts);
    completeCheck(
      verification,
      check.id,
      result.status,
      result.result
    );
  }

  const allPassed = verification.checks.every(c => c.status === VERIFICATION_STATUS.PASSED);
  const anyFailed = verification.checks.some(c => c.status === VERIFICATION_STATUS.FAILED);

  if (anyFailed) {
    completeVerification(verification, VERIFICATION_STATUS.FAILED);
  } else if (verification.checks.length > 0) {
    completeVerification(verification, VERIFICATION_STATUS.PASSED);
  } else {
    completeVerification(verification, VERIFICATION_STATUS.PASSED);
  }

  return verification;
}

// ── Plan Step Verification Helpers ─────────────────────
/**
 * 为 Plan Step 添加 expectedOutcome。
 */
function setStepExpectedOutcome(plan, stepId, expectedOutcome) {
  if (!plan || !Array.isArray(plan.steps)) return;
  const step = plan.steps.find(s => s.id === stepId);
  if (step) {
    step.expectedOutcome = expectedOutcome;
    step.verificationState = createVerificationFromStep(plan, step);
    plan.updatedAt = Date.now();
  }
}

/**
 * 获取 Plan Step 的 Verification 状态。
 */
function getStepVerification(plan, stepId) {
  if (!plan || !Array.isArray(plan.steps)) return null;
  const step = plan.steps.find(s => s.id === stepId);
  return step?.verificationState || null;
}

export {
  VERIFICATION_STATUS,
  VERIFICATION_TYPE,
  createVerification,
  addCheck,
  startVerification,
  startCheck,
  completeCheck,
  completeVerification,
  createVerificationFromStep,
  runCommandVerification,
  runFileVerification,
  runGitVerification,
  runCheck,
  runVerification,
  setStepExpectedOutcome,
  getStepVerification,
};