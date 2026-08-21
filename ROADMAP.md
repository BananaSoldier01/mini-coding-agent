# ROADMAP — Mini Coding Agent

## 当前阶段
**V0.4.2 — Product Hardening**（已完成）

**Next: V0.5 — TBD after milestone review**

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
- Browser E2E / Playwright（10 scenarios 全绿）
- Session List（/api/sessions + /api/session/switch）
- Terminal/Timeline output hardening（truncation 保护）
- Accessibility（icon-only 按钮 aria-labels）
- Layout responsive hardening（1280×720 / 1440×900 / 1920×1080）
- Directory Delete 完整 runAgent E2E
- CI/Release Gate 标准化（test:all 必须 100% PASS）
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