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
  /** Resolves when background demo seeding has finished (never rejects). */
  readonly seeding: Promise<void>;
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

/** The demo accounts are created only when the judge-build flag is passed in explicitly. */
export function shouldSeedDemo(env: NodeJS.ProcessEnv): boolean {
  return env.EAC_SEED_DEMO === '1';
}

/** The local proxy is reached only as the app's own origin; other Host values (DNS rebinding) are refused. */
const ALLOWED_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1:5173', 'localhost:5173']);
/** Upstream API calls must answer within this time (transcription uploads stay well below it). */
export const UPSTREAM_TIMEOUT_MS = 120_000;

export function isAllowedHost(host: string | undefined, webPort: number): boolean {
  if (host === undefined) return false;
  const value = host.toLowerCase();
  return webPort === 5173
    ? ALLOWED_HOSTS.has(value)
    : value === `127.0.0.1:${webPort}` || value === `localhost:${webPort}`;
}

/** The API port accepts its own loopback hosts plus the web port's (the proxy forwards Host as-is). */
export function isAllowedApiHost(
  host: string | undefined,
  apiPort: number,
  webPort: number,
): boolean {
  if (host === undefined) return false;
  const value = host.toLowerCase();
  return (
    value === `127.0.0.1:${apiPort}` ||
    value === `localhost:${apiPort}` ||
    isAllowedHost(value, webPort)
  );
}

/** Each server gets this long to stop gracefully before it is forced. */
export const SERVER_STOP_TIMEOUT_MS = 3000;

/** Marker header so the Electron shell can tell a stale copy of this server from another program. */
export const SERVER_MARKER_HEADER = 'x-eac-server';
export const SERVER_MARKER_VALUE = 'desktop';

/** How often the server checks that the Electron process that started it is still alive. */
export const PARENT_POLL_MS = 2000;

/**
 * True when the process that started this server is gone: it was reparented (ppid changed or
 * became 1/launchd) or the original parent no longer exists. Pure so it can be unit tested.
 */
export function parentHasDied(state: {
  readonly initialPpid: number;
  readonly currentPpid: number;
  readonly parentAlive: boolean;
}): boolean {
  if (state.initialPpid <= 1) return false; // Not started by a parent we can watch.
  return state.currentPpid !== state.initialPpid || !state.parentAlive;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function tooLarge(response: ServerResponse): void {
  if (response.headersSent) return;
  response.statusCode = 413;
  response.setHeader('connection', 'close');
  response.end('The request body is too large.');
}

/** Streams the request to the API and the response back; bodies are never buffered. */
function forward(
  request: IncomingMessage,
  response: ServerResponse,
  apiPort: number,
  timeoutMs: number,
): void {
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
  let timedOut = false;
  upstream.setTimeout(timeoutMs, () => {
    timedOut = true;
    upstream.destroy();
  });
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
    response.statusCode = timedOut ? 504 : 502;
    response.setHeader('content-type', 'text/plain; charset=utf-8');
    response.end(timedOut ? 'The API did not respond in time.' : 'The API is not reachable.');
  });
  request.pipe(upstream);
}

export function createWebServer(
  webRoot: string,
  apiPort: number,
  webPort = 5173,
  upstreamTimeoutMs = UPSTREAM_TIMEOUT_MS,
): Server {
  const staticWeb = createStaticWebHandler(webRoot);
  return createServer((request, response) => {
    response.setHeader(SERVER_MARKER_HEADER, SERVER_MARKER_VALUE);
    if (!isAllowedHost(request.headers.host, webPort)) {
      response.statusCode = 421;
      response.setHeader('content-type', 'text/plain; charset=utf-8');
      response.setHeader('connection', 'close');
      response.end('Misdirected request.');
      return;
    }
    void (async () => {
      if (await staticWeb(request, response)) return;
      const pathname = (request.url ?? '/').split('?')[0] ?? '/';
      if (!isApiPath(pathname)) {
        response.statusCode = 404;
        response.setHeader('content-type', 'text/plain; charset=utf-8');
        response.end('Not found');
        return;
      }
      forward(request, response, apiPort, upstreamTimeoutMs);
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

  const application = createApiServer(loadConfig(env), {
    isAllowedHost: (host) => isAllowedApiHost(host, apiPort, webPort),
  });
  const web = createWebServer(resolve(webRoot), apiPort, webPort);
  try {
    await application.start(apiPort, '127.0.0.1');
    await listen(web, webPort);
  } catch (error) {
    await close(web);
    await application.stop().catch(() => undefined);
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      throw new Error(
        `Port ${String(apiPort)} or ${String(webPort)} on 127.0.0.1 is already in use (possibly a stale copy of this server left behind by a crash).`,
        { cause: error },
      );
    }
    throw error;
  }
  // Only the judge build seeds demo/instructor accounts (flag set by the Electron runtime).
  // Seeding runs after both servers listen, so a slow first seed (it can call out for question
  // generation) never delays readiness. A failure is logged and retried on the next launch.
  let seeding: Promise<void> = Promise.resolve();
  if (shouldSeedDemo(env)) {
    seeding = seedDemoOnce(join(dataDir, 'seeded'), (seedOptions) =>
      seedDemo({ env, wipe: seedOptions.wipe }),
    ).then(
      (seeded) => console.log(seeded ? 'Demo data seeded.' : 'Demo data already seeded.'),
      (error: unknown) =>
        console.error(
          'Demo data seeding failed; it will be retried on the next launch:',
          error instanceof Error ? error.message : error,
        ),
    );
  } else {
    console.log('Demo seeding is disabled for this build.');
  }
  return {
    apiPort,
    webPort,
    seeding,
    stop: async () => {
      // Each listener gets a bounded time to close; after that the process is torn down anyway.
      const started = Date.now();
      const bounded = (label: string, operation: Promise<unknown>): Promise<void> =>
        new Promise<void>((resolveStop) => {
          const timer = setTimeout(() => {
            console.warn(
              `${label} did not stop within ${String(SERVER_STOP_TIMEOUT_MS)} ms; forcing.`,
            );
            if (label === 'web') web.closeAllConnections();
            resolveStop();
          }, SERVER_STOP_TIMEOUT_MS);
          operation
            .then(
              () => undefined,
              (error: unknown) =>
                console.warn(
                  `${label} stop failed:`,
                  error instanceof Error ? error.message : error,
                ),
            )
            .finally(() => {
              clearTimeout(timer);
              resolveStop();
            });
        });
      await Promise.all([bounded('web', close(web)), bounded('api', application.stop())]);
      console.log(`Desktop servers stopped in ${String(Date.now() - started)} ms.`);
    },
  };
}

if (typeof __DESKTOP_BUNDLE__ !== 'undefined' && __DESKTOP_BUNDLE__) {
  let server: DesktopServer | undefined;
  let stopping = false;
  const shutdown = (): void => {
    if (stopping) return;
    stopping = true;
    setTimeout(() => process.exit(0), 5000).unref(); // Never linger if a graceful stop hangs.
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
  // If the Electron main process crashes, nothing else would stop this server (it would hold
  // ports 3000/5173 and block the next launch), so exit when the parent goes away.
  if (process.env.EAC_EXIT_WITH_PARENT === '1') {
    const initialPpid = process.ppid;
    const timer = setInterval(() => {
      if (
        parentHasDied({
          initialPpid,
          currentPpid: process.ppid,
          parentAlive: pidAlive(initialPpid),
        })
      )
        shutdown();
    }, PARENT_POLL_MS);
    timer.unref();
  }
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
