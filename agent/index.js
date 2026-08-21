/**
 * agent/index.js — Agent Loop 核心编排器
 *
 * V0.3 重构：
 * - 使用 WorkspaceFileService 统一文件访问
 * - 使用 capability-based Shell Policy
 * - Session Transcript 作为唯一真相源
 * - Run-scoped Approval
 * - Run Net Diff
 */

import { createProvider } from './LLM.js';
import { FileTools } from '../tools/file.js';
import { shellToolDef } from '../tools/shell.js';
import { ChangeTracker } from '../tracker.js';
import { Sandbox } from '../sandbox.js';
import { registry as approvalRegistry } from '../approval.js';
import { evaluate } from '../policy.js';
import { evaluateShell } from '../shellpolicy.js';

const MAX_ITERATIONS = 20;
const MAX_TOOL_OUTPUT_CHARS = 4000;

const TOOL_DESCS = {
  list_directory: '列出 workspace 中某个目录的内容，返回树状结构。',
  read_file: '读取文件内容。支持 startLine/endLine 范围读取，大文件可分段读取。',
  write_file: '创建或覆盖文件。',
  edit_file: '精确修改文件中的一段内容。oldString 必须唯一。',
  search_files: '搜索文件内容，支持正则。',
  delete_file: '删除文件或目录。危险操作，需要用户确认。',
  run_command: '在 workspace 内执行 shell 命令。安全命令自动执行，未知命令需要用户确认。',
};

const TOOL_SCHEMAS = {
  list_directory: { type: 'object', properties: { path: { type: 'string' } }, required: [] },
  read_file: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      startLine: { type: 'number' },
      endLine: { type: 'number' },
      offset: { type: 'number' },
      limit: { type: 'number' },
    },
    required: ['path'],
  },
  write_file: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
  edit_file: { type: 'object', properties: { path: { type: 'string' }, oldString: { type: 'string' }, newString: { type: 'string' } }, required: ['path', 'oldString', 'newString'] },
  search_files: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' }, maxResults: { type: 'number' } }, required: ['pattern'] },
  delete_file: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  run_command: { type: 'object', properties: { command: { type: 'string' }, timeout: { type: 'number' }, cwd: { type: 'string' } }, required: ['command'] },
};

async function runAgent(opts) {
  const { task, workspace, config, session, run, onEvent, signals } = opts;
  const sandbox = new Sandbox(workspace);
  const tracker = new ChangeTracker();
  const provider = createProvider(config);
  const fileTools = new FileTools(workspace);

  const toolDefs = [
    { name: 'list_directory', description: TOOL_DESCS.list_directory, input_schema: TOOL_SCHEMAS.list_directory },
    { name: 'read_file', description: TOOL_DESCS.read_file, input_schema: TOOL_SCHEMAS.read_file },
    { name: 'write_file', description: TOOL_DESCS.write_file, input_schema: TOOL_SCHEMAS.write_file },
    { name: 'edit_file', description: TOOL_DESCS.edit_file, input_schema: TOOL_SCHEMAS.edit_file },
    { name: 'search_files', description: TOOL_DESCS.search_files, input_schema: TOOL_SCHEMAS.search_files },
    { name: 'delete_file', description: TOOL_DESCS.delete_file, input_schema: TOOL_SCHEMAS.delete_file, dangerous: true },
    { name: 'run_command', description: TOOL_DESCS.run_command, input_schema: TOOL_SCHEMAS.run_command },
  ];

  const toolMap = new Map(toolDefs.map((t) => [t.name, t]));

  const systemPrompt = buildSystemPrompt(sandbox);

  // 从 session 获取历史上下文（排除旧 system prompt）
  const sessionMessages = session ? session.messages.filter((m) => m.role !== 'system') : [];
  const messages = [
    { role: 'system', content: systemPrompt },
    ...sessionMessages,
  ];

  // 本轮消息（turn boundary），不依赖 content 匹配
  const turnMessages = [];
  turnMessages.push({ role: 'user', content: task });
  messages.push(...turnMessages);

  let iteration = 0;
  let finalContent = '';
  let stopped = false;

  while (iteration < MAX_ITERATIONS) {
    iteration++;

    if (run?.isStopped() || signals?.signal?.aborted) {
      stopped = true;
      emit(onEvent, { type: 'error', message: '任务被用户取消' });
      break;
    }

    emit(onEvent, { type: 'iteration', iteration, max: MAX_ITERATIONS });

    let assistantMsg;
    try {
      assistantMsg = await callLLMStream(provider, messages, toolDefs, onEvent, signals);
    } catch (err) {
      if (run?.isStopped() || err.name === 'AbortError') {
        stopped = true;
        emit(onEvent, { type: 'error', message: '任务被用户取消' });
        break;
      }
      emit(onEvent, { type: 'error', message: `LLM 调用失败: ${err.message}` });
      break;
    }

    if (assistantMsg.tool_calls && assistantMsg.tool_calls.length > 0) {
      // 将 assistant 消息加入上下文（保持为一个消息）
      messages.push(assistantMsg);
      turnMessages.push(assistantMsg);

      for (const tc of assistantMsg.tool_calls) {
        if (run?.isStopped() || signals?.signal?.aborted) {
          stopped = true;
          emit(onEvent, { type: 'error', message: '任务被用户取消' });
          break;
        }

        const toolName = tc.function.name;
        let args;
        try { args = JSON.parse(tc.function.arguments); } catch { args = {}; }

        // ── Policy 评估 ──────────────────────────────
        let policyResult;
        if (toolName === 'run_command') {
          policyResult = evaluateShell(args.command || '');
        } else {
          const toolDef = toolMap.get(toolName);
          if (!toolDef) {
            emit(onEvent, {
              type: 'tool_result',
              toolCall: { id: tc.id, name: toolName, args },
              result: { error: `未知工具: ${toolName}` },
            });
            messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ error: `未知工具: ${toolName}` }) });
            turnMessages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ error: `未知工具: ${toolName}` }) });
            continue;
          }
          policyResult = evaluate(toolDef, args, { sandbox, tracker, workspace, run });
        }

        emit(onEvent, {
          type: 'tool_call',
          toolCall: { id: tc.id, name: toolName, args },
          policy: policyResult.decision,
          category: policyResult.category,
        });

        if (policyResult.decision === 'deny') {
          emit(onEvent, {
            type: 'tool_result',
            toolCall: { id: tc.id, name: toolName, args },
            result: { error: `拒绝执行: ${policyResult.reason}`, denied: true },
          });
          messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ error: `拒绝执行: ${policyResult.reason}` }) });
          turnMessages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ error: `拒绝执行: ${policyResult.reason}` }) });
          continue;
        }

        if (policyResult.decision === 'requireApproval') {
          emit(onEvent, {
            type: 'approval_needed',
            toolCall: { id: tc.id, name: toolName, args },
            reason: policyResult.reason,
            category: policyResult.category,
            runId: run?.runId,
          });

          run?.setPendingApproval(tc.id);
          const approved = await approvalRegistry.register(run?.runId || 'default', tc.id);
          run?.clearPendingApproval();

          if (!approved) {
            emit(onEvent, {
              type: 'tool_result',
              toolCall: { id: tc.id, name: toolName, args },
              result: { error: '用户拒绝执行', cancelled: true },
            });
            messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ error: '用户拒绝执行' }) });
          turnMessages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ error: '用户拒绝执行' }) });
            continue;
          }
        }

        // ── 执行工具 ────────────────────────────────
        let result;
        try {
          if (toolName === 'run_command') {
            result = await shellToolDef.run_command.execute(args, { sandbox, tracker, workspace, run });
          } else {
            const method = {
              list_directory: fileTools.listDirectory.bind(fileTools),
              read_file: fileTools.readFile.bind(fileTools),
              write_file: fileTools.writeFile.bind(fileTools),
              edit_file: fileTools.editFile.bind(fileTools),
              search_files: fileTools.searchFiles.bind(fileTools),
              delete_file: fileTools.deleteFile.bind(fileTools),
            }[toolName];
            if (!method) {
              result = { error: `工具未实现: ${toolName}` };
            } else {
              result = await method(args);
            }
          }

          // 记录变更到 tracker（使用真实 before/after 内容）
          if (result.path && (toolName === 'write_file' || toolName === 'edit_file' || toolName === 'delete_file')) {
            tracker.record({
              type: toolName === 'write_file' ? (result.action === 'created' ? 'create' : 'modify')
                : toolName === 'delete_file' ? 'delete' : 'modify',
              path: result.path,
              oldContent: result.before,
              newContent: result.after,
            });
          }
        } catch (err) {
          result = { error: err.message };
        }

        // 截断过大的 tool output
        const resultStr = JSON.stringify(result);
        const truncated = resultStr.length > MAX_TOOL_OUTPUT_CHARS;
        const finalResult = truncated
          ? { ...result, _truncated: true, _originalLength: resultStr.length }
          : result;

        emit(onEvent, {
          type: 'tool_result',
          toolCall: { id: tc.id, name: toolName, args },
          result: finalResult,
        });

        const toolContent = truncated
          ? resultStr.slice(0, MAX_TOOL_OUTPUT_CHARS) + '\n...[输出已截断]'
          : resultStr;
        messages.push({ role: 'tool', tool_call_id: tc.id, content: toolContent });
        turnMessages.push({ role: 'tool', tool_call_id: tc.id, content: toolContent });
      }

      if (stopped) break;
    } else {
      finalContent = assistantMsg.content || '';
      // 将最终 assistant 消息加入 canonical transcript
      const finalAssistantMsg = { role: 'assistant', content: finalContent };
      messages.push(finalAssistantMsg);
      turnMessages.push(finalAssistantMsg);
      emit(onEvent, { type: 'done', content: finalContent, iteration });
      break;
    }
  }

  if (iteration >= MAX_ITERATIONS && !finalContent && !stopped) {
    emit(onEvent, { type: 'error', message: `已达到最大迭代次数 (${MAX_ITERATIONS})` });
  }

  // 计算净变更
  const netDiff = tracker.getNetDiff();

  // 返回本轮消息（turnMessages），不含旧 session 消息和 system prompt
  return {
    messages: turnMessages,
    changes: netDiff,
    finalContent,
    iteration,
    stopped,
  };
}

async function callLLMStream(provider, messages, toolDefs, onEvent, signals) {
  const stream = await provider.chatStream({
    messages,
    tools: toolDefs.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.input_schema },
    })),
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
      try { parsed = JSON.parse(data); } catch { continue; }

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
            toolCalls[idx] = { id: tc.id || '', name: tc.function?.name || '', arguments: '' };
          }
          if (tc.id) toolCalls[idx].id = tc.id;
          if (tc.function?.name) toolCalls[idx].name = tc.function.name;
          if (tc.function?.arguments) toolCalls[idx].arguments += tc.function.arguments;
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
          id: tc.id, type: 'function',
          function: { name: tc.name, arguments: tc.arguments },
        }))
      : null,
  };

  emit(onEvent, { type: 'assistant_end', content, toolCalls: validToolCalls.length });
  return assistantMsg;
}

function buildSystemPrompt(sandbox) {
  return `你是 Mini Coding Agent，一个在本地 workspace 中执行编码任务的自主 Agent。

## 工具
- list_directory: 查看目录结构
- read_file: 读取文件（支持 startLine/endLine 范围）
- write_file: 创建或覆盖文件
- edit_file: 精确修改（推荐）
- search_files: 搜索内容（支持正则）
- delete_file: 删除文件（需确认）
- run_command: 执行 shell 命令

## 流程
1. list_directory 了解结构
2. search_files 定位
3. read_file 精确读取
4. edit_file / write_file 修改
5. run_command 验证
6. 迭代直到完成

## 规则
- 只在 workspace 内操作
- 优先 edit_file 精确修改
- 修改后主动验证
- 遇到错误分析并修复
- 不读取 .env、密钥等敏感文件
- 不执行读取敏感环境变量的命令`;
}

function emit(onEvent, event) {
  if (onEvent) onEvent(event);
}

export { runAgent };