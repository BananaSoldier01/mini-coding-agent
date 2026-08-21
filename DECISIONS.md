# DECISIONS — Mini Coding Agent

长期架构与产品决策记录。

---

## Decision 1 — Inspector 是文件与 Diff 的统一审查入口

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

## Decision 2 — WorkspaceFileService 是 Workspace 文件读取及 Binary Detection 的唯一事实源

**状态**: 已采纳（V0.4.1）

**决策**: 所有 Binary Detection 必须通过 `WorkspaceFileService.isBinary()`，不得在 FileTools 或其他模块维护独立的 Binary extension list。

**理由**:
- V0.4.0.3 中 FileTools._collectFiles() 复制了 BINARY_EXTS，导致两套 binary policy
- 长期一定会漂移
- 统一事实源后，File Viewer / search_files / directory delete / Explorer 共用同一规则

**影响**:
- `tools/file.js`: _collectFiles 使用 this.service.isBinary(rel)
- `tools/file.js`: search_files 使用 this.service.isBinary(relPath)

---

## Decision 3 — Explorer 使用 workspace-relative path contract

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

## Decision 4 — Changes 表示 Current Run Net Diff

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

## Decision 5 — Terminal navigation 使用 Tool Call identity

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

## Decision 6 — Mini Coding Agent 定位为 Coding Agent Workspace

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