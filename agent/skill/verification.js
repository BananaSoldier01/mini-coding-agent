/**
 * agent/skill/verification.js — Skill Verification Runtime
 *
 * V0.8.2
 * - createVerificationResult
 * - runSkillVerification
 */

import { RUNTIME_EVENT_TYPES } from '../runtime/events.js';
import { EvidenceRegistry } from '../runtime/persistence.js';

// ── Verification Result ───────────────────────────────────

/**
 * V0.7.3: VerificationResult — the outcome of a skill verification.
 */
function createVerificationResult(skillId, success, evidenceRefs, checks, reason) {
  return {
    skillId,
    success,
    verifiedAt: Date.now(),
    evidenceRefs: evidenceRefs || [],
    checks: checks || [],
    reason: reason || (success ? 'Verification passed' : 'Verification failed'),
  };
}

// ── Skill Verification Runtime ────────────────────────────

/**
 * V0.7.3: Run skill verification.
 * Transitions: RUNNING → VERIFYING → COMPLETED/FAILED
 * Skill cannot go directly from RUNNING to COMPLETED without verification.
 * V0.8.1: Accepts optional eventLog for auto-emission.
 * V0.8.2: Accepts optional eventEmitter for auto-emission.
 *
 * @param {SkillRegistry} registry - The skill registry
 * @param {string} skillId - The skill to verify
 * @param {EvidenceRegistry} evidenceRegistry - The evidence registry
 * @param {object} opts - Options { checks, runtime, eventLog, eventEmitter, runId }
 * @returns {VerificationResult|null} - The verification result, or null if skill not in RUNNING state
 */
function runSkillVerification(registry, skillId, evidenceRegistry, opts = {}) {
  const skill = registry.get(skillId);
  if (!skill) return null;

  // Must be in RUNNING state to start verification
  if (skill.status !== 'running') {
    return null;
  }

  const eventLog = opts.eventLog;
  const eventEmitter = opts.eventEmitter;
  const runId = opts.runId;

  // Helper: record event via both log and emitter
  const emit = (type, data) => {
    const event = { runId, skillId, type, data };
    if (eventLog) eventLog.record(event);
    if (eventEmitter) eventEmitter.emit(event);
  };

  // Transition to VERIFYING
  skill.status = 'verifying';
  skill.updatedAt = Date.now();
  emit(RUNTIME_EVENT_TYPES.VERIFICATION_STARTED, { checks: opts.checks?.length || 0 });

  // Collect evidence
  const evidenceRefs = [];
  if (opts.checks) {
    for (const check of opts.checks) {
      const evidence = evidenceRegistry.addEvidence({
        skillId,
        type: check.type || 'custom',
        data: check,
      });
      evidenceRefs.push(evidence.id);
    }
  }

  // Determine verification result
  const allChecksPassed = opts.checks ? opts.checks.every(c => c.passed !== false) : true;
  const success = allChecksPassed && evidenceRefs.length > 0;

  // Create verification result
  const result = createVerificationResult(
    skillId,
    success,
    evidenceRefs,
    opts.checks || [],
    success ? null : (opts.reason || 'No passing evidence collected')
  );

  // Transition to final state
  if (success) {
    skill.status = 'completed';
    skill.updatedAt = Date.now();
    emit(RUNTIME_EVENT_TYPES.VERIFICATION_COMPLETED, { success: true, evidenceCount: evidenceRefs.length });
    emit(RUNTIME_EVENT_TYPES.SKILL_COMPLETED, { evidenceRefs });
  } else {
    skill.status = 'failed';
    skill.updatedAt = Date.now();
    emit(RUNTIME_EVENT_TYPES.VERIFICATION_COMPLETED, { success: false, reason: result.reason });
    emit(RUNTIME_EVENT_TYPES.SKILL_FAILED, { reason: result.reason });
  }

  return result;
}

export {
  createVerificationResult,
  runSkillVerification,
};