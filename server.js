/**
 * server.js — Mini Coding Agent 主服务器
 *
 * 职责：
 *   1. 静态文件服务（public/）
 *   2. REST API：配置管理、workspace 浏览
 *   3. SSE 端点：运行 Agent Loop，流式推送事件
 *   4. 审批接口：用户确认/拒绝危险操作
 *
 * 安全边界：
 *   - 默认监听 127.0.0.1（仅本机）
 *   - 同源 CORS（不允许外部网页调用）
 *   - workspace 参数统一验证
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
import { runManager } from './runmanager.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');

const config = loadConfig();
const PORT = config.port;
const DEFAULT_WORKSPACE = config.workspace;

const sessionManager = new SessionManager();

// ── 允许的 workspace 白名单（默认仅本地项目）────────────
const ALLOWED_WORKSPACES = new Set([
  path.join(process.cwd(), 'test-workspace'),
  // 用户通过 UI 添加的 workspace 也在此登记
]);

function isAllowedWorkspace(ws) {
  if (!ws) return false;
  const abs = path.resolve(ws);
  // 必须是绝对路径
  if (!path.isAbsolute(abs)) return false;
  // 必须在允许列表中，或在当前项目目录下
  if (ALLOWED_WORKSPACES.has(abs)) return true;
  const projectRoot = path.resolve(process.cwd());
  if (abs.startsWith(projectRoot + path.sep) || abs === projectRoot) return true;
  return false;
}

function registerWorkspace(ws) {
  ALLOWED_WORKSPACES.add(path.resolve(ws));
}

// ── CORS 配置（同源，不允许 wildcard）─────────────────
function setSameOriginCORS(resp, req) {
  const origin = req.headers.origin;
  // 仅允许同源（无 origin 或与服务器同源）
  // 由于是 127.0.0.1，同源即 127.0.0.1:PORT
  if (!origin) {
    // 无 origin（如 fetch from same origin）允许
    resp.setHeader('Access-Control-Allow-Origin', 'null');
  } else {
    // 有 origin 的请求：仅允许同源
    const url = new URL(origin);
    if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') {
      resp.setHeader('Access-Control-Allow-Origin', origin);
      resp.setHeader('Access-Control-Allow-Credentials', 'true');
    }
    // 其他 origin 不设置 CORS 头，浏览器会拦截
  }
  resp.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  resp.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// ── HTTP Server ──────────────────────────────────────
const server = http.createServer(async (req, resp) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;
  const method = req.method;

  // 设置 CORS（同源）
  setSameOriginCORS(resp, req);

  if (method === 'OPTIONS') {
    resp.writeHead(200);
    resp.end();
    return;
  }

  try {
    // ── API: 配置 ────────────────────────────────────
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
      registerWorkspace(merged.workspace);
      return sendJson(resp, {
        ok: true,
        config: { llm: { ...merged.llm, apiKey: maskApiKey(merged.llm.apiKey) } }
      });
    }

    // ── API: 文件列表 ────────────────────────────────
    if (pathname === '/api/files' && method === 'GET') {
      const ws = parsedUrl.query.workspace || config.workspace;
      if (!isAllowedWorkspace(ws)) {
        return sendError(resp, 403, `不允许访问 workspace: ${ws}`);
      }
      const sandbox = new Sandbox(ws);
      const tree = await buildFileTree(sandbox, '.');
      return sendJson(resp, { workspace: ws, tree });
    }

    // ── API: 文件读取 ────────────────────────────────
    if (pathname === '/api/files/read' && method === 'GET') {
      const ws = parsedUrl.query.workspace || config.workspace;
      const filePath = parsedUrl.query.path;
      if (!filePath) return sendError(resp, 400, '缺少 path 参数');
      if (!isAllowedWorkspace(ws)) {
        return sendError(resp, 403, `不允许访问 workspace: ${ws}`);
      }
      const sandbox = new Sandbox(ws);
      const absolute = sandbox.resolve(filePath);
      if (!fs.existsSync(absolute)) return sendError(resp, 404, '文件不存在');
      const content = fs.readFileSync(absolute, 'utf-8');
      return sendJson(resp, { path: filePath, content });
    }

    // ── API: Session ─────────────────────────────────
    if (pathname === '/api/session' && method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const ws = body.workspace || config.workspace;
      if (!isAllowedWorkspace(ws)) {
        return sendError(resp, 403, `不允许访问 workspace: ${ws}`);
      }
      const session = sessionManager.create(ws);
      return sendJson(resp, { sessionId: session.id, workspace: ws });
    }

    if (pathname === '/api/session' && method === 'GET') {
      const sessionId = parsedUrl.query.sessionId;
      const session = sessionManager.get(sessionId);
      if (!session) return sendError(resp, 404, '会话不存在');
      return sendJson(resp, {
        id: session.id,
        workspace: session.workspace,
        messageCount: session.messages.length,
        active: session.active,
      });
    }

    // ── API: 停止当前运行 ────────────────────────────
    if (pathname === '/api/stop' && method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const { sessionId } = body;
      const ok = runManager.stop(sessionId);
      return sendJson(resp, { ok, stopped: ok });
    }

    // ── SSE: 运行 Agent ──────────────────────────────
    if (pathname === '/api/run' && method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const { task, workspace, sessionId, config: clientConfig } = body;
      const ws = workspace || config.workspace;

      // workspace 验证
      if (!isAllowedWorkspace(ws)) {
        return sendError(resp, 403, `不允许访问 workspace: ${ws}`);
      }

      const llmConfig = clientConfig?.llm || config.llm;
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

      // 创建 ActiveRun（管理生命周期）
      const activeRun = runManager.create(session.id);

      const controller = activeRun.controller;

      try {
        const result = await runAgent({
          task,
          workspace: ws,
          config: finalConfig,
          session,        // ← 传入 session，Agent 使用历史上下文
          run: activeRun, // ← 传入 run，Agent 可检查停止状态
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

        sendEvent({
          type: 'agent_done',
          result: {
            changes: result.changes,
            iteration: result.iteration,
            stopped: result.stopped,
          },
        });
      } catch (err) {
        if (activeRun.isStopped()) {
          sendEvent({ type: 'error', message: '任务被用户取消' });
        } else {
          sendEvent({ type: 'error', message: err.message });
        }
      } finally {
        runManager.remove(session.id);
        resp.end();
      }
      return;
    }

    // ── API: 审批响应 ────────────────────────────────
    if (pathname === '/api/approve' && method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const { toolCallId, approved } = body;
      const { registry } = await import('./approval.js');
      const ok = registry.resolve(toolCallId, approved);
      return sendJson(resp, { ok: true, resolved: ok });
    }

    // ── 静态文件服务 ────────────────────────────────
    if (method === 'GET') {
      let filePath;
      if (pathname === '/') {
        filePath = path.join(PUBLIC_DIR, 'index.html');
      } else {
        filePath = path.join(PUBLIC_DIR, pathname);
      }
      if (!filePath.startsWith(PUBLIC_DIR)) return sendError(resp, 403, '禁止访问');
      if (!fs.existsSync(filePath)) {
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

// ── 工具函数 ────────────────────────────────────────
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

/** 构建文件树 */
async function buildFileTree(sandbox, relPath, maxDepth = 4) {
  const absolute = sandbox.resolve(relPath);
  if (!fs.existsSync(absolute)) return null;
  const stat = fs.statSync(absolute);
  if (!stat.isFile()) {
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
    .filter((e) => e.name !== 'node_modules' && e.name !== '.git')
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

// ── 启动 ────────────────────────────────────────────
server.listen(PORT, '127.0.0.1', () => {
  console.log(`
╔══════════════════════════════════════════════╗
║         Mini Coding Agent / Mini DSH         ║
╠══════════════════════════════════════════════╣
║  服务器:  http://127.0.0.1:${PORT}              ║
║  仅限本机访问                                  ║
║  Workspace: ${DEFAULT_WORKSPACE.slice(0, 40).padEnd(40)}║
║  模型:    ${config.llm.model.slice(0, 40).padEnd(40)}║
╚══════════════════════════════════════════════╝
  `);
});

// 定期清理过期会话
setInterval(() => sessionManager.cleanup(), 10 * 60 * 1000);