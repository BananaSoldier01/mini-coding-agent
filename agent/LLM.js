/**
 * agent/LLM.js — LLM Provider 抽象
 *
 * 设计为可替换 Provider。第一版支持 OpenAI-compatible API。
 * 后续可扩展 AnthropicProvider / OllamaProvider / LocalProvider。
 */

class LLMProvider {
  constructor(config) {
    this.endpoint = (config.endpoint || 'https://api.openai.com/v1').replace(/\/$/, '');
    this.apiKey = config.apiKey || '';
    this.model = config.model || 'gpt-4o-mini';
    this.temperature = config.temperature ?? 0.2;
  }

  /** 构建请求 URL */
  get url() {
    return `${this.endpoint}/chat/completions`;
  }

  /** 构建请求头 */
  headers() {
    const h = { 'Content-Type': 'application/json' };
    if (this.apiKey) {
      h['Authorization'] = `Bearer ${this.apiKey}`;
    }
    return h;
  }

  /**
   * chat — 非流式调用
   * 返回 { content, tool_calls, raw }
   */
  async chat({ messages, tools, signal } = {}) {
    const body = this.buildBody({ messages, tools, stream: false });
    const resp = await fetch(this.url, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal,
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`LLM 请求失败 (${resp.status}): ${text.slice(0, 500)}`);
    }

    const data = await resp.json();
    return this.parseResponse(data);
  }

  /**
   * chatStream — 流式调用
   * 返回 ReadableStream，逐 token 输出；tool_calls 在结束时解析
   */
  async chatStream({ messages, tools, signal } = {}) {
    const body = this.buildBody({ messages, tools, stream: true });
    const resp = await fetch(this.url, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal,
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`LLM 请求失败 (${resp.status}): ${text.slice(0, 500)}`);
    }

    return resp.body; // ReadableStream<Uint8Array>
  }

  /** 解析非流式响应 */
  parseResponse(data) {
    const choice = data.choices?.[0];
    if (!choice) {
      throw new Error('LLM 响应缺少 choices');
    }
    const msg = choice.message;
    return {
      content: msg.content || '',
      tool_calls: msg.tool_calls || null,
      finishReason: choice.finish_reason,
      raw: data,
    };
  }

  /** 构建请求体 */
  buildBody({ messages, tools, stream }) {
    const body = {
      model: this.model,
      messages,
      temperature: this.temperature,
      stream,
    };
    if (tools && tools.length > 0) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }
    return body;
  }

  /** 将工具定义转为 OpenAI tool schema */
  static formatTools(toolDefs) {
    return toolDefs.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      },
    }));
  }

  /**
   * chatSimple — 简单调用（无 tools，非流式）。
   * 用于 Compaction 等内部场景。
   * 返回 string content。
   */
  async chatSimple(prompt) {
    const result = await this.chat({
      messages: [{ role: 'user', content: prompt }],
      tools: [],
    });
    return result.content || '';
  }
}

/** 工厂函数：根据配置创建 Provider */
function createProvider(config) {
  return new LLMProvider(config);
}

export { LLMProvider, createProvider };