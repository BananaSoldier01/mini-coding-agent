/**
 * session.js — 会话状态管理
 *
 * V0.3:
 * - 移除无意义的 runCount
 * - prune() 真正进入运行生命周期（Agent 完成后调用）
 * - 结构合法性校验：无 orphan tool message，tool_call 与 tool_result 成组
 */

const MAX_SESSION_MESSAGES = 30;
const MAX_TOOL_RESULT_CHARS = 4000;

class Session {
  constructor(id, workspace) {
    this.id = id;
    this.workspace = workspace;
    this.messages = [];
    this.active = true;
    this.createdAt = Date.now();
    this.lastActivity = Date.now();
    this.title = 'New Session';
    // V0.4.0: Session-scoped Permission Mode
    this.permissionMode = 'standard';
    // V0.5.0: Session Context State (derived, NOT canonical transcript)
    this.contextState = {
      summary: null,
      compactedThrough: 0,
      compactionCount: 0,
      lastCompactedAt: null,
      status: 'fresh',
      sourceRange: { start: 0, end: 0 },
    };
    // V0.5.1: Plan State (Plan Mode & Execution Integrity)
    this.planState = null;
    // V1.3.0: Run-scoped observation data for the most recent Run.
    // Stored when a Run completes so session switch can restore the
    // Coding Workspace (Activity / Changes / Terminal / Summary) state.
    this.lastRunObservation = null;
  }

  /** 别名：与 API 返回字段对齐 */
  get updatedAt() {
    return this.lastActivity;
  }

  setTitle(title) {
    this.title = (title || 'New Session').slice(0, 60);
    this.lastActivity = Date.now();
  }

  addMessage(msg) {
    if (msg.role === 'tool' && msg.content && msg.content.length > MAX_TOOL_RESULT_CHARS) {
      msg = {
        ...msg,
        content: msg.content.slice(0, MAX_TOOL_RESULT_CHARS) + '\n...[已截断]',
      };
    }
    this.messages.push(msg);
    this.lastActivity = Date.now();
  }

  /**
   * V0.5.0: prune 已废弃。
   * Canonical Transcript 永远不被 destructive 修改。
   * Context 压缩由 ContextBuilder / Compactor 负责，只改变 Model Context Projection。
   */
  prune(_maxMessages) {
    // No-op: canonical transcript is preserved
  }

  serialize() {
    return {
      id: this.id,
      workspace: this.workspace,
      messages: this.messages,
      createdAt: this.createdAt,
      lastActivity: this.lastActivity,
      contextState: this.contextState,
      planState: this.planState,
      lastRunObservation: this.lastRunObservation,
    };
  }

  static deserialize(data) {
    const s = new Session(data.id, data.workspace);
    s.messages = data.messages || [];
    s.createdAt = data.createdAt || Date.now();
    s.lastActivity = data.lastActivity || Date.now();
    s.contextState = data.contextState || {
      summary: null,
      compactedThrough: 0,
      compactionCount: 0,
      lastCompactedAt: null,
      status: 'fresh',
      sourceRange: { start: 0, end: 0 },
    };
    s.planState = data.planState || null;
    s.lastRunObservation = data.lastRunObservation || null;
    return s;
  }
}

class SessionManager {
  constructor() {
    this.sessions = new Map();
  }

  create(workspace) {
    const id = `sess_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const session = new Session(id, workspace);
    this.sessions.set(id, session);
    return session;
  }

  get(id) {
    return this.sessions.get(id);
  }

  list(workspace) {
    if (workspace) {
      return Array.from(this.sessions.values()).filter(s => s.workspace === workspace);
    }
    return Array.from(this.sessions.values());
  }

  cleanup(maxAgeMs = 30 * 60 * 1000) {
    const now = Date.now();
    for (const [id, s] of this.sessions) {
      if (now - s.lastActivity > maxAgeMs) {
        this.sessions.delete(id);
      }
    }
  }
}

export { Session, SessionManager };