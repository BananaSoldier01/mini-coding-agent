# DECISIONS — Mini Coding Agent

长期架构与产品决策记录。Append-only 记录。

---

## V1.2.3 — Runtime Lifecycle & Recovery Correctness

### D15: Run Created and Run Started Are Distinct Events

**Decision**: `run_created` is emitted by `createRun()`, `run_started` is emitted by `startRun()`. They are separate lifecycle events.

**Trade-off**: One more event type to maintain.

**Rationale**: Conflating creation with start corrupts audit trails, consistency checks, and crash recovery. The Event Store must faithfully record each lifecycle step.

### D16: Event Type Derived from fromStatus + toStatus Pair

**Decision**: `getEventType(entityType, fromStatus, toStatus)` uses the transition pair, not just the target status.

- `CREATED → STARTED` = `run_started`
- `PAUSED → STARTED` = `run_resumed`

**Trade-off**: More complex event type mapping.

**Rationale**: Target-status-only mapping cannot distinguish initial start from resume. Both produce `STARTED` but are semantically different.

### D17: TransitionManager Is the Sole Lifecycle Mutation Entry Point

**Decision**: All lifecycle state changes flow through `TransitionManager.transition()`: Validate → Apply (Store) → Emit Event. Managers no longer directly mutate `entity.status`.

**Trade-off**: Managers must issue transition requests instead of direct mutations.

**Rationale**: Scattered `entity.status = xxx` bypasses validation, event emission, and Store persistence. Centralizing ensures consistency across all three.

### D18: Store Read API Returns Clones

**Decision**: `store.get()` and `store.list()` return shallow clones, not live references. External code cannot mutate internal Store state directly.

**Trade-off**: Slight memory overhead for clones.

**Rationale**: Live references enable accidental Store corruption. Clones enforce the update API as the only mutation path.

### D19: Crash Recovery Mutates Store Before Resuming Execution

**Decision**: `resumeAfterCrash()` first resets task states in TaskStore (RUNNING→PENDING, FAILED→PENDING), then drives `TaskExecutor.execute()`.

**Trade-off**: RecoveryManager now depends on TaskExecutor.

**Rationale**: State-only recovery leaves tasks in an unexecutable state. Store mutation is required before execution can resume.

## V1.2.2 — Runtime State Ownership & Persistence Layer

### D12: Store Layer as Single Source of Truth

**Decision**: Create RunStore, PlanStore, TaskStore as the authoritative state owners.

- `RunStore`: Run state (create/get/update/delete/serialize/restore)
- `PlanStore`: Plan state (create/get/update/delete/serialize/restore)
- `TaskStore`: Task state (create/get/update/delete/serialize/restore)
- ExecutionEngine holds references to Stores, NOT duplicate Maps

**Trade-off**: Three new objects. Engine becomes thinner.

**Rationale**: V1.1.1 established Store = Source of Truth for Workspace. V1.2.2 extends this to Run/Plan/Task. Eliminates dual-state inconsistency risk.

### D13: Manager Dependency Decoupling

**Decision**: Managers receive explicit Store dependencies, NOT `engine: this`.

- `RunManager({ runStore, workspaceStore, contextMgr, ... })`
- `TaskExecutor({ taskStore, skillRuntime, artifactStore, ... })`
- `RecoveryManager({ runStore, taskStore, workspaceStore, ... })`

**Trade-off**: More constructor parameters. Managers are less convenient to use.

**Rationale**: `engine: this` creates hidden circular dependencies. Explicit dependencies make the graph visible and testable.

### D14: Recovery as Execution Resumption

**Decision**: RecoveryManager.resumeAfterCrash() drives actual execution, not just state restoration.

- Restore Run → Load Workspace → Restore Context
- Categorize tasks: completed (skip) / failed (retry) / running (resume) / pending (execute)
- Drive TaskExecutor for each category

**Trade-off**: RecoveryManager now depends on TaskExecutor.

**Rationale**: State-only recovery leaves the Agent in an unknown execution context. Execution resumption ensures continuity.

## V1.2.1 — Execution Engine Stabilization & Runtime Consistency

### D9: Execution Engine Split

**Decision**: Split ExecutionEngine into four focused sub-managers.

- `RunManager`: Run lifecycle (create/start/pause/resume/complete/fail/cancel)
- `TaskExecutor`: Individual task execution through Skill Runtime
- `RecoveryManager`: Crash recovery and task state validation
- `TransitionManager`: Unified state transition validation and event emission

**Trade-off**: Four objects instead of one. Each has a single responsibility.

**Rationale**: V1.2.0 ExecutionEngine was becoming a God Object. Splitting improves testability and maintainability.

### D10: TransitionManager as Single Entry Point

**Decision**: All entity state transitions go through TransitionManager.

- Pattern: Transition Request → Validate → Apply → Emit Event
- Covers: Run, Task, Plan, Workspace
- Prevents: `entity.status = xxx` direct modification

**Trade-off**: Adds one indirection layer for every state change.

**Rationale**: Ensures events are always emitted for state changes, maintaining audit trail consistency.

### D11: Recovery as Execution Flow, Not Just State

**Decision**: Recovery restores not just objects but the execution flow.

- Restore Run → Load Workspace → Restore Context
- Find unfinished Tasks → Validate State → Continue Execution
- Categorize: completed (skip), failed (retry), running (resume), pending (execute)

**Trade-off**: More complex recovery logic.

**Rationale**: State-only recovery leaves the Agent in an unknown execution context. Flow recovery ensures continuity.

## V1.2.0 — Runtime Execution Engine & Orchestration

### D6: Execution Engine as Unified Entry Point

**Decision**: Create ExecutionEngine as the single entry point for Agent execution.

- ExecutionEngine owns: Run lifecycle, Task execution loop, Scheduler integration
- It delegates to existing components: WorkspaceStore, ContextMgr, ArtifactStore, SkillRuntime, ToolRegistry
- No new Runtime concepts introduced

**Trade-off**: Engine is a orchestrator, not a replacement for existing modules.

**Rationale**: Existing modules are independent capabilities. Engine ties them into a complete execution loop.

### D7: Scheduler → Engine → SkillRuntime Chain

**Decision**: Clarify the relationship between Scheduler, Execution Engine, and Skill Runtime.

- Scheduler: determines which tasks are ready (dependency check)
- Execution Engine: executes ready tasks through Skill Runtime
- Skill Runtime: executes skills through Tool Registry → Capability Check → Governance

**Trade-off**: Scheduler is query-only, Engine is execution-only.

**Rationale**: Previous architecture had unclear boundaries between scheduler and executor.

### D8: Task Execution Through VERIFYING

**Decision**: Task execution must go through VERIFYING state before COMPLETED.

- RUNNING → VERIFYING → COMPLETED
- This is enforced by TASK_TRANSITIONS, not bypassed

**Trade-off**: Adds one extra step to task completion.

**Rationale**: Existing task model requires verification before completion. Engine respects this.

## V1.1.1 — Runtime Hardening & Architecture Stabilization

### D1: Unified Runtime State Model

**Decision**: Clarify Source of Truth for all core Runtime objects.

| Object | Source of Truth | Derived State | Event Log |
|--------|----------------|---------------|-----------|
| Workspace | WorkspaceStore (Map) | status, runIds | workspace_created/activated/archived |
| Run | ExecutionCoordinator | tasks, planId | run_started/completed/failed |
| Task | TaskRuntime (in-memory) | status, revisionId | task_created/started/completed/failed |
| Plan | PlanRuntime (in-memory) | tasks, revisions | plan_created/approved/started |
| Skill | SkillRegistry (Map) | enabled flag | skill_registered/enabled/disabled |
| Capability | CapabilityRegistry (Map) | enabled flag | capability_registered/enabled/disabled |

**Trade-off**: Event Store is audit trail, not state source. Replay reconstructs state from events but does not replace live state.

**Rationale**: Avoids dual-write inconsistency. Each object has one owner.

### D2: WorkspaceStore vs WorkspaceRegistry

**Decision**: Split Workspace persistence from query.

- `WorkspaceStore`: Source of Truth (create/get/update/delete/serialize/restore)
- `WorkspaceRegistry`: Query layer (list/listByStatus/listByRun/getWorkspaceForRun)

**Trade-off**: Two objects instead of one. Registry delegates to Store for state.

**Rationale**: Registry was doing both persistence and query. Splitting allows independent scaling and testing.

### D3: Event Type Deduplication

**Decision**: Remove duplicate event type definitions, fix typos.

- Removed: duplicate TOOL_REQUESTED, TOOL_POLICY_CHECKED, TOOL_EXECUTING, TOOL_COMPLETED, TOOL_FAILED, RUN_STARTED, RUN_COMPLETED, RUN_FAILED
- Fixed: `task_resumend` → `task_resumed`, `run_resumend` → `run_resumed`
- Added: EVENT_SCHEMA for validation

**Trade-off**: Breaking change for any code using old event type strings. All internal references updated.

**Rationale**: Duplicates caused confusion about which definition was authoritative. Typos caused event matching failures.

### D4: Event Schema Validation

**Decision**: Add `validateEvent()` with strict mode for development.

**Trade-off**: Runtime overhead in strict mode (not for production).

**Rationale**: Catches invalid events at emit time instead of during replay.

### D5: No New Runtime Concepts

**Decision**: V1.1.1 introduces no new Agent capabilities.

**Rationale**: Stabilization phase. Existing abstractions are sufficient. Adding more layers increases maintenance burden.

## Decision 1 — ESM Module System

**状态**: 已采纳（V0.1）

**决策**: 所有核心模块使用 ES Modules（`.js` + `"type": "module"`）。

**理由**:
- Node.js 原生支持，无需 build step
- 与 Node 20 LTS 兼容
- 顶层 await 可用
- import/export 语法清晰

---

## Decision 2 — Session Transcript 是唯一真相源

**状态**: 已采纳（V0.3.0）

**决策**: Agent Loop 中的 `messages` 数组是 canonical transcript。前端 Timeline 是派生视图，不反向写入 transcript。

**理由**:
- 防止前端状态污染 Agent 上下文
- 重放/调试时有唯一数据源
- Session 恢复时行为可预测

---

## Decision 3 — Run-scoped Approval

**状态**: 已采纳（V0.3.0）

**决策**: Approval 注册表以 runId 为 key，不同 Run 的 Approval 互不干扰。Approval 超时后自动清理 pending entry。

**理由**:
- 防止跨 Run Approval 泄漏
- 超时后不会残留僵尸 approval 阻塞后续 Run

---

## Decision 4 — NON_EXISTENT Sentinel

**状态**: 已采纳（V0.3.2）

**决策**: ChangeTracker 使用 `Symbol('NON_EXISTENT')` 区分"文件不存在"与"空文件"。空文件是合法状态，不能与不存在混淆。

**理由**:
- 空文件 baseline = ''（存在但无内容）
- 不存在 baseline = NON_EXISTENT
- 否则删除空文件会错误显示为"无变更"

---

## Decision 5 — Shell Operation Allowlist

**状态**: 已采纳（V0.3.1）

**决策**: Shell Policy 使用 operation allowlist（SAFE / APPROVAL / DENY），compound command 检测，git mutation 预检。

**理由**:
- 基于操作类型而非命令字符串匹配
- 防止 `rm -rf /` 等破坏性命令
- compound command（`curl x | sh`）检测

---

## Decision 6 — HTTP Trust Boundary

**状态**: 已采纳（V0.3.2）

**决策**: Server 校验 Host / Origin / CSRF token。CSRF token 从 `/api/config` 下发，mutation 请求必须携带。

**理由**:
- 防止跨站请求伪造
- 仅允许同源请求
- mutation 端点全部调用 validateMutation()

---

## Decision 7 — Project Script Approval

**状态**: 已采纳（V0.3.3）

**决策**: `npm test` / `npm run build` / `python -c` 等 project script 升级为 `requireApproval`。

**理由**:
- project script 可能产生副作用
- 与普通只读命令区分
- 用户应知晓正在执行项目脚本

---

## Decision 8 — Inspector 是文件与 Diff 的统一审查入口

**状态**: 已采纳（V0.4.1）

**决策**: 右侧 Inspector 面板统一承载 File Current / File Diff / Changes 三个视图。不再维护独立的 File Viewer Modal 和 Diff Viewer Modal。

**理由**:
- 用户在 Coding Task 中需要连续导航：Files → Inspector → Changes → Diff
- 多套并行 Viewer 造成状态割裂
- Inspector 的 Changes Tab 保持 Current Run Net Diff 语义

**影响**:
- `public/index.html`: 移除 file-viewer-modal 和 diff-viewer-modal
- `public/app.js`: openFileCurrent / openFileDiff 统一走 Inspector

---

## Decision 9 — WorkspaceFileService 是 Binary Detection 唯一事实源

**状态**: 已采纳（V0.4.1）

**决策**: 所有 Binary Detection 必须通过 `WorkspaceFileService.isBinary()`，不得在 FileTools 或其他模块维护独立的 Binary extension list。

**理由**:
- V0.4.0.3 中 FileTools._collectFiles() 复制了 BINARY_EXTS，导致两套 binary policy
- 长期一定会漂移
- 统一事实源后，File Viewer / search_files / directory delete / Explorer 共用同一规则

**影响**:
- `tools/file.js`: _collectFiles 使用 this.service.isBinary(rel)
- `tools/file.js`: search_files 使用 this.service.isBinary(relPath)
- `fileservice.js`: readFile() 使用 this.isBinary(relPath)

---

## Decision 10 — Explorer 使用 workspace-relative path contract

**状态**: 已采纳（V0.4.1）

**决策**: Explorer / File Tree / API 均使用 workspace-relative path（如 `src/agent/index.js`），不向前端暴露 absolute path。

**理由**:
- workspace boundary 是安全基础
- absolute path 泄露系统信息
- 前端导航 contract 需要稳定、可预测的 path 格式

**影响**:
- `server.js`: /api/files/list 返回 entries[].path 为 workspace-relative
- `fileservice.js`: listDirectory 返回的 path 字段为 workspace-relative

---

## Decision 11 — Changes 表示 Current Run Net Diff

**状态**: 已采纳（V0.4.0）

**决策**: Inspector Changes Tab 显示的是当前 Run 的 Net Diff（baseline → current），不是 Git Working Tree Diff，也不是历史 Session 修改。

**理由**:
- 用户需要审查的是"这次 Agent 做了什么"
- Git Working Tree Diff 混入了用户手动修改
- 历史 Session 修改属于不同 Run 的证据

**影响**:
- Changes 数据来源：ChangeTracker.getNetDiff()
- Completion Summary 变更数字与 Changes Panel 一致

---

## Decision 12 — Terminal navigation 使用 Tool Call identity

**状态**: 已采纳（V0.4.1）

**决策**: Timeline → Terminal 导航使用 toolCallId 定位 Command Card，不使用 command string 匹配。

**理由**:
- 同一次 Run 可能执行两次相同 command（如 `npm test`）
- command string 匹配会定位到错误的 card
- toolCallId 是唯一稳定标识

**影响**:
- `terminalWrite()` 接收 toolCallId 参数并设置到 card 的 data-tool-call-id
- `navigateToTerminal()` 使用 CSS.escape(toolCallId) 精确查找

---

## Decision 13 — Mini Coding Agent 定位为 Coding Agent Workspace

**状态**: 已采纳（V0.4.1）

**决策**: 产品定位是 Coding Agent Workspace Viewer，不是完整 IDE。不开发 Monaco / LSP / autocomplete / debugger / Git Panel。

**理由**:
- 核心价值是 Agent 可见性、权限控制、修改审查
- IDE 能力超出当前范围
- 避免功能蔓延

**Deferred**:
- Monaco / Manual Editor
- LSP / Autocomplete
- Debugger
- Git Source Control Panel

---

## Decision 14 — Lazy Directory Loading

**状态**: 已采纳（V0.4.1.1）

**决策**: Explorer 使用 lazy directory loading，首次只加载 root，展开时通过 `/api/files/list` 加载子目录。不使用 `buildTree()` 整树加载。

**理由**:
- 旧 buildTree() 有 maxDepth 限制，深层目录无法访问
- 大型 Repository 整树加载性能差
- 用户按需展开，按需加载

**影响**:
- `server.js`: 新增 `/api/files/list` 端点
- `app.js`: loadDirEntries() + mergeEntries() + findNode()

---

## Decision 15 — Server ActiveRun.runId 是唯一 Run Identity

**状态**: 已采纳（V0.4.2.1）

**决策**: Run ID 只由 Server `ActiveRun.runId` 生成，Frontend 不再自行创建随机 runId。Server 通过 `run_started` SSE event 将 runId 传给 Frontend，Frontend 将其设为 `state.activeRunId`。

**理由**:
- V0.4.2 之前 Frontend 自行生成 `run-<timestamp>-<random>`，与 Server 的 `run_<timestamp><random>` 不一致
- 前端的 runId filter 会错误过滤掉真实的 `approval_needed` event，导致 Agent 卡死
- Server 是唯一能生成正确 runId 的位置

**影响**:
- `server.js`: `sendRunEvent` 包装层统一给所有 SSE event 携带 `runId: activeRun.runId`
- `server.js`: 第一个 event 是 `run_started`，携带 `activeRun.runId`
- `public/app.js`: `handleEvent` 中 `run_started` case 设置 `state.activeRunId = event.runId`
- `public/app.js`: `sendMessage()` 不再自行生成 runId

---

## Decision 16 — Browser Test 分层

**状态**: 已采纳（V0.4.2.1）

**决策**: Browser E2E 分为两层：Layer A（UI Interaction Tests，可用 `window.__dshTest` 注入状态）和 Layer B（Real Agent Browser E2E，必须经过 Browser → HTTP → Server → Session → RunManager → Fake LLM → runAgent → Policy → Tool → ChangeTracker → SSE → UI 完整链路）。

**理由**:
- Layer A 测试 UI 渲染、导航、交互，不需要真实 Agent
- Layer B 测试真实 Agent 行为（Approval、Tool 执行、Change Tracking、Stop 等）
- 混在一起会导致测试语义不清，无法区分"UI 对了"和"Agent 对了"

**影响**:
- `test/e2e/websocket-flow.test.js`: Layer A（11 tests）
- `test/e2e/agent-e2e.test.js`: Layer B（6 tests）

---

## Decision 17 — Session State 分离

**状态**: 已采纳（V0.4.2.1）

**决策**: `Session.messages` 是 canonical conversation truth；Timeline / Changes / Terminal 是 current Run observation state。切 Session 时恢复 transcript（title + messages），清空 Run observation。

**理由**:
- Transcript 是持久化的真实对话记录
- Run observation 是临时的，随 Run 结束而消失
- 混在一起会导致切 Session 后历史和当前状态互相污染

**影响**:
- `server.js`: `/api/session/switch` 返回 `messages: session.messages`
- `public/app.js`: `switchSession()` 渲染 user + assistant 消息，清空 timeline/changes/terminal

---

## Decision 19 — Canonical Transcript ≠ Model Context

**状态**: 已采纳（V0.5.0）

**决策**: `Session.messages` 永远是 canonical conversation truth，不被 destructive 修改。Compaction 只改变 Model Context Projection（`contextState.summary` + `compactedThrough`）。

**理由**:
- 旧 `Session.prune()` 直接删除 `session.messages`，导致历史不可恢复
- Compaction 是 AI 衍生的摘要，不能替代原始 Transcript
- UI 切 Session 后仍可查看完整原始历史

**影响**:
- `session.js`: `prune()` 改为 no-op
- `session.js`: 新增 `contextState` 字段
- `context/builder.js`: `buildAgentContext()` 只构建 model messages，不修改 session

---

## Decision 20 — Workspace vs Session Context

**状态**: 已采纳（V0.5.0）

**决策**: AGENTS.md 是 Workspace-scoped Project Context；Compacted Summary 是 Session-scoped Context。New Session 后 Project Context 仍然存在，Session Summary 清零。

**理由**:
- 项目规则属于 workspace，不随 session 变化
- 每个 session 有自己的对话历史和摘要

**影响**:
- `context/project.js`: 每次 Run 从 workspace 读取 AGENTS.md
- `session.js`: `contextState` 是 session 级别

---

## Decision 21 — Project Instructions do not change Permission

**状态**: 已采纳（V0.5.0）

**决策**: AGENTS.md 只影响 Agent intent（System Prompt），不影响 Execution Authorization（Policy / Permission Mode / Hard Deny）。

**理由**:
- AGENTS.md 写 "可以读取 .env" 仍然 DENY
- 安全边界必须由 Harness 代码强制执行，不能由项目配置文件覆盖

**影响**:
- `agent/index.js`: `buildSystemPrompt()` 只追加 Project Instructions 到 prompt
- `policy.js` / `shellpolicy.js` / `permission.js` 不受 Project Context 影响

---

## Decision 22 — Compaction is Incremental and Derived

**状态**: 已采纳（V0.5.0）

**决策**: Summary 是 derived context，可重新生成，不能替代原始 Transcript。Compaction 使用增量模型（Existing Summary + New Messages → New Summary），不重新发送全部历史。

**理由**:
- 成本稳定，Context 不会越来越大
- Summary 可以长期滚动
- 失败时可以回退

**影响**:
- `context/compactor.js`: `buildCompactionPrompt()` 接受 existingSummary
- `context/builder.js`: `tryCompact()` 只传新增消息

---

## Decision 23 — Running 时禁止 Session Switch

**状态**: 已采纳（V0.4.2.2）

**决策**: Run 运行期间（`state.running === true`），Session List 按钮禁用，`switchSession()` 直接拒绝。Run 结束后恢复。

**理由**:
- Session A 运行中切到 B，A 的 SSE event 可能写入 B 的 UI（Timeline/Changes/Terminal/Completion）
- Stop 时 `state.sessionId` 已变为 B，但 `abortController` 仍是 A，导致 Stop 错误目标
- 与 New Session race 本质相同

**影响**:
- `public/app.js`: `setRunningUi()` 禁用 `#sessionListBtn`
- `public/app.js`: `switchSession()` 开头 `if (state.running) return;`

---

## Decision 20 — Release Gate 必须 100% Green

**状态**: 已采纳（V0.4.2.1）

**决策**: `npm run test:all`（unit + integration + browser E2E）必须在 Release Commit 上 100% PASS，才能打 Tag。CI 必须安装 Playwright Chromium binary。

**理由**:
- 测试是 Release 的唯一客观证据
- 没有 100% green 的测试，Tag 就没有可信度
- Playwright binary 不是 npm install 的一部分，CI 必须显式安装

**影响**:
- `.github/workflows/ci.yml`: `npm ci` + `npx playwright install --with-deps chromium` + 三步测试 + `test:all`
- `package.json`: `test:all` = `test:unit && test:integration && test:e2e`