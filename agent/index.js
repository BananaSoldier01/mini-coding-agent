/**
 * agent/index.js — Agent Loop 核心编排器
 *
 * 职责：
 *   1. 接收用户任务 + session 上下文，组装 messages
 *   2. 调用 LLM（支持 streaming）
 *   3. 解析 tool_calls → policy.evaluate() → 执行/拒绝/审批
 *   4. 循环直到完成 / 失败 / 超出最大迭代
 *   5. 通过 onEvent 回调向前端推送事件
 *
 * 上下文管理：
 *   - 使用 session.messages 作为初始上下文
 *   - 自动 prune 超长上下文
 *   - 对超大 tool output 做截断
 */

import { LLMProvider, createProvider } from './LLM.js';
import { fileTools } from '../tools/file.js';
import { shellTools } from '../tools/shell.js';
import { ChangeTracker } from '../tracker.js';
import { Sandbox } from '../sandbox.js';
import { registry as approvalRegistry } from '../approval.js';
import { evaluate } from '../policy.js';

/** 所有可用工具 */
const ALL_TOOLS = [
  ...Object.entries(fileTools).map(([name, def]) => ({ name, ...def })),
  ...Object.entries(shellTools).map(([name, def]) => ({ name, ...def })),
];

const MAX_ITERATIONS = 20;
const MAX_TOOL_OUTPUT_CHARS = 4000; // 单个 tool result 最大字符数

/**
 * Agent Runner
 *
 * @param {object} opts
 * @param {string} opts.task        用户任务描述
 * @param {string} opts.workspace   workspace 根目录绝对路径
 * @param {object} opts.config      LLM 配置 { endpoint, apiKey, model }
 * @param {object} opts.session     Session 对象（提供上下文）
 * @param {object} opts.run         ActiveRun 对象（提供 abort/stop）
 * @param {function} opts.onEvent   事件回调
 * @param {object} opts.signals     { signal } AbortSignal
 * @returns {object} { messages, changes, finalContent, stopped }
 */
async function runAgent(opts) {
  const { task, workspace, config, session, run, onEvent, signals } = opts;
  const sandbox = new Sandbox(workspace);
  const tracker = new ChangeTracker();
  const provider = createProvider(config);

  const toolDefs = ALL_TOOLS;
  const toolMap = new Map(ALL_TOOLS.map((t) => [t.name, t]));

  // ── System Prompt ──────────────────────────────────
  const systemPrompt = buildSystemPrompt(sandbox);

  // ── 消息上下文 ────────────────────────────────────
  // 从 session 获取历史上下文（排除旧的 system prompt）
  const sessionMessages = session ? session.messages.filter((m) => m.role !== 'system') : [];
  const messages = [
    { role: 'system', content: systemPrompt },
    ...sessionMessages,
    { role: 'user', content: task },
  ];

  let iteration = 0;
  let finalContent = '';
  let stopped = false;

  while (iteration < MAX_ITERATIONS) {
    iteration++;

    // 检查是否被取消
    if (run?.isStopped() || signals?.signal?.aborted) {
      stopped = true;
      emit(onEvent, { type: 'error', message: '任务被用户取消' });
      break;
    }

    emit(onEvent, { type: 'iteration', iteration, max: MAX_ITERATIONS });

    // ── 调用 LLM（streaming） ────────────────────────
    let assistantMsg;
    try {
      assistantMsg = await callLLMStream(provider, messages, toolDefs, signals, onEvent, run);
    } catch (err) {
      if (run?.isStopped() || err.name === 'AbortError') {
        stopped = true;
        emit(onEvent, { type: 'error', message: '任务被用户取消' });
        break;
      }
      emit(onEvent, { type: 'error', message: `LLM 调用失败: ${err.message}` });
      break;
    }

    // ── 检查 tool_calls ─────────────────────────────
    if (assistantMsg.tool_calls && assistantMsg.tool_calls.length > 0) {
      // 将 assistant 消息加入上下文
      messages.push(assistantMsg);

      // 逐个执行 tool_call
      for (const tc of assistantMsg.tool_calls) {
        // 每次循环检查是否被停止
        if (run?.isStopped() || signals?.signal?.aborted) {
          stopped = true;
          emit(onEvent, { type: 'error', message: '任务被用户取消' });
          break;
        }

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

        // ── Policy 评估 ──────────────────────────────
        const policyResult = evaluate(toolDef, args, { sandbox, tracker, workspace, run });

        if (policyResult.decision === 'deny') {
          emit(onEvent, {
            type: 'tool_result',
            toolCall: { id: tc.id, name: toolName, args },
            result: { error: `拒绝执行: ${policyResult.reason}`, denied: true },
          });
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: JSON.stringify({ error: `拒绝执行: ${policyResult.reason}` }),
          });
          continue;
        }

        // 推送 tool_call 事件
        emit(onEvent, {
          type: 'tool_call',
          toolCall: { id: tc.id, name: toolName, args },
          policy: policyResult.decision,
          category: policyResult.category,
        });

        // ── 需要审批 ────────────────────────────────
        if (policyResult.decision === 'requireApproval') {
          emit(onEvent, {
            type: 'approval_needed',
            toolCall: { id: tc.id, name: toolName, args },
            reason: policyResult.reason,
            category: policyResult.category,
          });

          // 等待用户确认（通过 approval registry）
          run?.setPendingApproval(tc.id, null);
          const approved = await waitForApproval(tc.id);
          run?.clearPendingApproval();

          if (!approved) {
            emit(onEvent, {
              type: 'tool_result',
              toolCall: { id: tc.id, name: toolName, args },
              result: { error: '用户拒绝执行', cancelled: true },
            });
            messages.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: JSON.stringify({ error: '用户拒绝执行' }),
            });
            continue;
          }
        }

        // ── 执行工具 ────────────────────────────────
        let result;
        try {
          result = await toolDef.execute(args, { sandbox, tracker, workspace, run });
        } catch (err) {
          result = { error: err.message };
        }

        // 截断过大的 tool output
        const resultStr = JSON.stringify(result);
        const truncated = resultStr.length > MAX_TOOL_OUTPUT_CHARS;
        const finalResult = truncated
          ? { ...result, _truncated: true, _originalLength: resultStr.length }
          : result;

        // 推送 tool_result
        emit(onEvent, {
          type: 'tool_result',
          toolCall: { id: tc.id, name: toolName, args },
          result: finalResult,
        });

        // 将结果注入上下文（截断版）
        const toolContent = truncated
          ? resultStr.slice(0, MAX_TOOL_OUTPUT_CHARS) + '\n...[输出已截断]'
          : resultStr;
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: toolContent,
        });
      }

      // 如果被停止了，退出循环
      if (stopped) break;
    } else {
      // 没有 tool_calls → 最终回答
      finalContent = assistantMsg.content || '';
      emit(onEvent, { type: 'done', content: finalContent, iteration });
      break;
    }
  }

  if (iteration >= MAX_ITERATIONS && !finalContent && !stopped) {
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
    stopped,
  };
}

/** 调用 LLM 流式，返回 assistant 消息对象 */
async function callLLMStream(provider, messages, toolDefs, signals, onEvent, run) {
  const stream = await provider.chatStream({
    messages,
    tools: LLMProvider.formatTools(toolDefs),
    signal: signals?.signal,
  });

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let toolCalls = [];

  emit(onEvent, { type: 'assistant_start' });

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();

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

      if (delta?.content) {
        content += delta.content;
        emit(onEvent, { type: 'token', content: delta.content });
      }

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

  emit(onEvent, { type: 'assistant_end', content, toolCalls: validToolCalls.length });
  return assistantMsg;
}

/** 构建 System Prompt */
function buildSystemPrompt(sandbox) {
  return `你是 Mini Coding Agent，一个在本地 workspace 中执行编码任务的自主 Agent。

## 你的能力
- list_directory: 查看目录结构
- read_file: 读取文件内容（支持 startLine/endLine 范围读取）
- write_file: 创建或覆盖文件
- edit_file: 精确修改文件中的一段内容（推荐，比 write_file 更安全）
- search_files: 搜索文件内容（支持正则）
- delete_file: 删除文件（危险，需确认）
- run_command: 执行 shell 命令（运行测试、安装依赖、构建等）

## 工作流程
1. 先用 list_directory 了解项目结构
2. 用 search_files 快速定位代码
3. 用 read_file 精确读取相关行范围（大文件用 startLine/endLine 分段）
4. 用 edit_file 或 write_file 修改代码
5. 用 run_command 运行验证
6. 根据结果继续迭代，直到完成

## 规则
- 所有文件操作只能在 workspace 内，不能越界
- 优先使用 edit_file 做精确修改，write_file 用于创建新文件
- 修改后主动运行验证命令检查结果
- 遇到错误时分析原因并修复，不要放弃
- 完成任务后明确告诉用户"任务已完成"并总结做了什么
- 不要一次做太多无关的修改，保持改动聚焦
- 不要读取 .env、密钥等敏感文件
- 不要执行读取敏感环境变量的命令`;
}

function emit(onEvent, event) {
  if (onEvent) onEvent(event);
}

/** 等待用户批准 */
function waitForApproval(toolCallId) {
  return approvalRegistry.register(toolCallId);
}

export { runAgent, ALL_TOOLS };