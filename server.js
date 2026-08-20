/**
 * server.js — Mini Coding Agent 主服务器
 *
 * 职责：
 *   1. 静态文件服务（public/）
 *   2. REST API：配置管理、workspace 浏览
 *   3. SSE 端点：运行 Agent Loop，流式推送事件
 *   4. 审批接口：用户确认/拒绝危险操作
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import url from 'url';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { runAgent } from './agent/index.js';
import { SessionManager } from './session.js';
import { loadConfig, saveFileConfig, maskApiKey } from './config.js';
import { Sandbox } from './sandbox.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');

const config = loadConfig();
const PORT = config.port;
const DEFAULT_WORKSPACE = config.workspace;

const sessionManager = new SessionManager();

// ── HTTP Server ──────────────────────────────────────────────
const server = http.createServer(async (req, resp) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;
  const method = req.method;

  // 设置 CORS
  resp.setHeader('Access-Control-Allow-Origin', '*');
  resp.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  resp.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (method === 'OPTIONS') {
    resp.writeHead(200);
    resp.end();
    return;
  }

  try {
    // ── API 路由 ────────────────────────────────────────────
    if (pathname === '/api/config' && method === 'GET') {
      return sendJson(resp, {
        llm: {
          endpoint: config.llm.endpoint,
          apiKey: maskApiKey(config.llm.apiKey),
          model: config.llm.model,
        },
        workspace: config.workspace,
        port: config.port,
      });
    }

    if (pathname === '/api/config' && method === 'POST') {
      const body = await readBody(req);
      const newConfig = JSON.parse(body);
      // 合并保存
      const current = loadConfig();
      const merged = {
        llm: {
          endpoint: newConfig.llm?.endpoint || current.llm.endpoint,
          apiKey: newConfig.llm?.apiKey || current.llm.apiKey,
          model: newConfig.llm?.model || current.llm.model,
        },
        workspace: newConfig.workspace || current.workspace,
      };
      saveFileConfig(merged);
      Object.assign(config, { llm: merged.llm, workspace: merged.workspace });
      return sendJson(resp, { ok: true, config: { llm: { ...merged.llm, apiKey: maskApiKey(merged.llm.apiKey) } } });
    }

    if (pathname === '/api/files' && method === 'GET') {
      const ws = parsedUrl.query.workspace || config.workspace;
      const sandbox = new Sandbox(ws);
      const tree = await buildFileTree(sandbox, '.');
      return sendJson(resp, { workspace: ws, tree });
    }

    if (pathname === '/api/files/read' && method === 'GET') {
      const ws = parsedUrl.query.workspace || config.workspace;
      const filePath = parsedUrl.query.path;
      if (!filePath) return sendError(resp, 400, '缺少 path 参数');
      const sandbox = new Sandbox(ws);
      const absolute = sandbox.resolve(filePath);
      if (!fs.existsSync(absolute)) return sendError(resp, 404, '文件不存在');
      const content = fs.readFileSync(absolute, 'utf-8');
      return sendJson(resp, { path: filePath, content });
    }

    if (pathname === '/api/session' && method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const ws = body.workspace || config.workspace;
      const session = sessionManager.create(ws);
      return sendJson(resp, { sessionId: session.id, workspace: ws });
    }

    if (pathname === '/api/session' && method === 'GET') {
      const sessionId = parsedUrl.query.sessionId;
      const session = sessionManager.get(sessionId);
      if (!session) return sendError(resp, 404, '会话不存在');
      return sendJson(resp, { id: session.id, workspace: session.workspace, messageCount: session.messages.length });
    }

    // ── SSE: 运行 Agent ─────────────────────────────────────
    if (pathname === '/api/run' && method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const { task, workspace, sessionId, config: clientConfig } = body;
      const ws = workspace || config.workspace;
      const llmConfig = clientConfig?.llm || config.llm;

      // 合并客户端配置（API Key 可能是遮盖值，不覆盖）
      const finalConfig = {
        endpoint: llmConfig.endpoint || config.llm.endpoint,
        apiKey: llmConfig.apiKey && llmConfig.apiKey.length > 8 ? llmConfig.apiKey : config.llm.apiKey,
        model: llmConfig.model || config.llm.model,
      };

      resp.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      const sendEvent = (event) => {
        const data = JSON.stringify(event);
        resp.write(`data: ${data}\n\n`);
      };

      // 获取或创建 session
      let session;
      if (sessionId) {
        session = sessionManager.get(sessionId);
      }
      if (!session) {
        session = sessionManager.create(ws);
      }

      const controller = new AbortController();

      // 记录用户任务到 session
      session.addMessage({ role: 'user', content: task });

      try {
        const result = await runAgent({
          task,
          workspace: ws,
          config: finalConfig,
          onEvent: (event) => {
            sendEvent(event);
            // 同步到 session 上下文
            if (event.type === 'tool_call') {
              session.addMessage({
                role: 'assistant',
                content: null,
                tool_calls: [{
                  id: event.toolCall.id,
                  type: 'function',
                  function: { name: event.toolCall.name, arguments: JSON.stringify(event.toolCall.args) },
                }],
              });
            } else if (event.type === 'tool_result') {
              session.addMessage({
                role: 'tool',
                tool_call_id: event.toolCall.id,
                content: JSON.stringify(event.result),
              });
            }
          },
          signals: { signal: controller.signal },
        });

        // 记录 assistant 最终回复
        if (result.finalContent) {
          session.addMessage({ role: 'assistant', content: result.finalContent });
        }

        sendEvent({ type: 'agent_done', result: { changes: result.changes, iteration: result.iteration } });
      } catch (err) {
        sendEvent({ type: 'error', message: err.message });
      } finally {
        resp.end();
      }
      return;
    }

    // ── SSE: 审批响应 ───────────────────────────────────────
    if (pathname === '/api/approve' && method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const { toolCallId, approved } = body;
      const { registry } = await import('./approval.js');
      const ok = registry.resolve(toolCallId, approved);
      return sendJson(resp, { ok: true, resolved: ok });
    }

    // ── 静态文件服务 ────────────────────────────────────────
    if (method === 'GET') {
      let filePath;
      if (pathname === '/') {
        filePath = path.join(PUBLIC_DIR, 'index.html');
      } else {
        filePath = path.join(PUBLIC_DIR, pathname);
      }
      // 安全：防止路径穿越
      if (!filePath.startsWith(PUBLIC_DIR)) return sendError(resp, 403, '禁止访问');
      if (!fs.existsSync(filePath)) {
        // SPA 路由：返回 index.html
        filePath = path.join(PUBLIC_DIR, 'index.html');
      }
      const ext = path.extname(filePath).toLowerCase();
      const mimeTypes = {
        '.html': 'text/html; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.js': 'application/javascript; charset=utf-8',
        '.json': 'application/json',
        '.png': 'image/png',
        '.svg': 'image/svg+xml',
      };
      const mime = mimeTypes[ext] || 'application/octet-stream';
      resp.setHeader('Content-Type', mime);
      fs.createReadStream(filePath).pipe(resp);
      return;
    }

    sendError(resp, 404, '未找到');
  } catch (err) {
    console.error('[server] 请求处理错误:', err);
    if (!resp.headersSent) {
      sendError(resp, 500, err.message);
    }
  }
});

// ── 工具函数 ──────────────────────────────────────────────────
function sendJson(resp, data, status = 200) {
  resp.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  resp.end(JSON.stringify(data));
}

function sendError(resp, status, message) {
  sendJson(resp, { error: message }, status);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

/** 构建文件树（递归，仅一层深度用于展示） */
async function buildFileTree(sandbox, relPath, maxDepth = 4) {
  const absolute = sandbox.resolve(relPath);
  if (!fs.existsSync(absolute)) return null;
  const stat = fs.statSync(absolute);
  if (!stat.isDirectory()) {
    return { name: path.basename(absolute), type: 'file', path: relPath };
  }

  const node = {
    name: relPath === '.' ? 'workspace' : path.basename(absolute),
    type: 'directory',
    path: relPath,
    children: [],
  };

  if (maxDepth <= 0) {
    node.expanded = false;
    return node;
  }

  const entries = fs.readdirSync(absolute, { withFileTypes: true })
    .filter((e) => !e.name.startsWith('.') && e.name !== 'node_modules')
    .sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

  for (const entry of entries) {
    const childPath = path.join(relPath, entry.name);
    const child = await buildFileTree(sandbox, childPath, maxDepth - 1);
    if (child) node.children.push(child);
  }

  return node;
}

server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════╗
║         Mini Coding Agent / Mini DSH         ║
╠══════════════════════════════════════════════╣
║  服务器:  http://localhost:${PORT}               ║
║  Workspace: ${DEFAULT_WORKSPACE.slice(0, 40).padEnd(40)}║
║  模型:    ${config.llm.model.slice(0, 40).padEnd(40)}║
╚══════════════════════════════════════════════╝
  `);
});

// 定期清理过期会话
setInterval(() => sessionManager.cleanup(), 10 * 60 * 1000);