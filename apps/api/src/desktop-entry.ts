/* global console, process */

import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { dirname, join, resolve } from 'node:path';

import { loadConfig } from './config.js';
import { seedDemo, seedDemoOnce } from './demoSeed.js';
import { createApiServer, MAX_REQUEST_BODY_BYTES } from './server.js';
import { createStaticWebHandler, isApiPath } from './staticWeb.js';

/**
 * Entry point of the bundled server used by the desktop app. It serves the API on
 * 127.0.0.1:<API_PORT> and the built web app (plus /auth and /exam forwarding) on
 * 127.0.0.1:<WEB_PORT>. NODE_ENV is deliberately left alone: production demands HTTPS origins.
 */
export interface DesktopServerOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly cwd?: string;
}

export interface DesktopServer {
  readonly apiPort: number;
  readonly webPort: number;
  stop(): Promise<void>;
}

/** Replaced by `true` when esbuild bundles this file as the standalone server. */
declare const __DESKTOP_BUNDLE__: boolean | undefined;

function port(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`${name} must be a valid port number.`);
  }
  return parsed;
}

function tooLarge(response: ServerResponse): void {
  if (response.headersSent) return;
  response.statusCode = 413;
  response.setHeader('connection', 'close');
  response.end('The request body is too large.');
}

/** Streams the request to the API and the response back; bodies are never buffered. */
function forward(request: IncomingMessage, response: ServerResponse, apiPort: number): void {
  const declared = Number(request.headers['content-length'] ?? 0);
  if (declared > MAX_REQUEST_BODY_BYTES) {
    tooLarge(response);
    request.destroy();
    return;
  }
  const upstream = httpRequest(
    {
      host: '127.0.0.1',
      port: apiPort,
      method: request.method,
      path: request.url,
      headers: request.headers,
    },
    (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    },
  );
  let received = 0;
  request.on('data', (chunk: Buffer) => {
    received += chunk.length;
    if (received > MAX_REQUEST_BODY_BYTES && !upstream.destroyed) {
      upstream.destroy();
      tooLarge(response);
      request.destroy();
    }
  });
  upstream.on('error', () => {
    if (response.headersSent) {
      response.destroy();
      return;
    }
    response.statusCode = 502;
    response.setHeader('content-type', 'text/plain; charset=utf-8');
    response.end('The API is not reachable.');
  });
  request.pipe(upstream);
}

function createWebServer(webRoot: string, apiPort: number): Server {
  const staticWeb = createStaticWebHandler(webRoot);
  return createServer((request, response) => {
    void (async () => {
      if (await staticWeb(request, response)) return;
      const pathname = (request.url ?? '/').split('?')[0] ?? '/';
      if (!isApiPath(pathname)) {
        response.statusCode = 404;
        response.setHeader('content-type', 'text/plain; charset=utf-8');
        response.end('Not found');
        return;
      }
      forward(request, response, apiPort);
    })().catch(() => {
      if (!response.headersSent) response.statusCode = 502;
      response.end();
    });
  });
}

function listen(server: Server, listenPort: number): Promise<void> {
  return new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(listenPort, '127.0.0.1', () => {
      server.off('error', reject);
      resolveListen();
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolveClose) => {
    if (!server.listening) {
      resolveClose();
      return;
    }
    server.close(() => resolveClose());
    server.closeAllConnections();
  });
}

export async function startDesktopServer(options: DesktopServerOptions): Promise<DesktopServer> {
  const env = { ...options.env };
  const cwd = options.cwd ?? process.cwd();
  const apiPort = port(env.API_PORT ?? env.PORT, 3000, 'API_PORT');
  const webPort = port(env.WEB_PORT, 5173, 'WEB_PORT');
  const webRoot = env.SERVE_WEB_DIST?.trim();
  if (!webRoot) throw new Error('SERVE_WEB_DIST must point at the built web app.');
  env.DATABASE_PATH = resolve(cwd, env.DATABASE_PATH?.trim() || 'data/exam-anti-cheat.sqlite');
  env.PORT = String(apiPort);
  const dataDir = dirname(env.DATABASE_PATH);

  // Opening the database (by the seed and by the API) applies pending migrations.
  const seeded = await seedDemoOnce(join(dataDir, 'seeded'), () => seedDemo({ env }));
  console.log(seeded ? 'Demo data seeded.' : 'Demo data already seeded.');

  const application = createApiServer(loadConfig(env));
  const web = createWebServer(resolve(webRoot), apiPort);
  try {
    await application.start(apiPort, '127.0.0.1');
    await listen(web, webPort);
  } catch (error) {
    await close(web);
    await application.stop().catch(() => undefined);
    throw error;
  }
  return {
    apiPort,
    webPort,
    stop: async () => {
      await close(web);
      await application.stop();
    },
  };
}

if (typeof __DESKTOP_BUNDLE__ !== 'undefined' && __DESKTOP_BUNDLE__) {
  let server: DesktopServer | undefined;
  let stopping = false;
  const shutdown = (): void => {
    if (stopping) return;
    stopping = true;
    void (server?.stop() ?? Promise.resolve()).finally(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  const parentPort = (
    process as unknown as {
      parentPort?: { on(event: 'message', listener: (e: { data?: unknown }) => void): void };
    }
  ).parentPort;
  parentPort?.on('message', (event) => {
    if (event.data === 'shutdown') shutdown();
  });
  startDesktopServer({ env: process.env, cwd: process.cwd() }).then(
    (started) => {
      server = started;
      console.log(
        `exam-anti-cheat desktop server ready: api ${started.apiPort}, web ${started.webPort}`,
      );
    },
    (error: unknown) => {
      console.error(
        'exam-anti-cheat desktop server failed:',
        error instanceof Error ? error.message : error,
      );
      process.exit(1);
    },
  );
}
