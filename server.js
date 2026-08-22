/**
 * server.js — Mini Coding Agent 主服务器
 *
 * V0.3 重构：
 * - 同源 CORS（不开放 localhost-wide）
 * - TrustedWorkspaceRegistry（workspace 授权需明确用户操作）
 * - WorkspaceFileService 统一文件访问
 * - Session Transcript 由 Agent Runner 提交（不从 UI Event 拼）
 * - Run-scoped Approval
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import url from 'url';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { runAgent } from './agent/index.js';
import { SessionManager } from './session.js';
import { loadConfig, saveFileConfig, maskApiKey } from './config.js';
import { WorkspaceFileService } from './fileservice.js';
import { runManager } from './runmanager.js';
import { registry as approvalRegistry } from './approval.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');

const config = loadConfig();
const PORT = config.port;
const DEFAULT_WORKSPACE = config.workspace;

const sessionManager = new SessionManager();

// ── Local Session Token（CSRF 防护）─────────────────
const LOCAL_SESSION_TOKEN = 'tok_' + crypto.randomBytes(16).toString('hex');

function validateMutation(req) {
  const v = validateRequest(req);
  if (!v.ok) return v;
  const token = req.headers['x-local-token'];
  if (!token || token !== LOCAL_SESSION_TOKEN) {
    return { ok: false, status: 403, reason: '缺少或无效的本地会话 token' };
  }
  return { ok: true };
}

// ── Trusted Workspace Registry ────────────────────────
class TrustedWorkspaceRegistry {
  constructor() {
    this.workspaces = new Map(); // path → { addedAt, source }
  }

  add(ws, source = 'user') {
    const abs = path.resolve(ws);
    this.workspaces.set(abs, { addedAt: Date.now(), source });
    return abs;
  }

  isTrusted(ws) {
    if (!ws) return false;
    const abs = path.resolve(ws);
    if (!path.isAbsolute(abs)) return false;
    if (this.workspaces.has(abs)) return true;
    // 仅当前项目目录下的 workspace 自动可信
    const projectRoot = path.resolve(process.cwd());
    if (abs === projectRoot || abs.startsWith(projectRoot + path.sep)) return true;
    return false;
  }

  remove(ws) {
    const abs = path.resolve(ws);
    this.workspaces.delete(abs);
  }

  list() {
    return Array.from(this.workspaces.entries()).map(([p, info]) => ({ path: p, ...info }));
  }
}

const workspaceRegistry = new TrustedWorkspaceRegistry();
// 初始化默认 workspace
workspaceRegistry.add(DEFAULT_WORKSPACE, 'default');

// ── CORS + Trust Boundary：严格同源，拒绝非预期 Origin ──
function validateRequest(req) {
  const origin = req.headers.origin;
  const host = req.headers.host;

  // 验证 Host（防止 DNS rebinding）
  const expectedHost = `127.0.0.1:${PORT}`;
  const expectedHostAlt = `localhost:${PORT}`;
  if (host && host !== expectedHost && host !== expectedHostAlt) {
    return { ok: false, status: 403, reason: `Host 验证失败: ${host}` };
  }

  // 验证 Origin（有 Origin 时必须同源）
  if (origin) {
    const serverOrigin = `http://127.0.0.1:${PORT}`;
    const serverOriginAlt = `http://localhost:${PORT}`;
    if (origin !== serverOrigin && origin !== serverOriginAlt) {
      return { ok: false, status: 403, reason: `Origin 验证失败: ${origin}` };
    }
  }

  return { ok: true };
}

function setSameOriginCORS(resp, req) {
  const origin = req.headers.origin;
  if (!origin) {
    // 无 Origin（curl、CLI、同源 fetch）— 允许
    return;
  }
  // 有 Origin：必须与服务器同源
  const serverOrigin = `http://127.0.0.1:${PORT}`;
  const serverOriginAlt = `http://localhost:${PORT}`;
  if (origin === serverOrigin || origin === serverOriginAlt) {
    resp.setHeader('Access-Control-Allow-Origin', origin);
    resp.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  // 其他 Origin：不设置 CORS 头，浏览器拦截
}

// ── HTTP Server ──────────────────────────────────────
const server = http.createServer(async (req, resp) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;
  const method = req.method;

  setSameOriginCORS(resp, req);

  if (method === 'OPTIONS') {
    resp.writeHead(200);
    resp.end();
    return;
  }

  try {
    // ── 全局请求验证（Host / Origin） ────────────────
    const validation = validateRequest(req);
    if (!validation.ok) {
      return sendError(resp, validation.status, validation.reason);
    }
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
        localToken: LOCAL_SESSION_TOKEN,
        trustedWorkspaces: workspaceRegistry.list(),
        testMode: process.env.E2E_FAKE_LLM === '1',
      });
    }

    if (pathname === '/api/config' && method === 'POST') {
      const mv = validateMutation(req);
      if (!mv.ok) return sendError(resp, mv.status, mv.reason);
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
      workspaceRegistry.add(merged.workspace, 'user');
      return sendJson(resp, { ok: true });
    }

    // ── API: 受信 workspace 管理 ──────────────────────
    if (pathname === '/api/workspaces' && method === 'GET') {
      return sendJson(resp, { workspaces: workspaceRegistry.list() });
    }

    if (pathname === '/api/workspaces' && method === 'POST') {
      const mv = validateMutation(req);
      if (!mv.ok) return sendError(resp, mv.status, mv.reason);
      const body = JSON.parse(await readBody(req));
      const { path: wsPath, action } = body;
      if (action === 'add') {
        workspaceRegistry.add(wsPath, 'user');
        return sendJson(resp, { ok: true, path: path.resolve(wsPath) });
      }
      if (action === 'remove') {
        workspaceRegistry.remove(wsPath);
        return sendJson(resp, { ok: true });
      }
      return sendError(resp, 400, '未知操作');
    }

    // ── API: 文件列表 ────────────────────────────────
    if (pathname === '/api/files' && method === 'GET') {
      const ws = parsedUrl.query.workspace || config.workspace;
      if (!workspaceRegistry.isTrusted(ws)) {
        return sendError(resp, 403, `不允许访问 workspace: ${ws}`);
      }
      const svc = new WorkspaceFileService(ws);
      const tree = svc.buildTree('.');
      return sendJson(resp, { workspace: ws, tree });
    }

    // ── API: 目录列表（Lazy Directory Loading）─────────
    if (pathname === '/api/files/list' && method === 'GET') {
      const ws = parsedUrl.query.workspace || config.workspace;
      const dirPath = parsedUrl.query.path || '.';
      if (!workspaceRegistry.isTrusted(ws)) {
        return sendError(resp, 403, `不允许访问 workspace: ${ws}`);
      }
      const svc = new WorkspaceFileService(ws);
      try {
        const dirEntry = svc.listDirectory(dirPath);
        return sendJson(resp, { path: dirPath, entries: dirEntry.entries });
      } catch (err) {
        return sendError(resp, 400, err.message);
      }
    }

    // ── API: 文件读取 ────────────────────────────────
    if (pathname === '/api/files/read' && method === 'GET') {
      const ws = parsedUrl.query.workspace || config.workspace;
      const filePath = parsedUrl.query.path;
      if (!filePath) return sendError(resp, 400, '缺少 path 参数');
      if (!workspaceRegistry.isTrusted(ws)) {
        return sendError(resp, 403, `不允许访问 workspace: ${ws}`);
      }
      const svc = new WorkspaceFileService(ws);
      try {
        const data = svc.readFile(filePath);
        return sendJson(resp, data);
      } catch (err) {
        const msg = err.message || '';
        let code = 'FILE_ERROR';
        if (msg.includes('敏感文件')) code = 'SENSITIVE_FILE';
        else if (msg.includes('二进制')) code = 'BINARY_FILE';
        else if (msg.includes('不存在')) code = 'FILE_NOT_FOUND';
        else if (msg.includes('不是文件')) code = 'NOT_A_FILE';
        else if (msg.includes('过大')) code = 'FILE_TOO_LARGE';
        resp.writeHead(400, { 'Content-Type': 'application/json' });
        resp.end(JSON.stringify({ error: { code, message: msg } }));
      }
    }

    // ── API: Session ─────────────────────────────────
    if (pathname === '/api/session' && method === 'POST') {
      const mv = validateMutation(req);
      if (!mv.ok) return sendError(resp, mv.status, mv.reason);
      const body = JSON.parse(await readBody(req));
      const ws = body.workspace || config.workspace;
      if (!workspaceRegistry.isTrusted(ws)) {
        return sendError(resp, 403, `不允许访问 workspace: ${ws}`);
      }
      const session = sessionManager.create(ws);
      // 接受客户端传入的 permissionMode（默认 Standard）
      if (body.permissionMode) {
        const { isValidMode } = await import('./permission.js');
        if (isValidMode(body.permissionMode)) {
          session.permissionMode = body.permissionMode;
        }
      }
      // 接受客户端传入的 title
      if (body.title) session.setTitle(body.title);
      return sendJson(resp, {
        sessionId: session.id,
        workspace: ws,
        permissionMode: session.permissionMode,
        title: session.title,
      });
    }

    // ── API: Session 列表 ─────────────────────────────
    if (pathname === '/api/sessions' && method === 'GET') {
      const ws = parsedUrl.query.workspace || config.workspace;
      const sessions = sessionManager.list(ws);
      return sendJson(resp, {
        sessions: sessions.map(s => ({
          id: s.id,
          title: s.title || 'New Session',
          workspace: s.workspace,
          permissionMode: s.permissionMode || 'standard',
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
        })),
      });
    }

    // ── API: 切换 Session ─────────────────────────────
    if (pathname === '/api/session/switch' && method === 'POST') {
      const mv = validateMutation(req);
      if (!mv.ok) return sendError(resp, mv.status, mv.reason);
      const body = JSON.parse(await readBody(req));
      const { sessionId } = body;
      const session = sessionManager.get(sessionId);
      if (!session) return sendError(resp, 404, '会话不存在');
      return sendJson(resp, {
        sessionId: session.id,
        permissionMode: session.permissionMode || 'standard',
        title: session.title || 'New Session',
        workspace: session.workspace,
        messages: session.messages,
      });
    }

    // ── API: 更新 Session Permission Mode ──────────────
    if (pathname === '/api/session' && method === 'PATCH') {
      const mv = validateMutation(req);
      if (!mv.ok) return sendError(resp, mv.status, mv.reason);
      const body = JSON.parse(await readBody(req));
      const { sessionId, permissionMode } = body;
      const session = sessionManager.get(sessionId);
      if (!session) return sendError(resp, 404, '会话不存在');
      // 校验合法 mode
      const { isValidMode } = await import('./permission.js');
      if (!isValidMode(permissionMode)) {
        return sendError(resp, 400, `非法的 Permission Mode: ${permissionMode}。合法值: safe, standard, full_access`);
      }
      session.permissionMode = permissionMode;
      return sendJson(resp, { ok: true, permissionMode: session.permissionMode });
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
        permissionMode: session.permissionMode || 'standard',
      });
    }

    // ── API: 停止当前运行 ────────────────────────────
    if (pathname === '/api/stop' && method === 'POST') {
      const mv = validateMutation(req);
      if (!mv.ok) return sendError(resp, mv.status, mv.reason);
      const body = JSON.parse(await readBody(req));
      const { sessionId } = body;
      const ok = runManager.stop(sessionId);
      return sendJson(resp, { ok, stopped: ok });
    }

    // ── SSE: 运行 Agent ──────────────────────────────
    if (pathname === '/api/run' && method === 'POST') {
      // ── Phase 1: 解析 + 验证（在写 SSE headers 之前）──
      const mv = validateMutation(req);
      if (!mv.ok) return sendError(resp, mv.status, mv.reason);
      const body = JSON.parse(await readBody(req));
      const { task, workspace, sessionId, config: clientConfig, title } = body;
      const ws = workspace || config.workspace;

      // 验证 workspace
      if (!workspaceRegistry.isTrusted(ws)) {
        return sendError(resp, 403, `不允许访问 workspace: ${ws}`);
      }

      // 验证 session（Session 与 Workspace 强绑定）
      let session;
      if (sessionId) {
        session = sessionManager.get(sessionId);
        if (session && session.workspace !== ws) {
          return sendError(resp, 409, `Session ${sessionId} 属于 workspace ${session.workspace}，不能用于 ${ws}。请切换 workspace 或创建新 Session。`);
        }
      }
      if (!session) {
        session = sessionManager.create(ws);
      }
      // P1: 第一条 task 自动设置 Session title（newSession() 创建的默认标题需被覆盖）
      if (task && session.title === 'New Session') {
        session.setTitle(title ? title.slice(0, 60) : task.slice(0, 60));
      }

      const llmConfig = clientConfig?.llm || config.llm;
      const finalConfig = {
        endpoint: llmConfig.endpoint || config.llm.endpoint,
        apiKey: llmConfig.apiKey && llmConfig.apiKey.length > 8 ? llmConfig.apiKey : config.llm.apiKey,
        model: llmConfig.model || config.llm.model,
      };

      // ── Phase 2: 所有验证通过，开始 SSE ──────────────
      resp.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      const sendEvent = (event) => {
        const data = JSON.stringify(event);
        resp.write(`data: ${data}\n\n`);
      };

      // 创建 ActiveRun（管理生命周期）
      const activeRun = runManager.create(session.id);
      const controller = activeRun.controller;

      // ── 统一 Run Identity：Server ActiveRun.runId 是唯一真值 ──
      // 所有实时 Event 通过 sendRunEvent 携带 runId，避免遗忘
      const sendRunEvent = (event) => {
        sendEvent({ ...event, runId: activeRun.runId });
      };

      // 第一个 Event：建立 Frontend Run Identity
      sendRunEvent({ type: 'run_started', runId: activeRun.runId });

      // ── Fake LLM Provider 注入（仅测试环境） ──────────
      let fakeProvider = null;
      if (process.env.E2E_FAKE_LLM === '1') {
        try {
          const mod = await import('./test/fake-llm.js');
          const scenarios = mod.E2E_SCENARIOS || {};
          fakeProvider = mod.createProvider(scenarios);
          console.error('[server] Fake LLM provider injected');
        } catch (err) {
          console.error('[server] Fake LLM import failed:', err.message);
        }
      }

      try {
        const result = await runAgent({
          task,
          workspace: ws,
          config: finalConfig,
          session,
          run: activeRun,
          onEvent: sendRunEvent,
          signals: { signal: controller.signal },
          provider: fakeProvider || undefined,
        });

        // ── 由 Agent Runner 提交真实 Transcript ──────
        // result.messages 是 canonical transcript（仅新增的 user + assistant + tool）
        for (const msg of result.messages) {
          session.addMessage(msg);
        }
        // 上下文裁剪
        session.prune();

        sendRunEvent({
          type: 'agent_done',
          result: {
            changes: result.changes,
            iteration: result.iteration,
            stopped: result.stopped,
          },
        });
      } catch (err) {
        console.error('[server] runAgent error:', err.message);
        console.error('[server] runAgent stack:', err.stack);
        if (activeRun.isStopped()) {
          sendRunEvent({ type: 'error', message: '任务被用户取消' });
        } else {
          sendRunEvent({ type: 'error', message: err.message });
        }
      } finally {
        runManager.remove(session.id, activeRun);
        resp.end();
      }
      return;
    }

    // ── API: 审批响应 ────────────────────────────────
    if (pathname === '/api/approve' && method === 'POST') {
      const mv = validateMutation(req);
      if (!mv.ok) return sendError(resp, mv.status, mv.reason);
      const body = JSON.parse(await readBody(req));
      const { runId, toolCallId, approved } = body;
      const ok = approvalRegistry.resolve(runId, toolCallId, approved);
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