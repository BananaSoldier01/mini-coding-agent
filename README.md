# Mini Coding Agent / Mini DSH

一个可在本地 workspace 中执行编码任务的轻量级 Agent Harness。

**当前版本**: V0.9.2 — Planner Interface & Execution Orchestration

## 特性

- **Agent Loop** — LLM 分析 → 调用工具 → 获取结果 → 继续推理 → 修改项目 → 完成任务
- **多轮会话上下文** — 同一 session 内后续任务理解前文
- **基础工具能力** — 浏览目录、读取文件、搜索代码、创建/修改文件、执行 shell 命令、展示 diff
- **统一 Tool Policy** — `policy.js` 每个 tool call → allow / deny / requireApproval
- **Shell Capability Policy** — `shellpolicy.js` 按 operation 分类：SAFE / APPROVAL / DENY 三级
- **ActiveRun 生命周期** — `runmanager.js` 管理 sessionId → ActiveRun，Stop 中止 LLM + kill process tree + cancel approval
- **Run-scoped Approval** — 每个 Run 独立 approval scope，Stop A 不影响 B
- **Session Transcript** — LLM Transcript 是唯一真相源，UI Event 只是观察者
- **Run Net Diff** — 由 baseline → current 计算净变更，A → B → A 显示 No net change
- **安全沙箱** — 文件操作严格 workspace scoped；Shell 使用 operation classification
- **统一文件访问** — `WorkspaceFileService` 由 Agent Tool / Web API 共同复用
- **可替换 Provider** — 抽象 LLM 层，支持任何 OpenAI-compatible API；测试环境可注入 Fake LLM Provider
- **流式输出** — Token 级流式展示，Tool Call 实时可见
- **Web UI** — 开发者工具风格：文件树、对话、Changes、Terminal
- **Permission Mode** — Safe / Standard / Full Access 三档权限，Session-scoped
- **Agent Run Status** — Thinking / Reading / Searching / Editing / Running / Waiting / Verifying / Completed
- **Agent Activity Timeline** — 人类可读的工具调用展示，点击可导航到 File Inspector 或 Terminal
- **Approval UX** — 人类可读的审批说明（运行命令？/ 删除文件？/ 修改文件？）
- **Changes Panel** — Run Net Diff 一级展示，支持 A/M/D 文件标记
- **Completion Summary** — 结构化任务总结（变更 / 耗时 / 审批 / 命令证据）
- **Unified Inspector** — Changes | File 双 Tab，File 下 Current | Diff 子 Tab
- **Lazy Explorer** — 目录按需展开加载，不整树初始化
- **Session List** — 列出 Session，切换时恢复 canonical transcript
- **Browser E2E** — Playwright + Fake LLM Provider，覆盖 Browser UI 和 Real Agent 两条链路

## 安全边界

- **文件操作**：严格 workspace scoped，敏感文件（.env/.ssh/key 等）拒绝读写
- **Shell 命令**：按 operation 分类，明确低风险只读命令可自动执行；项目脚本、修改类命令和未知操作需要用户确认；硬拒绝的敏感操作永不执行
- **HTTP 访问**：仅限 127.0.0.1，严格 Host/Origin 验证，CSRF token 防护
- **Agent 权限**：修改 package.json 后执行 npm script 需要用户确认（项目脚本不视为安全）

## 已知限制

- **Shell 命令在 OS 层面不受 workspace 限制** — 安全模型依赖 operation classification + 用户监督
- **大文件范围读取** — 行计数不精确，UTF-8 chunk boundary 处理待完善
- **Diff 性能** — 使用 LCS 算法 O(m×n)，大文件性能不佳
- **Windows 平台** — process tree kill 已实现但未实际验证
- **Test Hook 技术债务** — `window.__dshTest` 仅在 `E2E_FAKE_LLM=1` 时可用，不应视为产品 API

## 快速启动

```bash
npm start
# 浏览器访问 http://localhost:38212
```

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `LLM_ENDPOINT` | OpenAI-compatible API 地址 | `https://api.openai.com/v1` |
| `LLM_API_KEY` | API Key | — |
| `LLM_MODEL` | 模型名称 | `gpt-4o-mini` |
| `PORT` | 服务器端口 | `38212` |
| `WORKSPACE` | 默认 workspace 路径 | `./test-workspace` |
| `E2E_FAKE_LLM` | 启用 Fake LLM Provider（仅测试） | — |

配置优先级：**显式环境变量 > 用户持久化配置 > 程序默认值**

## 项目结构

```
Harness/
├── server.js              # 主服务器 (HTTP + SSE, 仅监听 127.0.0.1)
├── config.js              # 配置管理
├── sandbox.js              # Workspace 沙箱 (路径穿越 + symlink 检测)
├── session.js              # 会话状态管理 (上下文裁剪)
├── tracker.js              # 文件变更追踪 (Run Net Diff)
├── approval.js             # 审批注册表 (Run-scoped)
├── policy.js               # 统一 Tool Execution Policy
├── runmanager.js           # Active Run 生命周期
├── shellpolicy.js          # Shell Capability Policy (SAFE / APPROVAL / DENY)
├── fileservice.js          # 统一 Workspace 文件访问层
├── agent/
│   ├── index.js            # Agent Loop 核心编排
│   └── LLM.js              # LLM Provider 抽象
├── tools/
│   ├── file.js             # 文件工具
│   └── shell.js            # Shell 工具
├── public/                 # 前端
├── test/                   # 自动测试 (97 unit + 49 integration + 17 browser E2E)
├── test-workspace/         # 测试 workspace
└── test/fake-llm.js        # Fake LLM Provider (E2E only)
```

## Agent Loop

```
用户任务 → Session 上下文 + System Prompt → LLM (streaming)
  → tool_calls? → policy.evaluate() → allow/deny/requireApproval
    → allow: execute → inject result → continue
    → deny: inject error → continue
    → requireApproval: wait for user → approved? execute : skip
  → no tool_calls? → final answer → done
```

- 最大迭代次数: 20
- 上下文自动 prune（保留 system + 最近消息，确保 tool_call/result 对完整）
- 单个 tool output 最大 4000 字符，超出截断
- 支持 Stop 中止（abort LLM + kill process tree + cancel approval）
- Run Identity: Server `ActiveRun.runId` 是唯一真值，通过 `run_started` SSE event 传给 Frontend

## 工具列表

| 工具 | 说明 | 风险 |
|------|------|------|
| `list_directory` | 列出目录内容 | safe |
| `read_file` | 读取文件（支持 startLine/endLine 范围） | safe |
| `write_file` | 创建或覆盖文件 | safe |
| `edit_file` | 精确搜索替换修改 | safe |
| `search_files` | 搜索文件内容（支持正则） | safe |
| `delete_file` | 删除文件/目录 | **需审批** |
| `run_command` | 执行 shell 命令 | 视命令而定 |

## Shell Capability Policy

V0.3 从 denylist 正则改为 allowlist / capability 思维：

- **SAFE** — 明确低风险只读命令（ls, git status 等），自动执行
- **APPROVAL** — 无法明确判断安全的命令 → 需要用户确认
- **DENY** — 读取 Secret / 攻击安全边界（printenv API_KEY, cat ~/.ssh/id_rsa, sudo, chmod 777 等）

原则：**Unknown shell command ≠ SAFE**

## 安全模型

### 文件 Tool
- 严格 workspace scoped，经 Sandbox 路径校验
- 拒绝路径穿越 (`../`)、绝对路径、symlink 逃逸
- 拒绝读写敏感文件（`.env`、密钥、`.pem`、`.key` 等）

### Shell Tool
- **Secret scrubbing**：不继承 `LLM_API_KEY` 等敏感环境变量
- **Capability classification**：SAFE / APPROVAL / DENY
- **Approval**：高风险命令需用户确认
- **Timeout**：合理范围 1s-2min
- **Process tree kill**：Stop 时终止整个进程树

### HTTP Server
- 仅监听 `127.0.0.1`（本机访问）
- 同源 CORS（不开放 localhost-wide）
- Workspace trust 需明确用户操作（TrustedWorkspaceRegistry）

> ⚠️ **诚实说明**：Shell 命令在 OS 层面不受 workspace 限制。
> 当前安全模型依赖：secret scrubbing + capability classification + approval + 用户监督。
> Full OS isolation 未来应依赖 container / OS sandbox。

## 测试

```bash
npm run test:unit          # 单元测试 (97 tests)
npm run test:integration   # 集成测试 (49 tests)
npm run test:e2e           # Browser E2E (17 tests: 11 UI + 6 Agent)
npm run test:all           # 全部测试 (163 tests, CI Release Gate)
```

覆盖：Sandbox / Policy / Permission Mode / Session / Tracker / Config / Integration（Agent Transcript / File API / Cancel / Large File / Security / Directory Delete）/ Browser E2E（UI Interaction + Real Agent with Fake LLM）。

## License

MIT