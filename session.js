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
    // V0.4.0: Session-scoped Permission Mode
    this.permissionMode = 'standard';
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
   * 上下文裁剪：
   *   - 保留 system prompt
   *   - 保留最近 N 条消息
   *   - 确保裁剪后结构合法：
   *     - 无 orphan tool message（每个 tool 的 tool_call_id 都有对应的 assistant tool_calls）
   *     - 每个 assistant tool_call 都有对应的 tool result
   *     - user context 不丢
   */
  prune(maxMessages = MAX_SESSION_MESSAGES) {
    if (this.messages.length <= maxMessages) return;

    const system = this.messages.find((m) => m.role === 'system');
    const rest = this.messages.filter((m) => m.role !== 'system');

    // 从后往前扫描，构建合法的 message 序列
    const kept = [];
    const keptToolCallIds = new Set(); // 已保留的 tool result 的 tool_call_id
    const neededToolCallIds = new Set(); // assistant tool_calls 中还没找到 result 的

    for (let i = rest.length - 1; i >= 0 && kept.length < maxMessages - (system ? 1 : 0); i--) {
      const msg = rest[i];

      if (msg.role === 'tool') {
        // 检查这个 tool 是否有对应的 assistant tool_calls
        const hasAssistant = rest.some((m) =>
          m.role === 'assistant' && m.tool_calls?.some((tc) => tc.id === msg.tool_call_id)
        );
        if (!hasAssistant) continue; // orphan tool，跳过
        kept.unshift(msg);
        keptToolCallIds.add(msg.tool_call_id);
      } else if (msg.role === 'assistant' && msg.tool_calls) {
        const toolCallIds = new Set(msg.tool_calls.map((tc) => tc.id));
        // 检查是否所有 tool_calls 都有对应的 tool result
        const allHaveResults = [...toolCallIds].every((id) => keptToolCallIds.has(id));
        if (!allHaveResults) {
          // 有 tool_call 还没找到对应的 tool result，继续往前找
          for (let j = i - 1; j >= 0; j--) {
            const prev = rest[j];
            if (prev.role === 'tool' && toolCallIds.has(prev.tool_call_id)) {
              if (!kept.includes(prev)) {
                kept.unshift(prev);
                keptToolCallIds.add(prev.tool_call_id);
                toolCallIds.delete(prev.tool_call_id);
              }
              if (toolCallIds.size === 0) break;
            }
          }
          // 如果还有未找到的，跳过这个 assistant（避免 orphan tool_call）
          if (toolCallIds.size > 0) continue;
        }
        kept.unshift(msg);
      } else {
        // user / assistant (无 tool_calls)
        kept.unshift(msg);
      }
    }

    // 最终校验：确保没有 orphan tool message
    const finalToolIds = new Set();
    for (const m of kept) {
      if (m.role === 'tool' && m.tool_call_id) finalToolIds.add(m.tool_call_id);
    }
    const finalAssistantToolCallIds = new Set();
    for (const m of kept) {
      if (m.role === 'assistant' && m.tool_calls) {
        for (const tc of m.tool_calls) finalAssistantToolCallIds.add(tc.id);
      }
    }
    // 移除没有对应 assistant tool_calls 的 tool message
    const validated = kept.filter((m) => {
      if (m.role === 'tool') return finalAssistantToolCallIds.has(m.tool_call_id);
      return true;
    });

    this.messages = system ? [system, ...validated] : validated;
  }

  serialize() {
    return {
      id: this.id,
      workspace: this.workspace,
      messages: this.messages,
      createdAt: this.createdAt,
      lastActivity: this.lastActivity,
    };
  }

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