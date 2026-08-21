# DECISIONS — Mini Coding Agent

长期架构与产品决策记录。Append-only 记录。

---

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