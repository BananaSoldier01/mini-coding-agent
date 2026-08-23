# Agent Core Architecture Review

> V0.8.3 (Pre-V0.9 Cleanup)
> 目的：确认 Permission / Memory / Plan / Tool / Runtime / Session 核心对象边界，为 V0.9 Control Plane 做架构冻结。

---

## 1. Permission 模型

### 当前状态

```
Skill → Allowed Tools
```

Permission 绑定在 Skill 上，缺少 Execution Context 层。

### V0.8.3 补充

新增 `RuntimePolicyContext` (`agent/runtime/policy.js`)：

```
Run
 ↓
RuntimePolicyContext
 ├── environment (development/staging/production)
 ├── user
 ├── workspace
 ├── skill (当前激活的 Skill)
 ├── allowedTools
 └── restrictions (环境/用户/工作区级限制)
 ↓
Skill → Tool Call → Environment
```

**优先级**（高 → 低）：
1. 显式 restrictions（始终 deny）
2. 环境 restrictions
3. Skill tool list
4. allowedTools 列表
5. availableTools

### V0.9 待办

- 完整 Policy Engine（基于 RuntimePolicyContext）
- 时间段限制（工作时间/非工作时间）
- 审批流集成（approval → auto-approve → deny）

---

## 2. Memory 分层

### 当前状态

Memory 系统混合了：
- 对话历史
- 任务上下文
- Runtime 状态
- 用户偏好

### 建议分层

```
Memory Layer
├── 1. Conversation Memory
│   对话历史（transcript）
│
├── 2. Working Memory
│   当前任务上下文（task, plan, active skills）
│
├── 3. Execution Memory
│   Runtime 状态（lifecycle, evidence, events）
│   → 对应 RuntimeSnapshot
│
└── 4. Long-term Memory
    用户/项目知识（Markdown + SQLite）
```

### V0.9 待办

- 明确各层读写权限
- Working Memory ↔ RuntimeContext 绑定
- Execution Memory 序列化策略

---

## 3. Plan 模型

### 当前状态

Plan 系统存在但偏弱：
- Plan Lifecycle: DRAFT → APPROVED → EXECUTING → VERIFYING → COMPLETED
- Skill ↔ Plan Binding 存在
- 但 Runtime 和 Plan 之间缺少编排层

### V0.9 目标

```
Goal
 ↓
Planner（V0.9 新增）
 ↓
Plan
 ├── Tasks
 │   ├── Skill A
 │   ├── Skill B
 │   └── ...
 ↓
Runtime
 ├── Skill Lifecycle
 ├── Tool Execution
 └── Verification
```

### V0.9 待办

- Planner：将 Goal 分解为 Plan
- Task Scheduler：管理 Task 执行顺序
- Dependency Resolution：Task 间依赖

---

## 4. Tool Execution Runtime

### 当前状态

Tool 执行缺少 Runtime 化：

```
当前: call tool() → return result
目标: TOOL_REQUESTED → APPROVAL_REQUIRED → APPROVED → EXECUTING → COMPLETED → EVIDENCE_CREATED
```

RuntimeEvent 已有 `TOOL_STARTED` / `TOOL_COMPLETED`，但缺少 Tool Execution 对象。

### V0.9 目标

```
ToolExecution
├── id
├── toolName
├── status (REQUESTED/APPROVED/EXECUTING/COMPLETED/FAILED)
├── params
├── result
├── evidenceRefs
├── startedAt
├── completedAt
└── error
```

### V0.9 待办

- ToolExecution 对象
- Tool Execution Lifecycle 状态机
- Tool → Evidence 直接通道
- Approval 集成

---

## 5. Runtime & Session 状态统一

### 当前状态

三套状态源：

```
Session State  → conversation history, permission mode
Runtime State  → SkillRuntimeContext (lifecycle, evidence, events)
Skill State    → Skill.status (REGISTERED → COMPLETED)
```

风险：状态可能不一致（如 Session 显示 completed 但 Runtime 显示 RUNNING）。

### V0.8.3 决策

**Single Source of Truth:**

```
RuntimeContext (唯一真相源)
 ├── SkillRuntimeContext
 ├── RuntimePolicyContext
 ├── EvidenceRegistry
 ├── RuntimeEventLog
 └── RuntimeSnapshot (持久化)
 ↓
Session (仅保存对话历史 + 用户交互)
```

Session 不再保存 Agent 状态。Agent 状态只从 RuntimeSnapshot 恢复。

---

## 6. 架构边界总结

```
┌─────────────────────────────────────────────────┐
│                  Session                         │
│  ┌──────────────────────────────────────────┐   │
│  │  Conversation History (transcript)        │   │
│  │  User Interaction                         │   │
│  └──────────────────────────────────────────┘   │
└──────────────────────┬──────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────┐
│               Runtime (V0.8 已冻结)               │
│  ┌──────────────┐  ┌──────────────┐             │
│  │ Skill Domain │  │ Runtime Domain│            │
│  │              │  │              │             │
│  │ model.js     │  │ events.js    │             │
│  │ lifecycle.js │  │ context.js   │             │
│  │ registry.js  │  │ snapshot.js  │             │
│  │ verification │  │ persistence  │             │
│  │              │  │ policy.js    │             │
│  └──────────────┘  └──────────────┘             │
└──────────────────────┬──────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────┐
│               V0.9 Control Plane                 │
│  ┌──────────────┐  ┌──────────────┐             │
│  │ Planner      │  │ Policy Engine│             │
│  │ Task Scheduler│  │ Approval Flow│             │
│  │ Dependency   │  │ Tool Runtime │             │
│  │ Resolution   │  │              │             │
│  └──────────────┘  └──────────────┘             │
└─────────────────────────────────────────────────┘
```

---

## 7. V0.9 启动检查清单

- [ ] Permission: RuntimePolicyContext 已就绪，可接 Policy Engine
- [ ] Memory: 分层定义已记录，V0.9 实现时按层接入
- [ ] Plan: Plan ↔ Runtime 编排层设计已明确
- [ ] Tool: ToolExecution 对象设计已明确
- [ ] Session: Session 不再保存 Agent 状态（已决策）
- [ ] Snapshot: 版本管理 + 严格迁移已就绪