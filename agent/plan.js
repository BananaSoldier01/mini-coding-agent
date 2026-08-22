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
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
};

// Valid status transitions
const PLAN_TRANSITIONS = {
  [PLAN_STATUS.DRAFT]: [PLAN_STATUS.AWAITING_APPROVAL],
  [PLAN_STATUS.AWAITING_APPROVAL]: [PLAN_STATUS.APPROVED, PLAN_STATUS.REJECTED],
  [PLAN_STATUS.APPROVED]: [PLAN_STATUS.EXECUTING, PLAN_STATUS.FAILED, PLAN_STATUS.CANCELLED],
  [PLAN_STATUS.EXECUTING]: [PLAN_STATUS.COMPLETED, PLAN_STATUS.FAILED, PLAN_STATUS.CANCELLED],
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
  // V0.6.0: Initialize step tracking + verification fields
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

  // V0.5.2: Update step status based on tool call
  updateStepFromToolCall(plan, toolName, args);
}

/**
 * V0.5.2: Update step status from tool call.
 * Maps tool calls to plan steps by file path.
 */
function updateStepFromToolCall(plan, toolName, args) {
  if (!plan || !Array.isArray(plan.steps)) return;

  const filePath = args?.path || args?.file;
  if (!filePath) return;

  for (const step of plan.steps) {
    if (!step.toolCalls) step.toolCalls = [];
    if (!step.status) step.status = 'pending';
    if (!step.completedAt) step.completedAt = null;

    // Check if this step touches the same file
    const stepFiles = step.files || [];
    if (stepFiles.some(f => filePath.includes(f) || f.includes(filePath))) {
      step.toolCalls.push({
        toolName,
        toolCallId: args._toolCallId,
        filePath,
        timestamp: Date.now(),
      });

      // Update step status
      if (step.status === 'pending') {
        step.status = 'running';
      }
      if (toolName === 'write_file' || toolName === 'edit_file' || toolName === 'delete_file') {
        step.status = 'completed';
        step.completedAt = Date.now();
      }
    }
  }
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
    { "id": "step-1", "description": "what this step does", "type": "explore|modify|verify|command", "files": [], "risks": [] }
  ],
  "risks": ["risk 1", "risk 2"],
  "files": ["file1", "file2"],
  "estimatedChanges": "low|medium|high"
}

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
  updateStepFromToolCall,
  completeStep,
  failStep,
  detectPlanDrift,
  buildPlanPrompt,
  formatPlanForApproval,
};