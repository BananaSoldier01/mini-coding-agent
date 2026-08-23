/**
 * agent/plan.js — Plan Lifecycle & Execution Integrity
 *
 * V0.6.0
 * - Plan Object: structured plan with steps, risks, files, runId
 * - Plan Mode: plan-only vs plan-execute
 * - Plan Approval Gate: user must approve plan before execution
 * - Plan ↔ Execution Binding: planId → runId → toolCalls
 * - Full lifecycle: DRAFT → AWAITING_APPROVAL → APPROVED → EXECUTING → COMPLETED/FAILED/CANCELLED
 * - Step Tracking: per-step status, completedAt, toolCalls
 * - Plan Drift Detection: detect unexpected file modifications
 * - Step Verification: expectedOutcome + verificationState per step
 */

// ── Plan Status ────────────────────────────────────────
const PLAN_STATUS = {
  DRAFT: 'draft',
  AWAITING_APPROVAL: 'awaiting_approval',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  EXECUTING: 'executing',
  VERIFYING: 'verifying',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
};

// Valid status transitions
const PLAN_TRANSITIONS = {
  [PLAN_STATUS.DRAFT]: [PLAN_STATUS.AWAITING_APPROVAL],
  [PLAN_STATUS.AWAITING_APPROVAL]: [PLAN_STATUS.APPROVED, PLAN_STATUS.REJECTED],
  [PLAN_STATUS.APPROVED]: [PLAN_STATUS.EXECUTING, PLAN_STATUS.FAILED, PLAN_STATUS.CANCELLED],
  [PLAN_STATUS.EXECUTING]: [PLAN_STATUS.VERIFYING, PLAN_STATUS.COMPLETED, PLAN_STATUS.FAILED, PLAN_STATUS.CANCELLED],
  [PLAN_STATUS.VERIFYING]: [PLAN_STATUS.COMPLETED, PLAN_STATUS.FAILED, PLAN_STATUS.CANCELLED],
  [PLAN_STATUS.COMPLETED]: [],
  [PLAN_STATUS.REJECTED]: [],
  [PLAN_STATUS.FAILED]: [],
  [PLAN_STATUS.CANCELLED]: [],
};

// ── Execution Mode ─────────────────────────────────────
const EXECUTION_MODE = {
  PLAN_ONLY: 'plan-only',
  PLAN_EXECUTE: 'plan-execute',
};

// ── Plan Object ────────────────────────────────────────
/**
 * 创建 Plan State。
 * 返回结构化的 plan 对象，包含完整生命周期字段。
 */
function createPlan(opts = {}) {
  const { goal, steps, risks, files, context, runId, executionMode } = opts;
  // V0.6.1: Initialize step tracking + verification fields
  // verificationState is built later by the orchestrator (agent/index.js)
  // from the verification array in the LLM schema
  const enrichedSteps = Array.isArray(steps)
    ? steps.map(s => ({
        id: s.id,
        description: s.description || s.title || '',
        title: s.title || s.description || '',
        type: s.type || 'modify',
        files: Array.isArray(s.files) ? s.files : [],
        risks: Array.isArray(s.risks) ? s.risks : [],
        status: 'pending',
        completedAt: null,
        toolCalls: [],
        // V0.6.0: Verification fields
        expectedOutcome: s.expectedOutcome || null,
        verificationState: s.verificationState || null,
        // V0.6.1: Raw verification array from LLM schema
        _verification: Array.isArray(s.verification) ? s.verification : null,
      }))
    : [];

  return {
    id: `plan_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    status: PLAN_STATUS.DRAFT,
    goal: goal || '',
    steps: enrichedSteps,
    risks: Array.isArray(risks) ? risks : [],
    files: Array.isArray(files) ? files : [],
    context: context || {},
    runId: runId || null,
    executionMode: executionMode || EXECUTION_MODE.PLAN_EXECUTE,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    approvedAt: null,
    executedAt: null,
    completedAt: null,
    toolCallBindings: [],
  };
}

/**
 * 验证 Plan 结构。
 * V0.6.2: 强制 verification — 每个 modify/command 类型的 step 必须有 verification
 */
function validatePlan(plan) {
  if (!plan || typeof plan !== 'object') {
    return { valid: false, errors: ['Plan is not an object'] };
  }
  const errors = [];
  if (!plan.goal || typeof plan.goal !== 'string') {
    errors.push('Plan must have a goal string');
  }
  if (!Array.isArray(plan.steps)) {
    errors.push('Plan.steps must be an array');
  } else {
    for (const step of plan.steps) {
      if (!step.id || !step.description) {
        errors.push('Each step must have id and description');
      }
      // V0.6.2: Enforce verification for modify/command steps
      if (step.type === 'modify' || step.type === 'command') {
        const hasVerification = step.verificationState && step.verificationState.checks && step.verificationState.checks.length > 0;
        const hasVerificationArray = step._verification && Array.isArray(step._verification) && step._verification.length > 0;
        if (!hasVerification && !hasVerificationArray) {
          errors.push(`Step "${step.id}" (${step.type}) must have verification checks`);
        }
      }
    }
  }
  if (!Array.isArray(plan.risks)) {
    errors.push('Plan.risks must be an array');
  }
  if (!Array.isArray(plan.files)) {
    errors.push('Plan.files must be an array');
  }
  if (plan.runId !== null && typeof plan.runId !== 'string') {
    errors.push('Plan.runId must be a string or null');
  }
  return { valid: errors.length === 0, errors };
}

/**
 * 状态机转换 —— 拒绝非法转换。
 */
function transitionPlanStatus(plan, newStatus) {
  if (!plan) return false;
  const allowed = PLAN_TRANSITIONS[plan.status] || [];
  if (!allowed.includes(newStatus)) {
    return false;
  }
  plan.status = newStatus;
  plan.updatedAt = Date.now();
  if (newStatus === PLAN_STATUS.APPROVED) plan.approvedAt = Date.now();
  if (newStatus === PLAN_STATUS.EXECUTING) plan.executedAt = Date.now();
  if (newStatus === PLAN_STATUS.COMPLETED) plan.completedAt = Date.now();
  return true;
}

/**
 * 绑定 Plan → Run → Tool Calls。
 */
function bindToolCall(plan, runId, toolCallId, toolName, args) {
  if (!plan) return;
  plan.toolCallBindings.push({
    planId: plan.id,
    runId: runId || plan.runId,
    toolCallId,
    toolName,
    args,
    timestamp: Date.now(),
  });
  plan.updatedAt = Date.now();

  // V0.6.1: Record tool call on matching step (NO status change)
  recordToolCallOnStep(plan, toolName, args, toolCallId);
}

/**
 * V0.6.1: Record tool call on matching step (NO status change).
 * Step status is managed by the orchestrator AFTER tool execution succeeds.
 */
function recordToolCallOnStep(plan, toolName, args, toolCallId) {
  if (!plan || !Array.isArray(plan.steps)) return;

  const filePath = args?.path || args?.file;
  if (!filePath) return;

  for (const step of plan.steps) {
    if (!step.toolCalls) step.toolCalls = [];
    const stepFiles = step.files || [];
    if (stepFiles.some(f => filePath.includes(f) || f.includes(filePath))) {
      step.toolCalls.push({
        toolName,
        toolCallId,
        filePath,
        timestamp: Date.now(),
      });
      // Only mark as running, NOT completed — completion happens after execution succeeds
      if (step.status === 'pending') {
        step.status = 'running';
      }
    }
  }
}

/**
 * V0.6.2: Mark step as completed AFTER tool execution succeeds.
 * Improved: handles command-type steps and multi-file steps.
 */
function completeStepAfterExecution(plan, stepId) {
  if (!plan || !Array.isArray(plan.steps)) return null;
  const step = plan.steps.find(s => s.id === stepId);
  if (!step || step.status !== 'running') return null;

  // V0.6.2: For command-type steps, check if all files in the step are done
  // For file-based steps, check if all files have been touched
  if (step.files && step.files.length > 0) {
    const allFilesTouched = step.files.every(f =>
      step.toolCalls.some(tc => tc.filePath && (tc.filePath.includes(f) || f.includes(tc.filePath)))
    );
    if (!allFilesTouched) return null; // Not all files done yet
  }

  step.status = 'completed';
  step.completedAt = Date.now();
  plan.updatedAt = Date.now();
  return step;
}

/**
 * V0.6.2: Find matching step for a tool call (handles command-type steps too).
 */
function findMatchingStep(plan, toolName, args) {
  if (!plan || !Array.isArray(plan.steps)) return null;
  const filePath = args?.path || args?.file;

  for (const step of plan.steps) {
    // Command-type steps match by tool name
    if (step.type === 'command' && toolName === 'run_command') {
      return step;
    }
    // File-based steps match by file path
    if (filePath) {
      const stepFiles = step.files || [];
      if (stepFiles.some(f => filePath.includes(f) || f.includes(filePath))) {
        return step;
      }
    }
  }
  return null;
}

/**
 * V0.5.2: Mark a step as completed.
 */
function completeStep(plan, stepId) {
  if (!plan || !Array.isArray(plan.steps)) return;
  const step = plan.steps.find(s => s.id === stepId);
  if (step) {
    step.status = 'completed';
    step.completedAt = Date.now();
    plan.updatedAt = Date.now();
  }
}

/**
 * V0.5.2: Mark a step as failed.
 */
function failStep(plan, stepId, error) {
  if (!plan || !Array.isArray(plan.steps)) return;
  const step = plan.steps.find(s => s.id === stepId);
  if (step) {
    step.status = 'failed';
    step.error = error;
    step.completedAt = Date.now();
    plan.updatedAt = Date.now();
  }
}

/**
 * V0.5.2: Plan Drift Detection.
 * Compares approved plan files with actual modified files.
 */
function detectPlanDrift(plan, actualFiles) {
  if (!plan) return { drift: false, unexpected: [], missing: [] };

  const approvedFiles = new Set(
    (plan.files || []).map(f => f.toLowerCase())
  );
  const actualFileSet = new Set(
    (actualFiles || []).map(f => f.toLowerCase())
  );

  const unexpected = [];
  for (const f of actualFileSet) {
    if (!approvedFiles.has(f)) {
      unexpected.push(f);
    }
  }

  const missing = [];
  for (const f of approvedFiles) {
    if (!actualFileSet.has(f)) {
      missing.push(f);
    }
  }

  return {
    drift: unexpected.length > 0,
    unexpected,
    missing,
  };
}

/**
 * 构建 Plan Prompt（用于 LLM 生成计划）。
 * V0.6.1: 加入 expectedOutcome + verification schema
 */
function buildPlanPrompt(task, projectContext, sessionContext) {
  let prompt = `You are a planning assistant. Analyze the following task and produce a structured execution plan.

## Task
${task}

## Project Instructions
${projectContext?.content || '(none)'}

## Conversation Context
${sessionContext?.summary ? JSON.stringify(sessionContext.summary) : '(fresh session)'}

## Instructions
Produce a JSON object with this exact schema:
{
  "goal": "one sentence describing the ultimate goal",
  "steps": [
    {
      "id": "step-1",
      "description": "what this step does",
      "type": "explore|modify|verify|command",
      "files": ["file1"],
      "risks": ["risk1"],
      "expectedOutcome": "how to verify this step is done correctly",
      "verification": [
        {
          "type": "command|file|git",
          "check": "npm test",
          "expected": "exit 0"
        }
      ]
    }
  ],
  "risks": ["risk 1", "risk 2"],
  "files": ["file1", "file2"],
  "estimatedChanges": "low|medium|high"
}

CRITICAL: Every step MUST include:
- expectedOutcome: A concrete, testable statement of what "done" looks like.
  Examples: "API returns 200 for valid input", "npm test passes with 0 failures",
  "file config.json exists with valid JSON", "no TypeScript errors".
- verification: An array of 1-3 verification checks.
  Each check MUST have:
  - type: "command" (run a shell command), "file" (check file state), or "git" (check git state)
  - check: The command to run or file to check
  - expected: What success looks like (e.g., "exit 0", "file exists", "working tree clean")

Rules:
- Break the task into concrete, ordered steps
- Identify all files that will be touched
- Flag any risks (destructive operations, permission-sensitive actions, etc.)
- Be specific and actionable
- Return ONLY valid JSON, no markdown, no explanation`;

  return prompt;
}

/**
 * 构建 Plan Approval Message（人类可读）。
 */
function formatPlanForApproval(plan) {
  const lines = [];
  lines.push('## 执行计划');
  lines.push('');
  lines.push(`**目标**: ${plan.goal}`);
  lines.push('');
  lines.push('### 步骤');
  for (const step of plan.steps) {
    const typeIcon = {
      explore: '🔍',
      modify: '✏️',
      verify: '✅',
      command: '⚡',
    }[step.type] || '•';
    lines.push(`${typeIcon} ${step.id}: ${step.description}`);
    if (step.files && step.files.length > 0) {
      lines.push(`   Files: ${step.files.join(', ')}`);
    }
  }
  lines.push('');
  lines.push('### 风险');
  for (const risk of plan.risks) {
    lines.push(`- ⚠️ ${risk}`);
  }
  lines.push('');
  lines.push('### 涉及文件');
  for (const f of plan.files) {
    lines.push(`- ${f}`);
  }
  lines.push('');
  lines.push(`**预计变更**: ${plan.estimatedChanges || 'medium'}`);
  return lines.join('\n');
}

export {
  PLAN_STATUS,
  PLAN_TRANSITIONS,
  EXECUTION_MODE,
  createPlan,
  validatePlan,
  transitionPlanStatus,
  bindToolCall,
  recordToolCallOnStep,
  completeStepAfterExecution,
  findMatchingStep,
  completeStep,
  failStep,
  detectPlanDrift,
  buildPlanPrompt,
  formatPlanForApproval,
};