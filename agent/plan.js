/**
 * agent/plan.js — Plan Mode & Execution Integrity
 *
 * V0.5.1
 * - Plan Object: structured plan with steps, risks, files
 * - Plan Mode: analysis-only, no tool execution
 * - Plan Approval Gate: user must approve plan before execution
 * - Plan ↔ Execution Binding: planId → runId → toolCalls
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

// ── Plan Object ────────────────────────────────────────
/**
 * 创建 Plan State。
 * 返回结构化的 plan 对象。
 */
function createPlan(opts = {}) {
  const { goal, steps, risks, files, context } = opts;
  return {
    id: `plan_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    status: PLAN_STATUS.DRAFT,
    goal: goal || '',
    steps: Array.isArray(steps) ? steps : [],
    risks: Array.isArray(risks) ? risks : [],
    files: Array.isArray(files) ? files : [],
    context: context || {},
    createdAt: Date.now(),
    updatedAt: Date.now(),
    approvedAt: null,
    executedAt: null,
    completedAt: null,
    runId: null,
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
  return { valid: errors.length === 0, errors };
}

/**
 * 更新 Plan 状态。
 */
function updatePlanStatus(plan, status) {
  if (!plan) return null;
  plan.status = status;
  plan.updatedAt = Date.now();
  if (status === PLAN_STATUS.APPROVED) plan.approvedAt = Date.now();
  if (status === PLAN_STATUS.EXECUTING) plan.executedAt = Date.now();
  if (status === PLAN_STATUS.COMPLETED) plan.completedAt = Date.now();
  return plan;
}

/**
 * 绑定 Plan → Run → Tool Calls。
 */
function bindToolCall(plan, toolCallId, toolName, args) {
  if (!plan) return;
  plan.toolCallBindings.push({
    toolCallId,
    toolName,
    args,
    timestamp: Date.now(),
  });
  plan.updatedAt = Date.now();
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
  createPlan,
  validatePlan,
  updatePlanStatus,
  bindToolCall,
  buildPlanPrompt,
  formatPlanForApproval,
};