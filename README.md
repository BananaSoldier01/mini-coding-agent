# Mini Coding Agent / Mini DSH

一个可在本地 workspace 中执行编码任务的轻量级 Agent Harness。

**当前版本**: V0.3.3 — Delivery Integrity

## 特性

- **Agent Loop** — LLM 分析 → 调用工具 → 获取结果 → 继续推理 → 修改项目 → 完成任务
- **多轮会话上下文** — 同一 session 内后续任务理解前文
- **基础工具能力** — 浏览目录、读取文件、搜索代码、创建/修改文件、执行 shell 命令、展示 diff
- **统一 Tool Policy** — `policy.js` 评估每个 tool call → allow / deny / requireApproval
- **Shell Capability Policy** — `shellpolicy.js` 按 operation 分类：SAFE / APPROVAL / DENY 三级
- **ActiveRun 生命周期** — `runmanager.js` 管理 sessionId → ActiveRun，Stop 中止 LLM + kill process tree + cancel approval
- **Run-scoped Approval** — 每个 Run 独立 approval scope，Stop A 不影响 B
- **Session Transcript** — LLM Transcript 是唯一真相源，UI Event 只是观察者
- **Run Net Diff** — 由 baseline → current 计算净变更，A → B → A 显示 No net change
- **安全沙箱** — 文件操作严格 workspace scoped；Shell 使用 operation classification
- **统一文件访问** — `WorkspaceFileService` 由 Agent Tool / Web API 共同复用
- **可替换 Provider** — 抽象 LLM 层，支持任何 OpenAI-compatible API
- **流式输出** — Token 级流式展示，Tool Call 实时可见
- **Web UI** — 开发者工具风格：文件树、对话、Changes、Terminal
- **CI** — GitHub Actions 自动运行单元测试和集成测试

## 安全边界

- **文件操作**：严格 workspace scoped，敏感文件（.env/.ssh/key 等）拒绝读写
- **Shell 命令**：按 operation 分类，SAFE 操作自动执行，其他需用户确认
- **HTTP 访问**：仅限 127.0.0.1，严格 Host/Origin 验证，CSRF token 防护
- **Agent 权限**：修改 package.json 后执行 npm script 需要用户确认（项目脚本不视为安全）

## 已知限制

- **Shell 命令在 OS 层面不受 workspace 限制** — 安全模型依赖 operation classification + 用户监督
- **大文件范围读取** — 行计数不精确，UTF-8 chunk boundary 处理待完善
- **Diff 性能** — 使用 LCS 算法 O(m×n)，大文件性能不佳（V0.4 计划迁移到 Myers）
- **Windows 平台** — process tree kill 已实现但未实际验证
- **浏览器 E2E** — 未引入 Playwright 或其他 browser automation

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
├── test/                   # 自动测试 (59 unit + 47 integration)
└── test-workspace/         # 测试 workspace
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

- **SAFE** — 明确低风险命令（ls, git, npm, python 等），自动执行
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
npm test                    # 单元测试
npm run test:integration    # 集成测试
npm run test:all            # 全部测试
```

覆盖：Sandbox / Policy / Session / Tracker / Config / Integration（Agent Transcript / File API / Cancel / Large File / Security）。

## License

MIT