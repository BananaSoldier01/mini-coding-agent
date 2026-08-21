# ROADMAP — Mini Coding Agent

## 当前阶段
**V0.4.0 — Control & Visibility**（进行中）

核心目标：Git 仓库、测试结果、文档和 Builder 报告四者描述的是同一个现实。

## 版本路线

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

#### V0.4.0 — Control & Visibility（当前）
- Permission Mode: Safe/Standard/Full Access, Session-scoped
- Agent Run Status: Thinking→Reading→Searching→Editing→Running→Waiting→Verifying→Completed
- Agent Activity Timeline: 人类可读的工具调用展示
- Approval UX: 人类可读的审批说明
- Changes Panel: Net Diff 一级展示
- Completion Summary: 结构化总结
- Directory delete: real before content snapshot
- 状态：进行中

### V0.2 — Core Overhaul
- Session 接入 Agent（真实多轮上下文）
- 统一 Tool Execution Policy
- Approval 机制
- ActiveRun / Cancel 生命周期
- Shell secret scrubming
- symlink escape 防护
- ranged read
- LCS-based diff
- 自动测试（58 tests）
- 状态：已完成

### V0.3 — Harness Reliability
- buildFileTree 回归修复
- WorkspaceFileService 统一文件访问
- Shell Policy 改为 capability-based（SAFE/APPROVAL/DENY）
- Sensitive file policy 精确匹配
- Session Transcript 重构（canonical messages）
- Run Net Diff（baseline → current）
- Run-scoped Approval 隔离
- 跨平台 process tree kill + terminationReason
- 大文件流式 range read
- TrustedWorkspaceRegistry
- 同源 CORS 收紧
- 106 tests（59 unit + 47 integration）
- 状态：已完成

### V0.4 — 下一步方向（待 Reviewer 确认）
_待定，根据下一轮 Review 结果确定。_

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