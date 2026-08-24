# KNOWN ISSUES — Mini Coding Agent

当前已知问题与 Deferred 项。

---

## V1.2.0 — Runtime Execution Engine & Orchestration（已完成）

### Execution Engine
- Unified Run lifecycle: createRun/startRun/pauseRun/resumeRun/completeRun/failRun/cancelRun (agent/runtime/execution-engine.js)
- Task Execution Loop: Pending → Check Dependency → Ready → Execute Skill → Artifact → Verify → Complete
- Scheduler-Executor Integration: Scheduler returns ready tasks, Engine executes
- Failure Recovery: resumeAfterFailure + restoreRun from event store
- State Transition Protection: invalid transitions rejected
- 27 new tests (833/833 PASS)

---

## V1.1.1 — Runtime Hardening & Architecture Stabilization（已完成）

### Runtime Hardening
- Unified State Model: Source of Truth / Derived State / Event Log 分离 (DECISIONS.md)
- Workspace Store: 持久化层与 Registry 分离 (agent/runtime/workspace-store.js)
- Workspace Recovery: serialize/restore 支持 Runtime 重启恢复
- Event System Cleanup: 去重 7 组重复 event 类型，修复 2 处拼写错误
- Event Schema 标准化: EVENT_SCHEMA + validateEvent() 开发模式校验
- Scenario Tests: Workspace Lifecycle / Recovery / Illegal State / Consistency (15 tests)
- 15 new tests (806/806 PASS)

---

## V1.1.0 — Workspace Runtime & Context Management（已完成）

### Workspace Runtime
- Workspace Model: lifecycle + run binding (agent/runtime/workspace.js)
- Workspace Registry: create/get/archive/list (agent/runtime/workspace-registry.js)
- Context Management: create/update/get context (agent/runtime/context-manager.js)
- Artifact Management: create/get/list artifacts (agent/runtime/artifact-store.js)
- Workspace Events: CREATED/ACTIVATED/ARCHIVED/CONTEXT_UPDATED/ARTIFACT_CREATED
- 34 new tests (791/791 PASS)

---

## V1.0.0 — Skill Runtime & Plugin System（已完成）

### Skill Runtime
- Skill Definition Model: createSkillDefinition with tools/capabilities/config (agent/runtime/skill-runtime.js)
- Skill Execution Runtime: executeSkill through full governance pipeline
- Skill Capability Binding: skills declare required capabilities, must pass capability check
- Plugin Package Format: skill.json + prompt.md + config.json local loading
- Skill Events: REGISTERED/ENABLED/DISABLED/EXECUTION_STARTED/COMPLETED/FAILED/CAPABILITY_DENIED
- 17 new tests (757/757 PASS)

---

## V0.9.9 — Capability Runtime & Tool Governance（已完成）

### Capability & Tool Governance
- Capability Model: lifecycle + permission check (agent/runtime/capability.js)
- Tool Registry: register/query + map to capabilities (agent/runtime/tool-registry.js)
- Sandbox Boundary: workspace path restrictions (agent/runtime/sandbox.js)
- Tool Execution Governance: capability→policy→approval→execute
- Capability Events: REGISTERED/ENABLED/DISABLED/CHECKED/DENIED + TOOL events
- 35 new tests (740/740 PASS)

---

## V0.9.8 — Runtime Governance & Human Approval Workflow（已完成）

### Governance & Approval
- Human Approval Gate: WAITING_APPROVAL task state + requestApproval/approveTask/rejectTask
- Runtime Pause / Resume: pauseRun/resumeRun + PAUSED run state
- Human Intervention Events: APPROVAL_REQUESTED/GRANTED/REJECTED/TASK_PAUSED/RESUMED/HUMAN_OVERRIDE
- Runtime Policy Control: requireApproval/maxRiskLevel/allowAutoRevision (agent/runtime/governance.js)
- Governance State Persistence: snapshot includes governance state
- 33 new tests (705/705 PASS)

---

## V0.9.7 — Runtime Event Log & Replay（已完成）

### Event Store & Replay
- Runtime Event Store: append/query/serialize (agent/runtime/event-store.js)
- Unified Event Schema: { id, runId, planId, taskId, type, timestamp, data, source }
- Emitter Integration: setStore() routes all events to store
- Runtime Replay: replayRuntime(events) reconstructs plan/task/revision state
- Debug Query API: getEventsByRun, getEventsByTask, getRevisionTimeline, getTaskTimeline
- Snapshot + Event Integration: serialize/deserialize round trip
- 24 new tests (672/672 PASS)

---

## V0.9.6.1 — Task Superseded Integration（已完成）

### Superseded Integration
- 统一 deprecated → SUPERSEDED: revision.js 使用 status=SUPERSEDED 替代 deprecated=true
- supersedeTask() 保留 evidence 和 previousStatus
- scheduler 通过 taskStatusMap 阻止 SUPERSEDED 任务调度
- 9 new tests (648/648 PASS)

---

## V0.9.6 — Runtime Consistency & Revision Hardening（已完成）

### Revision Hardening
- Task Superseded Lifecycle: SUPERSEDED status, supersedeTask()
- Revision Transaction: prepare/validate/apply/refresh/commit + rollback
- Dependency Conflict Detection: broken deps, invalid graph, orphan tasks
- Completed Task Protection: immutable completed tasks
- Revision History Persistence: plan.revisions + getRevisionHistory()
- 23 new tests (639/639 PASS)

---

## V0.9.5 — Dynamic Plan Revision Runtime（已完成）

### Plan Revision
- Plan Revision Model: createRevisionRequest (parentRevision/changes/reason/timestamp)
- RevisionEngine: checkCompatibility/applyRevision/rejectRevision/refreshScheduler
- Runtime Safe Update: Compatibility Check before Apply Revision
- Scheduler Refresh: recompute ready tasks after revision
- Running Task Protection: prevent direct deletion of RUNNING tasks (mark deprecated)
- 21 new tests (616/616 PASS)

---

## V0.9.4.1 — Recovery Integrity Patch（已完成）

### Recovery Integrity
- Approval Recovery: restore ApprovalRequest from snapshot to ExecutionGate
- ExecutionGate: restoreRequest/restoreRequests/getRequestsByRun/hasPendingApprovals
- Snapshot v2: include approvals field from ExecutionGate
- canAutoContinue() fix: checks pending approvals, failed plan, critical issues, expired approvals
- 20 new tests (595/595 PASS)

---

## V0.9.4 — Runtime Scheduler & Recovery Foundation（已完成）

### Scheduler & Recovery
- TaskScheduler: 调度器 (getReadyTasks/selectNextTask/pause/resume)
- ExecutionCoordinator: 协调 Scheduler→Gate→ToolExecution
- Runtime Recovery Manager: restore/validateConsistency/recoverPendingTasks/recoverPendingApprovals
- Approval Evidence Binding: 审批→证据链
- 27 new tests (575/575 PASS)

---

## V0.9.3 — Runtime Approval & Execution Gate（已完成）

### Approval & Execution Gate
- ApprovalRequest: 审批生命周期 (PENDING→APPROVED/REJECTED/EXPIRED)
- ExecutionGate: 审批门控机制 (request/approve/reject/canProceed)
- ApprovalPolicy: 审批策略 (destructive/production/high-risk 自动触发)
- 29 new tests (548/548 PASS)

---

## V0.9.2 — Planner Interface & Execution Orchestration（已完成）

### Planner & Orchestration
- Planner Interface: Planner/MockPlanner/RuleBasedPlanner/createSimplePlanner
- PlanRuntimeService: Event Sourcing 风格 Plan 状态投影（Task→Plan）
- Plan Revision: revisePlan 版本控制
- 系统不变量测试: Plan/Snapshot/Dependency invariant
- 22 new tests (497/497 PASS)

---

## V0.9.1 — Plan Runtime Foundation（已完成）

### Plan Runtime
- Plan Object: Plan 生命周期 (DRAFT→APPROVED→EXECUTING→VERIFYING→COMPLETED/FAILED/CANCELLED)
- Task Dependency: addTaskDependency/canTaskExecute/getExecutionOrder (拓扑排序)
- Runtime Snapshot v2: Plan+Task+ToolExecution+Evidence 全状态快照
- Runtime Contract: docs/runtime-contract.md
- 27 new tests (470/470 PASS)

---

## V0.9.0.1 — Runtime Consistency Patch（已完成）

### Consistency Fixes
- Task 生命周期约束: RUNNING 不能直接 COMPLETED（必须经过 VERIFYING）
- PolicyContext: skillId 替代 skill object，干净序列化
- checkToolPermission: 支持 skillTools 参数
- RuntimeContext 职责收缩: 业务逻辑未来下沉到 service
- 17 new tests (447/447 PASS)

---

## V0.9.0 — Runtime Control Plane Foundation（已完成）

### Control Plane Foundation
- AgentRuntimeContext: 统一运行时容器
- Task Runtime: Task 对象 + 生命周期
- ToolExecution Runtime: 工具执行一等公民
- Policy Enforcement: checkToolPermission 集成
- Evidence Binding: ToolExecution 自动创建 Evidence
- Event System: TASK_*/TOOL_* 事件类型扩展
- 架构契约: ARCHITECTURE.md（6 条 Contract Rules）
- 30 new tests (430/430 PASS)

---

## V0.8.3 — Pre-V0.9 Cleanup（已完成）

### Agent Core Architecture Review
- RuntimePolicyContext: Permission Context 抽象（environment/user/workspace/skill/restrictions）
- POLICY_PRESETS: development/production/readonly 预设
- Session/Runtime 状态统一决策: Single Source of Truth = RuntimeContext
- Tool Execution Runtime 化设计文档
- Memory 分层定义（Conversation/Working/Execution/Long-term）
- Plan 模型重新确认
- 架构文档: ARCHITECTURE.md
- 23 new tests (423/423 PASS)

---

## V0.8.2 — 已完成

### Runtime Cleanup & Architecture Debt
- Runtime 模块拆分: skill/ + runtime/ 目录结构
- Runtime Event Bus: RuntimeEventEmitter (pub/sub)
- Snapshot Migration Strict Mode: SnapshotCompatibilityError
- Persistence Adapter Contract: exists() method
- 21 new tests (400/400 PASS)

---

## V0.8.1 — 已完成

### Runtime Hardening
- Event-State Auto Sync: safeTransitionSkillStatus 自动 emit 事件
- Snapshot Versioning: SNAPSHOT_VERSION + migrateSnapshot()
- Persistence Error Handling: RuntimePersistenceError 统一错误模型
- Recovery 边界: Restore ≠ Resume 决策记录
- verifyEventStateConsistency(): orphan state 检测
- 23 new tests (379/379 PASS)

---

## V0.8.0 — 已完成

### Runtime Observability & Persistence
- RuntimeEventLog: record/getEvents/getSkillEvents/clearEvents/serialize/deserialize
- RuntimeSnapshot: createSnapshot/restoreSnapshot
- RuntimePersistence: save/load/delete/list with MemoryPersistenceAdapter
- SkillRuntimeContext: eventLog integration
- Lifecycle Entry Unification: safeTransitionSkillStatus as public API
- 25 new tests (356/356 PASS)

---

## V0.7.3 — 已完成

### Skill Verification & Evidence
- EvidenceRegistry: add/get/list/clear/serialize/deserialize
- VerificationResult: success/evidenceRefs/checks/reason
- runSkillVerification(): RUNNING → VERIFYING → COMPLETED/FAILED
- safeTransitionSkillStatus: strict lifecycle guard
- canTransitionSkillStatus: non-mutating check
- SkillRuntimeContext: verificationResults serialization
- 26 new tests (331/331 PASS)

---

## V0.7.2 — 已完成

### Skill Runtime Hardening
- Multi-Skill Permission: ANY active skill allows tool (not ALL must allow)
- Skill Lifecycle Runtime: activateSkillsForRun/startSkillVerification/completeSkill/failSkill/cancelAllSkills
- Instruction Provenance: source/priority tracked per block, not flat string
- SkillRuntimeContext: unified context with activeSkills/permissions/lifecycle/evidenceRefs
- 23 new tests (305/305 PASS)

---

## V0.7.1 — 已完成

### Skill Execution Integration
- Skill ↔ Agent Orchestrator: instruction injection, tool permission, lifecycle
- Skill Registry initialized with agent tool set
- Skill context injected into system prompt with priority ordering
- Skill tool permission enforced before tool execution
- Backward compatibility: plans without skills work normally
- 13 new tests (282/282 PASS)

---

## V0.7.0 — 已完成

### Skill Model Foundation & Registry
- Skill Object: id/name/description/version/tools/capabilities/instructions/verification
- Skill Lifecycle: REGISTERED → AVAILABLE → RUNNING → VERIFYING → COMPLETED/FAILED
- SkillRegistry: register/get/list/load/validate/unregister
- Skill ↔ Plan Binding: bindSkillToPlan/bindSkillToStep
- Skill Instruction Layer: priority-ordered context injection
- Tool Permission: isToolAllowedForSkill/assertSkillToolAllowed
- 53 new tests (269/269 PASS)

---

## V0.6.4 — 已完成

### Verification Hardening / Runtime Integrity
- Evidence Versioning: evidenceVersion + STALE status
- New mutation invalidates old PASSED verification
- read_file does not trigger invalidation
- Verification Runner routes through runtime.execute()/resolvePath()
- command/file/git verification use safe execution path
- 32 new tests (286/286 PASS)

---

## V0.6.3 — 已完成

### Verification Runtime Closure & Safety
- SKIPPED aggregation: only ALL PASSED → PASSED, else FAILED
- expectedOutcome no longer auto-creates CUSTOM check
- validateCheck: typed spec enforcement (type/check/command)
- recordToolCallOnStep: command steps no longer blocked by missing filePath
- successfulEffects: execution evidence separated from intent
- baseline: passed to runVerification from ChangeTracker
- repair → reverify: failed step can be reopened
- done event: emitted AFTER Plan gate (unified completion)
- EXUTING typo fixed
- 24 new tests (278/278 PASS)

---

## V0.6.2 — 已完成

### Verification Closure & Safety
- validatePlan: enforce verification for modify/command steps
- File/Git schema mapping: check field properly mapped by type
- CUSTOM check: SKIPPED (not PASSED) without external evidence
- Completion Gate: only PASSED → COMPLETED, no backdoor
- Step Completion: multi-file steps require all files done
- Command step: properly mapped via findMatchingStep
- Verification feedback: results written to messages for LLM
- Duplicate call: removed double recordToolCallOnStep
- RunStatus: VERIFYING transitions fixed
- PLAN_STATUS.VERIFYING: added
- createHash: from node:crypto (not node:fs)
- 18 Verification Integration Tests

---

## V0.6.1 — 已完成

### Verification Integrity
- Plan Schema: expectedOutcome + verification array in buildPlanPrompt
- Step Completion: AFTER tool execution (not at bind time)
- Verification: awaited (not fire-and-forget)
- Completion Rules: pending/running → FAILED, only PASSED → COMPLETED
- Workspace: verification runner uses workspace param (not process.cwd())
- File 'modified': baseline hash comparison
- Git: porcelain output check for clean tree
- VERIFYING: connected to RunStatus state machine
- Frontend: FAILED shows "计划失败", evidence fields preserved
- setStepExpectedOutcome dead logic fixed

---

## V0.6.0 — 已完成

### Verification Foundation
- Verification Object: verificationState + checks
- Plan Step Verification: expectedOutcome + verificationState
- Verification Lifecycle: EXECUTING → VERIFYING → PASSED/FAILED
- Verification Runner: command/file/git
- Auto Post-Execution Verification
- Verification Timeline Integration
- Plan Completion Rules: verification failed → FAILED
- Verification UI in Plan Panel
- 13 Verification Tests

---

## V0.5.2 — 已完成

### Plan Workspace UI
- Plan Panel: goal/steps/risks/files/status 可视化
- Plan Approval: approve/reject 按钮
- Plan Timeline: plan events 进入 timeline
- Plan Step ↔ ToolCall Mapping
- Plan Execution Progress: 实时步骤状态
- Plan Drift Detection: 意外文件修改检测
- Session Restore: plan state 恢复
- 10 Plan UI Integration Tests

---

## V0.5.1.1 — 已完成

### Plan Lifecycle Closure
- Plan State Machine: DRAFT → AWAITING_APPROVAL → APPROVED → EXECUTING → COMPLETED/FAILED/CANCELLED
- Plan ↔ Run Binding: runId 在 Plan 和 toolCallBindings 中
- Plan Persistence: 序列化/反序列化/switch/new session 全覆盖
- Plan Mode Semantics: plan-only vs plan-execute
- Plan Failure Policy: plan mode 不允许静默 fallback
- 18 Plan Regression Tests

---

## V0.5.1 — 已完成

### Plan Mode
- Plan Object (session.planState) 已定义
- Plan Mode 逻辑已集成到 agent/index.js
- Plan Approval Gate 已实现
- Plan ↔ Execution Binding 已实现
- 状态：开发中

---

## Closed — V0.5.0.3 已解决

### Below trigger 时也会偷偷裁掉历史
- **已关闭**: 三种场景分开
  - below trigger → 全 raw history 保留
  - compaction success → summary + recent raw target
  - degraded/fallback → trim oldest if necessary
- historyTrimmed 真实反映是否丢 raw history

### AGENTS.md content 前端丢失
- **已关闭**: context_loaded 携带 content，前端保存

### Context UI 不是 Session-scoped
- **已关闭**: Server switch 返回 contextState，前端同步恢复
- New Session reset Summary，Project Context 保留

---

## Closed — V0.5.0.2 已解决

### Hard Budget runtime ReferenceError
- **已关闭**: turnMessages 提前初始化，overflow 分支不再 TDZ
- Agent overflow test 确认无 ReferenceError、LLM 未被调用

### History Trimmed ≠ Overflow 语义
- **已关闭**: 两个独立概念
- historyTrimmed = 历史被裁掉
- overflow = 最终 projection 超过 HARD_BUDGET
- trim 成功后允许继续 Run

### RECENT_CONTEXT_TARGET 未参与预算
- **已关闭**: 从后往前选 turns，尽量保留到 target budget，至少 MIN_RECENT_TURNS

### Context Panel 数据不完整
- **已关闭**: Server/Agent 携带 summary/content，Panel 显示 Goals/Constraints/Decisions/Progress/Verification/Open Items

---

## Closed — V0.5.0.1 已解决

### ProjectInstructions contract Bug
- **已关闭**: 正确读取 `readFile().content`（readFile 返回对象，不是字符串）
- AGENTS.md 正文真实进入 modelMessages

### Turn grouping 改变消息顺序
- **已关闭**: Turn 内保持 canonical 原始消息顺序，永不重排 assistant/tool
- 新增多轮 tool iteration regression test

### Compaction 后无 Recent Raw Turns
- **已关闭**: 只 compact 最老 historical turns，保留最近完整 Turn
- `MIN_RECENT_TURNS = 2` 真正参与预算

### Hard Budget 未 enforce
- **已关闭**: 超限 emit `context_overflow`，不调用 LLM
- Agent Loop 内也检查 hard budget

### Context Observability 缺失
- **已关闭**: Context indicator + panel + frontend event handlers（context_loaded/compacted/warning/overflow）

### Project Instructions 重复注入
- **已关闭**: 只在 buildSystemPrompt 中注入一次，builder 不重复

### SUMMARY_MAX_CHARS 未 enforce
- **已关闭**: 超限 degraded，不推进 compactedThrough

---

## Closed — V0.5.0 已解决

### Destructive Session Prune
- **已关闭**: `Session.prune()` 改为 no-op，Canonical Transcript 永远保留

### Message-Count-Only Context Limit
- **已关闭**: Context Budget 使用字符估算（~4 chars/token），不再只看 message count

### No Formal Project Instruction Mechanism
- **已关闭**: AGENTS.md 加载（context/project.js），通过 WorkspaceFileService 读取

### Long Session Context Loss
- **已关闭**: Structured Summary + Incremental Compaction + Recent Turn 保留

---

## Closed — V0.4.2.1 已解决

### Browser E2E Not Introduced
- **已关闭**: Playwright 已引入，17 tests 全绿（11 Browser UI + 6 Real Agent E2E）

### Directory Delete Lacks Agent E2E
- **已关闭**: Agent E2E E — Directory Delete 覆盖完整链路（delete_file → Changes D → Diff → real content）

### Session Title Incomplete
- **已关闭**: 第一条 User Task 自动设置 Session title（POST /api/session 传 title + /api/run 兜底）

### Session Transcript Switching Incomplete
- **已关闭**: /api/session/switch 返回 canonical messages，前端恢复 user + assistant transcript

### Release Artifact Version Drift
- **已关闭**: package.json / package-lock.json / README / ROADMAP / Tag 均为 0.4.2.1

### activeRunId Client-Generated Bug
- **已关闭**: Server ActiveRun.runId 是唯一 Run Identity，Frontend 通过 run_started event 获取

### Output UI Unlimited Rendering
- **已关闭**: Terminal stdout/stderr 各 4000 字符截断，Timeline args/result 各 500 字符截断

---

## Open — 当前已知问题

### Large File Reader
- `totalLines` 可能只是局部近似
- UTF-8 chunk boundary 处理不够严谨
- line range 对极大文件仍可优化
- **File Viewer 对大文件诚实提示**: "Large file — partial preview"

### LCS Diff Performance
- 当前使用 LCS O(m×n) 算法
- 大文件 Diff 可能卡顿
- **触发条件**: 实际出现大文件 Diff 卡顿、CPU 异常、UI 无法审查时再进入 Myers Diff
- **不提前重写**

### Windows Process Tree Kill
- 已实现但无 Windows 实机验证
- **放**: Cross-platform Release Milestone

### OS-level Sandbox
- Shell 目前无 OS 级别 sandbox / container 隔离
- **放**: V1 高自主能力之前的架构 Milestone

### Test Hook Technical Debt
- `window.__dshTest` 在所有 Production Browser 中都会暴露（ unconditional `window.__dshTest = {...}`）
- 仅 `E2E_FAKE_LLM=1` 控制的是 Server 端的 Fake LLM Provider 注入，不影响前端 test hook
- 不应视为产品 API
- **放**: 未来可用 build-time 条件编译或独立 test harness 替代

### Nested AGENTS.md
- V0.5.0 只支持 workspace 根目录 `/AGENTS.md`
- 不支持 `/src/AGENTS.md` 等 directory-scoped 指令
- **放**: V0.5.1+ 根据实际使用反馈决定

### Context Estimation
- Context size 是估算值（~4 chars/token），不是 tokenizer-exact
- UI 不显示虚假精确 token 数
- **放**: 如果需要精确 token 计数，未来可接入 tokenizer

### Summary Fidelity
- Compaction 是 LLM 生成的衍生上下文，可能不完美地总结历史
- Canonical Transcript 始终保留，可用于审计
- **放**: 这是设计取舍，不是 bug

### Permission Mode Category Names
- `policy.js` 使用 `file_destructive` 而 `permission.js` 使用 `file_edit` / `file_delete`
- Safe 模式下默认拒绝未在 ALLOW 白名单中的类别，功能正确但命名不一致
- **放**: 后续统一 category 命名

---

## Deferred — 不阻塞当前版本

### V0.5 候选方向（不做决策、不做实现）
- Task Planning / Plan Mode
- Context Management / 自动摘要
- Extensibility / Skills
- Git-aware Workflow
- 多任务 / Worktree
- 更强安全隔离（container / OS sandbox）

---

## Not Implemented — 明确不做

- Monaco / Manual Editor
- LSP / Autocomplete
- Debugger
- Git Source Control Panel / Worktree
- Plan Mode
- MCP / Skills / Subagent
- Multi-Agent / Memory System / Vector DB
- Browser Agent
- Multi-provider
- UI Framework 全面重写
- 大面积视觉重构（圆角卡片、渐变、玻璃拟态等）