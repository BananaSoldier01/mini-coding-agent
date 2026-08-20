# Mini Coding Agent / Mini DSH

一个可在本地 workspace 中执行编码任务的轻量级 Agent Harness。

## 特性

- **完整 Agent Loop** — LLM 分析 → 调用工具 → 获取结果 → 继续推理 → 修改项目 → 运行验证 → 完成任务
- **多轮会话上下文** — 同一 session 内后续任务理解前文，自动 prune 超长上下文
- **基础工具能力** — 浏览目录、读取文件（支持范围读取）、搜索代码、创建/修改文件、执行 shell 命令、展示 diff
- **统一 Tool Policy** — 所有 tool call 经 policy.evaluate() 评估：allow / deny / requireApproval
- **安全沙箱** — 文件操作严格 workspace scoped；Shell 使用 secret scrubbing + risk classification
- **审批机制** — delete_file / 危险 Shell / 网络命令需用户确认，timeout 自动拒绝
- **Stop / Cancel** — 真正中止 LLM request、Agent Loop、child process tree，cancel pending approval
- **可替换 Provider** — 抽象 LLM 层，支持任意 OpenAI-compatible API
- **流式输出** — Token 级流式展示，Tool Call 实时可见
- **Web UI** — 开发者工具风格：文件树、对话、Changes、Terminal

## 快速启动

```bash
# 1. 配置（通过界面右上角 ⚙ 或 .env 文件）
cp .env.example .env
# 编辑 .env，填入 LLM_ENDPOINT / LLM_API_KEY / LLM_MODEL

# 2. 启动
npm start

# 3. 浏览器访问
open http://localhost:38212
```

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `LLM_ENDPOINT` | OpenAI-compatible API 地址 | `https://api.openai.com/v1` |
| `LLM_API_KEY` | API Key | — |
| `LLM_MODEL` | 模型名称 | `gpt-4o-mini` |
| `PORT` | 服务器端口 | `38212` |
| `WORKSPACE` | 默认 workspace 路径 | `./test-workspace` |

配置优先级：**显式环境变量 > 用户持久化配置 > 程序默认值**

## 项目结构

```
Harness/
├── server.js              # 主服务器 (HTTP + SSE, 仅监听 127.0.0.1)
├── config.js              # 配置管理 (env > file > defaults)
├── sandbox.js              # Workspace 沙箱 (路径穿越 + symlink 检测)
├── session.js              # 会话状态管理 (上下文裁剪)
├── tracker.js              # 文件变更追踪 (LCS-based unified diff)
├── approval.js             # 审批注册表 (timeout / cancel / 重复 resolve 防护)
├── policy.js               # 统一 Tool Execution Policy
├── runmanager.js           # Active Run 生命周期 (abort / kill / cancel)
├── agent/
│   ├── index.js            # Agent Loop 核心编排
│   └── LLM.js              # LLM Provider 抽象
├── tools/
│   ├── file.js             # 文件工具 (read/write/edit/search/list/delete)
│   └── shell.js            # Shell 工具 (secret scrubbing / process tree kill)
├── public/
│   ├── index.html          # 前端页面
│   ├── styles.css          # 样式
│   └── app.js              # 前端逻辑 (SSE + UI)
├── test/                   # 自动测试 (58 tests)
├── test-workspace/         # 测试 workspace
└── README.md
```

## Agent Loop 设计

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

## 安全模型

### 文件 Tool
- 严格 workspace scoped，经 Sandbox 路径校验
- 拒绝路径穿越 (`../`)、绝对路径、symlink 逃逸
- 拒绝读写敏感文件 (`.env`、密钥等)

### Shell Tool
- **Secret scrubbing**：不继承 `LLM_API_KEY` 等敏感环境变量
- **Risk classification**：safe / destructive / network / system / secret
- **Approval**：高风险命令需用户确认
- **Timeout**：合理范围 1s-2min
- **Process tree kill**：Stop 时终止整个进程树

### HTTP Server
- 仅监听 `127.0.0.1`（本机访问）
- 同源 CORS（不允许外部网页调用）
- workspace 参数白名单验证

> ⚠️ **诚实说明**：Shell 命令在 OS 层面不受 workspace 限制。
> cwd 在 workspace 内不代表命令只能访问 workspace。
> 当前安全模型依赖：secret scrubbing + risk classification + approval + 用户监督。
> 后续可考虑 container / OS-level sandbox。

## 测试

```bash
npm test
```

覆盖：Sandbox（路径穿越/symlink）、Policy（allow/deny/approval）、Session（上下文/prune）、Tracker（diff/create/modify/delete）、Config（优先级/持久化）。

## License

MIT