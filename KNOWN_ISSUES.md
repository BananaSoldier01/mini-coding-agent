# KNOWN ISSUES — Mini Coding Agent

当前已知问题与 Deferred 项。

---

## Deferred — 不阻塞当前版本

### Large File Reader
- `totalLines` 可能只是局部近似
- UTF-8 chunk boundary 处理不够严谨
- line range 对极大文件仍可优化
- **File Viewer 对大文件诚实提示**: "Large file — partial preview"

### LCS Diff Performance
- 当前使用 LCS O(m×n) 算法
- 大文件 Diff 可能卡顿
- **触发条件**: 实际出现大文件 Diff 卡顿、CPU 异常、UI 无法审查时再进入 Myers Diff
- **不提前重写**

### Windows Process Tree Kill
- 已实现但无 Windows 实机验证
- **放**: Cross-platform Release Milestone

### OS-level Sandbox
- Shell 目前无 OS 级别 sandbox / container 隔离
- **放**: V1 高自主能力之前的架构 Milestone

### Browser E2E
- 尚未引入 Playwright
- **放**: V0.4.2 Product Hardening

### Directory Delete 完整 runAgent E2E
- 单元测试覆盖完整，但无完整 Agent Run E2E
- **放**: V0.4.2

### Session 历史 UI
- 当前仅支持 New Session（清空前端状态）
- Session List / 切换 / 持久化未实现
- **放**: V0.4.2

---

## Not Implemented — 明确不做

- Monaco / Manual Editor
- LSP / Autocomplete
- Debugger
- Git Source Control Panel / Worktree
- Plan Mode
- MCP / Skills / Subagent
- Multi-Agent / Memory System / Vector DB
- Browser Agent
- Multi-provider
- UI Framework 全面重写
- 大面积视觉重构（圆角卡片、渐变、玻璃拟态等）