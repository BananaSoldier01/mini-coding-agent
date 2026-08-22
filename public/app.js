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
  // Inspector state
  inspectorTab: 'changes',
  fvView: 'current',
  fvPath: null,
  fvContent: null,
  fvDiff: null,
  // Explorer state
  expandedDirs: new Set(),
  selectedFile: null,
  fileTreeData: null,
  // Run identity
  activeRunId: null,
};

/* ── Inspector ─────────────────────────────────────── */

function switchInspectorTab(tab) {
  state.inspectorTab = tab;
  $$('.inspector-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === tab);
  });
  $('#inspectorChanges').style.display = tab === 'changes' ? '' : 'none';
  $('#inspectorFile').style.display = tab === 'file' ? '' : 'none';
}

function switchFvView(view) {
  state.fvView = view;
  $$('.fv-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.fv === view);
  });
  renderFvBody();
}

async function openFileCurrent(relPath) {
  state.fvPath = relPath;
  state.fvView = 'current';
  $$('.fv-tab').forEach(t => t.classList.toggle('active', t.dataset.fv === 'current'));
  $('#fvPath').textContent = relPath;
  const body = $('#fvBody');
  body.innerHTML = '<div class="fv-loading">Loading…</div>';
  switchInspectorTab('file');

  try {
    const data = await api(`/api/files/read?path=${encodeURIComponent(relPath)}`);
    state.fvContent = data.content;
    state.fvPath = data.path;
    $('#fvPath').textContent = data.path;
    renderFvBody();
  } catch (err) {
    let html;
    if (err instanceof ApiError) {
      switch (err.code) {
        case 'BINARY_FILE':
          html = '<div class="fv-error">Binary file preview is not supported.</div>';
          break;
        case 'SENSITIVE_FILE':
          html = '<div class="fv-error">Sensitive file — access denied.</div>';
          break;
        case 'FILE_TOO_LARGE':
          html = '<div class="fv-error">File is too large for full preview.<br>Use Agent range reading for this file.</div>';
          break;
        case 'FILE_NOT_FOUND':
          html = '<div class="fv-error">File no longer exists.</div>';
          break;
        case 'NOT_A_FILE':
          html = '<div class="fv-error">Not a regular file.</div>';
          break;
        default:
          html = '<div class="fv-error">Unable to open file: ' + escapeHtml(err.message) + '</div>';
      }
    } else {
      html = '<div class="fv-error">Unable to open file: ' + escapeHtml(err.message) + '</div>';
    }
    body.innerHTML = html;
  }
}

function openFileDiff(relPath) {
  state.fvPath = relPath;
  state.fvView = 'diff';
  $$('.fv-tab').forEach(t => t.classList.toggle('active', t.dataset.fv === 'diff'));
  $('#fvPath').textContent = relPath;
  switchInspectorTab('file');

  // 从当前 Run Net Diff 中查找该文件
  const diff = state.changes.find(c => c.path === relPath);
  if (!diff) {
    $('#fvBody').innerHTML = '<div class="fv-empty">No changes in this run for this file</div>';
    return;
  }

  const before = diff.before || '';
  const after = diff.after || '';

  if (diff.type === 'delete') {
    $('#fvBody').innerHTML = `
      <div class="fv-empty">
        File deleted in this run<br>
        <button class="btn btn-ghost" id="viewDiffBtn" style="margin-top:8px">View Diff</button>
      </div>`;
    $('#viewDiffBtn').addEventListener('click', () => renderDiffView(before, after, relPath));
    return;
  }

  renderDiffView(before, after, relPath);
}

function renderDiffView(before, after, path) {
  const lines = unifiedDiffLines(before, after);
  const body = $('#fvBody');
  if (lines.length === 0) {
    body.innerHTML = '<div class="fv-diff-empty">No changes in this run</div>';
    return;
  }
  let html = '<div class="fv-diff-container">';
  for (const line of lines) {
    const cls = line.type === 'added' ? 'added' : line.type === 'removed' ? 'removed' : '';
    html += '<div class="fv-diff-line ' + cls + '">' + escapeHtml(line.text) + '</div>';
  }
  html += '</div>';
  body.innerHTML = html;
}

function renderFvBody() {
  const body = $('#fvBody');
  if (state.fvView === 'current') {
    if (state.fvContent === null) {
      body.innerHTML = '<div class="fv-empty">Select a file or change to inspect</div>';
      return;
    }
    const lines = state.fvContent.split('\n');
    let html = '<div class="fv-content">';
    for (let i = 0; i < lines.length; i++) {
      html += '<div class="fv-line"><span class="fv-line-num">' + (i + 1) + '</span><span class="fv-line-content">' + escapeHtml(lines[i]) + '</span></div>';
    }
    html += '</div>';
    body.innerHTML = html;
  } else if (state.fvView === 'diff') {
    const diff = state.changes.find(c => c.path === state.fvPath);
    if (!diff) {
      body.innerHTML = '<div class="fv-empty">No changes in this run</div>';
      return;
    }
    renderDiffView(diff.before || '', diff.after || '', state.fvPath);
  }
}

/* ── Unified Diff Lines ────────────────────────────── */
function unifiedDiffLines(before, after) {
  const beforeLines = before ? before.split('\n') : [];
  const afterLines = after ? after.split('\n') : [];
  const result = [];
  const m = beforeLines.length;
  const n = afterLines.length;
  const dp = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (beforeLines[i] === afterLines[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
      else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (beforeLines[i] === afterLines[j]) {
      result.push({ type: 'context', text: '  ' + beforeLines[i] });
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      result.push({ type: 'removed', text: '- ' + beforeLines[i] });
      i++;
    } else {
      result.push({ type: 'added', text: '+ ' + afterLines[j] });
      j++;
    }
  }
  while (i < m) { result.push({ type: 'removed', text: '- ' + beforeLines[i] }); i++; }
  while (j < n) { result.push({ type: 'added', text: '+ ' + afterLines[j] }); j++; }
  return result;
}

/* ── Explorer ──────────────────────────────────────── */

function toggleDir(path) {
  if (state.expandedDirs.has(path)) state.expandedDirs.delete(path);
  else state.expandedDirs.add(path);
  renderFileTree();
}

function selectFile(path) {
  state.selectedFile = path;
  renderFileTree();
}

function renderFileTree() {
  const container = $('#fileTree');
  if (!state.fileTreeData) {
    container.innerHTML = '<div class="tree-empty">加载中…</div>';
    return;
  }
  const html = renderTreeNode(state.fileTreeData, 0);
  container.innerHTML = html;
}

function renderTreeNode(node, depth) {
  if (!node) return '';
  // Sort: directories first, then files, alphabetically
  const entries = (node.children || []).sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  let html = '';
  const isExpanded = state.expandedDirs.has(node.path);
  const hasChildren = entries.length > 0;

  // Row for this node (skip root)
  if (node.path !== '.' && node.path !== '') {
    const isSelected = state.selectedFile === node.path;
    const badge = getChangeBadge(node.path);
    const chevron = node.type === 'directory'
      ? (isExpanded ? '▼' : '▶')
      : '';
    const icon = node.type === 'directory'
      ? (isExpanded ? '📁' : '📁')
      : '📄';

    html += '<div class="tree-row' + (isSelected ? ' selected' : '') + '" data-path="' + escapeHtml(node.path) + '" data-type="' + node.type + '">';
    if (node.type === 'directory') {
      html += '<span class="tree-chevron" data-toggle="' + escapeHtml(node.path) + '">' + chevron + '</span>';
    } else {
      html += '<span class="tree-chevron"></span>';
    }
    html += '<span class="tree-icon">' + icon + '</span>';
    html += '<span class="tree-name">' + escapeHtml(node.name) + '</span>';
    if (badge) html += '<span class="tree-badge ' + badge.cls + '">' + badge.text + '</span>';
    html += '</div>';
  }

  // Children
  if (hasChildren && (isExpanded || node.path === '.')) {
    html += '<div class="tree-children">';
    for (const child of entries) {
      html += renderTreeNode(child, depth + 1);
    }
    html += '</div>';
  }

  return html;
}

function getChangeBadge(relPath) {
  const diff = state.changes.find(c => c.path === relPath);
  if (!diff) return null;
  if (diff.type === 'create') return { text: 'A', cls: 'tree-badge-add' };
  if (diff.type === 'delete') return { text: 'D', cls: 'tree-badge-delete' };
  if (diff.type === 'modify') return { text: 'M', cls: 'tree-badge-modify' };
  return null;
}

/* ── UI Lifecycle ──────────────────────────────────── */

function setRunningUi(running) {
  state.running = running;
  $('#sendBtn').disabled = running;
  $('#stopBtn').disabled = !running;
  $('#newSessionBtn').disabled = running;
  if (running) {
    setStatus('running', 'running');
  } else {
    setStatus('idle', 'idle');
  }
}

/* ── Session List ──────────────────────────────────── */
async function openSessionList() {
  try {
    const data = await api('/api/sessions');
    const list = $('#sessionList');
    if (data.sessions.length === 0) {
      list.innerHTML = '<div class="fv-empty">暂无 Session</div>';
    } else {
      list.innerHTML = '';
      for (const s of data.sessions) {
        const item = document.createElement('div');
        item.className = 'session-item' + (s.id === state.sessionId ? ' active' : '');
        item.innerHTML = `
          <div class="session-item-info">
            <div class="session-item-title">${escapeHtml(s.title)}</div>
            <div class="session-item-meta">${s.workspace} · ${new Date(s.updatedAt).toLocaleString()}</div>
          </div>
          <span class="session-item-mode">${s.permissionMode}</span>
        `;
        item.onclick = () => switchSession(s.id);
        list.appendChild(item);
      }
    }
    $('#sessionListModal').classList.add('open');
  } catch (err) {
    appendSystemMessage('❌ 加载 Session 列表失败: ' + err.message);
  }
}

async function switchSession(sessionId) {
  $('#sessionListModal').classList.remove('open');
  try {
    const data = await api('/api/session/switch', {
      method: 'POST',
      body: { sessionId },
    });
    state.sessionId = data.sessionId;
    state.permissionMode = data.permissionMode || 'standard';
    $('#modeSelect').value = state.permissionMode;
    updateModeLabel(state.permissionMode);

    // 恢复 canonical transcript
    const chat = $('#chatMessages');
    chat.innerHTML = '';

    // 渲染历史消息（user + assistant，跳过 system 和 tool）
    if (data.messages && data.messages.length > 0) {
      for (const msg of data.messages) {
        if (msg.role === 'system') continue;
        if (msg.role === 'tool') continue;
        if (msg.role === 'user') {
          appendMessage('user', escapeHtml(msg.content));
        } else if (msg.role === 'assistant') {
          appendMessage('assistant', escapeHtml(msg.content || ''));
        }
      }
    } else if (data.title) {
      const welcome = document.createElement('div');
      welcome.className = 'welcome';
      welcome.innerHTML = `<div class="welcome-logo">◆</div><h1>Mini Coding Agent</h1><p class="welcome-sub">${escapeHtml(data.title)}</p>`;
      chat.appendChild(welcome);
    }

    // 清空 Run observation
    state.timeline = [];
    state.changes = [];
    state.commands = [];
    state.approvals = { approved: 0, rejected: 0 };
    state.activeRunId = null;
    state.expandedDirs.clear();
    state.expandedDirs.add('.');
    state.selectedFile = null;
    state.fvPath = null;
    state.fvContent = null;

    $('#timeline').innerHTML = '';
    $('#completionSummary').style.display = 'none';
    $('#diffPanel').innerHTML = '<div class="diff-empty">文件修改将在此显示</div>';
    $('#fvBody').innerHTML = '<div class="fv-empty">选择一个文件或修改来查看</div>';
    $('#terminalBody').innerHTML = '';
  } catch (err) {
    appendSystemMessage('❌ 切换 Session 失败: ' + err.message);
  }
}

/* ── New Session ───────────────────────────────────── */
async function newSession() {
  if (state.running) {
    $('#newSessionBtn').disabled = true;
    return;
  }
  try {
    const data = await api('/api/session', {
      method: 'POST',
      body: { workspace: state.workspace, permissionMode: 'standard' },
    });
    state.sessionId = data.sessionId;
    state.permissionMode = data.permissionMode || 'standard';
    $('#modeSelect').value = state.permissionMode;
    updateModeLabel(state.permissionMode);

    // 清空前端状态
    state.timeline = [];
    state.changes = [];
    state.commands = [];
    state.approvals = { approved: 0, rejected: 0 };
    state.expandedDirs.clear();
    state.expandedDirs.add('.');
    state.selectedFile = null;
    state.fvPath = null;
    state.fvContent = null;
    state.fvView = 'current';

    $('#timeline').innerHTML = '';
    $('#completionSummary').style.display = 'none';
    $('#diffPanel').innerHTML = '<div class="diff-empty">文件修改将在此显示</div>';
    $('#fvBody').innerHTML = '<div class="fv-empty">选择一个文件或修改来查看</div>';
    $('#terminalBody').innerHTML = '';
    loadFileTree();

    // 清空 chat
    const chat = $('#chatMessages');
    chat.innerHTML = '<div class="welcome"><div class="welcome-logo">◆</div><h1>Mini Coding Agent</h1><p class="welcome-sub">输入任务，Agent 会自主读取文件、修改代码、运行验证。</p><div class="quick-starts"><button class="quick-start" data-task="阅读测试 workspace，把首页标题修改成 Hello Agent">示例：修改标题</button><button class="quick-start" data-task="检查这个项目目前为什么无法启动，找出问题并修复，修复后自行运行验证">示例：修复启动问题</button></div></div>';
  } catch (err) {
    appendSystemMessage('❌ 创建 Session 失败: ' + err.message);
  }
}

/* ── Test Hooks (仅 E2E) ──────────────────────────── */
if (typeof window !== 'undefined') {
  window.__dshTest = {
    setTimeline(items) {
      state.timeline = items;
      renderTimeline();
    },
    setChanges(changes) {
      state.changes = changes;
      const panel = $('#diffPanel');
      panel.innerHTML = '';
      if (changes.length === 0) {
        panel.innerHTML = '<div class="diff-empty">本轮无净变更</div>';
        return;
      }
      const summary = document.createElement('div');
      summary.className = 'diff-summary';
      summary.textContent = `${changes.length} files changed`;
      panel.appendChild(summary);
      for (const c of changes) {
        const fileEl = document.createElement('div');
        fileEl.className = 'diff-file';
        const badge = c.type === 'create' ? 'A' : c.type === 'delete' ? 'D' : 'M';
        const badgeClass = c.type === 'create' ? 'create' : c.type === 'delete' ? 'delete' : 'modify';
        const header = document.createElement('div');
        header.className = 'diff-file-header';
        header.innerHTML = `<span class="badge ${badgeClass}">${badge}</span><span class="diff-file-name">${escapeHtml(c.path)}</span><span class="stats">+${c.added||0} -${c.removed||0}</span>`;
        const body = document.createElement('div');
        body.className = 'diff-file-body';
        if (c.diff && c.diff.length) {
          for (const line of c.diff) {
            const dl = document.createElement('div');
            dl.className = 'diff-line ' + line.type;
            dl.textContent = (line.type === 'add' ? '+' : '-') + ' ' + line.content;
            body.appendChild(dl);
          }
        }
        fileEl.appendChild(header);
        fileEl.appendChild(body);
        header.addEventListener('click', (e) => {
          if (e.target.closest('.stats')) { fileEl.classList.toggle('open'); return; }
          openFileDiff(c.path);
          switchInspectorTab('file');
        });
        fileEl.classList.add('open');
        panel.appendChild(fileEl);
      }
    },
    setFileTree(tree) {
      state.fileTreeData = tree;
      state.expandedDirs.add('.');
      renderFileTree();
    },
    openFile(path) {
      openFileCurrent(path);
    },
    setTerminal(commands) {
      const body = $('#terminalBody');
      body.innerHTML = '';
      for (const cmd of commands) {
        const card = document.createElement('div');
        card.className = 'cmd-card';
        card.dataset.toolCallId = cmd.toolCallId || '';
        const header = document.createElement('div');
        header.className = 'cmd-card-header';
        const chevron = document.createElement('span');
        chevron.className = 'cmd-card-chevron';
        chevron.textContent = '▶';
        const cmdSpan = document.createElement('span');
        cmdSpan.className = 'cmd-card-command';
        cmdSpan.textContent = '$ ' + cmd.command;
        const status = document.createElement('span');
        status.className = 'cmd-card-status ok';
        status.textContent = 'Exit 0';
        const dur = document.createElement('span');
        dur.className = 'cmd-card-duration';
        dur.textContent = '0.1s';
        header.appendChild(chevron);
        header.appendChild(cmdSpan);
        header.appendChild(status);
        header.appendChild(dur);
        header.onclick = () => {
          card.classList.toggle('open');
          chevron.classList.toggle('open', card.classList.contains('open'));
        };
        card.appendChild(header);
        const body2 = document.createElement('div');
        body2.className = 'cmd-card-body';
        body2.textContent = cmd.stdout || '(no output)';
        card.appendChild(body2);
        body.appendChild(card);
      }
    },
  };
}

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
  $('#sessionListBtn').addEventListener('click', openSessionList);
  $('#newSessionBtn').addEventListener('click', newSession);
  $('#newSessionFromList').addEventListener('click', () => {
    $('#sessionListModal').classList.remove('open');
    newSession();
  });
  $('#refreshTree').addEventListener('click', loadFileTree);
  $('#clearTerminal').addEventListener('click', () => { $('#terminalBody').innerHTML = ''; });
  $('#toggleTerminal').addEventListener('click', toggleTerminal);
  $('#clearDiff').addEventListener('click', clearDiff);
  $('#saveConfig').addEventListener('click', saveConfig);

  // Inspector tab switching
  $$('.inspector-tab').forEach(tab => {
    tab.addEventListener('click', () => switchInspectorTab(tab.dataset.tab));
  });

  // File Viewer tabs
  $$('.fv-tab').forEach(tab => {
    tab.addEventListener('click', () => switchFvView(tab.dataset.fv));
  });

  // File tree delegation
  $('#fileTree').addEventListener('click', async (e) => {
    const toggle = e.target.closest('[data-toggle]');
    if (toggle) {
      const path = toggle.dataset.toggle;
      toggleDir(path);
      // Lazy load if expanding a directory that hasn't been loaded
      if (state.expandedDirs.has(path) && path !== '.') {
        const node = findNode(state.fileTreeData, path);
        if (node && (!node.children || node.children.length === 0)) {
          await loadDirEntries(path);
        }
      }
      return;
    }
    const row = e.target.closest('.tree-row');
    if (row) {
      selectFile(row.dataset.path);
      if (row.dataset.type === 'file') {
        openFileCurrent(row.dataset.path);
      } else if (row.dataset.type === 'directory') {
        const path = row.dataset.toggle || row.dataset.path;
        if (path) {
          toggleDir(path);
          if (state.expandedDirs.has(path)) {
            const node = findNode(state.fileTreeData, path);
            if (node && (!node.children || node.children.length === 0)) {
              await loadDirEntries(path);
            }
          }
        }
      }
    }
  });

function findNode(node, path) {
  if (!node) return null;
  if (node.path === path) return node;
  if (node.children) {
    for (const child of node.children) {
      const found = findNode(child, path);
      if (found) return found;
    }
  }
  return null;
}

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

class ApiError extends Error {
  constructor(status, code, message) {
    super(message || `HTTP ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.code = code || 'HTTP_ERROR';
  }
}

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
  if (!res.ok) {
    let code = 'HTTP_ERROR';
    let message = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (body.error) {
        code = body.error.code || code;
        message = body.error.message || message;
      }
    } catch {}
    throw new ApiError(res.status, code, message);
  }
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
    // 使用 /api/config 获取 workspace 信息，不再用 /api/files 构建整树
    const cfg = await api('/api/config');
    state.workspace = cfg.workspace;
    $('#wsPath').textContent = state.workspace;
    state.expandedDirs.clear();
    state.expandedDirs.add('.');
    state.fileTreeData = null;
    $('#fileTree').innerHTML = '<div class="tree-empty">加载中…</div>';
    // Lazy load root only
    await loadDirEntries('.');
  } catch (err) {
    $('#fileTree').innerHTML = `<div class="tree-empty">加载失败: ${err.message}</div>`;
  }
}

async function loadDirEntries(relPath) {
  try {
    const data = await api(`/api/files/list?path=${encodeURIComponent(relPath)}`);
    if (!state.fileTreeData) {
      state.fileTreeData = { name: '', path: '.', type: 'directory', children: [] };
    }
    // Merge entries into the tree at the right level
    mergeEntries(state.fileTreeData, relPath, data.entries);
    state.expandedDirs.add(relPath);
    renderFileTree();
  } catch (err) {
    console.error('loadDirEntries failed:', relPath, err);
  }
}

function mergeEntries(root, relPath, entries) {
  // Navigate to the target directory node
  const parts = relPath === '.' ? [] : relPath.split('/');
  let node = root;
  for (const part of parts) {
    if (!node.children) node.children = [];
    let child = node.children.find(c => c.name === part && c.type === 'directory');
    if (!child) {
      child = { name: part, path: relPath, type: 'directory', children: [] };
      node.children.push(child);
    }
    node = child;
  }
  if (!node.children) node.children = [];
  // Merge new entries (avoid duplicates)
  for (const entry of entries) {
    const existing = node.children.find(c => c.name === entry.name);
    if (!existing) {
      node.children.push({
        name: entry.name,
        path: entry.path,
        type: entry.type,
        children: entry.type === 'directory' ? [] : undefined,
      });
    }
  }
  // Sort: directories first, then files
  node.children.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
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
    state.changes = [];
    return;
  }

  // 摘要
  const summary = document.createElement('div');
  summary.className = 'diff-summary';
  summary.textContent = `${netDiff.totalChanges} files changed`;
  panel.appendChild(summary);

  // 统一 Change View Model: 填充 state.changes
  state.changes = netDiff.files.map(f => ({
    path: f.path,
    type: f.type, // create | delete | modify
    added: f.added || 0,
    removed: f.removed || 0,
    diff: f.diff || [],
    before: f.before || '',
    after: f.after || '',
  }));

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
      <span class="diff-file-name">${escapeHtml(file.path)}</span>
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
    header.addEventListener('click', (e) => {
      if (e.target.closest('.stats')) {
        fileEl.classList.toggle('open');
        return;
      }
      // 点击文件名 → Inspector Diff
      openFileDiff(file.path);
      switchInspectorTab('file');
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
  const card = document.createElement('div');
  card.className = 'cmd-card';
  card.dataset.toolCallId = result.toolCallId || '';

  const header = document.createElement('div');
  header.className = 'cmd-card-header';

  const chevron = document.createElement('span');
  chevron.className = 'cmd-card-chevron';
  chevron.textContent = '▶';

  const cmdSpan = document.createElement('span');
  cmdSpan.className = 'cmd-card-command';
  cmdSpan.textContent = '$ ' + cmd;

  const status = document.createElement('span');
  let statusCls = 'ok';
  let statusText = '';
  if (result.timedOut) { statusCls = 'timeout'; statusText = 'Timed out'; }
  else if (result.stopped) { statusCls = 'stopped'; statusText = 'Stopped'; }
  else if (result.exitCode === 0) { statusCls = 'ok'; statusText = 'Exit 0'; }
  else if (result.exitCode !== undefined) { statusCls = 'fail'; statusText = 'Exit ' + result.exitCode; }
  else { statusCls = 'ok'; statusText = 'Running'; }
  status.className = 'cmd-card-status ' + statusCls;
  status.textContent = statusText;

  const dur = document.createElement('span');
  dur.className = 'cmd-card-duration';
  dur.textContent = result.duration ? (result.duration / 1000).toFixed(1) + 's' : '';

  header.appendChild(chevron);
  header.appendChild(cmdSpan);
  header.appendChild(status);
  header.appendChild(dur);

  header.onclick = () => {
    card.classList.toggle('open');
    chevron.classList.toggle('open', card.classList.contains('open'));
  };

  card.appendChild(header);

  const body2 = document.createElement('div');
  body2.className = 'cmd-card-body';
  const MAX_OUT = 4000;
  if (result.stdout) {
    const out = document.createElement('div');
    out.className = 'cmd-card-body stdout';
    const t = truncateText(result.stdout, MAX_OUT);
    out.textContent = t.text;
    if (t.truncated) {
      const more = document.createElement('span');
      more.className = 'cmd-truncated';
      more.textContent = ' （输出已截断，共 ' + result.stdout.length + ' 字符）';
      out.appendChild(more);
    }
    body2.appendChild(out);
  }
  if (result.stderr) {
    const err = document.createElement('div');
    err.className = 'cmd-card-body stderr';
    const t = truncateText(result.stderr, MAX_OUT);
    err.textContent = t.text;
    if (t.truncated) {
      const more = document.createElement('span');
      more.className = 'cmd-truncated';
      more.textContent = ' （输出已截断，共 ' + result.stderr.length + ' 字符）';
      err.appendChild(more);
    }
    body2.appendChild(err);
  }
  if (!result.stdout && !result.stderr) {
    body2.innerHTML = '<span style="color:var(--text-dim)">（无输出）</span>';
  }
  card.appendChild(body2);

  body.appendChild(card);
  body.scrollTop = body.scrollHeight;
}

function navigateToTerminal(toolCallId) {
  const panel = $('#terminalPanel');
  if (panel.classList.contains('collapsed')) {
    panel.classList.remove('collapsed');
    $('#toggleTerminal').textContent = '─';
  }
  const card = document.querySelector('.cmd-card[data-tool-call-id="' + CSS.escape(toolCallId) + '"]');
  if (card) {
    card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    card.classList.add('cmd-highlight');
    setTimeout(() => card.classList.remove('cmd-highlight'), 1500);
    if (!card.classList.contains('open')) {
      card.classList.add('open');
      const chevron = card.querySelector('.cmd-card-chevron');
      if (chevron) chevron.classList.add('open');
    }
  }
}

function toggleTerminal() {
  const panel = $('#terminalPanel');
  panel.classList.toggle('collapsed');
  $('#toggleTerminal').textContent = panel.classList.contains('collapsed') ? '+' : '─';
}

/* ── Status ─────────────────────────────────────────── */
function setStatus(status, text) {
  const dot = $('#runStatus .status-dot');
  const txt = $('#statusText');
  if (dot) dot.className = 'status-dot ' + status;
  if (txt) txt.textContent = text;
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
  // Run Identity 由 Server ActiveRun.runId 提供（通过 run_started SSE event）
  setRunningUi(true);
  state.runStartTime = Date.now();
  state.timeline = [];
  state.commands = [];
  state.approvals = { approved: 0, rejected: 0 };

  if (!state.sessionId) {
    try {
      const data = await api('/api/session', {
        method: 'POST',
        body: { workspace: state.workspace, permissionMode: state.permissionMode, title: task.slice(0, 60) },
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
      setRunningUi(false);
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

    console.log('[DSH] fetch response status:', res.status, 'ok:', res.ok);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        console.log('[DSH] stream done');
        break;
      }

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

        console.log('[DSH SSE]', event.type, event.runId);

        handleEvent(event);
      }
    }
  } catch (err) {
    console.log('[DSH] error:', err.message);
    if (err.name === 'AbortError') {
      appendSystemMessage('任务已停止。');
    } else {
      appendSystemMessage('运行出错: ' + err.message);
    }
  } finally {
    setRunningUi(false);
    state.currentAssistant = null;
    state.currentThinking = null;
    state.activeRunId = null;
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
  console.log('[DSH EVENT]', event.type, event.runId ? 'runId=' + event.runId : '');
  // Run identity filter: ignore late events from old runs
  // run_started is exempt — it establishes the identity
  if (event.type !== 'run_started' && state.activeRunId && event.runId && event.runId !== state.activeRunId) {
    return;
  }
  switch (event.type) {
    case 'run_started':
      state.activeRunId = event.runId;
      break;
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
        terminalWrite(event.toolCall.args.command, { ...event.result, toolCallId: event.toolCall.id });
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
      console.log('[DSH] agent_done received, changes:', event.result?.changes ? JSON.stringify(event.result.changes).slice(0, 200) : 'NO CHANGES');
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
    }).then((result) => {
      // 只有 Server 确认 resolved=true 时才计数
      if (result && result.resolved === true) {
        if (approved) state.approvals.approved++;
        else state.approvals.rejected++;
      }
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

/**
 * Truncate text to a max length with a tail indicator.
 * Returns { text, truncated } so callers can show a "show more" affordance.
 */
function truncateText(s, maxLen) {
  if (s === undefined || s === null) return { text: '', truncated: false };
  const str = String(s);
  if (str.length <= maxLen) return { text: str, truncated: false };
  return { text: str.slice(0, maxLen) + '…', truncated: true };
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
      cmd.style.cursor = 'pointer';
      cmd.title = '点击定位到 Terminal';
      cmd.onclick = () => navigateToTerminal(item.id);
      text.appendChild(cmd);
    } else if (item.name === 'read_file') {
      const f = document.createElement('div');
      f.className = 'ti-file';
      f.style.cursor = 'pointer';
      f.title = '点击打开文件';
      f.innerHTML = '📄 <span class="ti-file-link">' + escapeHtml(item.args.path || '') + '</span>';
      f.onclick = () => openFileCurrent(item.args.path);
      text.appendChild(f);
    } else if (item.name === 'write_file') {
      const f = document.createElement('div');
      f.className = 'ti-file';
      f.style.cursor = 'pointer';
      f.title = '点击打开文件';
      f.innerHTML = '✏️ <span class="ti-file-link">' + escapeHtml(item.args.path || '') + '</span>';
      f.onclick = () => openFileCurrent(item.args.path);
      text.appendChild(f);
    } else if (item.name === 'edit_file') {
      const f = document.createElement('div');
      f.className = 'ti-file';
      f.style.cursor = 'pointer';
      f.title = '点击打开文件（可切换 Diff）';
      f.innerHTML = '✏️ <span class="ti-file-link">' + escapeHtml(item.args.path || '') + '</span>';
      f.onclick = () => openFileCurrent(item.args.path);
      text.appendChild(f);
    } else if (item.name === 'search_files') {
      const f = document.createElement('div');
      f.className = 'ti-file';
      f.textContent = '🔍 ' + (item.args.pattern || '');
      text.appendChild(f);
    } else if (item.name === 'delete_file') {
      const f = document.createElement('div');
      f.className = 'ti-file';
      f.style.cursor = 'pointer';
      f.title = '点击查看 Diff';
      f.innerHTML = '🗑 <span class="ti-file-link">' + escapeHtml(item.args.path || '') + '</span>';
      f.onclick = () => openFileDiff(item.args.path);
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
    expand.setAttribute('aria-label', '展开/折叠详情');
    expand.onclick = () => el.classList.toggle('open');
    el.appendChild(expand);

    // Details
    const details = document.createElement('div');
    details.className = 'timeline-details';
    let detailText = '';
    if (item.args && Object.keys(item.args).length > 0) {
      const aStr = JSON.stringify(item.args);
      detailText += 'args: ' + (aStr.length > 500 ? aStr.slice(0, 500) + '...' : aStr) + '\n';
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

  // Commands evidence: 实际执行过的 command + exit status
  if (state.commands.length > 0) {
    html += '<div class="cs-section"><span class="cs-label">Commands</span>';
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

/* ── Init ───────────────────────────────────────────── */
window.addEventListener('error', (e) => {
  console.error('[DSH ERROR]', e.message, e.error?.stack);
});

document.addEventListener('DOMContentLoaded', init);