import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import type { AgentHealth, DeviceRegistrationSnapshot } from '@jade-dev-agent/protocol';

export const DEFAULT_PROXY_HOST = '127.0.0.1' as const;
export const DEFAULT_PROXY_PORT = 17681;

export const ALLOWED_PROXY_PATHS = [
  '/health',
  '/device/status',
  '/proxy/test',
  '/pos/device-proof',
  '/scanner/events',
] as const;

export type AllowedProxyPath = (typeof ALLOWED_PROXY_PATHS)[number];

export interface AgentProxyOptions {
  port?: number;
  getHealth: () => AgentHealth;
  getDeviceStatus: () => DeviceRegistrationSnapshot;
  getPosDeviceProof?: (binding: string) => Promise<PosDeviceProofResponse>;
  /** Phase 3B — cursor-based scanner event delivery for the local POS
   *  consumer. The proxy treats the payload as OPAQUE: the queue shape
   *  (and its raw values) is owned by the main process, and this layer
   *  never inspects, logs, or persists it. Throwing an UPPER_SNAKE
   *  error message surfaces as a safe 423 readiness code. */
  getScannerEvents?: (query: ScannerEventsQuery) => Promise<unknown>;
  allowedPosOrigin?: string | null;
  safeLog?: (event: ProxyLogEvent) => void;
}

export interface ScannerEventsQuery {
  cursor: number;
  waitMs: number;
}

export interface PosDeviceProofResponse {
  proof: string;
  expiresAt: string;
}

export interface ProxyLogEvent {
  method: string;
  path: string;
  statusCode: number;
}

export interface RunningAgentProxy {
  host: typeof DEFAULT_PROXY_HOST;
  port: number;
  close: () => Promise<void>;
}

const POS_PROOF_RATE_LIMIT_WINDOW_MS = 60_000;
const POS_PROOF_RATE_LIMIT_MAX = 30;
const POS_PROOF_BINDING_RE = /^[A-Za-z0-9_-]{32,128}$/u;
const posProofRateLimits = new Map<string, { count: number; resetAt: number }>();

// Scanner event polling is long-poll paced (~1 request/second while the
// cashier is open), so it gets its own, more generous bucket than the
// proof endpoint. Still bounded: a runaway client cannot spin the CPU.
const SCANNER_EVENTS_RATE_LIMIT_WINDOW_MS = 60_000;
const SCANNER_EVENTS_RATE_LIMIT_MAX = 240;
const SCANNER_EVENTS_MAX_WAIT_MS = 1_500;
const SCANNER_EVENTS_CURSOR_RE = /^\d{1,12}$/u;
const scannerEventsRateLimits = new Map<string, { count: number; resetAt: number }>();

export function isAllowedProxyPath(pathname: string): pathname is AllowedProxyPath {
  return (ALLOWED_PROXY_PATHS as readonly string[]).includes(pathname);
}

export function resolveLocalProxyPath(rawUrl: string): string | null {
  if (!rawUrl.startsWith('/') || rawUrl.startsWith('//')) return null;

  try {
    const url = new URL(rawUrl, `http://${DEFAULT_PROXY_HOST}`);
    if (url.origin !== `http://${DEFAULT_PROXY_HOST}`) return null;
    return url.pathname;
  } catch {
    return null;
  }
}

function writeJson(
  res: ServerResponse,
  statusCode: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(JSON.stringify(body));
}

function writeEmpty(
  res: ServerResponse,
  statusCode: number,
  headers: Record<string, string> = {},
): void {
  res.writeHead(statusCode, {
    'cache-control': 'no-store',
    ...headers,
  });
  res.end();
}

async function readBody(req: IncomingMessage, maxBytes = 64 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      throw new Error('REQUEST_TOO_LARGE');
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function corsHeadersForPosProof(origin: string): Record<string, string> {
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-private-network': 'true',
    vary: 'Origin',
  };
}

function resolveAllowedPosOrigin(
  req: IncomingMessage,
  configuredOrigin: string | null | undefined,
): { ok: true; headers: Record<string, string> } | { ok: false } {
  const origin = req.headers.origin;
  if (
    typeof origin !== 'string'
    || typeof configuredOrigin !== 'string'
    || origin !== configuredOrigin
  ) {
    return { ok: false };
  }
  return { ok: true, headers: corsHeadersForPosProof(origin) };
}

function consumeRateLimit(
  limits: Map<string, { count: number; resetAt: number }>,
  req: IncomingMessage,
  windowMs: number,
  max: number,
): boolean {
  const key = req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const current = limits.get(key);
  if (!current || current.resetAt <= now) {
    limits.set(key, {
      count: 1,
      resetAt: now + windowMs,
    });
    return true;
  }
  if (current.count >= max) return false;
  current.count += 1;
  return true;
}

function consumePosProofRateLimit(req: IncomingMessage): boolean {
  return consumeRateLimit(
    posProofRateLimits,
    req,
    POS_PROOF_RATE_LIMIT_WINDOW_MS,
    POS_PROOF_RATE_LIMIT_MAX,
  );
}

function consumeScannerEventsRateLimit(req: IncomingMessage): boolean {
  return consumeRateLimit(
    scannerEventsRateLimits,
    req,
    SCANNER_EVENTS_RATE_LIMIT_WINDOW_MS,
    SCANNER_EVENTS_RATE_LIMIT_MAX,
  );
}

function safeProxyErrorCode(error: unknown): string {
  if (!(error instanceof Error)) return 'POS_DEVICE_PROOF_UNAVAILABLE';
  return /^[A-Z0-9_]{3,80}$/u.test(error.message)
    ? error.message
    : 'POS_DEVICE_PROOF_UNAVAILABLE';
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: AgentProxyOptions,
): Promise<void> {
  const rawUrl = req.url || '/';
  let path = '[invalid-local-proxy-path]';
  let statusCode = 404;
  try {
    const resolvedPath = resolveLocalProxyPath(rawUrl);
    if (!resolvedPath) {
      statusCode = 404;
      writeJson(res, statusCode, {
        ok: false,
        code: 'AGENT_PROXY_PATH_NOT_ALLOWED',
        message: 'This local agent path is not available.',
      });
      return;
    }

    path = resolvedPath;

    if (!isAllowedProxyPath(path)) {
      statusCode = 404;
      writeJson(res, statusCode, {
        ok: false,
        code: 'AGENT_PROXY_PATH_NOT_ALLOWED',
        message: 'This local agent path is not available.',
      });
      return;
    }

    if (path === '/pos/device-proof') {
      const cors = resolveAllowedPosOrigin(req, options.allowedPosOrigin);
      if (!cors.ok) {
        statusCode = 403;
        writeJson(res, statusCode, {
          code: 'POS_DEVICE_PROOF_ORIGIN_NOT_ALLOWED',
          message: 'This POS origin is not allowed.',
        });
        return;
      }
      if (req.method === 'OPTIONS') {
        statusCode = 204;
        writeEmpty(res, statusCode, cors.headers);
        return;
      }
      if (req.method !== 'GET') {
        statusCode = 405;
        writeJson(
          res,
          statusCode,
          {
            code: 'AGENT_PROXY_METHOD_NOT_ALLOWED',
            message: 'This method is not allowed on the local agent path.',
          },
          cors.headers,
        );
        return;
      }
      if (!consumePosProofRateLimit(req)) {
        statusCode = 429;
        writeJson(
          res,
          statusCode,
          {
            code: 'POS_DEVICE_PROOF_RATE_LIMITED',
            message: 'POS device proof requests are rate limited.',
          },
          cors.headers,
        );
        return;
      }
      const url = new URL(rawUrl, `http://${DEFAULT_PROXY_HOST}`);
      const binding = url.searchParams.get('binding') || '';
      if (!POS_PROOF_BINDING_RE.test(binding)) {
        statusCode = 400;
        writeJson(
          res,
          statusCode,
          {
            code: 'POS_DEVICE_PROOF_BINDING_INVALID',
            message: 'POS device proof binding is invalid.',
          },
          cors.headers,
        );
        return;
      }
      if (!options.getPosDeviceProof) {
        statusCode = 503;
        writeJson(
          res,
          statusCode,
          {
            code: 'POS_DEVICE_PROOF_UNAVAILABLE',
            message: 'POS device proof is unavailable.',
          },
          cors.headers,
        );
        return;
      }
      try {
        const proof = await options.getPosDeviceProof(binding);
        statusCode = 200;
        writeJson(res, statusCode, proof, cors.headers);
      } catch (error) {
        statusCode = 423;
        writeJson(
          res,
          statusCode,
          {
            code: safeProxyErrorCode(error),
            message: 'POS device proof is not ready.',
          },
          cors.headers,
        );
      }
      return;
    }

    if (path === '/scanner/events') {
      const cors = resolveAllowedPosOrigin(req, options.allowedPosOrigin);
      if (!cors.ok) {
        statusCode = 403;
        writeJson(res, statusCode, {
          code: 'SCANNER_EVENTS_ORIGIN_NOT_ALLOWED',
          message: 'This POS origin is not allowed.',
        });
        return;
      }
      if (req.method === 'OPTIONS') {
        statusCode = 204;
        writeEmpty(res, statusCode, cors.headers);
        return;
      }
      if (req.method !== 'GET') {
        statusCode = 405;
        writeJson(
          res,
          statusCode,
          {
            code: 'AGENT_PROXY_METHOD_NOT_ALLOWED',
            message: 'This method is not allowed on the local agent path.',
          },
          cors.headers,
        );
        return;
      }
      if (!consumeScannerEventsRateLimit(req)) {
        statusCode = 429;
        writeJson(
          res,
          statusCode,
          {
            code: 'SCANNER_EVENTS_RATE_LIMITED',
            message: 'Scanner event requests are rate limited.',
          },
          cors.headers,
        );
        return;
      }
      const url = new URL(rawUrl, `http://${DEFAULT_PROXY_HOST}`);
      const rawCursor = url.searchParams.get('cursor') ?? '0';
      if (!SCANNER_EVENTS_CURSOR_RE.test(rawCursor)) {
        statusCode = 400;
        writeJson(
          res,
          statusCode,
          {
            code: 'SCANNER_EVENTS_CURSOR_INVALID',
            message: 'Scanner event cursor is invalid.',
          },
          cors.headers,
        );
        return;
      }
      const rawWaitMs = url.searchParams.get('waitMs') ?? '0';
      const waitMs = SCANNER_EVENTS_CURSOR_RE.test(rawWaitMs)
        ? Math.min(Number.parseInt(rawWaitMs, 10), SCANNER_EVENTS_MAX_WAIT_MS)
        : 0;
      if (!options.getScannerEvents) {
        statusCode = 503;
        writeJson(
          res,
          statusCode,
          {
            code: 'SCANNER_EVENTS_UNAVAILABLE',
            message: 'Scanner events are unavailable.',
          },
          cors.headers,
        );
        return;
      }
      try {
        const payload = await options.getScannerEvents({
          cursor: Number.parseInt(rawCursor, 10),
          waitMs,
        });
        statusCode = 200;
        writeJson(res, statusCode, payload, cors.headers);
      } catch (error) {
        statusCode = 423;
        writeJson(
          res,
          statusCode,
          {
            code: safeProxyErrorCode(error),
            message: 'Scanner events are not ready.',
          },
          cors.headers,
        );
      }
      return;
    }

    if (path === '/health' && req.method === 'GET') {
      statusCode = 200;
      writeJson(res, statusCode, options.getHealth());
      return;
    }

    if (path === '/device/status' && req.method === 'GET') {
      statusCode = 200;
      writeJson(res, statusCode, options.getDeviceStatus());
      return;
    }

    if (path === '/proxy/test' && req.method === 'POST') {
      const body = await readBody(req);
      statusCode = 200;
      writeJson(res, statusCode, {
        ok: true,
        mode: 'DEV_ONLY_NO_UPSTREAM_FORWARDING',
        receivedBytes: body.length,
        device: options.getDeviceStatus(),
        futureProof: {
          nonce: 'placeholder',
          timestamp: new Date().toISOString(),
          bodyHash: 'placeholder',
          deviceSession: 'placeholder',
        },
      });
      return;
    }

    statusCode = 405;
    writeJson(res, statusCode, {
      ok: false,
      code: 'AGENT_PROXY_METHOD_NOT_ALLOWED',
      message: 'This method is not allowed on the local agent path.',
    });
  } catch (err) {
    statusCode = err instanceof Error && err.message === 'REQUEST_TOO_LARGE' ? 413 : 500;
    writeJson(res, statusCode, {
      ok: false,
      code: statusCode === 413 ? 'AGENT_PROXY_REQUEST_TOO_LARGE' : 'AGENT_PROXY_INTERNAL',
      message:
        statusCode === 413
          ? 'The local proxy request is too large.'
          : 'The local proxy could not process the request.',
    });
  } finally {
    options.safeLog?.({
      method: req.method || 'UNKNOWN',
      path,
      statusCode,
    });
  }
}

export function createAgentProxyServer(options: AgentProxyOptions): Server {
  return createServer((req, res) => {
    void handleRequest(req, res, options);
  });
}

export const __INTERNAL_AGENT_PROXY_TESTING = {
  posProofRateLimits,
  scannerEventsRateLimits,
};

export async function startAgentProxy(options: AgentProxyOptions): Promise<RunningAgentProxy> {
  const port = options.port ?? DEFAULT_PROXY_PORT;
  const server = createAgentProxyServer(options);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, DEFAULT_PROXY_HOST, () => {
      server.off('error', reject);
      resolve();
    });
  });
  return {
    host: DEFAULT_PROXY_HOST,
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
