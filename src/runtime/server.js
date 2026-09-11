/**
 * Jewel OS - local control API.
 *
 * This is the bridge Codex's command centre stopped at. The visual shell can
 * navigate; it could not read real state or act. This gives it both, without
 * giving it any authority of its own.
 *
 * Security posture, because a local API is still an attack surface:
 *
 *   LOOPBACK ONLY      binds 127.0.0.1 by default. It is a control surface for
 *                      FMB's own machine, not a service.
 *   TOKEN REQUIRED     every route except /health needs a bearer token,
 *                      compared in constant time. No token configured means no
 *                      API - it refuses to start rather than running open.
 *   NO NEW AUTHORITY   every mutating route goes through the same Executor the
 *                      CLI uses. The API cannot skip policy, approval binding,
 *                      idempotency or audit, because it never touches them
 *                      directly.
 *   GRANTS ARE HUMAN   approve/deny are exposed, but they are recorded as
 *                      coming from FMB's authenticated session, and Jewel
 *                      still cannot approve her own request.
 *   NO SECRETS OUT     every response passes through redaction.
 *   ORIGIN CHECKED     browser requests must come from an allowed origin, so a
 *                      random page cannot drive Jewel through the user's
 *                      browser.
 */
import { createServer } from 'node:http';
import { safeEqual } from '../core/ids.js';
import { redact } from '../core/redact.js';
import { toJewelError, ValidationError, AuthError } from '../core/errors.js';
import { EVENT } from '../core/audit.js';

const MAX_BODY_BYTES = 256 * 1024;

/** Status code for each typed error, so clients can branch correctly. */
const STATUS = {
  INVALID_INPUT: 400,
  UNAUTHENTICATED: 401,
  UNAUTHORIZED: 403,
  POLICY_DENIED: 403,
  APPROVAL_REQUIRED: 409,
  NOT_FOUND: 404,
  SEAL_VIOLATION: 503,
  PROVIDER_FAILURE: 502,
  TIMEOUT: 504,
  INTERNAL_ERROR: 500,
};

export function createApi(kernel, opts = {}) {
  const token = opts.token ?? process.env.JEWEL_API_TOKEN ?? null;
  const host = opts.host ?? '127.0.0.1';
  const port = Number(opts.port ?? process.env.JEWEL_API_PORT ?? 7777);
  const allowedOrigins = new Set(opts.allowedOrigins ?? [
    `http://localhost:${port}`, `http://127.0.0.1:${port}`,
    'http://localhost:5173', 'http://127.0.0.1:5173',   // vite dev
    'http://localhost:4173', 'http://127.0.0.1:4173',   // vite preview
  ]);

  if (!token) {
    throw new ValidationError(
      'JEWEL_API_TOKEN is not set. Jewel will not start an unauthenticated control surface. Generate one:\n  node -e "console.log(require(\'node:crypto\').randomBytes(24).toString(\'hex\'))"',
    );
  }

  const server = createServer(async (req, res) => {
    const started = Date.now();
    try {
      await route(req, res);
    } catch (err) {
      send(res, err, null, req);
    } finally {
      if (!res.headersSent) res.end();
      void started;
    }
  });

  async function route(req, res) {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = req.method ?? 'GET';

    // CORS: only the shell's own origins, and only with credentials by token.
    const origin = req.headers.origin;
    if (origin) {
      if (!allowedOrigins.has(origin)) {
        return send(res, new AuthError('Origin not allowed.'), null, req);
      }
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('vary', 'origin');
      res.setHeader('access-control-allow-headers', 'authorization, content-type');
      res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    }
    if (method === 'OPTIONS') { res.writeHead(204); return res.end(); }

    // /health is the only unauthenticated route, and it reveals nothing:
    // liveness and lockdown state only, so the shell can render an honest
    // "not connected" screen without a token.
    if (path === '/health' && method === 'GET') {
      return ok(res, { ok: true, lockdown: kernel.lockdown, sealed: kernel.seal.ok, signed: kernel.seal.signed });
    }

    if (!authorized(req)) {
      kernel.audit.write(EVENT.AUTH_DENIED, { path, method }, { outcome: 'denied' });
      return send(res, new AuthError('A valid bearer token is required.'), null, req);
    }

    const principal = kernel.owner();

    if (method === 'GET') {
      switch (path) {
        case '/status': {
          const chain = kernel.audit.verifyChain();
          return ok(res, {
            owner: kernel.config.owner,
            mode: kernel.config.mode,
            lockdown: kernel.lockdown,
            seal: { ok: kernel.seal.ok, signed: kernel.seal.signed, summary: kernel.seal.summary, violations: kernel.seal.violations },
            audit: { intact: chain.ok, records: chain.length, brokenAt: chain.brokenAt },
            capabilities: kernel.registry.names().length,
            capabilityFingerprint: kernel.capabilityFingerprint,
            providers: {
              notion: !!kernel.workspace.notion?.configured,
              google: !!kernel.workspace.google?.configured,
              github: !!kernel.workspace.github?.configured,
            },
            pendingApprovals: kernel.approvals.pending().length,
            indeterminate: kernel.ledger.indeterminate().length,
            memory: kernel.memory.stats(),
          });
        }
        case '/capabilities':
          return ok(res, { capabilities: kernel.registry.catalogue(), fingerprint: kernel.capabilityFingerprint });
        case '/approvals':
          return ok(res, {
            approvals: kernel.approvals.list(url.searchParams.get('state') ?? undefined).map(publicApproval),
          });
        case '/tasks':
          return ok(res, { tasks: kernel.tasks ? kernel.tasks.list({ status: url.searchParams.get('status') ?? 'open' }) : [] });
        case '/memory': {
          const out = kernel.memory.search({ query: url.searchParams.get('q') ?? '', limit: 25 }, principal);
          return ok(res, { records: kernel.memory.toContext(out.results), withheld: out.withheld, conflicts: out.conflicts });
        }
        case '/audit': {
          const cid = url.searchParams.get('trace');
          if (cid) {
            const receipt = kernel.audit.receipt(cid);
            if (!receipt) return send(res, Object.assign(new Error('No such trace'), { code: 'NOT_FOUND' }), null, req);
            return ok(res, receipt);
          }
          return ok(res, kernel.audit.verifyChain());
        }
        default:
          return notFound(res, path);
      }
    }

    if (method === 'POST') {
      const body = await readJson(req);
      switch (path) {
        case '/ask': {
          if (!kernel.agent) throw new ValidationError('No model is configured, so Jewel cannot answer.');
          if (typeof body.request !== 'string' || !body.request.trim()) throw new ValidationError('request is required');
          const turn = await kernel.agent.run(body.request, { principal });
          return ok(res, {
            answer: turn.answer, trace: turn.correlationId, steps: turn.steps,
            actions: turn.actions, awaitingApproval: turn.awaitingApproval,
            warnings: turn.warnings, truncated: turn.truncated,
          });
        }
        case '/call': {
          if (typeof body.tool !== 'string') throw new ValidationError('tool is required');
          const result = await kernel.executor.call(body.tool, body.args ?? {}, { principal });
          return ok(res, result);
        }
        case '/approvals/grant':
        case '/approvals/deny': {
          if (typeof body.ref !== 'string') throw new ValidationError('ref is required');
          const record = kernel.approvals.resolve(body.ref);
          const decided = path.endsWith('grant')
            ? kernel.approvals.grant(record.id, { by: kernel.config.owner, note: body.note ?? null })
            : kernel.approvals.deny(record.id, { by: kernel.config.owner, reason: body.reason ?? null });
          return ok(res, publicApproval(decided));
        }
        default:
          return notFound(res, path);
      }
    }

    return notFound(res, path);
  }

  function authorized(req) {
    const header = req.headers.authorization ?? '';
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match) return false;
    return safeEqual(match[1].trim(), token);
  }

  async function readJson(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) throw new ValidationError('Request body is too large.');
      chunks.push(chunk);
    }
    if (!chunks.length) return {};
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new ValidationError('Body must be valid JSON.'); }
  }

  function ok(res, payload) {
    const body = JSON.stringify(redact(payload));
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(body);
  }

  function notFound(res, path) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: `No such route: ${path}` } }));
  }

  function send(res, err) {
    const e = toJewelError(err);
    const status = STATUS[e.code] ?? 500;
    if (!res.headersSent) res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: redact(e.toJSON()) }));
  }

  return {
    server,
    host,
    port,
    /**
     * Resolve with the port the OS actually bound, not the one requested.
     * They differ whenever port 0 is used to get an ephemeral port.
     */
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          const actual = server.address();
          resolve({ host, port: typeof actual === 'object' && actual ? actual.port : port });
        });
      });
    },
    close() {
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

/** Never expose the full payload in a list - only what identifies the action. */
function publicApproval(r) {
  return {
    id: r.id, ref: r.ref, action: r.action, account: r.account, risk: r.risk,
    summary: r.summary, state: r.state, requestedAt: r.requestedAt,
    expiresAt: r.expiresAt, binding: r.binding,
  };
}
