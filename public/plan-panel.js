/**
 * plan-panel.js — Plan Workspace UI
 *
 * V0.5.2
 * - Plan Panel: goal/steps/risks/files/status
 * - Plan Approval: approve/reject buttons
 * - Plan Step ↔ ToolCall Mapping
 * - Plan Execution Progress
 * - Plan Drift Detection
 */

// ── Step Status Icons ─────────────────────────────────
const STEP_STATUS_ICONS = {
  pending: '○',
  running: '⟳',
  completed: '✓',
  failed: '✗',
  skipped: '⊘',
};

const STEP_STATUS_CLASSES = {
  pending: 'step-pending',
  running: 'step-running',
  completed: 'step-completed',
  failed: 'step-failed',
  skipped: 'step-skipped',
};

const PLAN_STATUS_LABELS = {
  draft: 'Draft',
  awaiting_approval: 'Awaiting Approval',
  approved: 'Approved',
  rejected: 'Rejected',
  executing: 'Executing',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

// ── Plan Panel Render ─────────────────────────────────
function renderPlanPanel(plan) {
  if (!plan) {
    return '<div class="plan-panel-empty">No plan available</div>';
  }

  const statusLabel = PLAN_STATUS_LABELS[plan.status] || plan.status;
  const stepStatusClass = STEP_STATUS_CLASSES;

  let html = '<div class="plan-panel">';

  // Header
  html += '<div class="plan-header">';
  html += `<span class="plan-status plan-status-${plan.status}">${statusLabel}</span>`;
  html += `<span class="plan-id">Plan: ${escapeHtml(plan.id)}</span>`;
  html += '</div>';

  // Goal
  html += '<div class="plan-section">';
  html += '<h4>Goal</h4>';
  html += `<p class="plan-goal">${escapeHtml(plan.goal)}</p>`;
  html += '</div>';

  // Steps
  html += '<div class="plan-section">';
  html += '<h4>Steps</h4>';
  html += '<ul class="plan-steps">';
  for (const step of plan.steps) {
    const icon = STEP_STATUS_ICONS[step.status] || '○';
    const cls = stepStatusClass[step.status] || 'step-pending';
    html += `<li class="plan-step ${cls}" data-step-id="${escapeHtml(step.id)}">`;
    html += `<span class="step-icon">${icon}</span>`;
    html += `<span class="step-text">${escapeHtml(step.description || step.title || '')}</span>`;
    if (step.status === 'completed' && step.completedAt) {
      html += `<span class="step-time">${new Date(step.completedAt).toLocaleTimeString()}</span>`;
    }
    if (step.status === 'failed' && step.error) {
      html += `<span class="step-error">${escapeHtml(step.error)}</span>`;
    }
    // Tool calls for this step
    if (step.toolCalls && step.toolCalls.length > 0) {
      html += '<ul class="step-toolcalls">';
      for (const tc of step.toolCalls) {
        html += `<li class="step-toolcall">→ ${escapeHtml(tc.toolName)} (${escapeHtml(tc.filePath || '')})</li>`;
      }
      html += '</ul>';
    }
    html += '</li>';
  }
  html += '</ul>';
  html += '</div>';

  // Risks
  if (plan.risks && plan.risks.length > 0) {
    html += '<div class="plan-section">';
    html += '<h4>Risks</h4>';
    html += '<ul class="plan-risks">';
    for (const risk of plan.risks) {
      html += `<li>⚠️ ${escapeHtml(risk)}</li>`;
    }
    html += '</ul>';
    html += '</div>';
  }

  // Files
  if (plan.files && plan.files.length > 0) {
    html += '<div class="plan-section">';
    html += '<h4>Files</h4>';
    html += '<ul class="plan-files">';
    for (const f of plan.files) {
      html += `<li data-file="${escapeHtml(f)}">📄 ${escapeHtml(f)}</li>`;
    }
    html += '</ul>';
    html += '</div>';
  }

  // Drift Warning
  if (plan._drift && plan._drift.unexpected && plan._drift.unexpected.length > 0) {
    html += '<div class="plan-section plan-drift">';
    html += '<h4>⚠️ Execution Differs from Plan</h4>';
    for (const f of plan._drift.unexpected) {
      html += `<div class="drift-item">Unexpected: ${escapeHtml(f)}</div>`;
    }
    if (plan._drift.missing && plan._drift.missing.length > 0) {
      for (const f of plan._drift.missing) {
        html += `<div class="drift-item">Missing: ${escapeHtml(f)}</div>`;
      }
    }
    html += '</div>';
  }

  // Approval Buttons
  if (plan.status === 'awaiting_approval') {
    html += '<div class="plan-approval">';
    html += '<button class="btn btn-primary" onclick="approvePlan()">✅ Approve</button>';
    html += '<button class="btn btn-danger" onclick="rejectPlan()">❌ Reject</button>';
    html += '</div>';
  }

  // Execution progress bar
  if (plan.status === 'executing' || plan.status === 'completed') {
    const total = plan.steps.length;
    const done = plan.steps.filter(s => s.status === 'completed').length;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    html += '<div class="plan-progress">';
    html += `<div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>`;
    html += `<span class="progress-text">${done}/${total} steps</span>`;
    html += '</div>';
  }

  html += '</div>';
  return html;
}

// ── Open Plan Panel ───────────────────────────────────
function openPlanPanel() {
  const plan = state.plan;
  if (!plan) {
    appendSystemMessage('📋 当前没有计划。启用 Plan Mode 开始。');
    return;
  }

  const html = renderPlanPanel(plan);
  const modal = $('#planPanel');
  if (modal) {
    modal.innerHTML = html;
    modal.classList.add('open');
  }
}

function closePlanPanel() {
  const modal = $('#planPanel');
  if (modal) {
    modal.classList.remove('open');
  }
}

// ── Plan Approval Actions ──────────────────────────────
async function approvePlan() {
  if (!state.plan || state.plan.status !== 'awaiting_approval') return;
  if (!state.sessionId) return;

  try {
    const res = await api('/api/plan/approve', {
      method: 'POST',
      body: {
        sessionId: state.sessionId,
        planId: state.plan.id,
        approved: true,
      },
    });

    if (res.ok) {
      state.plan.status = 'approved';
      appendSystemMessage('✅ 计划已批准，开始执行。');
      closePlanPanel();
    }
  } catch (err) {
    appendSystemMessage('❌ 审批失败: ' + err.message);
  }
}

async function rejectPlan() {
  if (!state.plan || state.plan.status !== 'awaiting_approval') return;
  if (!state.sessionId) return;

  try {
    const res = await api('/api/plan/approve', {
      method: 'POST',
      body: {
        sessionId: state.sessionId,
        planId: state.plan.id,
        approved: false,
      },
    });

    if (res.ok) {
      state.plan.status = 'rejected';
      appendSystemMessage('❌ 计划已被拒绝。');
      closePlanPanel();
    }
  } catch (err) {
    appendSystemMessage('❌ 拒绝失败: ' + err.message);
  }
}

// ── Plan Step Click Handler ────────────────────────────
function handlePlanStepClick(stepId) {
  const plan = state.plan;
  if (!plan) return;

  const step = plan.steps.find(s => s.id === stepId);
  if (!step) return;

  // Show tool calls associated with this step
  const toolCalls = step.toolCalls || [];
  let info = `Step: ${step.description || step.title}\n`;
  info += `Status: ${step.status}\n`;
  if (step.files && step.files.length > 0) {
    info += `Files: ${step.files.join(', ')}\n`;
  }
  if (toolCalls.length > 0) {
    info += '\nTool Calls:\n';
    for (const tc of toolCalls) {
      info += `  - ${tc.toolName}: ${tc.filePath || ''}\n`;
    }
  } else {
    info += '\nNo tool calls yet.';
  }
  appendSystemMessage('ℹ️ ' + info);
}

// ── Plan Indicator in Status Bar ───────────────────────
function updatePlanIndicator() {
  const indicator = $('#planIndicator');
  if (!indicator) return;

  const plan = state.plan;
  if (!plan) {
    indicator.style.display = 'none';
    return;
  }

  indicator.style.display = 'inline-flex';
  const statusLabel = PLAN_STATUS_LABELS[plan.status] || plan.status;
  const done = plan.steps.filter(s => s.status === 'completed').length;
  const total = plan.steps.length;

  indicator.innerHTML = `<span class="plan-indicator-status plan-status-${plan.status}">${statusLabel}</span>` +
    `<span class="plan-indicator-progress">${done}/${total}</span>`;
}

// ── Attach Event Delegation ───────────────────────────
function attachPlanPanelEvents() {
  // Click on plan step
  document.addEventListener('click', (e) => {
    const stepEl = e.target.closest('.plan-step');
    if (stepEl) {
      handlePlanStepClick(stepEl.dataset.stepId);
    }
  });
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
  attachPlanPanelEvents();
  updatePlanIndicator();
});