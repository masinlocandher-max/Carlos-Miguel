/**
 * Jewel OS - model adapters (Anthropic + OpenAI).
 *
 * DESIGN NOTE - why raw HTTP instead of the official SDKs.
 * Jewel's core is sealed: every file in the capability surface is hashed and
 * owner-signed, and the runtime refuses to boot if a byte changes. A node_modules
 * tree would place thousands of files inside that trust boundary which the seal
 * cannot cover, and any one of them could alter what Jewel is able to do. The
 * whole point of this build is that no third party can change her capability, so
 * the dependency count is zero and the wire format is spoken directly.
 *
 * Tradeoff, stated plainly: the SDKs handle API drift for us and this does not.
 * If Anthropic or OpenAI change a shape, this file must be updated by hand.
 * Wire formats verified against the Messages API and Chat Completions API as of
 * the current documentation; see docs/PROVIDERS.md before changing them.
 *
 * Both adapters expose ONE interface so the agent loop never branches on vendor:
 *   complete({ system, messages, tools, maxTokens }) ->
 *     { text, toolCalls:[{id,name,args}], stopReason, usage, raw }
 */
import { HttpClient } from './http.js';
import { ProviderError, ValidationError } from '../core/errors.js';

export const ANTHROPIC_VERSION = '2023-06-01';

/** Current model ids. Keep in sync with docs/PROVIDERS.md. */
export const MODELS = Object.freeze({
  anthropic: Object.freeze({
    default: 'claude-opus-5',
    fast: 'claude-sonnet-5',
    cheap: 'claude-haiku-4-5',
  }),
  openai: Object.freeze({ default: 'gpt-4.1' }),
});

/**
 * @typedef {object} ModelResponse
 * @property {string} text
 * @property {{ id:string, name:string, args:object }[]} toolCalls
 * @property {string} stopReason
 * @property {object} usage
 * @property {boolean} refused
 */

export class AnthropicModel {
  /** @param {{ apiKey:string, model?:string, baseUrl?:string, audit?:object, fetchImpl?:typeof fetch, effort?:string }} opts */
  constructor(opts) {
    if (!opts.apiKey) throw new ValidationError('Anthropic API key is required');
    this.model = opts.model ?? MODELS.anthropic.default;
    this.effort = opts.effort ?? 'high';
    this.http = new HttpClient({
      baseUrl: opts.baseUrl ?? 'https://api.anthropic.com',
      provider: 'anthropic',
      auth: { type: 'header', header: 'x-api-key', value: opts.apiKey },
      defaultHeaders: { 'anthropic-version': ANTHROPIC_VERSION },
      audit: opts.audit,
      fetchImpl: opts.fetchImpl,
      timeoutMs: opts.timeoutMs ?? 120_000,
    });
  }

  /**
   * @param {{ system:string, messages:object[], tools?:object[], maxTokens?:number,
   *           correlationId?:string }} req
   * @returns {Promise<ModelResponse>}
   */
  async complete(req) {
    const body = {
      model: this.model,
      max_tokens: req.maxTokens ?? 16000,
      system: req.system,
      messages: req.messages,
      // Adaptive thinking: budget_tokens is rejected on this model family.
      thinking: { type: 'adaptive' },
      output_config: { effort: this.effort },
    };
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.input ?? { type: 'object', properties: {} },
      }));
    }

    const data = await this.http.post('/v1/messages', body, { correlationId: req.correlationId });
    return this._normalize(data);
  }

  _normalize(data) {
    const content = Array.isArray(data?.content) ? data.content : [];
    const text = content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    const toolCalls = content
      .filter((b) => b.type === 'tool_use')
      .map((b) => ({ id: b.id, name: b.name, args: b.input ?? {} }));

    // A safety decline arrives as HTTP 200. Treat it as a refusal, never as an
    // empty success - otherwise Jewel would silently do nothing and say "done".
    const refused = data?.stop_reason === 'refusal';
    if (refused && !text) {
      throw new ProviderError('The model declined this request.', {
        provider: 'anthropic',
        category: data?.stop_details?.category ?? null,
        explanation: data?.stop_details?.explanation ?? null,
      });
    }

    return {
      text,
      toolCalls,
      stopReason: data?.stop_reason ?? 'end_turn',
      usage: data?.usage ?? {},
      refused,
      raw: data,
    };
  }

  /**
   * Build the assistant + tool-result turns for a continued conversation.
   * All tool results MUST go back in a SINGLE user message, or the model
   * learns to stop issuing parallel calls.
   */
  static toolResultTurns(assistantContent, results) {
    return [
      { role: 'assistant', content: assistantContent },
      {
        role: 'user',
        content: results.map((r) => ({
          type: 'tool_result',
          tool_use_id: r.id,
          content: typeof r.content === 'string' ? r.content : JSON.stringify(r.content),
          ...(r.isError ? { is_error: true } : {}),
        })),
      },
    ];
  }

  /** Cheap liveness probe that spends no generation tokens. */
  async ping(correlationId) {
    const data = await this.http.get('/v1/models', { correlationId });
    return { ok: true, models: Array.isArray(data?.data) ? data.data.length : 0 };
  }
}

export class OpenAIModel {
  /** @param {{ apiKey:string, model?:string, baseUrl?:string, audit?:object, fetchImpl?:typeof fetch }} opts */
  constructor(opts) {
    if (!opts.apiKey) throw new ValidationError('OpenAI API key is required');
    this.model = opts.model ?? MODELS.openai.default;
    this.http = new HttpClient({
      baseUrl: opts.baseUrl ?? 'https://api.openai.com',
      provider: 'openai',
      auth: { type: 'bearer', value: opts.apiKey },
      audit: opts.audit,
      fetchImpl: opts.fetchImpl,
      timeoutMs: opts.timeoutMs ?? 120_000,
    });
  }

  async complete(req) {
    const messages = [{ role: 'system', content: req.system }, ...this._flatten(req.messages)];
    const body = { model: this.model, max_tokens: req.maxTokens ?? 4096, messages };
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({
        type: 'function',
        function: { name: t.name.replace(/\./g, '__'), description: t.description, parameters: t.input ?? { type: 'object', properties: {} } },
      }));
    }
    const data = await this.http.post('/v1/chat/completions', body, { correlationId: req.correlationId });
    const choice = data?.choices?.[0];
    const msg = choice?.message ?? {};
    return {
      text: (msg.content ?? '').trim(),
      toolCalls: (msg.tool_calls ?? []).map((c) => ({
        id: c.id,
        name: (c.function?.name ?? '').replace(/__/g, '.'),
        args: safeParse(c.function?.arguments),
      })),
      stopReason: choice?.finish_reason ?? 'stop',
      usage: data?.usage ?? {},
      refused: false,
      raw: data,
    };
  }

  /** Anthropic-shaped history flattened to OpenAI's chat format. */
  _flatten(messages) {
    return messages.map((m) => {
      if (typeof m.content === 'string') return { role: m.role, content: m.content };
      const text = (m.content ?? []).filter((b) => b.type === 'text' || b.type === 'tool_result')
        .map((b) => (b.type === 'text' ? b.text : `[tool_result ${b.tool_use_id}] ${b.content}`))
        .join('\n');
      return { role: m.role, content: text };
    });
  }

  async ping(correlationId) {
    const data = await this.http.get('/v1/models', { correlationId });
    return { ok: true, models: Array.isArray(data?.data) ? data.data.length : 0 };
  }
}

function safeParse(text) {
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { __unparsed: String(text).slice(0, 500) }; }
}

/**
 * Offline model used in dry-run and tests. Deterministic, no network, and
 * honest about what it is - it never pretends to be a real completion.
 */
export class EchoModel {
  constructor({ script = [] } = {}) { this.script = [...script]; this.calls = []; }
  async complete(req) {
    this.calls.push(req);
    const next = this.script.shift();
    if (next) return { toolCalls: [], usage: {}, stopReason: 'end_turn', refused: false, ...next };
    return {
      text: 'Offline model: no provider configured, so Jewel cannot generate a real answer. Configure a key and switch to live mode.',
      toolCalls: [], stopReason: 'end_turn', usage: {}, refused: false,
    };
  }
  async ping() { return { ok: true, offline: true }; }
}

/**
 * @param {{ anthropicKey?:string, openaiKey?:string, prefer?:string, model?:string,
 *           audit?:object, fetchImpl?:typeof fetch }} cfg
 */
export function createModel(cfg = {}) {
  const prefer = cfg.prefer ?? (cfg.anthropicKey ? 'anthropic' : cfg.openaiKey ? 'openai' : 'offline');
  if (prefer === 'anthropic' && cfg.anthropicKey) {
    return new AnthropicModel({ apiKey: cfg.anthropicKey, model: cfg.model, audit: cfg.audit, fetchImpl: cfg.fetchImpl });
  }
  if (prefer === 'openai' && cfg.openaiKey) {
    return new OpenAIModel({ apiKey: cfg.openaiKey, model: cfg.model, audit: cfg.audit, fetchImpl: cfg.fetchImpl });
  }
  return new EchoModel();
}
