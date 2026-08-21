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
  permissionMode: 'standard',
  runStatus: 'idle',
  timeline: [],
  runStartTime: null,
  approvals: { approved: 0, rejected: 0 },
  commands: [],
};

/* ── Init ──────────────────────────────────────────── */
async function init() {
  const cfg = await api('/api/config');
  if (cfg.localToken) localToken = cfg.localToken;
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

  // Permission Mode selector — 仅在 PATCH 成功后更新 UI
  $('#modeSelect').addEventListener('change', async (e) => {
    const newMode = e.target.value;
    if (state.sessionId) {
      try {
        const result = await api('/api/session', {
          method: 'PATCH',
          body: { sessionId: state.sessionId, permissionMode: newMode },
        });
        // Server 真值：只在成功后更新
        state.permissionMode = result.permissionMode;
        $('#modeSelect').value = result.permissionMode;
        updateModeLabel(result.permissionMode);
      } catch (err) {
        // 失败时恢复 UI 到 Server 真值
        $('#modeSelect').value = state.permissionMode;
        appendSystemMessage('❌ 切换权限模式失败: ' + err.message);
      }
    } else {
      state.permissionMode = newMode;
      updateModeLabel(newMode);
    }
  });

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
let localToken = null;

async function api(url, opts) {
  const headers = { 'Content-Type': 'application/json' };
  // Mutation 请求携带 CSRF token
  const method = (opts?.method || 'GET').toUpperCase();
  if (method !== 'GET' && localToken) {
    headers['X-Local-Token'] = localToken;
  }
  const res = await fetch(url, {
    method,
    headers,
    body: opts?.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function loadConfig() {
  try {
    const cfg = await api('/api/config');
    if (cfg.localToken) localToken = cfg.localToken;
    return cfg;
  } catch { return null; }
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

/* ── Run Net Diff 渲染 ──────────────────────────────── */
function renderNetDiff(netDiff) {
  const panel = $('#diffPanel');
  panel.innerHTML = '';

  if (!netDiff || netDiff.totalChanges === 0) {
    panel.innerHTML = '<div class="diff-empty">本轮无净变更</div>';
    return;
  }

  // 摘要
  const summary = document.createElement('div');
  summary.className = 'diff-summary';
  summary.textContent = `${netDiff.totalChanges} files changed`;
  panel.appendChild(summary);

  // 每个文件
  for (const file of netDiff.files) {
    const fileEl = document.createElement('div');
    fileEl.className = 'diff-file';

    const header = document.createElement('div');
    header.className = 'diff-file-header';

    const badge = file.type === 'create' ? 'A' : file.type === 'delete' ? 'D' : 'M';
    const badgeClass = file.type === 'create' ? 'create' : file.type === 'delete' ? 'delete' : 'modify';
    const stats = `+${file.added} -${file.removed}`;

    header.innerHTML = `
      <span class="badge ${badgeClass}">${badge}</span>
      <span>${escapeHtml(file.path)}</span>
      <span class="stats">${stats}</span>
    `;

    const body = document.createElement('div');
    body.className = 'diff-file-body';

    if (file.diff && file.diff.length > 0) {
      for (const line of file.diff) {
        const dl = document.createElement('div');
        dl.className = 'diff-line ' + line.type;
        dl.textContent = (line.type === 'add' ? '+' : '-') + ' ' + line.content;
        body.appendChild(dl);
      }
    } else if (file.type === 'create') {
      const dl = document.createElement('div');
      dl.className = 'diff-line add';
      dl.textContent = '+ (新建文件)';
      body.appendChild(dl);
    } else if (file.type === 'delete') {
      const dl = document.createElement('div');
      dl.className = 'diff-line remove';
      dl.textContent = '- (删除)';
      body.appendChild(dl);
    }

    fileEl.appendChild(header);
    fileEl.appendChild(body);
    header.addEventListener('click', () => {
      fileEl.classList.toggle('open');
    });
    fileEl.classList.add('open');
    panel.appendChild(fileEl);
  }
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
  state.runStartTime = Date.now();
  state.timeline = [];
  state.commands = [];
  state.approvals = { approved: 0, rejected: 0 };
  $('#sendBtn').disabled = true;
  $('#stopBtn').disabled = false;
  setStatus('running', 'running');

  if (!state.sessionId) {
    try {
      const data = await api('/api/session', {
        method: 'POST',
        body: { workspace: state.workspace, permissionMode: state.permissionMode },
      });
      state.sessionId = data.sessionId;
      // 使用 Server 返回的 permissionMode 真值
      if (data.permissionMode) {
        state.permissionMode = data.permissionMode;
        $('#modeSelect').value = data.permissionMode;
        updateModeLabel(data.permissionMode);
      }
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
      headers: {
        'Content-Type': 'application/json',
        ...(localToken ? { 'X-Local-Token': localToken } : {}),
      },
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
  // 关闭 Approval Modal
  $('#approvalModal').classList.remove('open');
  pendingApproval = null;

  if (state.sessionId) {
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
    case 'status':
      updateRunStatus(event.status, event.label, event.detail);
      break;
    case 'tool_call':
      addTimelineItem(event.toolCall, event.policy);
      break;
    case 'tool_result':
      updateTimelineItem(event.toolCall.id, event.result, event.toolCall.name);
      if (event.toolCall.name === 'run_command') {
        terminalWrite(event.toolCall.args.command, event.result);
      }
      break;
    case 'command_result':
      state.commands.push({
        command: event.command,
        exitCode: event.exitCode,
        duration: event.duration,
        stopped: event.stopped,
        timedOut: event.timedOut,
        terminationReason: event.terminationReason,
      });
      break;
    case 'approval_needed':
      addTimelineApproval(event);
      showApproval(event);
      break;
    case 'done':
      appendSystemMessage(`✅ 任务完成（${event.iteration} 轮）`);
      setStatus('done', 'done');
      break;
    case 'agent_done':
      if (event.result && event.result.changes) {
        renderNetDiff(event.result.changes);
      }
      renderCompletionSummary(event.result);
      break;
    case 'error':
      if (event.message && event.message.includes('取消')) {
        appendSystemMessage('🛑 ' + event.message);
        setStatus('cancelled', 'cancelled');
      } else {
        appendSystemMessage('❌ ' + event.message);
        setStatus('error', 'error');
      }
      break;
  }
}

/* ── Approval ───────────────────────────────────────── */
let pendingApproval = null;

function respondApproval(approved) {
  $('#approvalModal').classList.remove('open');
  if (pendingApproval) {
    const { runId, toolCallId } = pendingApproval;
    pendingApproval = null;
    api('/api/approve', {
      method: 'POST',
      body: { runId, toolCallId, approved },
    }).then(() => {
      // Server 确认成功后才计数
      if (approved) state.approvals.approved++;
      else state.approvals.rejected++;
    }).catch(() => {});
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

/* ── V0.4.0: Run Status ─────────────────────────────── */
function updateRunStatus(status, label, detail) {
  state.runStatus = status;
  const dot = $('#runStatus .status-dot');
  const text = $('#statusText');
  const detailEl = $('#statusDetail');
  dot.className = 'status-dot ' + status;
  text.textContent = label;
  detailEl.textContent = detail || '';
}

/* ── V0.4.0: Permission Mode ────────────────────────── */
function updateModeLabel(mode) {
  const labels = { safe: 'Safe', standard: 'Standard', full_access: 'Full Access' };
  $('.mode-label').textContent = labels[mode] || mode;
}

/* ── V0.4.0: Agent Activity Timeline ────────────────── */
function addTimelineItem(toolCall, policy) {
  const item = {
    id: toolCall.id,
    name: toolCall.name,
    args: toolCall.args,
    policy: policy || 'allow',
    status: 'running',
    startTime: Date.now(),
    result: null,
  };
  state.timeline.push(item);
  renderTimeline();
}

function updateTimelineItem(toolCallId, result, toolName) {
  const item = state.timeline.find((t) => t.id === toolCallId);
  if (!item) return;
  item.result = result;
  item.status = result.error ? 'error' : 'done';
  item.duration = Date.now() - item.startTime;
  renderTimeline();
}

function addTimelineApproval(event) {
  const item = {
    id: event.toolCall.id,
    name: event.toolCall.name,
    args: event.toolCall.args,
    policy: 'requireApproval',
    status: 'waiting',
    startTime: Date.now(),
    result: null,
  };
  state.timeline.push(item);
  renderTimeline();
}

function renderTimeline() {
  const container = $('#timeline');
  if (state.timeline.length === 0) {
    container.innerHTML = '';
    return;
  }
  container.innerHTML = '';
  for (const item of state.timeline) {
    const el = document.createElement('div');
    el.className = 'timeline-item' + (item.status === 'running' || item.status === 'waiting' ? '' : '');
    el.dataset.id = item.id;

    const icon = document.createElement('span');
    icon.className = 'ti-icon ' + item.status;
    icon.textContent = item.status === 'done' ? '✓' : item.status === 'error' ? '✕' : item.status === 'waiting' ? '⚠' : '●';
    el.appendChild(icon);

    const text = document.createElement('span');
    text.className = 'ti-text';

    if (item.name === 'run_command') {
      const cmd = document.createElement('div');
      cmd.className = 'ti-cmd';
      cmd.textContent = '$ ' + (item.args.command || '');
      text.appendChild(cmd);
    } else if (item.name === 'read_file') {
      const f = document.createElement('div');
      f.className = 'ti-file';
      f.textContent = '📄 ' + (item.args.path || '');
      text.appendChild(f);
    } else if (item.name === 'write_file') {
      const f = document.createElement('div');
      f.className = 'ti-file';
      f.textContent = '✏️ ' + (item.args.path || '');
      text.appendChild(f);
    } else if (item.name === 'edit_file') {
      const f = document.createElement('div');
      f.className = 'ti-file';
      f.textContent = '✏️ ' + (item.args.path || '');
      text.appendChild(f);
    } else if (item.name === 'search_files') {
      const f = document.createElement('div');
      f.className = 'ti-file';
      f.textContent = '🔍 ' + (item.args.pattern || '');
      text.appendChild(f);
    } else if (item.name === 'delete_file') {
      const f = document.createElement('div');
      f.className = 'ti-file';
      f.textContent = '🗑 ' + (item.args.path || '');
      text.appendChild(f);
    } else if (item.name === 'list_directory') {
      const f = document.createElement('div');
      f.className = 'ti-file';
      f.textContent = '📁 ' + (item.args.path || '.');
      text.appendChild(f);
    } else {
      text.textContent = item.name;
    }

    if (item.duration) {
      const dur = document.createElement('span');
      dur.className = 'ti-duration';
      dur.textContent = (item.duration / 1000).toFixed(1) + 's';
      text.appendChild(dur);
    }

    el.appendChild(text);

    // Expand button
    const expand = document.createElement('button');
    expand.className = 'ti-expand';
    expand.textContent = '>';
    expand.onclick = () => el.classList.toggle('open');
    el.appendChild(expand);

    // Details
    const details = document.createElement('div');
    details.className = 'timeline-details';
    let detailText = '';
    if (item.args && Object.keys(item.args).length > 0) {
      detailText += 'args: ' + JSON.stringify(item.args) + '\n';
    }
    if (item.result) {
      const rStr = JSON.stringify(item.result);
      detailText += 'result: ' + (rStr.length > 500 ? rStr.slice(0, 500) + '...' : rStr);
    }
    details.textContent = detailText;
    el.appendChild(details);

    container.appendChild(el);
  }
  container.scrollTop = container.scrollHeight;
}

/* ── V0.4.0: Completion Summary ─────────────────────── */
function renderCompletionSummary(result) {
  const container = $('#completionSummary');
  if (!result) {
    container.style.display = 'none';
    return;
  }

  const changes = result.changes || { files: [], totalChanges: 0 };
  const totalAdded = changes.files.reduce((s, f) => s + (f.added || 0), 0);
  const totalRemoved = changes.files.reduce((s, f) => s + (f.removed || 0), 0);

  let html = '<div class="cs-title">✓ 任务完成</div>';
  html += '<div class="cs-grid">';
  html += '<span class="cs-label">变更</span>';
  html += `<span class="cs-value">${changes.totalChanges} files · +${totalAdded} -${totalRemoved}</span>`;
  html += '<span class="cs-label">耗时</span>';
  html += `<span class="cs-value">${state.runStartTime ? ((Date.now() - state.runStartTime) / 1000).toFixed(1) + 's' : '—'}</span>`;
  html += '<span class="cs-label">审批</span>';
  html += `<span class="cs-value">${state.approvals.approved} approved · ${state.approvals.rejected} rejected</span>`;
  html += '</div>';

  // Verification evidence: 实际执行过的 command + exit status
  if (state.commands.length > 0) {
    html += '<div class="cs-section"><span class="cs-label">验证</span>';
    for (const cmd of state.commands) {
      const status = cmd.stopped ? '■ 停止' : cmd.timedOut ? '⏱ 超时' : cmd.exitCode === 0 ? '✓' : '✕';
      html += `<div class="cs-cmd">${status} ${escapeHtml(cmd.command)} ${cmd.exitCode !== null ? '(exit ' + cmd.exitCode + ')' : ''} ${cmd.duration ? (cmd.duration/1000).toFixed(1)+'s' : ''}</div>`;
    }
    html += '</div>';
  }

  if (result.finalContent) {
    html += '<div class="cs-summary">' + escapeHtml(result.finalContent).slice(0, 200) + '</div>';
  }

  container.innerHTML = html;
  container.style.display = 'block';
}

/* ── V0.4.0: Human-Readable Approval ────────────────── */
function showApproval(event) {
  pendingApproval = {
    runId: event.runId,
    toolCallId: event.toolCall.id,
    toolName: event.toolCall.name,
    args: event.toolCall.args,
    reason: event.reason,
    category: event.category,
    permissionMode: event.permissionMode,
  };

  const titleEl = $('#approvalTitle');
  const msgEl = $('#approvalMessage');
  const cmdEl = $('#approvalCommand');
  const reasonEl = $('#approvalReason');
  const catEl = $('#approvalCategory');

  const toolName = event.toolCall.name;
  const args = event.toolCall.args;

  if (toolName === 'run_command') {
    titleEl.textContent = '运行命令？';
    msgEl.textContent = 'Agent 即将执行以下 Shell 命令：';
    cmdEl.textContent = args.command || '';
    reasonEl.textContent = event.reason || '此操作可能产生破坏性影响，需要确认。';
  } else if (toolName === 'delete_file') {
    titleEl.textContent = '删除文件？';
    msgEl.textContent = '以下文件将被移出当前 workspace：';
    cmdEl.textContent = args.path || '';
    reasonEl.textContent = event.reason || '此操作不可撤销，需要确认。';
  } else if (toolName === 'write_file') {
    titleEl.textContent = '写入文件？';
    msgEl.textContent = 'Agent 即将写入以下文件：';
    cmdEl.textContent = args.path || '';
    reasonEl.textContent = event.reason || '此操作将修改 workspace 文件，需要确认。';
  } else if (toolName === 'edit_file') {
    titleEl.textContent = '修改文件？';
    msgEl.textContent = 'Agent 即将修改以下文件：';
    cmdEl.textContent = args.path || '';
    reasonEl.textContent = event.reason || '此操作将修改 workspace 文件，需要确认。';
  } else if (toolName && toolName.startsWith('git')) {
    titleEl.textContent = '修改 Git 状态？';
    msgEl.textContent = 'Agent 即将执行 Git 操作：';
    cmdEl.textContent = JSON.stringify(args);
    reasonEl.textContent = event.reason || '此操作将修改 Git 状态，需要确认。';
  } else {
    titleEl.textContent = '需要确认';
    msgEl.textContent = 'Agent 即将执行以下操作：';
    cmdEl.textContent = JSON.stringify(args);
    reasonEl.textContent = event.reason || '需要确认。';
  }

  catEl.textContent = event.category || '';
  $('#approvalModal').classList.add('open');
}

/* ── V0.4.0: Diff Viewer ────────────────────────────── */
function openDiffViewer(filePath, diff) {
  $('#diffFilePath').textContent = filePath;
  const body = $('#diffViewerBody');
  body.innerHTML = '';
  if (!diff || diff.length === 0) {
    body.innerHTML = '<div class="dv-line">无 diff 数据</div>';
    return;
  }
  for (const line of diff) {
    const dl = document.createElement('div');
    dl.className = 'dv-line ' + line.type;
    dl.textContent = (line.type === 'add' ? '+' : '-') + ' ' + (line.content || '');
    body.appendChild(dl);
  }
  $('#diffViewerModal').classList.add('open');
}

/* ── Init ───────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', init);