/**
 * agent/skill.js — Skill Model Foundation (Backward-Compatible Barrel)
 *
 * V0.8.2: Module Split
 * This file is now a re-export barrel for backward compatibility.
 * New code should import from agent/skill/ or agent/runtime/ directly.
 *
 * Structure:
 *   agent/skill/
 *     ├── model.js       — Skill Object, Validation, Serialization
 *     ├── lifecycle.js   — Status, Transitions, safeTransitionSkillStatus
 *     ├── registry.js    — SkillRegistry, Plan Binding, Lifecycle Helpers
 *     └── index.js       — Skill Domain Barrel
 *
 *   agent/runtime/
 *     ├── events.js      — RuntimeEventLog, RuntimeEventEmitter
 *     ├── context.js     — SkillRuntimeContext
 *     ├── snapshot.js    — Snapshot, Migration, Compatibility
 *     └── persistence.js — EvidenceRegistry, RuntimePersistence
 */

export * from './skill/index.js';
export * from './runtime/index.js';