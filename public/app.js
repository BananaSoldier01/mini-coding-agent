/* ── Mini Coding Agent — Frontend ───────────────────── */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const state = {
  sessionId: null,
  workspace: null,
  running: false,
  abortController: null,
  currentAssistant: null,
  currentThinking: null,
  changes: [],
  operations: [],
  terminalRunning: false,
};

/* ── Init ──────────────────────────────────────────── */
async function init() {
  const cfg = await api('/api/config');
  state.workspace = cfg.workspace;
  $('#wsPath').textContent = state.workspace;
  $('#cfgEndpoint').value = cfg.llm.endpoint || '';
  $('#cfgApiKey').value = '';
  $('#cfgModel').value = cfg.llm.model || '';
  $('#cfgWorkspace').value = cfg.workspace || '';

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

  $$('[data-close]').forEach((el) => el.addEventListener('click', closeConfig));

  $('#approveApproval').addEventListener('click', () => respondApproval(true));
  $('#rejectApproval').addEventListener('click', () => respondApproval(false));

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

  $$('.quick-start').forEach((btn) => {
    btn.addEventListener('click', () => {
      $('#chatInput').value = btn.dataset.task;
      sendMessage();
    });
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
      openFileViewer(node.path);
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

async function openFileViewer(relPath) {
  try {
    const data = await api(`/api/files/read?path=${encodeURIComponent(relPath)}`);
    $('#fvPath').textContent = relPath;
    $('#fvContent').textContent = data.content;
    $('#fileViewerModal').classList.add('open');
  } catch (err) {
    appendSystemMessage(`打开文件失败: ${err.message}`);
  }
}

/* ── Chat ───────────────────────────────────────────── */
function appendMessage(role, content) {
  const container = $('#chatMessages');
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
  bubble.innerHTML += escapeHtml(text);
  scrollToBottom();
}

function finalizeAssistant(content) {
  if (state.currentThinking) removeThinking();
  state.currentAssistant = null;
}

/* ── Compact Tool Call ──────────────────────────────── */
function addToolCall(toolCall) {
  const container = $('#chatMessages');
  const el = document.createElement('div');
  el.className = 'tool-call';
  el.id = 'tc-' + toolCall.id;

  // 生成紧凑摘要
  const summary = compactSummary(toolCall.name, toolCall.args);

  el.innerHTML = `
    <div class="tc-head">
      <span class="tc-name">${escapeHtml(toolCall.name)}</span>
      <span class="tc-summary">${escapeHtml(summary)}</span>
      <span class="tc-status running">●</span>
      <span class="tc-expand">▾</span>
    </div>
    <div class="tc-details">
      <div class="tc-args">${escapeHtml(JSON.stringify(toolCall.args, null, 2))}</div>
      <div class="tc-result"></div>
    </div>
  `;

  // 点击展开/折叠
  el.querySelector('.tc-head').addEventListener('click', () => {
    el.classList.toggle('expanded');
    el.querySelector('.tc-expand').textContent = el.classList.contains('expanded') ? '▴' : '▾';
  });

  container.appendChild(el);
  scrollToBottom();
}

function compactSummary(toolName, args) {
  switch (toolName) {
    case 'list_directory':
      return args.path || '.';
    case 'read_file':
      return args.path + (args.startLine ? `:${args.startLine}-${args.endLine || ''}` : '');
    case 'write_file':
      return (args.path || '') + (args.content ? ` (${Math.round(args.content.length / 1024)}KB)` : '');
    case 'edit_file':
      return (args.path || '') + ` +1 -1`;
    case 'search_files':
      return `"${args.pattern}"`;
    case 'delete_file':
      return (args.path || '');
    case 'run_command':
      return (args.command || '').slice(0, 60);
    default:
      return JSON.stringify(args).slice(0, 60);
  }
}

function setToolCallResult(toolCallId, result, toolName) {
  const el = document.getElementById('tc-' + toolCallId);
  if (!el) return;
  const status = el.querySelector('.tc-status');
  const resultEl = el.querySelector('.tc-result');

  if (result.error) {
    status.textContent = '●';
    status.className = 'tc-status error';
    resultEl.innerHTML = `<pre>${escapeHtml(result.error)}</pre>`;
  } else {
    status.textContent = '✓';
    status.className = 'tc-status done';
    const summary = compactResultSummary(toolName, result);
    resultEl.innerHTML = `<pre>${escapeHtml(summary)}</pre>`;
  }

  // 如果是文件修改，更新 diff 面板
  if (toolName === 'edit_file' || toolName === 'write_file' || toolName === 'delete_file') {
    if (result.path && !result.error) {
      addDiffFromResult(toolName, result);
    }
  }
}

function compactResultSummary(toolName, result) {
  if (result.error) return result.error;
  switch (toolName) {
    case 'run_command':
      const parts = [];
      if (result.exitCode !== undefined) parts.push(`exit=${result.exitCode}`);
      if (result.timedOut) parts.push('TIMEOUT');
      if (result.stdout) parts.push(result.stdout.slice(0, 200));
      if (result.stderr) parts.push('STDERR: ' + result.stderr.slice(0, 200));
      return parts.join('\n') || '(no output)';
    case 'read_file':
      return `${result.lines || 0} lines${result.hasMore ? ' (more…)' : ''}`;
    case 'search_files':
      return `${result.count} matches`;
    case 'list_directory':
      return `${result.count} entries`;
    default:
      return result.action || JSON.stringify(result).slice(0, 100);
  }
}

/* ── Diff ───────────────────────────────────────────── */
function addDiffFromResult(toolName, result) {
  const panel = $('#diffPanel');
  if ($('.diff-empty')) panel.innerHTML = '';

  // 更新摘要
  updateDiffSummary();

  const file = document.createElement('div');
  file.className = 'diff-file';

  const badge = toolName === 'write_file' ? (result.action === 'created' ? 'create' : 'modify') :
                 toolName === 'delete_file' ? 'delete' : 'modify';
  const header = document.createElement('div');
  header.className = 'diff-file-header';
  const stats = result.diff ? `${result.diff.filter(d=>d.type==='add').length}+/${result.diff.filter(d=>d.type==='remove').length}-` : '';
  header.innerHTML = `
    <span class="badge ${badge}">${badge}</span>
    <span>${escapeHtml(result.path)}</span>
    <span class="stats">${stats}</span>
  `;
  file.appendChild(header);

  const body = document.createElement('div');
  body.className = 'diff-file-body';

  if (result.diff && result.diff.length) {
    for (const line of result.diff) {
      const dl = document.createElement('div');
      dl.className = 'diff-line ' + line.type;
      dl.textContent = (line.type === 'add' ? '+' : '-') + ' ' + line.content;
      body.appendChild(dl);
    }
  } else if (toolName === 'write_file' && result.action === 'created') {
    const dl = document.createElement('div');
    dl.className = 'diff-line add';
    dl.textContent = '+ (新建文件)';
    body.appendChild(dl);
  } else if (toolName === 'delete_file') {
    const dl = document.createElement('div');
    dl.className = 'diff-line remove';
    dl.textContent = '- (删除)';
    body.appendChild(dl);
  }

  file.appendChild(body);
  header.addEventListener('click', () => {
    file.classList.toggle('open');
  });
  file.classList.add('open');

  panel.appendChild(file);
  state.changes.push({ type: badge, path: result.path });
}

function updateDiffSummary() {
  const existing = $('.diff-summary');
  const total = state.changes.length;
  const summary = `${total} files changed`;
  if (existing) {
    existing.textContent = summary;
  } else {
    const el = document.createElement('div');
    el.className = 'diff-summary';
    el.textContent = summary;
    $('#diffPanel').insertBefore(el, $('#diffPanel').firstChild);
  }
}

function clearDiff() {
  $('#diffPanel').innerHTML = '<div class="diff-empty">文件修改将在此显示</div>';
  state.changes = [];
}

/* ── Terminal ───────────────────────────────────────── */
function terminalWrite(cmd, result) {
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

  // 状态行
  const status = document.createElement('div');
  if (result.timedOut) {
    status.className = 't-timeout';
    status.textContent = `[timeout after ${result.duration || '?'}ms]`;
  } else if (result.stopped) {
    status.className = 't-killed';
    status.textContent = `[killed]`;
  } else if (result.exitCode !== undefined) {
    status.className = result.exitCode === 0 ? 't-sys' : 't-sys';
    status.textContent = `[exit: ${result.exitCode}]`;
  }
  if (result.duration) {
    status.textContent += `  ${result.duration}ms`;
  }
  body.appendChild(status);

  body.scrollTop = body.scrollHeight;
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

  const welcome = $('.welcome');
  if (welcome) welcome.remove();

  appendMessage('user', escapeHtml(task));
  state.running = true;
  $('#sendBtn').disabled = true;
  $('#stopBtn').disabled = false;
  setStatus('running', 'running');

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

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

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
        const t = line.trim();
        if (!t || !t.startsWith('data: ')) continue;
        const data = t.slice(6);
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
  if (state.sessionId) {
    // 通知后端停止
    api('/api/stop', {
      method: 'POST',
      body: { sessionId: state.sessionId },
    }).catch(() => {});
  }
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
      break;
    case 'tool_call':
      addToolCall(event.toolCall);
      break;
    case 'tool_result':
      setToolCallResult(event.toolCall.id, event.result, event.toolCall.name);
      if (event.toolCall.name === 'run_command') {
        terminalWrite(event.toolCall.args.command, event.result);
      }
      break;
    case 'approval_needed':
      showApproval(event);
      break;
    case 'done':
      appendSystemMessage(`✅ 任务完成（${event.iteration} 轮）`);
      setStatus('done', 'done');
      break;
    case 'agent_done':
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
  $('#approvalReason').textContent = event.reason || 'Agent 即将执行此操作';
  $('#approvalModal').classList.add('open');
}

function respondApproval(approved) {
  $('#approvalModal').classList.remove('open');
  if (pendingApproval) {
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
    await api('/api/config', { method: 'POST', body: cfg });
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