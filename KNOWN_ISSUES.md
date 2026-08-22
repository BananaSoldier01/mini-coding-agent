# KNOWN ISSUES — Mini Coding Agent

当前已知问题与 Deferred 项。

---

## Closed — V0.4.2.1 已解决

### Browser E2E Not Introduced
- **已关闭**: Playwright 已引入，17 tests 全绿（11 Browser UI + 6 Real Agent E2E）

### Directory Delete Lacks Agent E2E
- **已关闭**: Agent E2E E — Directory Delete 覆盖完整链路（delete_file → Changes D → Diff → real content）

### Session Title Incomplete
- **已关闭**: 第一条 User Task 自动设置 Session title（POST /api/session 传 title + /api/run 兜底）

### Session Transcript Switching Incomplete
- **已关闭**: /api/session/switch 返回 canonical messages，前端恢复 user + assistant transcript

### Release Artifact Version Drift
- **已关闭**: package.json / package-lock.json / README / ROADMAP / Tag 均为 0.4.2.1

### activeRunId Client-Generated Bug
- **已关闭**: Server ActiveRun.runId 是唯一 Run Identity，Frontend 通过 run_started event 获取

### Output UI Unlimited Rendering
- **已关闭**: Terminal stdout/stderr 各 4000 字符截断，Timeline args/result 各 500 字符截断

---

## Open — 当前已知问题

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

### Test Hook Technical Debt
- `window.__dshTest` 仅在 `E2E_FAKE_LLM=1` 时可用
- 不应视为产品 API
- **放**: 未来可用 build-time 条件编译或独立 test harness 替代

### Permission Mode Category Names
- `policy.js` 使用 `file_destructive` 而 `permission.js` 使用 `file_edit` / `file_delete`
- Safe 模式下默认拒绝未在 ALLOW 白名单中的类别，功能正确但命名不一致
- **放**: 后续统一 category 命名

---

## Deferred — 不阻塞当前版本

### V0.5 候选方向（不做决策、不做实现）
- Task Planning / Plan Mode
- Context Management / 自动摘要
- Extensibility / Skills
- Git-aware Workflow
- 多任务 / Worktree
- 更强安全隔离（container / OS sandbox）

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