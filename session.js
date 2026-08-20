/**
 * session.js — 会话状态管理
 *
 * 管理对话历史、上下文裁剪、活跃状态。
 *
 * 上下文管理策略：
 *   - 保留 system prompt（第一条）
 *   - 保留最近 N 轮完整对话（user → assistant → tool_calls → tool_results）
 *   - 对超长 tool output 在存储时截断
 *   - 不截断孤立的 tool message（tool_call_id 必须有对应的 assistant tool_calls）
 */

const MAX_SESSION_MESSAGES = 30; // 最多保留 30 条消息（约 10 轮）
const MAX_TOOL_RESULT_CHARS = 4000; // 单个 tool result 最大字符

class Session {
  constructor(id, workspace) {
    this.id = id;
    this.workspace = workspace;
    this.messages = [];
    this.active = true;
    this.createdAt = Date.now();
    this.lastActivity = Date.now();
    this.runCount = 0;
  }

  addMessage(msg) {
    // 对 tool 类型消息做截断
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
   * 上下文裁剪：
   *   - 保留 system prompt
   *   - 保留最近 N 条消息
   *   - 确保裁剪后消息结构合法（tool 消息必须有对应的 assistant tool_calls）
   */
  prune(maxMessages = MAX_SESSION_MESSAGES) {
    if (this.messages.length <= maxMessages) return;

    // 保留 system prompt
    const system = this.messages.find((m) => m.role === 'system');
    const rest = this.messages.filter((m) => m.role !== 'system');

    // 从后往前取，确保结构合法
    const kept = [];
    let hasOpenToolCalls = false;

    for (let i = rest.length - 1; i >= 0 && kept.length < maxMessages - (system ? 1 : 0); i--) {
      const msg = rest[i];
      // 如果遇到 assistant 有 tool_calls，需要确保对应的 tool result 也在
      if (msg.role === 'assistant' && msg.tool_calls) {
        // 检查是否所有 tool_calls 都有对应的 tool result
        const toolCallIds = new Set(msg.tool_calls.map((tc) => tc.id));
        const keptToolIds = new Set();
        for (const k of kept) {
          if (k.role === 'tool' && k.tool_call_id) {
            keptToolIds.add(k.tool_call_id);
          }
        }
        // 如果有 tool_call 的 result 还没被保留，继续往前找
        const missing = [...toolCallIds].filter((id) => !keptToolIds.has(id));
        if (missing.length > 0) {
          // 需要包含对应的 tool result
          // 这里简化：如果 assistant 有 tool_calls，需要包含完整的 assistant + tool 组
          // 继续往前找对应的 tool 消息
          for (let j = i - 1; j >= 0; j--) {
            const prev = rest[j];
            if (prev.role === 'tool' && toolCallIds.has(prev.tool_call_id)) {
              if (!kept.includes(prev)) {
                kept.unshift(prev);
                toolCallIds.delete(prev.tool_call_id);
              }
              if (toolCallIds.size === 0) break;
            }
          }
        }
      }
      kept.unshift(msg);
    }

    this.messages = system ? [system, ...kept] : kept;
  }

  /** 序列化 */
  serialize() {
    return {
      id: this.id,
      workspace: this.workspace,
      messages: this.messages,
      createdAt: this.createdAt,
      lastActivity: this.lastActivity,
      runCount: this.runCount,
    };
  }

  /** 反序列化 */
  static deserialize(data) {
    const s = new Session(data.id, data.workspace);
    s.messages = data.messages || [];
    s.createdAt = data.createdAt || Date.now();
    s.lastActivity = data.lastActivity || Date.now();
    s.runCount = data.runCount || 0;
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

  /** 清理过期会话 */
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