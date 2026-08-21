# KNOWN ISSUES — 已知问题

记录已知问题、当前处理状态、延后原因和计划版本。

---

## K-001: Shell 命令不受 workspace 限制

**发现版本**: V0.2  
**当前状态**: 已接受，延后  
**严重程度**: 中（安全边界不完整）

**描述**:
Shell 命令在 OS 层面不受 workspace 限制。cwd 在 workspace 内不代表命令只能访问 workspace。例如 `cat /etc/passwd`、`cp ~/.ssh/id_rsa .` 等命令可以访问 workspace 外的文件。

**当前缓解措施**:
- `safeEnv()` 剥离 LLM_API_KEY 等敏感环境变量
- Shell Capability Policy（SAFE/APPROVAL/DENY）拦截已知危险命令
- 用户审批机制

**延后原因**:
完整的 OS-level sandbox 需要 container / gVisor / seccomp 等技术，复杂度较高。V0.3 阶段优先保证核心链路可靠性。

**计划版本**: V0.4+（考虑 Safe Mode / Standard Mode / Full Access 三级模式）

---

## K-002: LCS diff 对大文件性能不佳

**发现版本**: V0.2  
**当前状态**: 已接受，延后  
**严重程度**: 低（影响范围有限）

**描述**:
`unifiedDiff()` 使用 LCS DP 算法，时间/空间复杂度为 O(m×n)。对大文件（如 1000+ 行）的 diff 计算会明显变慢。

**当前缓解措施**:
- ChangeTracker 升级为 Run Net Diff（baseline → current），减少需要 diff 的次数
- 同一 Run 内多次修改同一文件只计算一次净变更

**延后原因**:
成熟的 Myers diff 算法或可靠依赖需要额外引入。V0.3 优先保证核心链路正确性。

**计划版本**: V0.4+（如需高频大文件 diff，迁移到 Myers 实现）

---

## K-003: 大文件 range read 的流式实现有边界问题

**发现版本**: V0.3  
**当前状态**: 已知，部分修复  
**严重程度**: 低

**描述**:
`_readRange()` 的流式实现对 10MB+ 文件的行计数可能不精确（buffer 分片导致行边界处理有误差）。当前测试已放宽验证条件。

**当前缓解措施**:
- 敏感文件检查先于存在性检查
- 范围读取使用 `fs.readSync` 分块，不载入整个文件
- 测试验证了 1MB 和 10MB 文件的基本 range read 能力

**计划版本**: V0.4（优化行计数精度）

---

## K-004: GitHub 网络不稳定

**发现版本**: V0.3  
**当前状态**: 已接受  
**严重程度**: 低（仅影响发布）

**描述**:
`git push` 和 `gh release create` 偶发超时或连接失败（HTTP2 framing error / connection timeout）。

**当前缓解措施**:
- 重试推送
- 提交和标签在本地始终保留

**计划版本**: 无需修复，网络问题。

---

## K-005: Agent Loop 的 LLM 调用失败处理

**发现版本**: V0.3  
**当前状态**: 已知，部分修复  
**严重程度**: 中

**描述**:
LLM 调用失败时（网络超时、API error），Agent Loop 直接 break，没有重试机制。当前用户需要手动重新发送任务。

**当前缓解措施**:
- 捕获 LLM 异常并发送 `error` event
- Server 端 `activeRun.isStopped()` 检查区分用户取消和 LLM 失败

**计划版本**: V0.4（可选：增加有限重试 + 恢复机制）

---

## K-006: 没有结构化日志

**发现版本**: V0.3  
**当前状态**: 已接受，延后  
**严重程度**: 低（开发阶段）

**描述**:
当前日志使用 `console.log` / `console.error`，没有结构化格式，不支持日志级别过滤和 tracing。

**计划版本**: V0.4+（可选：引入结构化日志 + tracing）

---

## K-007: Windows Process Tree Kill 未实际验证

**发现版本**: V0.3.3  
**当前状态**: 已实现，未验证  
**严重程度**: 中（跨平台可靠性）

**描述**:
Windows 分支的 `taskkill /T /F` 已改为 ESM-compatible 实现，但当前开发平台为 Linux，Windows 行为未实际测试。

**当前缓解措施**:
- 代码已从 `require('child_process')` 迁移到 ESM import
- Linux/macOS 平台已验证 process group kill

**计划版本**: 需要在 Windows 主机上验证

---

## K-008: 浏览器 E2E 测试未引入

**发现版本**: V0.3.3  
**当前状态**: 未开始  
**严重程度**: 低

**描述**:
Playwright 或其他 browser E2E 测试未引入。当前仅通过 Node.js 脚本模拟 HTTP 请求验证核心链路。

**计划版本**: V0.4+（可选）

---

## K-009: Project Script 权限升级

**发现版本**: V0.3.3  
**当前状态**: 已缓解  
**严重程度**: 中

**描述**:
Agent 可以修改 `package.json` 后执行 `npm test` / `npm run build`，相当于间接执行任意代码。

**当前缓解措施**:
- V0.3.3 将 npm test/build/lint 从 SAFE 移至 REQUIRE_APPROVAL
- 用户需要确认后才执行项目脚本

**计划版本**: V0.4 Permission Modes 可进一步区分