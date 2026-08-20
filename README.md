# Mini Coding Agent / Mini DSH

一个可在本地 workspace 中执行编码任务的轻量级 Agent Harness。

## 特性

- **完整 Agent Loop** — LLM 分析 → 调用工具 → 获取结果 → 继续推理 → 修改项目 → 运行验证 → 完成任务
- **基础工具能力** — 浏览目录、读取文件、搜索代码、创建/修改文件、执行 shell 命令、展示 diff
- **安全沙箱** — 所有文件操作限制在 workspace 内，危险命令需用户确认
- **可替换 Provider** — 抽象 LLM 层，支持任意 OpenAI-compatible API
- **流式输出** — Token 级流式展示，Tool Call 实时可见
- **Web UI** — 开发者工具风格的界面，支持文件树、对话、操作历史、diff、终端

## 快速启动

```bash
# 1. 配置环境变量（或通过界面右上角 ⚙ 设置）
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

## 项目结构

```
Harness/
├── server.js              # 主服务器 (HTTP + SSE)
├── config.js              # 配置管理 (环境变量 + 本地文件)
├── sandbox.js              # Workspace 沙箱 (路径穿越防护)
├── session.js              # 会话状态管理
├── tracker.js              # 文件变更追踪
├── approval.js             # 审批注册表 (危险操作确认)
├── agent/
│   ├── index.js            # Agent Loop 核心编排
│   └── LLM.js              # LLM Provider 抽象
├── tools/
│   ├── file.js             # 文件工具 (read/write/edit/search/list/delete)
│   └── shell.js            # Shell 工具 (run_command)
├── public/
│   ├── index.html          # 前端页面
│   ├── styles.css          # 样式
│   └── app.js              # 前端逻辑
└── test-workspace/         # 测试 workspace
```

## Agent Loop 设计

```
用户任务 → System Prompt + Messages → LLM (streaming)
  → 有 tool_calls? → 执行工具 → 注入结果 → 继续
  → 无 tool_calls? → 最终回答 → 完成
```

- 最大迭代次数: 20
- 工具结果通过 `role: 'tool'` 注入上下文
- 危险操作通过 ApprovalRegistry 暂停等待用户确认
- 支持 AbortController 中止正在运行的任务

## 工具列表

| 工具 | 说明 | 危险 |
|------|------|------|
| `list_directory` | 列出目录内容 | 否 |
| `read_file` | 读取文件内容 | 否 |
| `write_file` | 创建或覆盖文件 | 否 |
| `edit_file` | 精确搜索替换修改 | 否 |
| `search_files` | 搜索文件内容 | 否 |
| `delete_file` | 删除文件/目录 | 是 |
| `run_command` | 执行 shell 命令 | 部分 |

## License

MIT