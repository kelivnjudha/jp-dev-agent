import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import type { AgentHealth, DeviceRegistrationSnapshot } from '@jade-dev-agent/protocol';

export const DEFAULT_PROXY_HOST = '127.0.0.1' as const;
export const DEFAULT_PROXY_PORT = 17681;

export const ALLOWED_PROXY_PATHS = ['/health', '/device/status', '/proxy/test'] as const;

export type AllowedProxyPath = (typeof ALLOWED_PROXY_PATHS)[number];

export interface AgentProxyOptions {
  port?: number;
  getHealth: () => AgentHealth;
  getDeviceStatus: () => DeviceRegistrationSnapshot;
  safeLog?: (event: ProxyLogEvent) => void;
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

export function isAllowedProxyPath(pathname: string): pathname is AllowedProxyPath {
  return (ALLOWED_PROXY_PATHS as readonly string[]).includes(pathname);
}

function writeJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
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

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: AgentProxyOptions,
): Promise<void> {
  const rawUrl = req.url || '/';
  const url = new URL(rawUrl, `http://${DEFAULT_PROXY_HOST}`);
  const path = url.pathname;
  let statusCode = 404;
  try {
    if (!isAllowedProxyPath(path)) {
      statusCode = 404;
      writeJson(res, statusCode, {
        ok: false,
        code: 'AGENT_PROXY_PATH_NOT_ALLOWED',
        message: 'This local agent path is not available.',
      });
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
