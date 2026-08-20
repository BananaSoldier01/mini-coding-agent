/* ── Mini Coding Agent — Frontend ───────────────────── */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const state = {
  sessionId: null,
  workspace: null,
  running: false,
  abortController: null,
  currentAssistant: null,    // 当前 assistant 消息元素
  currentThinking: null,     // 当前 thinking 指示
  lastToolCallId: null,
  changes: [],               // 所有文件变更
  operations: [],            // 操作历史
};

/* ── Init ──────────────────────────────────────────── */
async function init() {
  // 加载配置
  const cfg = await api('/api/config');
  state.workspace = cfg.workspace;
  $('#wsPath').textContent = state.workspace;
  $('#cfgEndpoint').value = cfg.llm.endpoint || '';
  $('#cfgApiKey').value = '';
  $('#cfgModel').value = cfg.llm.model || '';
  $('#cfgWorkspace').value = cfg.workspace || '';

  // 加载文件树
  loadFileTree();

  // 事件绑定
  $('#sendBtn').addEventListener('click', sendMessage);
  $('#stopBtn').addEventListener('click', stopTask);
  $('#configBtn').addEventListener('click', openConfig);
  $('#refreshTree').addEventListener('click', loadFileTree);
  $('#clearTerminal').addEventListener('click', () => { $('#terminalBody').innerHTML = ''; });
  $('#toggleTerminal').addEventListener('click', toggleTerminal);
  $('#clearDiff').addEventListener('click', clearDiff);
  $('#saveConfig').addEventListener('click', saveConfig);

  // 配置弹窗关闭
  $$('[data-close]').forEach((el) => el.addEventListener('click', closeConfig));

  // 审批弹窗
  $('#approveApproval').addEventListener('click', () => respondApproval(true));
  $('#rejectApproval').addEventListener('click', () => respondApproval(false));

  // 输入框自动高度
  const input = $('#chatInput');
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // 快捷示例
  $$('.quick-start').forEach((btn) => {
    btn.addEventListener('click', () => {
      $('#chatInput').value = btn.dataset.task;
      sendMessage();
    });
  });

  // 回车聚焦到输入框（除非在终端）
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && document.activeElement !== $('#chatInput')) {
      // ignore
    }
  });
}

/* ── API ───────────────────────────────────────────── */
async function api(url, opts) {
  const res = await fetch(url, {
    method: opts?.method || 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: opts?.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/* ── File Tree ─────────────────────────────────────── */
async function loadFileTree() {
  try {
    const data = await api('/api/files');
    state.workspace = data.workspace;
    $('#wsPath').textContent = data.workspace;
    $('#fileTree').innerHTML = '';
    $('#fileTree').appendChild(renderTree(data.tree));
  } catch (err) {
    $('#fileTree').innerHTML = `<div class="tree-empty">加载失败: ${err.message}</div>`;
  }
}

function renderTree(node, depth = 0) {
  if (!node) return document.createDocumentFragment();
  const frag = document.createDocumentFragment();
  const el = document.createElement('div');
  el.className = 'tree-node';

  const row = document.createElement('div');
  row.className = 'tree-row';
  row.style.paddingLeft = (8 + depth * 14) + 'px';

  const toggle = document.createElement('span');
  toggle.className = 'toggle' + (node.children?.length ? '' : ' empty');
  toggle.textContent = node.children?.length ? '▸' : '';

  const icon = document.createElement('span');
  icon.className = 'icon';
  icon.textContent = node.type === 'directory' ? '📁' : '📄';

  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = node.name;

  row.appendChild(toggle);
  row.appendChild(icon);
  row.appendChild(name);
  el.appendChild(row);

  if (node.type === 'file') {
    row.addEventListener('click', () => {
      $$('.tree-row').forEach((r) => r.classList.remove('selected'));
      row.classList.add('selected');
      openFileInEditor(node.path);
    });
  } else if (node.children?.length) {
    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      const children = el.querySelector('.tree-children');
      if (children) {
        const hidden = children.style.display === 'none';
        children.style.display = hidden ? '' : 'none';
        toggle.textContent = hidden ? '▾' : '▸';
      }
    });
    // 默认展开根目录
    const children = document.createElement('div');
    children.className = 'tree-children';
    children.style.display = depth === 0 ? '' : 'none';
    if (depth === 0) toggle.textContent = '▾';
    node.children.forEach((c) => children.appendChild(renderTree(c, depth + 1)));
    el.appendChild(children);
  }

  frag.appendChild(el);
  return frag;
}

async function openFileInEditor(relPath) {
  // 简单实现：在 chat 中显示文件内容
  // 后续可扩展为独立编辑器
  try {
    const data = await api(`/api/files/read?path=${encodeURIComponent(relPath)}`);
    appendSystemMessage(`已打开: ${relPath}\n\n${data.content}`);
  } catch (err) {
    appendSystemMessage(`打开文件失败: ${err.message}`);
  }
}

/* ── Chat ───────────────────────────────────────────── */
function appendMessage(role, content) {
  const container = $('#chatMessages');
  // 如果是 assistant 且已有正在进行的，复用
  const msg = document.createElement('div');
  msg.className = `msg ${role}`;
  msg.innerHTML = `
    <div class="avatar">${role === 'user' ? 'U' : 'A'}</div>
    <div class="bubble">${content}</div>
  `;
  container.appendChild(msg);
  scrollToBottom();
  return msg;
}

function appendSystemMessage(content) {
  const container = $('#chatMessages');
  const msg = document.createElement('div');
  msg.className = 'msg assistant';
  msg.innerHTML = `<div class="avatar" style="color:var(--text-faint)">!</div><div class="bubble" style="color:var(--text-dim);font-size:12px">${escapeHtml(content)}</div>`;
  container.appendChild(msg);
  scrollToBottom();
}

function showThinking() {
  const container = $('#chatMessages');
  state.currentThinking = document.createElement('div');
  state.currentThinking.className = 'msg assistant';
  state.currentThinking.innerHTML = `<div class="avatar">A</div><div class="bubble"><div class="thinking">思考中…</div></div>`;
  container.appendChild(state.currentThinking);
  scrollToBottom();
}

function removeThinking() {
  if (state.currentThinking) {
    state.currentThinking.remove();
    state.currentThinking = null;
  }
}

function startAssistantMessage() {
  const container = $('#chatMessages');
  state.currentAssistant = document.createElement('div');
  state.currentAssistant.className = 'msg assistant';
  state.currentAssistant.innerHTML = `<div class="avatar">A</div><div class="bubble"></div>`;
  container.appendChild(state.currentAssistant);
  scrollToBottom();
}

function appendToken(text) {
  if (!state.currentAssistant) startAssistantMessage();
  const bubble = state.currentAssistant.querySelector('.bubble');
  // 简单的 markdown 渲染
  bubble.innerHTML += escapeHtml(text);
  scrollToBottom();
}

function finalizeAssistant(content) {
  if (state.currentThinking) removeThinking();
  if (state.currentAssistant) {
    state.currentAssistant = null;
  }
}

/* ── Tool Call UI ───────────────────────────────────── */
function addToolCall(toolCall) {
  const container = $('#chatMessages');
  const el = document.createElement('div');
  el.className = 'tool-call';
  el.id = 'tc-' + toolCall.id;
  const argsStr = JSON.stringify(toolCall.args, null, 2);
  el.innerHTML = `
    <div class="tc-head">
      <span class="tc-name">${escapeHtml(toolCall.name)}</span>
      <span class="tc-status running">running</span>
    </div>
    <div class="tc-args">${escapeHtml(argsStr)}</div>
    <div class="tc-result" style="display:none"></div>
  `;
  container.appendChild(el);
  addOperation(toolCall);
  scrollToBottom();
}

function setToolCallResult(toolCallId, result, toolName) {
  const el = document.getElementById('tc-' + toolCallId);
  if (!el) return;
  const status = el.querySelector('.tc-status');
  const resultEl = el.querySelector('.tc-result');
  if (result.error) {
    status.textContent = 'error';
    status.className = 'tc-status error';
    resultEl.innerHTML = `<pre>${escapeHtml(result.error)}</pre>`;
  } else {
    status.textContent = 'done';
    status.className = 'tc-status done';
    const summary = summarizeResult(result);
    resultEl.innerHTML = `<pre>${escapeHtml(summary)}</pre>`;
  }
  resultEl.style.display = '';
  updateOperation(toolCallId, result);

  // 如果是文件修改操作，添加到 diff 面板
  if (toolName === 'edit_file' || toolName === 'write_file' || toolName === 'delete_file') {
    if (result.path && !result.error) {
      addDiffFromResult(toolName, result);
    }
  }
}

function addDiffFromResult(toolName, result) {
  const panel = $('#diffPanel');
  if ($('.diff-empty')) panel.innerHTML = '';

  const file = document.createElement('div');
  file.className = 'diff-file';

  const badge = toolName === 'write_file' ? (result.action === 'created' ? 'create' : 'modify') :
                 toolName === 'delete_file' ? 'delete' : 'modify';
  const header = document.createElement('div');
  header.className = 'diff-file-header';
  header.innerHTML = `<span class="badge ${badge}">${badge}</span><span>${escapeHtml(result.path)}</span>`;
  file.appendChild(header);

  if (result.diff && result.diff.length) {
    for (const line of result.diff) {
      const dl = document.createElement('div');
      dl.className = 'diff-line ' + line.type;
      dl.textContent = (line.type === 'add' ? '+' : '-') + ' ' + line.content;
      file.appendChild(dl);
    }
  } else if (toolName === 'write_file' && result.action === 'created') {
    const dl = document.createElement('div');
    dl.className = 'diff-line add';
    dl.textContent = '+ (新建文件, ' + result.size + ' bytes)';
    file.appendChild(dl);
  } else if (toolName === 'delete_file') {
    const dl = document.createElement('div');
    dl.className = 'diff-line remove';
    dl.textContent = '- (删除)';
    file.appendChild(dl);
  } else if (toolName === 'edit_file') {
    const dl = document.createElement('div');
    dl.className = 'diff-line add';
    dl.textContent = '+ (已修改)';
    file.appendChild(dl);
  }

  panel.appendChild(file);
  state.changes.push({ type: badge, path: result.path });
}

function summarizeResult(result) {
  if (result.error) return result.error;
  const keys = Object.keys(result);
  if (keys.length === 0) return '(无返回)';
  // 选取关键字段
  const important = ['path', 'action', 'exitCode', 'stdout', 'stderr', 'content', 'count', 'entries', 'lines', 'size'];
  const lines = [];
  for (const k of important) {
    if (k in result) {
      let v = result[k];
      if (typeof v === 'string' && v.length > 200) v = v.slice(0, 200) + '\n…';
      lines.push(`${k}: ${v}`);
    }
  }
  return lines.join('\n') || JSON.stringify(result).slice(0, 200);
}

/* ── Operations ─────────────────────────────────────── */
function addOperation(toolCall) {
  const panel = $('#opsPanel');
  if ($('.ops-empty')) panel.innerHTML = '';
  const el = document.createElement('div');
  el.className = 'ops-item';
  el.id = 'op-' + toolCall.id;
  const icon = toolCall.name === 'run_command' ? '⚡' :
               toolCall.name.startsWith('write') ? '✏️' :
               toolCall.name.startsWith('read') ? '📄' :
               toolCall.name === 'search_files' ? '🔍' :
               toolCall.name === 'list_directory' ? '📁' :
               toolCall.name === 'delete_file' ? '🗑' : '⚙';
  el.innerHTML = `
    <span class="oi-icon">${icon}</span>
    <div style="flex:1">
      <div class="oi-name">${escapeHtml(toolCall.name)}</div>
      <div class="oi-detail">${escapeHtml(JSON.stringify(toolCall.args).slice(0, 80))}</div>
    </div>
    <span class="oi-time">—</span>
  `;
  panel.appendChild(el);
}

function updateOperation(toolCallId, result) {
  const el = document.getElementById('op-' + toolCallId);
  if (!el) return;
  const time = el.querySelector('.oi-time');
  time.textContent = 'just now';
  const detail = el.querySelector('.oi-detail');
  if (result.error) {
    detail.textContent = '失败: ' + result.error.slice(0, 60);
    detail.style.color = 'var(--red)';
  } else {
    detail.textContent = summarizeResult(result).slice(0, 80);
    detail.style.color = 'var(--text-dim)';
  }
}

/* ── Diff ───────────────────────────────────────────── */
function addDiff(change) {
  const panel = $('#diffPanel');
  if ($('.diff-empty')) panel.innerHTML = '';

  const file = document.createElement('div');
  file.className = 'diff-file';

  const badge = change.type === 'create' ? 'create' : change.type === 'delete' ? 'delete' : 'modify';
  const header = document.createElement('div');
  header.className = 'diff-file-header';
  header.innerHTML = `<span class="badge ${badge}">${badge}</span><span>${escapeHtml(change.path)}</span>`;
  file.appendChild(header);

  if (change.diff && change.diff.length) {
    for (const line of change.diff) {
      const dl = document.createElement('div');
      dl.className = 'diff-line ' + line.type;
      dl.textContent = (line.type === 'add' ? '+' : '-') + ' ' + line.content;
      file.appendChild(dl);
    }
  } else if (change.type === 'create') {
    const dl = document.createElement('div');
    dl.className = 'diff-line add';
    dl.textContent = '+ (新建文件)';
    file.appendChild(dl);
  } else if (change.type === 'delete') {
    const dl = document.createElement('div');
    dl.className = 'diff-line remove';
    dl.textContent = '- (删除)';
    file.appendChild(dl);
  }

  panel.appendChild(file);
  state.changes.push(change);
}

function clearDiff() {
  $('#diffPanel').innerHTML = '<div class="diff-empty">文件修改将在此显示</div>';
  state.changes = [];
}

/* ── Terminal ───────────────────────────────────────── */
function terminalWrite(cmd, result) {
  // 自动展开终端
  const panel = $('#terminalPanel');
  if (panel.classList.contains('collapsed')) {
    panel.classList.remove('collapsed');
    $('#toggleTerminal').textContent = '─';
  }
  const body = $('#terminalBody');
  const line = document.createElement('div');
  line.innerHTML = `<span class="t-cmd">$ ${escapeHtml(cmd)}</span>`;
  body.appendChild(line);

  if (result.stdout) {
    const out = document.createElement('div');
    out.className = 't-out';
    out.textContent = result.stdout;
    body.appendChild(out);
  }
  if (result.stderr) {
    const err = document.createElement('div');
    err.className = 't-err';
    err.textContent = result.stderr;
    body.appendChild(err);
  }
  if (result.exitCode !== undefined && result.exitCode !== 0) {
    const sys = document.createElement('div');
    sys.className = 't-sys';
    sys.textContent = `[exit: ${result.exitCode}]`;
    body.appendChild(sys);
  }
  body.scrollTop = body.scrollHeight;
}

function clearTerminal() {
  $('#terminalBody').innerHTML = '';
}

function toggleTerminal() {
  const panel = $('#terminalPanel');
  panel.classList.toggle('collapsed');
  $('#toggleTerminal').textContent = panel.classList.contains('collapsed') ? '+' : '─';
}

/* ── Status ─────────────────────────────────────────── */
function setStatus(status, text) {
  const dot = $('#statusIndicator .status-dot');
  const txt = $('#statusIndicator .status-text');
  dot.className = 'status-dot ' + status;
  txt.textContent = text;
}

/* ── Send Message ───────────────────────────────────── */
async function sendMessage() {
  const input = $('#chatInput');
  const task = input.value.trim();
  if (!task || state.running) return;

  input.value = '';
  input.style.height = 'auto';

  // 隐藏欢迎界面
  const welcome = $('.welcome');
  if (welcome) welcome.remove();

  // 添加用户消息
  appendMessage('user', escapeHtml(task));
  state.running = true;
  $('#sendBtn').disabled = true;
  $('#stopBtn').disabled = false;
  setStatus('running', 'running');

  // 创建或获取 session
  if (!state.sessionId) {
    try {
      const data = await api('/api/session', {
        method: 'POST',
        body: { workspace: state.workspace },
      });
      state.sessionId = data.sessionId;
    } catch (err) {
      appendSystemMessage('创建会话失败: ' + err.message);
      state.running = false;
      $('#sendBtn').disabled = false;
      $('#stopBtn').disabled = true;
      return;
    }
  }

  // 连接 SSE
  const controller = new AbortController();
  state.abortController = controller;

  try {
    const res = await fetch('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        task,
        workspace: state.workspace,
        sessionId: state.sessionId,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

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

        let event;
        try { event = JSON.parse(data); } catch { continue; }

        handleEvent(event);
      }
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      appendSystemMessage('任务已停止。');
    } else {
      appendSystemMessage('运行出错: ' + err.message);
    }
  } finally {
    state.running = false;
    $('#sendBtn').disabled = false;
    $('#stopBtn').disabled = true;
    setStatus('idle', 'idle');
    state.currentAssistant = null;
    state.currentThinking = null;
  }
}

function stopTask() {
  if (state.abortController) {
    state.abortController.abort();
  }
}

/* ── Event Handler ──────────────────────────────────── */
function handleEvent(event) {
  switch (event.type) {
    case 'assistant_start':
      startAssistantMessage();
      break;
    case 'token':
      appendToken(event.content);
      break;
    case 'assistant_end':
      finalizeAssistant(event.content);
      break;
    case 'iteration':
      // 可以显示迭代次数，这里简化
      break;
    case 'tool_call':
      addToolCall(event.toolCall);
      break;
    case 'tool_result':
      setToolCallResult(event.toolCall.id, event.result, event.toolCall.name);
      // 如果是 run_command，写入终端
      if (event.toolCall.name === 'run_command') {
        terminalWrite(event.toolCall.args.command, event.result);
      }
      break;
    case 'approval_needed':
      showApproval(event);
      break;
    case 'done':
      if (state.currentAssistant) {
        // 已经在流式中
      }
      appendSystemMessage(`✅ 任务完成（${event.iteration} 轮）`);
      setStatus('done', 'done');
      break;
    case 'agent_done':
      if (event.result?.changes) {
        // changes 已在工具执行时添加
      }
      break;
    case 'error':
      appendSystemMessage('❌ ' + event.message);
      setStatus('error', 'error');
      break;
  }
}

/* ── Approval ───────────────────────────────────────── */
let pendingApproval = null;

function showApproval(event) {
  pendingApproval = event;
  $('#approvalCommand').textContent = event.toolCall.args.command || JSON.stringify(event.toolCall.args);
  $('#approvalModal').classList.add('open');
}

function respondApproval(approved) {
  $('#approvalModal').classList.remove('open');
  if (pendingApproval) {
    // 发送审批结果到后端
    api('/api/approve', {
      method: 'POST',
      body: { toolCallId: pendingApproval.toolCall.id, approved },
    }).catch(() => {});
    pendingApproval = null;
  }
}

/* ── Config Modal ───────────────────────────────────── */
function openConfig() {
  $('#configModal').classList.add('open');
}

function closeConfig() {
  $('#configModal').classList.remove('open');
}

async function saveConfig() {
  const cfg = {
    llm: {
      endpoint: $('#cfgEndpoint').value,
      apiKey: $('#cfgApiKey').value,
      model: $('#cfgModel').value,
    },
    workspace: $('#cfgWorkspace').value,
  };
  try {
    await api('/api/config', {
      method: 'POST',
      body: cfg,
    });
    state.workspace = cfg.workspace;
    $('#wsPath').textContent = cfg.workspace;
    loadFileTree();
    closeConfig();
    appendSystemMessage('配置已保存。');
  } catch (err) {
    appendSystemMessage('保存配置失败: ' + err.message);
  }
}

/* ── Utils ──────────────────────────────────────────── */
function escapeHtml(s) {
  if (s === undefined || s === null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function scrollToBottom() {
  const container = $('#chatMessages');
  container.scrollTop = container.scrollHeight;
}

/* ── Init ───────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', init);