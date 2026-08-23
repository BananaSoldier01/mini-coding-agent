/**
 * agent/skill.js — Skill Model Foundation
 *
 * V0.7.0
 * - Skill Object: reusable Agent capability unit (NOT a tool collection)
 * - Skill Lifecycle: REGISTERED → AVAILABLE → RUNNING → VERIFYING → COMPLETED/FAILED
 * - Skill Schema Validation: rejects malformed skills before loading
 * - Skill ↔ Tool Runtime binding: skills must use existing Tool Runtime
 * - Skill Instruction Layer: context injection with priority ordering
 */

// ── Skill Status ──────────────────────────────────────────
const SKILL_STATUS = {
  REGISTERED: 'registered',
  AVAILABLE: 'available',
  RUNNING: 'running',
  VERIFYING: 'verifying',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
};

const SKILL_TRANSITIONS = {
  [SKILL_STATUS.REGISTERED]: [SKILL_STATUS.AVAILABLE],
  [SKILL_STATUS.AVAILABLE]: [SKILL_STATUS.RUNNING, SKILL_STATUS.CANCELLED],
  [SKILL_STATUS.RUNNING]: [SKILL_STATUS.VERIFYING, SKILL_STATUS.COMPLETED, SKILL_STATUS.FAILED, SKILL_STATUS.CANCELLED],
  [SKILL_STATUS.VERIFYING]: [SKILL_STATUS.COMPLETED, SKILL_STATUS.FAILED, SKILL_STATUS.CANCELLED],
  [SKILL_STATUS.COMPLETED]: [],
  [SKILL_STATUS.FAILED]: [],
  [SKILL_STATUS.CANCELLED]: [],
};

// ── Skill Instruction Priority ────────────────────────────
// Higher number = higher priority
const SKILL_INSTRUCTION_PRIORITY = {
  SYSTEM: 100,
  RUNTIME_POLICY: 80,
  SKILL_INSTRUCTION: 60,
  USER_REQUEST: 40,
};

// ── Validation ────────────────────────────────────────────

/**
 * Validate a Skill definition.
 * Returns { valid, errors }.
 */
function validateSkill(skill) {
  const errors = [];

  if (!skill || typeof skill !== 'object') {
    return { valid: false, errors: ['Skill must be an object'] };
  }

  // Required fields
  if (!skill.id || typeof skill.id !== 'string' || skill.id.trim() === '') {
    errors.push('Skill must have a non-empty string "id"');
  }

  if (!skill.name || typeof skill.name !== 'string' || skill.name.trim() === '') {
    errors.push('Skill must have a non-empty string "name"');
  }

  if (!skill.description || typeof skill.description !== 'string') {
    errors.push('Skill must have a string "description"');
  }

  if (!skill.version || typeof skill.version !== 'string') {
    errors.push('Skill must have a string "version"');
  }

  // Tools must be an array of strings
  if (skill.tools !== undefined) {
    if (!Array.isArray(skill.tools)) {
      errors.push('Skill "tools" must be an array');
    } else {
      for (const t of skill.tools) {
        if (typeof t !== 'string' || t.trim() === '') {
          errors.push('Each tool in "tools" must be a non-empty string');
          break;
        }
      }
    }
  }

  // Verification must be valid
  if (skill.verification !== undefined) {
    if (!Array.isArray(skill.verification)) {
      errors.push('Skill "verification" must be an array');
    } else {
      for (const v of skill.verification) {
        if (!v.type || typeof v.type !== 'string') {
          errors.push('Each verification must have a "type" string');
          break;
        }
        const validTypes = ['command', 'file', 'git', 'custom'];
        if (!validTypes.includes(v.type)) {
          errors.push(`Unknown verification type: ${v.type}`);
          break;
        }
      }
    }
  }

  // Instructions must be a string
  if (skill.instructions !== undefined && typeof skill.instructions !== 'string') {
    errors.push('Skill "instructions" must be a string');
  }

  // Capabilities must be an array
  if (skill.capabilities !== undefined && !Array.isArray(skill.capabilities)) {
    errors.push('Skill "capabilities" must be an array');
  }

  return { valid: errors.length === 0, errors };
}

// ── Skill Factory ─────────────────────────────────────────

/**
 * Create a new Skill with defaults.
 */
function createSkill(definition) {
  const validation = validateSkill(definition);
  if (!validation.valid) {
    throw new Error(`Invalid Skill: ${validation.errors.join('; ')}`);
  }

  return {
    id: definition.id,
    name: definition.name,
    description: definition.description,
    version: definition.version,
    tools: Array.isArray(definition.tools) ? definition.tools : [],
    capabilities: Array.isArray(definition.capabilities) ? definition.capabilities : [],
    instructions: definition.instructions || '',
    verification: Array.isArray(definition.verification) ? definition.verification : [],
    status: SKILL_STATUS.REGISTERED,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    runCount: 0,
    lastRunAt: null,
  };
}

// ── Lifecycle ─────────────────────────────────────────────

function transitionSkillStatus(skill, newStatus) {
  if (!skill) return false;
  const allowed = SKILL_TRANSITIONS[skill.status] || [];
  if (!allowed.includes(newStatus)) {
    console.warn(`[Skill] Invalid transition: ${skill.status} → ${newStatus}`);
    return false;
  }
  skill.status = newStatus;
  skill.updatedAt = Date.now();
  return true;
}

// ── Instruction Layer ─────────────────────────────────────

/**
 * Build skill instruction context block.
 * Priority: System > Runtime Policy > Skill Instruction > User Request
 */
function buildSkillInstructionContext(skill) {
  if (!skill || !skill.instructions) return '';

  return `[Skill: ${skill.name} v${skill.version}]\n${skill.instructions}\n[End Skill Instruction]`;
}

/**
 * Check if a tool is allowed for this skill.
 * Skills can only use tools listed in their "tools" array,
 * or the default tool set if "tools" is empty.
 */
function isToolAllowedForSkill(skill, toolName, availableTools) {
  if (!skill) return false;
  // If skill has no tools list, no tools are allowed (explicit deny)
  if (!skill.tools || skill.tools.length === 0) return false;
  // Check against available tools
  return skill.tools.includes(toolName) && availableTools.includes(toolName);
}

// ── Serialization ─────────────────────────────────────────

function serializeSkill(skill) {
  if (!skill) return null;
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    version: skill.version,
    tools: skill.tools,
    capabilities: skill.capabilities,
    instructions: skill.instructions,
    verification: skill.verification,
    status: skill.status,
    createdAt: skill.createdAt,
    updatedAt: skill.updatedAt,
    runCount: skill.runCount,
    lastRunAt: skill.lastRunAt,
  };
}

function deserializeSkill(data) {
  if (!data) return null;
  const skill = createSkill(data);
  skill.status = data.status || SKILL_STATUS.REGISTERED;
  skill.createdAt = data.createdAt || Date.now();
  skill.updatedAt = data.updatedAt || Date.now();
  skill.runCount = data.runCount || 0;
  skill.lastRunAt = data.lastRunAt || null;
  return skill;
}

// ── Exports ───────────────────────────────────────────────

// ── Skill Registry ────────────────────────────────────────

/**
 * SkillRegistry — manages Skill lifecycle: register, query, load, validate.
 * Skills must pass validation before being available for execution.
 */
class SkillRegistry {
  constructor(availableTools = []) {
    this.skills = new Map(); // id → skill
    this.availableTools = availableTools;
  }

  /**
   * Register a skill definition. Validates before accepting.
   * Returns the created skill or throws on invalid.
   */
  register(definition) {
    const validation = validateSkill(definition);
    if (!validation.valid) {
      throw new Error(`Cannot register invalid skill: ${validation.errors.join('; ')}`);
    }

    // Check that all tools referenced exist in availableTools
    if (definition.tools && definition.tools.length > 0) {
      const missingTools = definition.tools.filter(t => !this.availableTools.includes(t));
      if (missingTools.length > 0) {
        throw new Error(`Skill references unknown tools: ${missingTools.join(', ')}`);
      }
    }

    // Check for duplicate id
    if (this.skills.has(definition.id)) {
      throw new Error(`Skill already registered: ${definition.id}`);
    }

    const skill = createSkill(definition);
    this.skills.set(skill.id, skill);
    return skill;
  }

  /**
   * Get a skill by id. Returns null if not found.
   */
  get(skillId) {
    return this.skills.get(skillId) || null;
  }

  /**
   * List all registered skills, optionally filtered by status.
   */
  list(filterStatus = null) {
    const all = Array.from(this.skills.values());
    if (filterStatus) {
      return all.filter(s => s.status === filterStatus);
    }
    return all;
  }

  /**
   * Load a skill (transition to AVAILABLE).
   * Returns the skill or null if not found.
   */
  load(skillId) {
    const skill = this.get(skillId);
    if (!skill) return null;
    if (skill.status === SKILL_STATUS.REGISTERED) {
      transitionSkillStatus(skill, SKILL_STATUS.AVAILABLE);
    }
    return skill;
  }

  /**
   * Validate a skill definition without registering.
   */
  validate(definition) {
    return validateSkill(definition);
  }

  /**
   * Unregister a skill.
   */
  unregister(skillId) {
    return this.skills.delete(skillId);
  }

  /**
   * Get count of registered skills.
   */
  count() {
    return this.skills.size;
  }

  /**
   * Check if a skill exists.
   */
  has(skillId) {
    return this.skills.has(skillId);
  }
}

// ── Skill Runtime Lifecycle Helpers ───────────────────────

/**
 * V0.7.2: Activate skills for a run — transition from AVAILABLE to RUNNING.
 * Called when the Run starts executing.
 */
function activateSkillsForRun(registry, skillIds) {
  const activated = [];
  for (const id of skillIds) {
    const skill = registry.get(id);
    if (skill && skill.status === SKILL_STATUS.AVAILABLE) {
      transitionSkillStatus(skill, SKILL_STATUS.RUNNING);
      activated.push(skill);
    }
  }
  return activated;
}

/**
 * V0.7.2: Start skill verification — transition from RUNNING to VERIFYING.
 */
function startSkillVerification(registry, skillId) {
  const skill = registry.get(skillId);
  if (skill && skill.status === SKILL_STATUS.RUNNING) {
    transitionSkillStatus(skill, SKILL_STATUS.VERIFYING);
    return skill;
  }
  return null;
}

/**
 * V0.7.2: Complete a skill — transition from VERIFYING to COMPLETED.
 */
function completeSkill(registry, skillId) {
  const skill = registry.get(skillId);
  if (skill && (skill.status === SKILL_STATUS.VERIFYING || skill.status === SKILL_STATUS.RUNNING)) {
    transitionSkillStatus(skill, SKILL_STATUS.COMPLETED);
    return skill;
  }
  return null;
}

/**
 * V0.7.2: Fail a skill — transition to FAILED.
 */
function failSkill(registry, skillId) {
  const skill = registry.get(skillId);
  if (skill && (skill.status === SKILL_STATUS.RUNNING || skill.status === SKILL_STATUS.VERIFYING)) {
    transitionSkillStatus(skill, SKILL_STATUS.FAILED);
    return skill;
  }
  return null;
}

/**
 * V0.7.2: Cancel all skills — transition to CANCELLED.
 */
function cancelAllSkills(registry) {
  const cancelled = [];
  for (const skill of registry.list()) {
    if (skill.status !== SKILL_STATUS.COMPLETED && skill.status !== SKILL_STATUS.FAILED) {
      transitionSkillStatus(skill, SKILL_STATUS.CANCELLED);
      cancelled.push(skill);
    }
  }
  return cancelled;
}

/**
 * V0.7.2: Get skill lifecycle summary for a run.
 */
function getSkillLifecycleSummary(registry) {
  const skills = registry.list();
  return {
    total: skills.length,
    registered: skills.filter(s => s.status === SKILL_STATUS.REGISTERED).length,
    available: skills.filter(s => s.status === SKILL_STATUS.AVAILABLE).length,
    running: skills.filter(s => s.status === SKILL_STATUS.RUNNING).length,
    verifying: skills.filter(s => s.status === SKILL_STATUS.VERIFYING).length,
    completed: skills.filter(s => s.status === SKILL_STATUS.COMPLETED).length,
    failed: skills.filter(s => s.status === SKILL_STATUS.FAILED).length,
    cancelled: skills.filter(s => s.status === SKILL_STATUS.CANCELLED).length,
  };
}

// ── Instruction Provenance ─────────────────────────────────

/**
 * V0.7.2: Build instruction context with provenance tracking.
 * Returns an array of typed instruction blocks, NOT a flat string.
 * The final prompt string is built by the caller from these blocks.
 */
function buildInstructionProvenance(skill, baseBlocks = []) {
  const blocks = [...baseBlocks];

  if (skill && skill.instructions) {
    blocks.push({
      source: 'skill',
      skillId: skill.id,
      skillName: skill.name,
      priority: SKILL_INSTRUCTION_PRIORITY.SKILL_INSTRUCTION,
      timestamp: Date.now(),
      content: skill.instructions,
    });
  }

  return blocks;
}

/**
 * V0.7.2: Sort instruction blocks by priority (highest first).
 */
function sortInstructionsByPriority(blocks) {
  return [...blocks].sort((a, b) => (b.priority || 0) - (a.priority || 0));
}

/**
 * V0.7.2: Render instruction blocks to final prompt string.
 */
function renderInstructionsToPrompt(blocks) {
  const sorted = sortInstructionsByPriority(blocks);
  return sorted.map(b => {
    if (b.source === 'skill') {
      return `[Skill: ${b.skillName} v${b.skillId}]\n${b.content}\n[End Skill: ${b.skillName}]`;
    }
    return b.content;
  }).join('\n\n');
}

// ── Skill Runtime Context ──────────────────────────────────

/**
 * V0.7.2: Unified Skill Runtime Context.
 * Centralizes skill state instead of scattering across agent/index.js, plan.js, verification.js.
 */
class SkillRuntimeContext {
  constructor(runId) {
    this.runId = runId;
    this.activeSkills = [];       // [{ skill, status, activatedAt }]
    this.permissions = new Map(); // skillId → allowedTools[]
    this.lifecycle = new Map();   // skillId → { state, transitions[] }
    this.evidenceRefs = new Map(); // skillId → [evidenceIds]
    this.verificationResults = new Map(); // skillId → VerificationResult
    this.instructionBlocks = [];  // provenance-tracked instructions
    this.eventLog = new RuntimeEventLog(); // V0.8: runtime event timeline
  }

  /**
   * Add a skill to the runtime context.
   */
  addSkill(skill) {
    if (!this.activeSkills.find(s => s.skill.id === skill.id)) {
      this.activeSkills.push({
        skill,
        status: skill.status,
        activatedAt: Date.now(),
      });
      this.lifecycle.set(skill.id, {
        state: skill.status,
        transitions: [{ status: skill.status, timestamp: Date.now() }],
      });
      this.permissions.set(skill.id, skill.tools);
    }
  }

  /**
   * Update skill lifecycle state with transition tracking.
   */
  updateSkillStatus(skillId, newStatus) {
    const entry = this.activeSkills.find(s => s.skill.id === skillId);
    if (entry) {
      entry.status = newStatus;
    }
    const lc = this.lifecycle.get(skillId);
    if (lc) {
      lc.state = newStatus;
      lc.transitions.push({ status: newStatus, timestamp: Date.now() });
    }
  }

  /**
   * Add an instruction block with provenance.
   */
  addInstructionBlock(block) {
    this.instructionBlocks.push({
      ...block,
      timestamp: Date.now(),
    });
  }

  /**
   * Add an evidence reference.
   */
  addEvidenceRef(skillId, evidenceId) {
    if (!this.evidenceRefs.has(skillId)) {
      this.evidenceRefs.set(skillId, []);
    }
    this.evidenceRefs.get(skillId).push(evidenceId);
  }

  /**
   * V0.7.3: Store verification result for a skill.
   */
  setVerificationResult(skillId, result) {
    this.verificationResults.set(skillId, result);
  }

  /**
   * V0.7.3: Get verification result for a skill.
   */
  getVerificationResult(skillId) {
    return this.verificationResults.get(skillId) || null;
  }

  /**
   * Get skills by status.
   */
  getSkillsByStatus(status) {
    return this.activeSkills.filter(s => s.status === status);
  }

  /**
   * Check if a tool is allowed across all active skills (ANY model).
   */
  isToolAllowed(toolName, availableTools) {
    if (this.activeSkills.length === 0) return true; // No skills → all tools allowed
    return this.activeSkills.some(entry =>
      isToolAllowedForSkill(entry.skill, toolName, availableTools)
    );
  }

  /**
   * Serialize for session persistence.
   */
  serialize() {
    return {
      runId: this.runId,
      activeSkills: this.activeSkills.map(s => ({
        skillId: s.skill.id,
        status: s.status,
        activatedAt: s.activatedAt,
      })),
      permissions: Object.fromEntries(this.permissions),
      lifecycle: Object.fromEntries(this.lifecycle),
      evidenceRefs: Object.fromEntries(this.evidenceRefs),
      verificationResults: Object.fromEntries(this.verificationResults),
      instructionBlocks: this.instructionBlocks,
      eventLog: this.eventLog ? this.eventLog.serialize() : null,
    };
  }

  /**
   * Deserialize from session.
   */
  static deserialize(data, registry) {
    const ctx = new SkillRuntimeContext(data.runId);
    if (data.activeSkills) {
      for (const s of data.activeSkills) {
        const skill = registry.get(s.skillId);
        if (skill) {
          ctx.addSkill(skill);
          ctx.updateSkillStatus(s.skillId, s.status);
        }
      }
    }
    if (data.evidenceRefs) {
      for (const [skillId, refs] of Object.entries(data.evidenceRefs)) {
        ctx.evidenceRefs.set(skillId, refs);
      }
    }
    if (data.verificationResults) {
      for (const [skillId, result] of Object.entries(data.verificationResults)) {
        ctx.verificationResults.set(skillId, result);
      }
    }
    if (data.instructionBlocks) {
      ctx.instructionBlocks = data.instructionBlocks;
    }
    if (data.eventLog) {
      ctx.eventLog = RuntimeEventLog.deserialize(data.eventLog);
    }
    return ctx;
  }
}

// ── Evidence Registry ─────────────────────────────────────

/**
 * V0.7.3: Evidence Registry — records why a skill is considered complete.
 * Evidence is the traceable proof that a skill's execution produced expected results.
 */
class EvidenceRegistry {
  constructor() {
    this.evidences = new Map(); // id → evidence
    this.skillIndex = new Map(); // skillId → [evidenceIds]
  }

  /**
   * Add evidence for a skill execution.
   */
  addEvidence(evidence) {
    const ev = {
      id: evidence.id || `ev_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      skillId: evidence.skillId,
      type: evidence.type || 'unknown',
      timestamp: evidence.timestamp || Date.now(),
      data: evidence.data || {},
      ...evidence,
    };
    this.evidences.set(ev.id, ev);

    if (!this.skillIndex.has(ev.skillId)) {
      this.skillIndex.set(ev.skillId, []);
    }
    this.skillIndex.get(ev.skillId).push(ev.id);

    return ev;
  }

  /**
   * Get evidence by id.
   */
  getEvidence(evidenceId) {
    return this.evidences.get(evidenceId) || null;
  }

  /**
   * List all evidence for a skill.
   */
  listSkillEvidence(skillId) {
    const ids = this.skillIndex.get(skillId) || [];
    return ids.map(id => this.evidences.get(id)).filter(Boolean);
  }

  /**
   * Get evidence count for a skill.
   */
  countSkillEvidence(skillId) {
    return (this.skillIndex.get(skillId) || []).length;
  }

  /**
   * Clear evidence for a skill (used when re-verifying).
   */
  clearSkillEvidence(skillId) {
    const ids = this.skillIndex.get(skillId) || [];
    for (const id of ids) {
      this.evidences.delete(id);
    }
    this.skillIndex.delete(skillId);
  }

  /**
   * Serialize for persistence.
   */
  serialize() {
    return {
      evidences: Object.fromEntries(this.evidences),
      skillIndex: Object.fromEntries(this.skillIndex),
    };
  }

  /**
   * Deserialize from persistence.
   */
  static deserialize(data) {
    const registry = new EvidenceRegistry();
    if (data.evidences) {
      for (const [id, ev] of Object.entries(data.evidences)) {
        registry.evidences.set(id, ev);
      }
    }
    if (data.skillIndex) {
      for (const [skillId, ids] of Object.entries(data.skillIndex)) {
        registry.skillIndex.set(skillId, ids);
      }
    }
    return registry;
  }
}

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
 *
 * @param {SkillRegistry} registry - The skill registry
 * @param {string} skillId - The skill to verify
 * @param {EvidenceRegistry} evidenceRegistry - The evidence registry
 * @param {object} opts - Options { checks, runtime, eventLog, runId }
 * @returns {VerificationResult|null} - The verification result, or null if skill not in RUNNING state
 */
function runSkillVerification(registry, skillId, evidenceRegistry, opts = {}) {
  const skill = registry.get(skillId);
  if (!skill) return null;

  // Must be in RUNNING state to start verification
  if (skill.status !== SKILL_STATUS.RUNNING) {
    return null;
  }

  const eventLog = opts.eventLog;
  const runId = opts.runId;

  // Transition to VERIFYING
  transitionSkillStatus(skill, SKILL_STATUS.VERIFYING);
  if (eventLog) {
    eventLog.record({
      runId,
      skillId,
      type: RUNTIME_EVENT_TYPES.VERIFICATION_STARTED,
      data: { checks: opts.checks?.length || 0 },
    });
  }

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
    transitionSkillStatus(skill, SKILL_STATUS.COMPLETED);
    if (eventLog) {
      eventLog.record({
        runId,
        skillId,
        type: RUNTIME_EVENT_TYPES.VERIFICATION_COMPLETED,
        data: { success: true, evidenceCount: evidenceRefs.length },
      });
      eventLog.record({
        runId,
        skillId,
        type: RUNTIME_EVENT_TYPES.SKILL_COMPLETED,
        data: { evidenceRefs },
      });
    }
  } else {
    transitionSkillStatus(skill, SKILL_STATUS.FAILED);
    if (eventLog) {
      eventLog.record({
        runId,
        skillId,
        type: RUNTIME_EVENT_TYPES.VERIFICATION_COMPLETED,
        data: { success: false, reason: result.reason },
      });
      eventLog.record({
        runId,
        skillId,
        type: RUNTIME_EVENT_TYPES.SKILL_FAILED,
        data: { reason: result.reason },
      });
    }
  }

  return result;
}

// ── Lifecycle Constraint Enforcement ──────────────────────

/**
 * V0.7.3: Strict lifecycle transition guard.
 * Prevents illegal transitions like AVAILABLE → COMPLETED directly.
 * All status changes MUST go through this function.
 * V0.8.1: Auto-emits runtime events. See safeTransitionSkillStatus below.
 */
function canTransitionSkillStatus(skill, newStatus) {
  if (!skill) return false;
  if (newStatus === SKILL_STATUS.COMPLETED && skill.status !== SKILL_STATUS.VERIFYING) {
    return false;
  }
  if (skill.status === SKILL_STATUS.COMPLETED || skill.status === SKILL_STATUS.FAILED) {
    return false;
  }
  return (SKILL_TRANSITIONS[skill.status] || []).includes(newStatus);
}

// ── Runtime Event Timeline ────────────────────────────────

const RUNTIME_EVENT_TYPES = {
  SKILL_ACTIVATED: 'skill_activated',
  SKILL_RUNNING: 'skill_running',
  TOOL_STARTED: 'tool_started',
  TOOL_COMPLETED: 'tool_completed',
  VERIFICATION_STARTED: 'verification_started',
  EVIDENCE_COLLECTED: 'evidence_collected',
  VERIFICATION_COMPLETED: 'verification_completed',
  SKILL_COMPLETED: 'skill_completed',
  SKILL_FAILED: 'skill_failed',
  SKILL_CANCELLED: 'skill_cancelled',
  RUN_STARTED: 'run_started',
  RUN_COMPLETED: 'run_completed',
  RUN_FAILED: 'run_failed',
  SNAPSHOT_SAVED: 'snapshot_saved',
  SNAPSHOT_RESTORED: 'snapshot_restored',
};

/**
 * V0.8: RuntimeEventLog — records the full execution timeline for observability.
 */
class RuntimeEventLog {
  constructor() {
    this.events = [];
    this.maxEvents = 1000;
  }

  /**
   * Record a runtime event.
   */
  record(event) {
    const ev = {
      id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
      timestamp: Date.now(),
      ...event,
    };
    this.events.push(ev);

    // Cap the log size
    if (this.events.length > this.maxEvents) {
      this.events = this.events.slice(-this.maxEvents);
    }

    return ev;
  }

  /**
   * Get all events for a run.
   */
  getEvents(runId) {
    if (!runId) return [...this.events];
    return this.events.filter(e => e.runId === runId);
  }

  /**
   * Get events for a specific skill.
   */
  getSkillEvents(skillId) {
    return this.events.filter(e => e.skillId === skillId);
  }

  /**
   * Get the latest event for a skill.
   */
  getLatestSkillEvent(skillId) {
    const skillEvents = this.getSkillEvents(skillId);
    return skillEvents.length > 0 ? skillEvents[skillEvents.length - 1] : null;
  }

  /**
   * Clear events for a run.
   */
  clearEvents(runId) {
    if (!runId) {
      this.events = [];
    } else {
      this.events = this.events.filter(e => e.runId !== runId);
    }
  }

  /**
   * Get event count.
   */
  count(runId) {
    if (!runId) return this.events.length;
    return this.events.filter(e => e.runId === runId).length;
  }

  /**
   * Serialize for persistence.
   */
  serialize() {
    return {
      events: this.events,
      maxEvents: this.maxEvents,
    };
  }

  /**
   * Deserialize from persistence.
   */
  static deserialize(data) {
    const log = new RuntimeEventLog();
    log.events = data.events || [];
    log.maxEvents = data.maxEvents || 1000;
    return log;
  }
}

// ── Runtime Snapshot ──────────────────────────────────────

// V0.8.1: Current snapshot format version
const SNAPSHOT_VERSION = '1';

/**
 * V0.8: RuntimeSnapshot — captures the full state of a run at a point in time.
 * V0.8.1: Added version field for future migration support.
 */
function createSnapshot(runId, runtimeContext, evidenceRegistry, eventLog, status) {
  return {
    id: `snap_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    runId,
    timestamp: Date.now(),
    version: SNAPSHOT_VERSION,
    status: status || 'unknown',
    runtimeContext: runtimeContext ? runtimeContext.serialize() : null,
    evidenceRegistry: evidenceRegistry ? evidenceRegistry.serialize() : null,
    eventLog: eventLog ? eventLog.serialize() : null,
  };
}

/**
 * V0.8: Restore a RuntimeSnapshot into fresh runtime objects.
 * V0.8.1: Applies snapshot version migration if needed.
 */
function restoreSnapshot(snapshot, registry) {
  if (!snapshot) return null;

  // V0.8.1: Apply version migration if needed
  const migrated = migrateSnapshot(snapshot);

  const ctx = new SkillRuntimeContext(migrated.runId);
  if (migrated.runtimeContext) {
    const restored = SkillRuntimeContext.deserialize(migrated.runtimeContext, registry);
    Object.assign(ctx, restored);
  }

  const evRegistry = new EvidenceRegistry();
  if (migrated.evidenceRegistry) {
    const restoredEv = EvidenceRegistry.deserialize(migrated.evidenceRegistry);
    Object.assign(evRegistry, restoredEv);
  }

  const eventLog = new RuntimeEventLog();
  if (migrated.eventLog) {
    const restoredEv = RuntimeEventLog.deserialize(migrated.eventLog);
    Object.assign(eventLog, restoredEv);
  }

  return {
    runtimeContext: ctx,
    evidenceRegistry: evRegistry,
    eventLog,
    restoredAt: Date.now(),
    snapshotVersion: migrated.version,
  };
}

/**
 * V0.8.1: Migrate a snapshot to the current version.
 * Currently supports v0 (no version) → v1.
 */
function migrateSnapshot(snapshot) {
  if (!snapshot) return snapshot;

  // v0 snapshots have no version field
  if (!snapshot.version) {
    return {
      ...snapshot,
      version: '1',
      migratedAt: Date.now(),
      migration: 'v0 → v1 (added version field)',
    };
  }

  // Already current version
  if (snapshot.version === SNAPSHOT_VERSION) {
    return snapshot;
  }

  // Future migrations would go here
  console.warn(`[Snapshot] Unknown version ${snapshot.version}, attempting best-effort restore`);
  return snapshot;
}

// ── Runtime Persistence ───────────────────────────────────

/**
 * V0.8.1: RuntimePersistenceError — unified error model for persistence operations.
 */
class RuntimePersistenceError extends Error {
  constructor(message, errorCode, details = {}) {
    super(message);
    this.name = 'RuntimePersistenceError';
    this.errorCode = errorCode;
    this.details = details;
    this.timestamp = Date.now();
  }

  static serializationFailed(detail) {
    return new RuntimePersistenceError(
      'Snapshot serialization failed',
      'SERIALIZATION_FAILED',
      { detail }
    );
  }

  static deserializationFailed(detail) {
    return new RuntimePersistenceError(
      'Snapshot deserialization failed',
      'DESERIALIZATION_FAILED',
      { detail }
    );
  }

  static notFound(runId) {
    return new RuntimePersistenceError(
      `Snapshot not found: ${runId}`,
      'NOT_FOUND',
      { runId }
    );
  }

  static saveFailed(runId, reason) {
    return new RuntimePersistenceError(
      `Failed to save snapshot: ${runId}`,
      'SAVE_FAILED',
      { runId, reason }
    );
  }

  static deleteFailed(runId, reason) {
    return new RuntimePersistenceError(
      `Failed to delete snapshot: ${runId}`,
      'DELETE_FAILED',
      { runId, reason }
    );
  }
}

/**
 * V0.8: RuntimePersistence — pluggable adapter for saving/loading snapshots.
 * V0.8.1: Added unified error handling.
 */
class RuntimePersistence {
  constructor(adapter) {
    this.adapter = adapter || new MemoryPersistenceAdapter();
  }

  /**
   * Save a snapshot. Throws RuntimePersistenceError on failure.
   */
  async save(snapshot) {
    try {
      // Validate snapshot before saving
      if (!snapshot || !snapshot.runId) {
        throw RuntimePersistenceError.serializationFailed('Invalid snapshot: missing runId');
      }
      return await this.adapter.save(snapshot);
    } catch (err) {
      if (err instanceof RuntimePersistenceError) throw err;
      throw RuntimePersistenceError.saveFailed(snapshot?.runId, err.message);
    }
  }

  /**
   * Load a snapshot by runId. Returns null if not found.
   * Throws RuntimePersistenceError on errors other than not-found.
   */
  async load(runId) {
    try {
      return await this.adapter.load(runId);
    } catch (err) {
      if (err instanceof RuntimePersistenceError) throw err;
      throw new RuntimePersistenceError(
        `Failed to load snapshot: ${runId}`,
        'LOAD_FAILED',
        { runId, reason: err.message }
      );
    }
  }

  /**
   * Delete a snapshot by runId.
   */
  async delete(runId) {
    try {
      return await this.adapter.delete(runId);
    } catch (err) {
      if (err instanceof RuntimePersistenceError) throw err;
      throw RuntimePersistenceError.deleteFailed(runId, err.message);
    }
  }

  /**
   * List all saved snapshot runIds.
   */
  async list() {
    try {
      return await this.adapter.list();
    } catch (err) {
      throw new RuntimePersistenceError(
        'Failed to list snapshots',
        'LIST_FAILED',
        { reason: err.message }
      );
    }
  }
}

/**
 * V0.8: In-memory persistence adapter (default).
 * V0.8.1: Added error simulation capability for testing.
 */
class MemoryPersistenceAdapter {
  constructor(options = {}) {
    this.store = new Map();
    this.failOnSave = options.failOnSave || false;
    this.failOnLoad = options.failOnLoad || false;
  }

  async save(snapshot) {
    if (this.failOnSave) {
      throw RuntimePersistenceError.saveFailed(snapshot?.runId, 'Simulated save failure');
    }
    this.store.set(snapshot.runId, JSON.parse(JSON.stringify(snapshot)));
    return { ok: true, runId: snapshot.runId };
  }

  async load(runId) {
    if (this.failOnLoad) {
      throw new RuntimePersistenceError(
        `Failed to load snapshot: ${runId}`,
        'LOAD_FAILED',
        { runId, reason: 'Simulated load failure' }
      );
    }
    return this.store.get(runId) || null;
  }

  async delete(runId) {
    return this.store.delete(runId);
  }

  async list() {
    return Array.from(this.store.keys());
  }
}

// ── Lifecycle Entry Unification ───────────────────────────

/**
 * V0.8: Unified lifecycle transition — the ONLY public entry point.
 * transitionSkillStatus is now internal-only.
 * All external code MUST use safeTransitionSkillStatus.
 *
 * V0.8.1: Auto-emits runtime events on every transition.
 * State change → event is GUARANTEED. No orphan states.
 *
 * @param {object} skill - The skill to transition
 * @param {string} newStatus - Target status
 * @param {RuntimeEventLog} eventLog - Optional event log for auto-emission
 * @param {object} context - Optional context { runId, skillId, reason }
 * @returns {boolean} True if transition succeeded
 */
function safeTransitionSkillStatus(skill, newStatus, eventLog, context) {
  if (!skill) return false;
  const allowed = SKILL_TRANSITIONS[skill.status] || [];

  // V0.7.3: Additional constraint — must go through VERIFYING before COMPLETED
  if (newStatus === SKILL_STATUS.COMPLETED && skill.status !== SKILL_STATUS.VERIFYING) {
    console.warn(
      `[Skill] Illegal transition: ${skill.status} → ${newStatus}. ` +
      `Skill must go through VERIFYING before COMPLETED.`
    );
    return false;
  }

  // V0.7.3: Cannot transition from terminal states
  if (skill.status === SKILL_STATUS.COMPLETED || skill.status === SKILL_STATUS.FAILED) {
    console.warn(`[Skill] Cannot transition from terminal state: ${skill.status}`);
    return false;
  }

  if (!allowed.includes(newStatus)) {
    console.warn(`[Skill] Invalid transition: ${skill.status} → ${newStatus}`);
    return false;
  }

  // Execute transition
  const oldStatus = skill.status;
  skill.status = newStatus;
  skill.updatedAt = Date.now();

  // V0.8.1: Auto-emit event — state change ALWAYS produces an event
  if (eventLog) {
    const eventType = statusToEventType(newStatus);
    if (eventType) {
      eventLog.record({
        runId: context?.runId,
        skillId: context?.skillId || skill.id,
        type: eventType,
        data: {
          from: oldStatus,
          to: newStatus,
          reason: context?.reason,
        },
      });
    }
  }

  return true;
}

/**
 * V0.8.1: Map skill status to runtime event type.
 */
function statusToEventType(status) {
  const map = {
    [SKILL_STATUS.RUNNING]: RUNTIME_EVENT_TYPES.SKILL_RUNNING,
    [SKILL_STATUS.VERIFYING]: RUNTIME_EVENT_TYPES.VERIFICATION_STARTED,
    [SKILL_STATUS.COMPLETED]: RUNTIME_EVENT_TYPES.SKILL_COMPLETED,
    [SKILL_STATUS.FAILED]: RUNTIME_EVENT_TYPES.SKILL_FAILED,
    [SKILL_STATUS.CANCELLED]: RUNTIME_EVENT_TYPES.SKILL_CANCELLED,
  };
  return map[status] || null;
}

/**
 * V0.8.1: Verify event-state consistency.
 * Checks that every state transition has a corresponding event.
 * Returns { consistent, missingEvents }.
 */
function verifyEventStateConsistency(skill, eventLog) {
  if (!skill || !eventLog) return { consistent: true, missingEvents: [] };

  const skillEvents = eventLog.getSkillEvents(skill.id);
  const stateTransitions = skillEvents.filter(e =>
    e.type === RUNTIME_EVENT_TYPES.SKILL_RUNNING ||
    e.type === RUNTIME_EVENT_TYPES.VERIFICATION_STARTED ||
    e.type === RUNTIME_EVENT_TYPES.SKILL_COMPLETED ||
    e.type === RUNTIME_EVENT_TYPES.SKILL_FAILED ||
    e.type === RUNTIME_EVENT_TYPES.SKILL_CANCELLED
  );

  // Check: if skill is in a non-REGISTERED/non-AVAILABLE state,
  // there should be at least one event
  const terminalStates = [SKILL_STATUS.COMPLETED, SKILL_STATUS.FAILED, SKILL_STATUS.CANCELLED];
  if (terminalStates.includes(skill.status)) {
    const hasCompletionEvent = stateTransitions.some(e =>
      e.type === (skill.status === SKILL_STATUS.COMPLETED ? RUNTIME_EVENT_TYPES.SKILL_COMPLETED :
                   skill.status === SKILL_STATUS.FAILED ? RUNTIME_EVENT_TYPES.SKILL_FAILED :
                   RUNTIME_EVENT_TYPES.SKILL_CANCELLED)
    );
    if (!hasCompletionEvent) {
      return {
        consistent: false,
        missingEvents: [`Missing ${skill.status} event for skill ${skill.id}`],
      };
    }
  }

  return { consistent: true, missingEvents: [] };
}

/**
 * V0.8.1: Internal transition without event emission.
 * For use within this module where events are handled separately.
 */
function transitionSkillStatusInternal(skill, newStatus) {
  if (!skill) return false;
  skill.status = newStatus;
  skill.updatedAt = Date.now();
  return true;
}

// ── Skill ↔ Plan Binding ──────────────────────────────────

/**
 * Attach a skill to a plan.
 * The plan references the skill but execution still goes through Tool Runtime.
 */
function bindSkillToPlan(plan, skill) {
  if (!plan) throw new Error('Plan is required');
  if (!skill) throw new Error('Skill is required');

  if (!plan.skills) plan.skills = [];
  // Avoid duplicate binding
  if (!plan.skills.some(s => s.skillId === skill.id)) {
    plan.skills.push({
      skillId: skill.id,
      skillName: skill.name,
      boundAt: Date.now(),
    });
  }
  plan.updatedAt = Date.now();
  return plan;
}

/**
 * Attach a skill to a specific step.
 */
function bindSkillToStep(step, skill) {
  if (!step) throw new Error('Step is required');
  if (!skill) throw new Error('Skill is required');

  step.skillId = skill.id;
  step.skillName = skill.name;
  step.updatedAt = Date.now();
  return step;
}

/**
 * Get the skill bound to a plan.
 */
function getPlanSkill(plan, skillId) {
  if (!plan || !plan.skills) return null;
  const binding = plan.skills.find(s => s.skillId === skillId);
  return binding || null;
}

// ── Skill Execution Context ───────────────────────────────

/**
 * Build the full skill instruction context for LLM injection.
 * Priority: System > Runtime Policy > Skill Instruction > User Request
 */
function buildSkillContextForLLM(skill, baseContext = '') {
  if (!skill) return baseContext;

  const skillBlock = buildSkillInstructionContext(skill);
  if (!skillBlock) return baseContext;

  // Skill instruction goes AFTER system/runtime context, BEFORE user request
  return `${baseContext}\n\n${skillBlock}`;
}

/**
 * Verify that a tool call is allowed for a skill.
 * Skills must not bypass the Tool Runtime.
 */
function assertSkillToolAllowed(skill, toolName, availableTools) {
  if (!isToolAllowedForSkill(skill, toolName, availableTools)) {
    throw new Error(
      `Skill "${skill.id}" is not permitted to use tool "${toolName}". ` +
      `Allowed tools: ${skill.tools.length > 0 ? skill.tools.join(', ') : '(none)'}`
    );
  }
}

export {
  SKILL_STATUS,
  SKILL_TRANSITIONS,
  SKILL_INSTRUCTION_PRIORITY,
  validateSkill,
  createSkill,
  transitionSkillStatus,
  buildSkillInstructionContext,
  isToolAllowedForSkill,
  serializeSkill,
  deserializeSkill,
  SkillRegistry,
  bindSkillToPlan,
  bindSkillToStep,
  getPlanSkill,
  buildSkillContextForLLM,
  assertSkillToolAllowed,
  // V0.7.2: Runtime Hardening
  activateSkillsForRun,
  startSkillVerification,
  completeSkill,
  failSkill,
  cancelAllSkills,
  getSkillLifecycleSummary,
  buildInstructionProvenance,
  sortInstructionsByPriority,
  renderInstructionsToPrompt,
  SkillRuntimeContext,
  // V0.7.3: Verification & Evidence
  EvidenceRegistry,
  createVerificationResult,
  runSkillVerification,
  safeTransitionSkillStatus,
  canTransitionSkillStatus,
  // V0.8: Observability & Persistence
  RUNTIME_EVENT_TYPES,
  RuntimeEventLog,
  createSnapshot,
  restoreSnapshot,
  RuntimePersistence,
  MemoryPersistenceAdapter,
  RuntimePersistenceError,
  SNAPSHOT_VERSION,
  migrateSnapshot,
  verifyEventStateConsistency,
};