# Runtime Contract

> V0.9.1 (Plan Runtime Foundation)
> 显式冻结 Runtime 边界，防止 Planner / Scheduler / Memory 污染 Runtime。

---

## Runtime 可以拥有

### ✅ Lifecycle State

- Skill: REGISTERED → AVAILABLE → RUNNING → VERIFYING → COMPLETED/FAILED/CANCELLED
- Task: PENDING → RUNNING → VERIFYING → COMPLETED/FAILED/CANCELLED
- ToolExecution: REQUESTED → POLICY_CHECKING → APPROVED/DENIED → EXECUTING → COMPLETED/FAILED
- Plan: DRAFT → APPROVED → EXECUTING → VERIFYING → COMPLETED/FAILED/CANCELLED

### ✅ Execution References

- Skill ↔ Task binding
- Task ↔ ToolExecution binding
- ToolExecution ↔ Evidence binding
- Plan ↔ Task containment

### ✅ Events

所有状态转换必须产生 Runtime Event。

### ✅ Snapshots

RuntimeContext 全状态可序列化/反序列化。

---

## Runtime 不应该拥有

### ❌ Planning Logic

- 不做 LLM planning
- 不做 automatic task decomposition
- 不做 goal → plan 的自动翻译

Planning 是 V0.9.2+ 的独立层。

### ❌ Reasoning Logic

- 不做 LLM 推理
- 不做决策逻辑

Reasoning 属于 Agent Core（独立于 Runtime）。

### ❌ Tool Implementation

- 不实现具体工具（run_shell, read_file 等）
- 工具实现由 Tool Runtime 管理

Runtime 只管理 ToolExecution 生命周期。

### ❌ UI State

- 不做 Dashboard
- 不做 Timeline 页面
- 不做 Web UI

UI 层独立于 Runtime。

---

## Runtime 职责边界

```
┌─────────────────────────────────────────────┐
│                 Agent Core                   │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  │
│  │ Reasoning│  │Planning  │  │ Memory   │  │
│  └──────────┘  └──────────┘  └──────────┘  │
└──────────────────────┬──────────────────────┘
                       │
┌──────────────────────▼──────────────────────┐
│              Runtime (V0.9.1)                │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  │
│  │  Plan    │  │  Task    │  │  Tool    │  │
│  │ Lifecycle│  │ Lifecycle│  │Execution │  │
│  └──────────┘  └──────────┘  └──────────┘  │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  │
│  │  Skill   │  │ Policy   │  │Evidence  │  │
│  │ Lifecycle│  │Enforcement│  │ Registry │  │
│  └──────────┘  └──────────┘  └──────────┘  │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  │
│  │  Event   │  │Snapshot  │  │Persist   │  │
│  │  System  │  │          │  │          │  │
│  └──────────┘  └──────────┘  └──────────┘  │
└──────────────────────┬──────────────────────┘
                       │
┌──────────────────────▼──────────────────────┐
│               Tool Runtime                   │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  │
│  │run_shell │  │read_file │  │ write_.. │  │
│  └──────────┘  └──────────┘  └──────────┘  │
└─────────────────────────────────────────────┘
```

---

## Contract Rules

### Rule 1 — Single Source of Truth

RuntimeContext 是执行真相源。

Session / Skill / Plan / Task 都不能独立持有执行状态。

### Rule 2 — State → Event

所有状态转换必须产生 Runtime Event。

没有例外。

### Rule 3 — Capability ≠ Permission

Skill 声明能力。

Policy 决定是否允许执行。

最终权限 = Capability ∩ Runtime Policy ∩ Environment Constraint

### Rule 4 — Evidence from Execution

Evidence 来自 Runtime 执行事件。

Skill 自报不算 Evidence。

### Rule 5 — Runtime 不依赖 Planner

Runtime 不感知 Planner 的存在。

Planner 通过 Plan Object 与 Runtime 交互。

### Rule 6 — Snapshot is the recovery unit

Runtime 状态只通过 Snapshot 恢复。

不支持增量恢复。

---

## V0.9.1 Scope

### Must Implement

- [x] Plan Object (lifecycle, status, tasks)
- [x] Plan Lifecycle (DRAFT → APPROVED → EXECUTING → VERIFYING → COMPLETED)
- [x] Task Dependency (resolve, check)
- [x] Runtime Snapshot v2 (Plan + Task + ToolExecution + Evidence)

### Must NOT Implement

- [ ] LLM Planner
- [ ] Automatic task decomposition
- [ ] Multi-agent
- [ ] Memory restructure
- [ ] UI changes