/**
 * agent/index.js — Agent Loop 核心编排器
 *
 * 职责：
 *   1. 接收用户任务，组装 system prompt + messages
 *   2. 调用 LLM（支持 streaming）
 *   3. 解析 tool_calls，执行工具，注入结果
 *   4. 循环直到完成 / 失败 / 超出最大迭代
 *   5. 通过 onEvent 回调向前端推送事件
 */

import { LLMProvider, createProvider } from './LLM.js';
import { fileTools } from '../tools/file.js';
import { shellTools } from '../tools/shell.js';
import { ChangeTracker } from '../tracker.js';
import { Sandbox } from '../sandbox.js';
import { registry as approvalRegistry } from '../approval.js';

/** 所有可用工具 */
const ALL_TOOLS = [
  ...Object.entries(fileTools).map(([name, def]) => ({ name, ...def })),
  ...Object.entries(shellTools).map(([name, def]) => ({ name, ...def })),
];

const MAX_ITERATIONS = 20;

/**
 * Agent Runner
 *
 * @param {object} opts
 * @param {string} opts.task        用户任务描述
 * @param {string} opts.workspace   workspace 根目录绝对路径
 * @param {object} opts.config      LLM 配置 { endpoint, apiKey, model }
 * @param {function} opts.onEvent   事件回调 (event) => void
 * @param {object} opts.signals     { signal } AbortSignal
 * @returns {object} { messages, changes, finalContent }
 */
async function runAgent(opts) {
  const { task, workspace, config, onEvent, signals } = opts;
  const sandbox = new Sandbox(workspace);
  const tracker = new ChangeTracker();
  const provider = createProvider(config);

  const toolDefs = ALL_TOOLS;
  const toolMap = new Map(ALL_TOOLS.map((t) => [t.name, t]));

  // ── System Prompt ──────────────────────────────────────────
  const systemPrompt = buildSystemPrompt(sandbox);

  // ── 消息上下文 ────────────────────────────────────────────
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: task },
  ];

  let iteration = 0;
  let finalContent = '';

  while (iteration < MAX_ITERATIONS) {
    iteration++;

    // 检查是否被取消
    if (signals?.signal?.aborted) {
      emit(onEvent, { type: 'error', message: '任务被用户取消' });
      break;
    }

    emit(onEvent, { type: 'iteration', iteration, max: MAX_ITERATIONS });

    // ── 调用 LLM（streaming） ────────────────────────────────
    let assistantMsg;
    try {
      assistantMsg = await callLLMStream(provider, messages, toolDefs, signals, onEvent);
    } catch (err) {
      emit(onEvent, { type: 'error', message: `LLM 调用失败: ${err.message}` });
      break;
    }

    // ── 检查 tool_calls ─────────────────────────────────────
    if (assistantMsg.tool_calls && assistantMsg.tool_calls.length > 0) {
      // 将 assistant 消息（含 tool_calls）加入上下文
      messages.push(assistantMsg);

      // 逐个执行 tool_call
      for (const tc of assistantMsg.tool_calls) {
        const toolName = tc.function.name;
        let args;
        try {
          args = JSON.parse(tc.function.arguments);
        } catch {
          args = {};
        }

        const toolDef = toolMap.get(toolName);
        if (!toolDef) {
          emit(onEvent, {
            type: 'tool_result',
            toolCall: { id: tc.id, name: toolName, args },
            result: { error: `未知工具: ${toolName}` },
          });
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: JSON.stringify({ error: `未知工具: ${toolName}` }),
          });
          continue;
        }

        // 推送 tool_call 事件
        emit(onEvent, {
          type: 'tool_call',
          toolCall: { id: tc.id, name: toolName, args },
        });

        // 执行工具
        let result;
        try {
          result = await toolDef.execute(args, { sandbox, tracker, workspace });
        } catch (err) {
          // 危险命令需要确认
          if (err.requiresApproval) {
            emit(onEvent, {
              type: 'approval_needed',
              toolCall: { id: tc.id, name: toolName, args },
              reason: err.message,
            });
            // 等待用户确认
            const approved = await waitForApproval(tc.id);
            if (!approved) {
              result = { error: '用户拒绝执行此命令', cancelled: true };
            } else {
              // 用户批准后重新执行
              try {
                result = await toolDef.execute(args, { sandbox, tracker, workspace });
              } catch (err2) {
                result = { error: err2.message };
              }
            }
          } else {
            result = { error: err.message };
          }
        }

        // 推送 tool_result
        emit(onEvent, {
          type: 'tool_result',
          toolCall: { id: tc.id, name: toolName, args },
          result,
        });

        // 将结果注入上下文
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify(result),
        });
      }
    } else {
      // 没有 tool_calls → 最终回答
      finalContent = assistantMsg.content || '';
      emit(onEvent, { type: 'done', content: finalContent, iteration });
      break;
    }
  }

  if (iteration >= MAX_ITERATIONS && !finalContent) {
    emit(onEvent, {
      type: 'error',
      message: `已达到最大迭代次数 (${MAX_ITERATIONS})，任务可能未完成。`,
    });
  }

  return {
    messages,
    changes: tracker.getDiff(),
    finalContent,
    iteration,
  };
}

/** 调用 LLM 流式，返回 assistant 消息对象 */
async function callLLMStream(provider, messages, toolDefs, signals, onEvent) {
  const stream = await provider.chatStream({
    messages,
    tools: LLMProvider.formatTools(toolDefs),
    signal: signals?.signal,
  });

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let toolCalls = []; // { id, name, arguments_delta }

  // 发送开始事件
  emit(onEvent, { type: 'assistant_start' });

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop(); // 保留最后一行可能不完整

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data: ')) continue;
      const data = trimmed.slice(6);
      if (data === '[DONE]') continue;

      let parsed;
      try {
        parsed = JSON.parse(data);
      } catch {
        continue;
      }

      const choice = parsed.choices?.[0];
      if (!choice) continue;

      const delta = choice.delta;

      // content token
      if (delta?.content) {
        content += delta.content;
        emit(onEvent, { type: 'token', content: delta.content });
      }

      // tool_calls delta
      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          if (!toolCalls[idx]) {
            toolCalls[idx] = {
              id: tc.id || '',
              name: tc.function?.name || '',
              arguments: '',
            };
          }
          if (tc.id) toolCalls[idx].id = tc.id;
          if (tc.function?.name) toolCalls[idx].name = tc.function.name;
          if (tc.function?.arguments) {
            toolCalls[idx].arguments += tc.function.arguments;
          }
        }
      }
    }
  }

  // 构建 assistant 消息（过滤可能的空洞）
  const validToolCalls = toolCalls.filter(Boolean);
  const assistantMsg = {
    role: 'assistant',
    content: content || null,
    tool_calls: validToolCalls.length > 0
      ? validToolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.arguments },
        }))
      : null,
  };

  emit(onEvent, { type: 'assistant_end', content, toolCalls: toolCalls.length });
  return assistantMsg;
}

/** 构建 System Prompt */
function buildSystemPrompt(sandbox) {
  return `你是 Mini Coding Agent，一个在本地 workspace 中执行编码任务的自主 Agent。

## 你的能力
你可以使用以下工具来分析和修改 workspace：
- list_directory: 查看目录结构
- read_file: 读取文件内容
- write_file: 创建或覆盖文件
- edit_file: 精确修改文件中的一段内容（推荐，比 write_file 更安全）
- search_files: 搜索文件内容（支持正则）
- delete_file: 删除文件（危险，需确认）
- run_command: 执行 shell 命令（运行测试、安装依赖、构建等）

## 工作流程
1. 先用 list_directory 了解项目结构
2. 用 read_file 读取相关文件
3. 用 search_files 快速定位代码
4. 用 edit_file 或 write_file 修改代码
5. 用 run_command 运行验证
6. 根据结果继续迭代，直到完成

## 规则
- 所有文件操作只能在 workspace 内（${sandbox.getRoot()}），不能越界
- 优先使用 edit_file 做精确修改，write_file 用于创建新文件
- 修改后主动运行验证命令检查结果
- 遇到错误时分析原因并修复，不要放弃
- 完成任务后明确告诉用户"任务已完成"并总结做了什么
- 不要一次做太多无关的修改，保持改动聚焦

## 工具使用
- 工具参数使用 JSON 格式
- edit_file 的 oldString 必须精确且唯一
- 命令执行有超时和输出限制，避免死循环
- 遇到需要用户确认的危险操作，说明原因并等待确认`;
}

function emit(onEvent, event) {
  if (onEvent) onEvent(event);
}

/** 等待用户批准（通过审批注册表） */
function waitForApproval(toolCallId) {
  return approvalRegistry.register(toolCallId);
}

export { runAgent, ALL_TOOLS };