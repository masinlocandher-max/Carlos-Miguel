/**
 * Jewel OS - the only outbound HTTP path.
 *
 * Every provider call goes through here so that four things are guaranteed in
 * one place rather than repeated (and forgotten) per adapter:
 *
 *   - credentials are attached at the edge and never logged, never returned,
 *     never placed in a URL (they would land in proxy logs);
 *   - failures are typed and honestly classified as retryable or not;
 *   - retries use exponential backoff with jitter and are applied ONLY to
 *     idempotent verbs, so a retry never duplicates a POST side effect;
 *   - every request is audited with the credential fingerprinted, not shown.
 *
 * INV-6 lives here too: a non-2xx response, a timeout or a transport error
 * always raises. There is no path that turns a failure into a success value.
 */
import { ProviderError, AuthError, toJewelError } from '../core/errors.js';
import { redact, registerSecret, fingerprint } from '../core/redact.js';
import { EVENT } from '../core/audit.js';

const IDEMPOTENT = new Set(['GET', 'HEAD', 'OPTIONS']);
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export class HttpClient {
  /**
   * @param {{ baseUrl:string, auth?:{ type:'bearer'|'header'|'none', value?:string, header?:string },
   *           audit?:object, provider:string, timeoutMs?:number, maxRetries?:number,
   *           defaultHeaders?:Record<string,string>, fetchImpl?:typeof fetch }} opts
   */
  constructor(opts) {
    this.baseUrl = (opts.baseUrl ?? '').replace(/\/+$/, '');
    this.auth = opts.auth ?? { type: 'none' };
    this.audit = opts.audit;
    this.provider = opts.provider;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.maxRetries = opts.maxRetries ?? 3;
    this.defaultHeaders = opts.defaultHeaders ?? {};
    this.fetch = opts.fetchImpl ?? globalThis.fetch;
    if (this.auth.value) registerSecret(this.auth.value);
  }

  _headers(extra = {}) {
    const h = { accept: 'application/json', ...this.defaultHeaders, ...extra };
    if (this.auth.type === 'bearer' && this.auth.value) h.authorization = `Bearer ${this.auth.value}`;
    if (this.auth.type === 'header' && this.auth.value) h[this.auth.header ?? 'x-api-key'] = this.auth.value;
    return h;
  }

  /**
   * @param {string} method
   * @param {string} path
   * @param {{ body?:unknown, headers?:object, query?:object, correlationId?:string, retryable?:boolean }} [opts]
   */
  async request(method, path, opts = {}) {
    const verb = method.toUpperCase();
    const url = new URL(`${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }

    // A retry is only safe for an idempotent verb, or where the caller has
    // explicitly asserted the endpoint is idempotent (e.g. carries an
    // Idempotency-Key header).
    const mayRetry = IDEMPOTENT.has(verb) || opts.retryable === true;
    const attempts = mayRetry ? this.maxRetries : 1;

    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const started = Date.now();
      try {
        const res = await this._once(verb, url, opts);
        this.audit?.write(EVENT.PROVIDER_CALL, {
          provider: this.provider, method: verb, path, status: res.status,
          attempt, ms: Date.now() - started, credential: fingerprint(this.auth.value),
        }, { correlationId: opts.correlationId, outcome: 'ok' });
        return res.data;
      } catch (err) {
        lastError = toJewelError(err);
        const retryable = lastError.retryable === true;
        this.audit?.write(EVENT.PROVIDER_CALL, {
          provider: this.provider, method: verb, path, attempt,
          ms: Date.now() - started, error: lastError.toJSON(), willRetry: retryable && attempt < attempts,
        }, { correlationId: opts.correlationId, outcome: 'error' });

        if (!retryable || attempt === attempts) throw lastError;
        await this._backoff(attempt);
      }
    }
    throw lastError;
  }

  async _once(verb, url, opts) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const hasBody = opts.body !== undefined && verb !== 'GET' && verb !== 'HEAD';
      const res = await this.fetch(url.toString(), {
        method: verb,
        headers: this._headers(hasBody ? { 'content-type': 'application/json', ...opts.headers } : opts.headers),
        body: hasBody ? JSON.stringify(opts.body) : undefined,
        signal: controller.signal,
      });

      const text = await res.text();
      let data = null;
      if (text) { try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 4000) }; } }

      if (res.ok) return { status: res.status, data };

      if (res.status === 401) {
        throw new AuthError(`${this.provider} rejected the credential.`, { provider: this.provider, status: 401 });
      }
      if (res.status === 403) {
        throw new AuthError(`${this.provider} refused this request. The credential lacks the required permission.`,
          { provider: this.provider, status: 403 });
      }
      const err = new ProviderError(
        `${this.provider} returned HTTP ${res.status}.`,
        { provider: this.provider, status: res.status, body: redact(data) },
        RETRYABLE_STATUS.has(res.status),
      );
      throw err;
    } catch (err) {
      if (err?.name === 'AbortError') {
        throw new ProviderError(`${this.provider} timed out after ${this.timeoutMs}ms.`, { provider: this.provider }, true);
      }
      if (err instanceof ProviderError || err instanceof AuthError) throw err;
      // Transport-level failure: DNS, TLS, reset. Retryable.
      throw new ProviderError(`Could not reach ${this.provider}.`, { provider: this.provider, cause: err?.code ?? err?.message }, true);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Exponential backoff with full jitter - avoids synchronized retry storms. */
  async _backoff(attempt) {
    const base = Math.min(2 ** attempt * 250, 8000);
    const wait = Math.floor(Math.random() * base);
    await new Promise((r) => setTimeout(r, wait));
  }

  get(path, opts) { return this.request('GET', path, opts); }
  post(path, body, opts) { return this.request('POST', path, { ...opts, body }); }
  patch(path, body, opts) { return this.request('PATCH', path, { ...opts, body }); }
  put(path, body, opts) { return this.request('PUT', path, { ...opts, body }); }
  delete(path, opts) { return this.request('DELETE', path, opts); }
}
