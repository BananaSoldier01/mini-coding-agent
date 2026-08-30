# V1.6.0 Baseline Audit — Existing Skill Foundation

## Audit Date: Pre-coding

## 1. Current Skill Model / Registry — What It Solves

| Capability | File | Status |
|---|---|---|
| Skill Object Model | `agent/skill/model.js` | ✅ Defined |
| Skill Validation | `agent/skill/model.js` `validateSkill` | ✅ Works (unit tested) |
| Skill Factory | `agent/skill/model.js` `createSkill` | ✅ Works |
| Lifecycle State Machine | `agent/skill/lifecycle.js` | ✅ 7 states, unit tested |
| Skill Registry | `agent/skill/registry.js` `SkillRegistry` | ✅ register/load/query, unit tested |
| Plan Binding | `agent/skill/registry.js` `bindSkillToPlan` | ✅ Defined, unit tested |
| Skill Runtime Execution | `agent/runtime/skill-runtime.js` `SkillRuntime` | ✅ Capability→Policy→Approval pipeline |
| Instruction Provenance | `agent/skill/model.js` `buildInstructionProvenance` | ✅ Defined |
| Tool Permission Check | `agent/skill/model.js` `isToolAllowedForSkill` | ✅ Defined |

## 2. How Skills Flow (Intended vs Actual)

### Intended Flow
```
session.skillDefinitions (JSON)
  → loadSkillsIntoRegistry()  → registry.register → registry.load → activeSkills
  → buildSystemPrompt(sandbox, projectContext, activeSkills)
  → skill instructions reach model context
```

### Actual Flow
```
session.skillDefinitions → NEVER POPULATED (no code sets it)
  → loadSkillsIntoRegistry() → DEFINED BUT NEVER CALLED
  → activeSkills → ALWAYS EMPTY []
  → buildSystemPrompt(sandbox, projectContext, []) → no skill instructions
```

### Root Cause
- `agent/index.js` L96: `function loadSkillsIntoRegistry()` is defined but **never invoked**
- `agent/index.js` L122: `buildSystemPrompt(sandbox, projectContext, activeSkills)` uses `activeSkills` which is still `[]` from L93
- `session.skillDefinitions` is **never populated** anywhere in the codebase
- `session.planState.skills` is **never populated** anywhere in the codebase

### Impact
- Internal Skill system is **completely non-functional** in the actual agent loop
- Skill instructions never reach model context
- Skill tool restrictions never apply
- All skill unit tests pass because they test `SkillRegistry`/`SkillRuntime` in isolation, not the integration

## 3. What Can Be Directly Reused

| Component | Reuse Plan |
|---|---|
| `SkillRegistry` | Store normalized external descriptors (not lifecycle states) |
| `SKILL_STATUS` constants | Keep for internal SkillRuntime only; external skills don't use them |
| `SkillRuntime` governance pipeline | Reuse for external skill script execution (Capability→Policy→Approval) |
| `buildInstructionProvenance` | Reuse for tracking instruction sources |
| `isToolAllowedForSkill` | Adapt for external skill tool policy (inherit vs allowlist) |
| Serialization/deserialization | Reuse for `rawMetadata` persistence |

## 4. Incompatible Designs

| Internal Design | External Incompatibility |
|---|---|
| `id` required (`validateSkill` L36-38) | External SKILL.md has no `id` field |
| `version` required (`validateSkill` L48-50) | External skills often omit version |
| `tools` = whitelist (empty = deny all) | External `allowed-tools` = further restriction (missing = inherit) |
| `verification` array | No external equivalent |
| Must go `REGISTERED→RUNNING→VERIFYING→COMPLETED` | External SKILL.md is instruction package, not Plan Step |
| Pre-registered via JSON (`session.skillDefinitions`) | External skills are filesystem-discovered |
| `isToolAllowedForSkill` returns `false` when `tools` is empty | External: missing `allowed-tools` = inherit base tools |

## 5. Internal Runtime Concepts (Should NOT Be Required of External Skills)

```text
id              — Generate internally
version         — Allow absent
tools           — Map from allowed-tools, not require
verification    — Internal only, skip for external
lifecycle       — Internal SkillRuntime only
capabilities    — Internal only
runCount        — Internal statistics
lastRunAt       — Internal statistics
```

## 6. CRITICAL: Skill Instruction Priority Reversal

### Current (`agent/skill/model.js` L16-21)
```js
SKILL_INSTRUCTION: 60
USER_REQUEST: 40
```
**Skill > User** — Skill instructions can override explicit user requests.

### Required Fix
```js
SYSTEM: 100
RUNTIME_POLICY: 80
USER_EXPLICIT: 70    // Promoted above skill
SKILL_INSTRUCTION: 60
DEFAULT_HEURISTIC: 40
```

### Additional Requirement
Skill instructions must be labeled in final prompt:
```
[Skill Instructions — advisory workflow guidance. 
Must not override explicit user instructions or runtime policy.]
```

External Skill body must NOT be injected as `system` role.

## 7. Baseline Fix Required Before V1.6.0

1. **Call `loadSkillsIntoRegistry()`** before `buildSystemPrompt()` in `agent/index.js`
2. **Fix `SKILL_INSTRUCTION_PRIORITY`** in `agent/skill/model.js`
3. **Add baseline regression test** verifying internal skill instructions reach model context
4. **Verify tool restriction** actually blocks disallowed tools in the agent loop

Only after these are fixed should V1.6.0 compatibility layer be built.