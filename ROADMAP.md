# ROADMAP — Mini Coding Agent

## 当前阶段
**V0.9.4 — Runtime Scheduler & Recovery Foundation**（已完成）

**Next: V0.9.5 — Dynamic Plan Revision**

核心目标：把 Files、Agent Activity、Changes、Diff、Terminal 从几个彼此独立的区域，变成一套连续、可导航、适合真实 Coding Task 的 Coding Workspace。

## 版本路线

### V0.1 — MVP
- 基础 Agent Loop（LLM → 工具 → 结果 → 迭代）
- 基础工具：read/write/edit/search/list/run
- 简单 Web UI
- 状态：已完成

### V0.3.x — Harness Reliability

#### V0.3.0
- buildFileTree 回归修复
- WorkspaceFileService 统一文件访问
- Shell Policy 改为 capability-based
- Session Transcript 重构
- Run Net Diff
- Run-scoped Approval
- 106 tests
- 状态：已完成

#### V0.3.1 — Integration Closure
- Approval 协议修复（runId 传递）
- Config POST 去重 JSON.parse
- LLM AbortSignal 完整链路
- RunManager race 修复
- Shell operation allowlist
- search_files 敏感文件防护
- Session/Workspace 绑定
- 状态：已完成

#### V0.3.2 — Verification Closure
- Run Net Diff: NON_EXISTENT sentinel
- Canonical transcript: final assistant
- Shell compound command 检测
- HTTP Trust Boundary: Host/Origin/CSRF
- /api/run 验证顺序修复
- 状态：已完成

#### V0.3.3 — Delivery Integrity
- 修复报告与 Git 状态不一致
- CSRF token 落地或删除
- Shell SAFE 边界收紧
- Project script 权限升级
- 目录删除 Net Diff
- Approval timeout cleanup
- Windows ESM process kill
- GitHub Actions CI
- Regression tests
- Version consistency
- 状态：已完成

#### V0.3.3.1 — Hotfix
- Shell SAFE / Approval precedence（git mutation 预检）
- Shell sensitive-file bypass（head/tail/sort 敏感路径检测）
- 目录删除 baseline 修复
- Regression tests
- 状态：已完成

### V0.4.x — Product Experience

#### V0.4.0 — Control & Visibility
- Permission Mode: Safe/Standard/Full Access, Session-scoped
- Agent Run Status: Thinking→Reading→Searching→Editing→Running→Waiting→Verifying→Completed
- Agent Activity Timeline: 人类可读的工具调用展示
- Approval UX: 人类可读的审批说明
- Changes Panel: Net Diff 一级展示
- Completion Summary: 结构化总结
- Directory delete: real before content snapshot
- 状态：已完成

#### V0.4.0.1 — Control Integrity Hotfix
- Permission decision merge 重构（Base Policy 始终执行）
- Hard Deny 永远不可被 Mode 覆盖
- Safe 的 Approval 不可被 base allow 降级
- Full Access: requireApproval → allow
- Permission UI ↔ Session 一致性（PATCH 成功后才更新 UI）
- Directory delete: NON_EXISTENT import + integration regression
- Completion Summary: 真实 command evidence
- 状态：已完成

#### V0.4.0.2 — Control Integrity Closure
- Agent import/symbol 一致性修复 + ESM import gate
- Safe 模式真正区别于 Standard（write/edit/delete/shell → requireApproval）
- 首次 Session 创建携带 permissionMode
- Completion Summary: Run-scoped evidence reset
- Approval 计数：Server 确认后才增加
- Run Status: approval recovery + 移除伪造 Verifying
- npm start 启动级验收通过
- 状态：已完成

#### V0.4.0.3 — Final Hotfix
- NON_EXISTENT import 修复（agent/index.js）
- _collectFiles: isBinary buffer 零填充 bug 修复
- Approval evidence: resolved=true 才计数
- test/permission.test.js: 14 tests 永久化
- test/integration/directory-delete.test.js: 2 tests 永久化
- V0.4.0 Control & Visibility 阶段正式关闭
- 状态：已完成

### V0.4.1 — Workspace Experience
- Unified Inspector: Changes | File 双 Tab
- File Current / Diff viewer（行号、monospace、导航）
- File Explorer: lazy loading, expand/collapse, change indicators
- Timeline → Inspector / Terminal 导航
- Changes → Inspector Diff 导航
- Terminal command cards
- Binary Detection 修复 + 统一事实源
- search_files path contract 修复
- New Session 入口
- 状态：已完成

### V0.4.2 — Product Hardening
- Browser E2E / Playwright（11 scenarios 全绿）
- Session List（/api/sessions + /api/session/switch）
- Terminal/Timeline output hardening（truncation 保护）
- Accessibility（icon-only 按钮 aria-labels）
- Layout responsive hardening（1280×720 / 1440×900 / 1920×1080）
- Directory Delete 完整 runAgent E2E
- CI/Release Gate 标准化（test:all 必须 100% PASS）
- 状态：已完成

### V0.9.4 — Runtime Scheduler & Recovery Foundation
- TaskScheduler: 调度器 (getReadyTasks/selectNextTask/pause/resume)
- ExecutionCoordinator: 协调 Scheduler→Gate→ToolExecution
- Runtime Recovery Manager: restore/validateConsistency/recoverPendingTasks/recoverPendingApprovals
- Approval Evidence Binding: 审批→证据链
- 27 new tests (575/575 PASS)
- 状态：已完成

### V0.9.3 — Runtime Approval & Execution Gate
- ApprovalRequest: 审批生命周期 (PENDING→APPROVED/REJECTED/EXPIRED)
- ExecutionGate: 审批门控机制 (request/approve/reject/canProceed)
- ApprovalPolicy: 审批策略 (destructive/production/high-risk 自动触发)
- 与 ToolExecution / Plan 集成
- 29 new tests (548/548 PASS)
- 状态：已完成

### V0.9.2 — Planner Interface & Execution Orchestration
- Planner Interface: Planner/MockPlanner/RuleBasedPlanner/createSimplePlanner
- PlanRuntimeService: Event Sourcing 风格 Plan 状态投影
- Plan Revision: revisePlan 版本控制
- 系统不变量测试: Plan/Snapshot/Dependency invariant
- 22 new tests (497/497 PASS)
- 状态：已完成

### V0.9.1 — Plan Runtime Foundation
- Plan Object: Plan 生命周期 (DRAFT→APPROVED→EXECUTING→VERIFYING→COMPLETED/FAILED/CANCELLED)
- Task Dependency: addTaskDependency/canTaskExecute/getExecutionOrder (拓扑排序)
- Runtime Snapshot v2: Plan+Task+ToolExecution+Evidence 全状态快照
- Runtime Contract: docs/runtime-contract.md (6 条 Contract Rules)
- 27 new tests (470/470 PASS)
- 状态：已完成

### V0.9.0.1 — Runtime Consistency Patch
- Task 生命周期约束: RUNNING 不能直接 COMPLETED，必须经过 VERIFYING（与 Skill 一致）
- PolicyContext 序列化: skillId 替代 skill object，避免序列化污染
- checkToolPermission: 支持 skillTools 参数传递
- RuntimeContext 职责收缩: 文档约束，业务逻辑未来下沉到 service
- 17 new tests (447/447 PASS)
- 状态：已完成

### V0.9.0 — Runtime Control Plane Foundation
- AgentRuntimeContext: 统一运行时容器（Skill/Policy/Task/Tool/Evidence/Event 子上下文）
- Task Runtime: Task 对象 + 生命周期（PENDING→RUNNING→VERIFYING→COMPLETED/FAILED/CANCELLED）
- ToolExecution Runtime: 工具执行一等公民（REQUESTED→POLICY_CHECKING→APPROVED/DENIED→EXECUTING→COMPLETED/FAILED）
- Policy Enforcement: checkToolPermission 集成（Skill ∩ Runtime Policy ∩ Environment）
- Evidence Binding: ToolExecution 自动创建 Evidence 引用
- Event System Extension: TASK_*/TOOL_* 新增事件类型
- 架构契约规则: ARCHITECTURE.md（6 条 Contract Rules）
- 30 new tests (430/430 PASS)
- 状态：已完成

### V0.8.3 — Pre-V0.9 Cleanup
- RuntimePolicyContext: Permission Context 抽象（environment/user/workspace/skill/restrictions）
- POLICY_PRESETS: development/production/readonly 预设
- Session/Runtime 状态统一: Single Source of Truth = RuntimeContext
- 架构文档: ARCHITECTURE.md（Permission/Memory/Plan/Tool/Session 边界确认）
- 23 new tests (423/423 PASS)
- 状态：已完成

### V0.8.2 — Runtime Cleanup & Architecture Debt
- Runtime 模块拆分: agent/skill/ (model/lifecycle/registry/verification) + agent/runtime/ (events/context/snapshot/persistence)
- Runtime Event Bus: RuntimeEventEmitter (pub/sub, decouples lifecycle from consumers)
- Snapshot Migration Strict Mode: SnapshotCompatibilityError, rejects unknown future versions
- Persistence Adapter Contract: exists() method added
- 21 new tests (400/400 PASS)
- 状态：已完成

### V0.8.1 — Runtime Hardening
- Event-State Auto Sync: safeTransitionSkillStatus 自动 emit 事件，状态变化 = 必然产生事件
- Snapshot Versioning: SNAPSHOT_VERSION + migrateSnapshot() 迁移支持
- Persistence Error Handling: RuntimePersistenceError 统一错误模型
- Recovery 边界明确化: Restore ≠ Resume，决策记录
- verifyEventStateConsistency(): 检测 orphan state
- 23 new tests (379/379 PASS)
- 状态：已完成

### V0.8.0 — Runtime Observability & Persistence
- RuntimeEventLog: record/getEvents/getSkillEvents/clearEvents/serialize/deserialize
- RuntimeSnapshot: createSnapshot/restoreSnapshot with full state capture
- RuntimePersistence: save/load/delete/list with pluggable MemoryPersistenceAdapter
- SkillRuntimeContext: eventLog integration + serialization
- Lifecycle Entry Unification: safeTransitionSkillStatus as public API
- 25 new tests (356/356 PASS)
- 状态：已完成

### V0.7.3 — Skill Verification & Evidence
- EvidenceRegistry: addEvidence/getEvidence/listSkillEvidence/clearSkillEvidence
- VerificationResult: createVerificationResult with success/evidenceRefs/checks/reason
- runSkillVerification(): RUNNING → VERIFYING → COMPLETED/FAILED (no direct COMPLETE)
- safeTransitionSkillStatus: strict lifecycle guard (no AVAILABLE → COMPLETED)
- canTransitionSkillStatus: check without modifying
- SkillRuntimeContext: verificationResults serialization/deserialization
- 26 new tests (331/331 PASS)
- 状态：已完成

### V0.7.2 — Skill Runtime Hardening
- Multi-Skill Permission Model: ANY active skill allows tool (not ALL)
- Skill Lifecycle Runtime Integration: activate/start/complete/fail/cancel helpers
- Instruction Provenance: source/priority tracked per instruction block
- SkillRuntimeContext: unified context (activeSkills, permissions, lifecycle, evidenceRefs)
- 23 new tests (305/305 PASS)
- 状态：已完成

### V0.7.1 — Skill Execution Integration
- Skill ↔ Agent Orchestrator Integration
- Skill instruction injection into system prompt (priority-ordered)
- Skill tool permission enforcement during execution
- Skill Registry initialized with agent tool set
- Skill lifecycle tracking alongside Run lifecycle
- Backward compatibility: plans without skills work normally
- 13 new tests (282/282 PASS)
- 状态：已完成

### V0.7.0 — Skill Model Foundation & Registry
- Skill Object: id/name/description/version/tools/capabilities/instructions/verification
- Skill Lifecycle: REGISTERED → AVAILABLE → RUNNING → VERIFYING → COMPLETED/FAILED
- SkillRegistry: register/get/list/load/validate/unregister
- Skill ↔ Plan Binding: bindSkillToPlan/bindSkillToStep
- Skill Instruction Layer: priority-ordered context injection
- Tool Permission: isToolAllowedForSkill/assertSkillToolAllowed
- 53 new tests (269/269 PASS)
- 状态：已完成

### V0.6.4 — Verification Hardening / Runtime Integrity
- P0: Evidence Versioning — evidenceVersion + STALE 状态
- P0: 新 mutation 自动使旧 verification 失效（read_file 不触发）
- P0: Verification Runner 接入 Runtime 安全执行层
- P0: command/file/git verification 路由到 runtime.execute()/resolvePath()
- Tests: 32 new tests（286/286 PASS）
- 状态：已完成

### V0.6.3 — Verification Runtime Closure & Safety
- P0: SKIPPED 不得导致 Verification PASSED — 聚合逻辑改为 strict
- P0: 去掉 expectedOutcome → CUSTOM check — 只保留 verification[]
- P0: 类型化 Verification Spec — validateCheck 拒绝非法 type/check/command
- P0: command step 真链路 — recordToolCallOnStep 不再因无 filePath 提前返回
- P0: execution evidence 分离 — 新增 successfulEffects 字段，完成只认成功执行
- P0: baseline 进入真实 Agent 调用链 — 从 ChangeTracker 构建
- P0: Verification Failed → step 可 reopen → repair → reverify
- P0: Agent done 不早于 Plan gate — 统一 Completion Outcome
- P0: 修 PLAN_STATUS.EXUTING typo
- Tests: 24 new tests（278/278 PASS）
- 状态：已完成

### V0.6.2 — Verification Closure & Safety
- P0: validatePlan 强制 verification — 缺 verification → invalid
- P0: File/Git schema mapping 修复 — check 字段正确映射
- P0: CUSTOM check → SKIPPED（不允许 PASSED）
- P0: Completion Gate — 只有 PASSED → COMPLETED，无后门
- P0: Step Completion Contract — 多文件 step 需全部文件完成
- P0: command step 能正确映射和完成
- P0: Verification 结果写入 messages — LLM 能看到
- P0: 去除 bindToolCall/recordToolCallOnStep 重复调用
- P0: RunStatus VERIFYING 转换表修正 + PLAN_STATUS.VERIFYING
- P0: createHash from node:crypto（不是 node:fs）
- Tests: 18 Verification Integration Tests（272/272 PASS）
- 状态：已完成

### V0.6.1 — Verification Integrity
- P0: buildPlanPrompt 加入 expectedOutcome + verification schema
- P0: Step completion 移到工具成功执行后（不在 bindToolCall 时提前标记）
- P0: Verification 改为 await（不再 fire-and-forget）
- P0: Completion Rules 真正等待验证结果（pending/running 不能 Completed）
- P0: Verification Runner 使用 workspace 参数（不使用 process.cwd()）
- P0: File 'modified' 验证改为 baseline hash 对比
- P0: Git 验证增加实际状态检查（porcelain output）
- P0: VERIFYING 接入 RunStatus 状态机
- P1: 前端 FAILED 不显示"计划完成"
- P1: Verification evidence 保留 description/expected/type 字段
- P1: 修复 setStepExpectedOutcome 死逻辑
- Tests: 254/254 PASS
- 状态：已完成

### V0.6.0 — Verification Foundation
- P0: Verification Object — verificationState + checks 数据模型
- P0: Plan Step Verification — expectedOutcome + verificationState per step
- P0: Verification Lifecycle — EXECUTING → VERIFYING → PASSED/FAILED → COMPLETED
- P0: Basic Verification Runner — command/file/git verification
- P1: Automatic Post Execution Verification — step 完成后自动触发
- P1: Verification Timeline Integration — verification_started/completed
- P1: Plan Completion Rules — verification failed → FAILED, not Completed
- P1: Verification UI — Plan Panel 显示验证结果
- Tests: 13 Verification Tests（254/254 PASS）
- 状态：已完成

### V0.5.2 — Plan Workspace UI
- P0: Plan Panel — goal/steps/risks/files/status 可视化
- P0: Plan Approval UI — approve/reject 按钮
- P0: Plan Timeline Integration — plan events 进入 timeline
- P0: Plan Step ↔ ToolCall Mapping — 点击步骤查看关联 tool calls
- P1: Plan Execution Progress — 实时步骤状态更新
- P1: Plan Drift Detection — 检测意外文件修改
- P1: Session Restore — plan state 恢复
- Tests: 10 Plan UI Integration Tests（241/241 PASS）
- 状态：已完成

### V0.5.1.1 — Plan Lifecycle Closure
- P0: 完整 Plan State Machine — DRAFT → AWAITING_APPROVAL → APPROVED → EXECUTING → COMPLETED/FAILED/CANCELLED
- P0: Plan ↔ Run Binding — plan.runId + toolCallBindings.runId
- P0: Plan Persistence Closure — 序列化/反序列化/switch/new session
- P1: Plan Mode Semantics — plan-only vs plan-execute
- P1: Plan Failure Policy — plan mode 不允许静默 fallback
- Tests: 18 Plan Regression Tests（229/229 PASS）
- 状态：已完成

### V0.5.1 — Plan Mode & Execution Integrity（已完成）
- Plan Object: session.planState（goal/steps/risks/files/status）
- Plan Mode: chat vs plan 模式切换，plan 模式下只分析不执行
- Plan Approval Gate: 生成计划 → 用户审批 → 才执行
- Plan ↔ Execution Binding: planId → runId → toolCalls 绑定
- 状态：开发中

### V0.5.0.3 — Context Projection Closure
- P0: 修 Context Projection 状态机 — 三种场景分开
  - below trigger → 全 raw history 保留
  - compaction success → summary + recent raw target
  - degraded/fallback → trim oldest if necessary
- P1: AGENTS.md content 保存到前端（context_loaded 携带 content）
- P1: Session switch 恢复 contextState（Server 返回 + Frontend 同步）
- P1: New Session reset Summary（Project Context 保留）
- Tests: 42 context tests（含 3 种场景 + Session isolation）
- 状态：已完成

### V0.5.0.2 — Context Runtime Closure
- P0: 修 turnMessages TDZ — 提前初始化，overflow 分支不再 ReferenceError
- P0: 修 Recent Tail / Overflow 语义 — historyTrimmed ≠ overflow，trim 后可继续
- P1: RECENT_CONTEXT_TARGET 真正参与预算选择（从后往前选，至少 MIN_RECENT_TURNS）
- P1: Context Panel 真闭环 — Server/Agent 携带 summary/content，Panel 显示结构化 Summary
- P1: context_compacted 携带 summary + status + lastCompactedAt
- P1: context_loaded 携带 Project Instructions content
- Tests: 真实 ProjectInstructions.load() contract + overflow 无 ReferenceError + fallback trim
- 状态：已完成

### V0.5.0.1 — Context Integrity Closure
- P0-1: 修 ProjectInstructions contract — 正确读取 readFile().content
- P0-2: 修 Turn grouping — Turn 内保持 canonical 原始消息顺序
- P0-3: 保留 Recent Raw Turns — 只 compact 最老 historical turns
- P0-4: Hard Budget Closure — 超限 emit context_overflow，不调用 LLM
- P1: Context Observability — indicator + panel + frontend event handlers
- P1: Project Instructions 只注入一次（buildSystemPrompt 内，builder 不重复）
- P1: SUMMARY_MAX_CHARS 真 enforce（超限 degraded）
- Context Unit Tests: 30 tests（estimator / compactor / turn grouping / builder / session）
- 状态：已完成

### V0.5.0 — Project Context & Session Compaction
- Canonical Transcript ≠ Model Context 分离（messages = truth，contextState = derived）
- 移除 destructive Session.prune（改为 no-op）
- Context Budget 估算（字符基础，非 message count）
- Context Builder 模块（context/builder.js）
- AGENTS.md Project Instructions 加载（context/project.js）
- Structured Summary Schema（goal/constraints/decisions/progress/files/verification/openItems）
- Incremental Compaction（只总结新增消息）
- Recent Turn 保留（Turn Boundary 保护）
- Compaction Failure Fallback（degraded 状态）
- Context SSE events（context_loaded / context_compacted / context_warning）
- Fake Provider Compaction 支持（chatSimple）
- Agent E2E H/I/J：Project Instructions / Long Session / Constraint Survives
- 状态：已完成

### V0.4.2.2 — Session Boundary Closure
- Running 时禁用 Session List 按钮（setRunningUi 统一 lifecycle）
- switchSession() 增加 state.running 保护，运行时禁止切换
- Session title 第一条 task 自动设置（/api/run 传 title，Server 兜底）
- Session List 按 workspace 过滤（/api/sessions?workspace=）
- Session.updatedAt 字段与 lastActivity 对齐
- Agent E2E G — Session Switch Race Prevention
- 状态：已完成

### V0.4.2.1 — Release & E2E Integrity Closure
- Run Identity 单一事实源：Server ActiveRun.runId 为唯一真值，Frontend 不再自行生成
- 所有实时 SSE Event 统一携带 runId（sendRunEvent 包装层）
- Frontend Run Event Filter：run_started 建立身份后，旧 Run late event 自动忽略
- Fake LLM Provider 真正注入 runAgent（E2E_FAKE_LLM=1），支持多轮 Tool Loop
- Agent Browser E2E 六项：Standard Edit / Safe Approval / Reject / Command→Terminal / Directory Delete / Stop & Late Event
- Browser UI Tests 与 Agent E2E 分层（Layer A: UI Interaction / Layer B: Real Agent）
- Session title 第一条 task 自动设置（POST /api/session 传 title + /api/run 兜底）
- Session switch 恢复 canonical transcript（user + assistant 消息）
- Session List 按 workspace 过滤
- Output hardening：Terminal stdout/stderr 各 4000 字符截断，Timeline args/result 各 500 字符截断
- Accessibility：全部 icon-only 按钮 aria-label
- Responsive：1280/1024/720/1440/1920 断点
- 残留 openDiffViewer dead code 删除
- CI：npm ci + playwright install --with-deps chromium + test:all 100% PASS
- package / package-lock / README / ROADMAP / Tag 版本一致
- 状态：已完成

## 长期方向

1. **更可靠的隔离** — OS-level sandbox / container，让 Shell 真正受 workspace 限制
2. **更智能的上下文管理** — 自动摘要、语义 prune、长对话压缩
3. **更丰富的工具生态** — 在不引入 MCP/Subagent 的前提下，扩展安全工具集
4. **更好的可观测性** — 结构化日志、 tracing、运行回放
5. **V1.0** — 稳定、可信、可交付的 Coding Agent Harness

## 不做的事

- 不引入 MCP / Subagent / Browser Agent / Skill System / Vector DB / Memory System
- 不做多模型编排
- 不做分布式部署
- 不追求功能数量，追求核心链路的稳定和可信