# DECISIONS — 架构决策记录

记录重要的架构决策、技术选型和已接受的 Trade-off。

---

## D-001: 为什么使用 Node.js 原生 HTTP 而非 Express？

**日期**: V0.1  
**状态**: 已确定

Express 在 V0.3 中已从 dependencies 移除。项目使用 Node.js 原生 `http` 模块。

**理由**:
- 项目只需要静态文件服务 + REST API + SSE，Express 提供的额外功能（中间件、路由等）用不上
- 原生 HTTP 更轻量，减少依赖面和攻击面
- 减少 `node_modules` 体积和安装时间

**Trade-off**: 代码量略多于 Express，但核心逻辑更可控。

---

## D-002: 为什么使用 ESM（`"type": "module"`）？

**日期**: V0.1  
**状态**: 已确定

**理由**:
- 现代 Node.js 支持 ESM，与浏览器端模块系统对齐
- 项目是前端 + 后端一体化的 Web App，ESM 提供一致的模块体验
- `import` 语法比 `require` 更适合大型项目

**Trade-off**: 一些旧版 Node 模块可能不兼容；`require('child_process')` 在 ESM 中需要改为顶层 `import`。

---

## D-003: 为什么 Agent Loop 使用 streaming LLM？

**日期**: V0.1  
**状态**: 已确定

**理由**:
- 流式输出提供更好的用户体验（token 级实时展示）
- 可以在 LLM 生成 tool_calls 时尽早开始处理，减少等待时间
- 支持 Stop/Cancel（AbortController 可以在流中途终止）

**Trade-off**: 流式解析比非流式复杂，需要处理 SSE 分片和 buffer。

---

## D-004: 为什么 Shell 安全模型不使用 OS-level sandbox？

**日期**: V0.2  
**状态**: 已确定，未来可演进

**理由**:
- V0.2/V0.3 阶段诚实承认：Shell 命令在 OS 层面不受 workspace 限制
- 当前安全模型依赖：secret scrubbing + capability classification + approval + 用户监督
- 完整的 OS isolation 需要 container / gVisor / seccomp 等，复杂度较高

**Trade-off**: 当前模型不是完美的 filesystem sandbox，但足以覆盖 Coding Agent 的常见场景。

**未来方向**: V0.4+ 可以考虑 Safe Mode / Standard Mode / Full Access 三级模式，或引入轻量级 container。

---

## D-005: 为什么使用 LCS-based diff 而非 Myers diff？

**日期**: V0.2  
**状态**: 已确定，V0.3 保持

**理由**:
- V0.2 自己实现了 LCS-based `unifiedDiff()`
- LCS DP 的时间/空间复杂度为 O(m×n)，对大文件 diff 性能不佳
- V0.3 保持了 LCS 实现，但 ChangeTracker 升级为 Run Net Diff（baseline → current），减少了需要 diff 的次数

**Trade-off**: 大文件 diff 仍然较慢。如果未来需要高频 diff 大文件，应迁移到成熟的 Myers 实现或可靠依赖。

---

## D-006: 为什么 Session Transcript 由 Agent Runner 提交而非 UI Event？

**日期**: V0.3  
**状态**: 已确定

**理由**:
- 核心原则：LLM Transcript 是唯一真相，UI Event 只是 Transcript 的观察者
- 防止 UI Event 和模型真实 Transcript 不一致
- 防止一个 assistant message 被拆成多个
- 防止 orphan tool message

**实现**: `runAgent()` 返回 `result.messages`（canonical transcript delta），Server 将其加入 Session。

---

## D-007: 为什么 Approval 是 Run-scoped 而非全局？

**日期**: V0.3  
**状态**: 已确定

**理由**:
- V0.2 的全局 `approvalRegistry.cancelAll()` 在 Stop A 时会影响 B
- V0.3 引入 `ApprovalScope`（runId → pending approvals），每个 Run 独立
- Stop A 只取消 A 的 pending approval，不影响 B

**Trade-off**: 实现略复杂（多一层 scope 映射），但并发安全性提升明显。

---

## D-008: 为什么 workspace trust 需要显式操作？

**日期**: V0.3  
**状态**: 已确定

**理由**:
- V0.2 的 `registerWorkspace()` 允许任何能调用 API 的页面通过传字符串授权任意目录
- V0.3 引入 `TrustedWorkspaceRegistry`，区分"已授权 workspace"和"未授权 path"
- 仅当前项目目录下的路径自动可信，其他路径需显式添加

**Trade-off**: 用户需要多一步操作来添加 workspace，但安全性提升。

---

## D-009: 为什么 CORS 不开放 localhost-wide？

**日期**: V0.3  
**状态**: 已确定

**理由**:
- V0.2 的 CORS 允许任意 `localhost` / `127.0.0.1` origin，其他 localhost port 的 Web App 可获取 CORS 权限
- 本项目是同一个 Server 同时提供 Web UI 和 REST API，通常根本不需要开放 CORS
- V0.3 改为严格同源：仅允许 `http://127.0.0.1:PORT` 的 origin

**Trade-off**: 无 Origin 的请求（curl/CLI）仍然允许，不影响开发调试。

---

## D-010: 为什么使用 NON_EXISTENT sentinel 区分"不存在"与"空文件"？

**日期**: V0.3.2  
**状态**: 已确定

**理由**:
- `value || null` 会将空文件 `""` 误判为不存在
- 删除操作后文件变为不存在，需要与空文件区分
- 使用 Symbol('NON_EXISTENT') 作为 sentinel，确保语义精确

**实现**: `tracker.js` 中 `NON_EXISTENT` 常量，`record()` 和 `getNetDiff()` 均使用它。

---

## D-011: 为什么 Shell SAFE 使用 operation allowlist 而非 executable allowlist？

**日期**: V0.3.1  
**状态**: 已确定

**理由**:
- V0.2 的 executable allowlist 允许 `cat`/`cp`/`mv` 等 executable，但这些可被用于读取敏感文件
- V0.3.1 改为 operation allowlist：只允许明确安全的操作（`pwd`/`git status`/`git diff` 等）
- 未知命令 → REQUIRE_APPROVAL，而不是 SAFE

**Trade-off**: 更多命令需要用户确认，但安全性提升。

---

## D-012: 为什么 Project Script 默认 REQUIRE_APPROVAL？

**日期**: V0.3.3  
**状态**: 已确定

**理由**:
- Agent 可以修改 `package.json` 后执行 `npm test` / `npm run build`
- 这相当于间接执行任意代码
- 没有 OS-level sandbox 时，不能假设项目脚本安全
- V0.4 Permission Modes 可以进一步区分

**Trade-off**: 用户需要多一步确认，但防止了权限升级攻击。

---

## D-013: 为什么引入 CSRF Local Session Token？

**日期**: V0.3.3  
**状态**: 已确定

**理由**:
- 即使 Host/Origin 验证严格，恶意网页仍可能通过 DNS rebinding 或用户诱导点击发起请求
- 启动时生成 `crypto.randomBytes(16)` token，前端从 `/api/config` 获取后附加到所有 mutation 请求
- Server 对 mutation route 统一执行 `validateMutation()`

**Trade-off**: 增加了一次请求往返（获取 token），但安全性提升明显。