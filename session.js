/**
 * session.js — 会话状态管理
 *
 * 管理对话历史、待确认请求、流式状态。
 */

class Session {
  constructor(id, workspace) {
    this.id = id;
    this.workspace = workspace;
    this.messages = [];     // 完整对话历史（含 tool_calls / tool_results）
    this.pendingApproval = null; // { toolCallId, resolve }
    this.active = true;
    this.createdAt = Date.now();
    this.lastActivity = Date.now();
  }

  addMessage(msg) {
    this.messages.push(msg);
    this.lastActivity = Date.now();
  }

  /** 清理旧上下文（保留最近 N 轮） */
  prune(keepRounds = 10) {
    // 保留 system + 最近 keepRounds 轮（user/assistant/tool）
    if (this.messages.length <= keepRounds * 3 + 1) return;
    const system = this.messages[0];
    const recent = this.messages.slice(-(keepRounds * 3));
    this.messages = [system, ...recent];
  }

  /** 序列化（用于持久化/调试，不含二进制） */
  serialize() {
    return {
      id: this.id,
      workspace: this.workspace,
      messages: this.messages,
      createdAt: this.createdAt,
      lastActivity: this.lastActivity,
    };
  }

  /** 反序列化 */
  static deserialize(data) {
    const s = new Session(data.id, data.workspace);
    s.messages = data.messages || [];
    s.createdAt = data.createdAt || Date.now();
    s.lastActivity = data.lastActivity || Date.now();
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

  /** 清理超过 30 分钟未活跃的会话 */
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