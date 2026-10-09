import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

import {
  DomainError,
  problemFromError,
  type ProblemCode,
  type ProblemDetails,
} from '@exam-anti-cheat/contracts';

import { loadConfig, type ApiConfig } from './config.js';
import { createAuthPlugin, type AuthPlugin, type AuthRequest } from './modules/auth/auth.plugin.js';
import type { AuthResponse } from './modules/auth/auth.routes.js';
import { createExamPlugin, type ExamPlugin } from './modules/exam/exam.plugin.js';
import type { ExamResponse } from './modules/exam/exam.routes.js';

export const MAX_REQUEST_BODY_BYTES = 15 * 1024 * 1024; // 15MB to allow video chunk uploads
export const MAX_BODY_DRAIN_MS = 1000;

type RouteResponse = AuthResponse | ExamResponse;

/**
 * The server is intentionally non-restartable: created -> starting -> running
 * -> stopping -> stopped. Once shutdown starts, start() rejects so a closed
 * SQLite handle cannot be paired with a reopened listener.
 */
type LifecycleState = 'created' | 'starting' | 'running' | 'stopping' | 'stopped';

const problemStatus: Record<ProblemCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  validation_failed: 400,
  invalid_state: 500,
};

class HttpProblemError extends Error {
  constructor(
    readonly status: number,
    readonly problem: ProblemDetails,
  ) {
    super(problem.message);
    this.name = 'HttpProblemError';
  }
}

function requestHeaders(request: IncomingMessage): Readonly<Record<string, string | undefined>> {
  const headers: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    headers[name] = Array.isArray(value) ? value.join(', ') : value;
  }
  return headers;
}

async function readJsonBody(request: IncomingMessage): Promise<unknown | undefined> {
  const contentLength = request.headers['content-length'];
  if (contentLength !== undefined) {
    const parsedLength = Number(contentLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0) {
      throw new DomainError('validation_failed', 'The request body length is invalid.');
    }
  }

  const declaredLength = contentLength === undefined ? undefined : Number(contentLength);
  const body = await readRequestBytes(
    request,
    declaredLength !== undefined && declaredLength > MAX_REQUEST_BODY_BYTES,
  );
  if (body.timedOut || body.oversized || (declaredLength ?? 0) > MAX_REQUEST_BODY_BYTES) {
    throw new HttpProblemError(413, {
      code: 'validation_failed',
      message: 'The request body is too large.',
    });
  }

  if (body.bytes.length === 0) {
    return undefined;
  }

  if (!['POST', 'PUT', 'PATCH'].includes((request.method ?? 'GET').toUpperCase())) {
    throw new DomainError('validation_failed', 'This request method does not accept a body.');
  }

  try {
    return JSON.parse(body.bytes.toString('utf8')) as unknown;
  } catch {
    throw new DomainError('validation_failed', 'The request body must be valid JSON.');
  }
}

interface RequestBytes {
  readonly bytes: Buffer;
  readonly oversized: boolean;
  readonly timedOut: boolean;
}

function readRequestBytes(
  request: IncomingMessage,
  declaredOversized: boolean,
): Promise<RequestBytes> {
  return new Promise<RequestBytes>((resolveBytes) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let oversized = false;
    let settled = false;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (timedOut: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (drainTimer !== undefined) {
        clearTimeout(drainTimer);
      }
      resolveBytes({
        bytes: Buffer.concat(chunks),
        oversized,
        timedOut,
      });
    };

    const armDrainDeadline = (): void => {
      if (drainTimer !== undefined) {
        return;
      }
      drainTimer = setTimeout(() => {
        request.destroy();
        finish(true);
      }, MAX_BODY_DRAIN_MS);
    };

    if (declaredOversized) {
      armDrainDeadline();
    }

    request.on('data', (chunk: Buffer | string) => {
      if (oversized) {
        return;
      }

      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.byteLength;
      if (size > MAX_REQUEST_BODY_BYTES) {
        oversized = true;
        armDrainDeadline();
        return;
      }
      chunks.push(buffer);
    });
    request.once('end', () => finish(false));
    request.once('aborted', () => finish(true));
    request.once('error', () => finish(true));
    request.once('close', () => finish(!request.complete));
    request.resume();
  });
}

function corsHeaders(
  request: IncomingMessage,
  allowedOrigins: readonly string[],
): Record<string, string> {
  const headers: Record<string, string> = { vary: 'Origin' };
  const origin = request.headers.origin;
  if (typeof origin === 'string' && allowedOrigins.includes(origin)) {
    headers['access-control-allow-origin'] = origin;
    headers['access-control-allow-credentials'] = 'true';
    headers['access-control-allow-methods'] = 'GET, POST, PUT, OPTIONS';
    headers['access-control-allow-headers'] = 'Content-Type, X-CSRF-Token, X-Requested-With';
  }
  return headers;
}

function problemResponse(
  request: IncomingMessage,
  config: ApiConfig,
  error: unknown,
): RouteResponse {
  const isHttpProblem = error instanceof HttpProblemError;
  const problem = isHttpProblem ? error.problem : problemFromError(error);
  return {
    status: isHttpProblem ? error.status : problemStatus[problem.code],
    headers: {
      ...corsHeaders(request, config.allowedOrigins),
      'cache-control': 'no-store',
      'content-type': 'application/problem+json',
      ...(isHttpProblem && error.status === 413 ? { connection: 'close' } : {}),
    },
    body: problem,
  };
}

function responseHeaders(response: RouteResponse): Readonly<Record<string, string | string[]>> {
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(response.headers)) {
    headers[name] = typeof value === 'string' ? value : Array.from(value);
  }
  return headers;
}

function sendResponse(response: ServerResponse, result: RouteResponse): void {
  response.statusCode = result.status;
  for (const [name, value] of Object.entries(responseHeaders(result))) {
    response.setHeader(name, value);
  }

  if (result.status === 204) {
    response.end();
    return;
  }

  response.end(JSON.stringify(result.body));
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  app: ApiApplication,
): Promise<void> {
  let result: RouteResponse;
  try {
    const body = await readJsonBody(request);
    const authRequest: AuthRequest = {
      method: request.method ?? 'GET',
      path: request.url ?? '/',
      headers: requestHeaders(request),
      ...(request.socket.remoteAddress === undefined
        ? {}
        : { remoteAddress: request.socket.remoteAddress }),
      ...(body === undefined ? {} : { body }),
    };

    if ((request.url ?? '/').split('?')[0]?.startsWith('/exam/') === true) {
      result = await app.exam.routes.handle(authRequest);
    } else {
      result = await app.auth.routes.handle(authRequest);
    }
  } catch (error) {
    result = problemResponse(request, app.config, error);
  }

  sendResponse(response, result);
}

export interface ApiApplication {
  readonly config: ApiConfig;
  readonly server: Server;
  readonly auth: AuthPlugin;
  readonly exam: ExamPlugin;
  start(port?: number, hostname?: string): Promise<AddressInfo>;
  stop(): Promise<void>;
}

export function createApiServer(config: ApiConfig = loadConfig()): ApiApplication {
  const auth = createAuthPlugin(config);
  const exam = createExamPlugin(auth.database, auth.boundary, config);
  const server = createHttpServer((request, response) => {
    void handleRequest(request, response, application).catch((error: unknown) => {
      sendResponse(response, problemResponse(request, config, error));
    });
  });
  const activeSockets = new Set<Socket>();
  server.on('connection', (socket) => {
    activeSockets.add(socket);
    socket.once('close', () => activeSockets.delete(socket));
  });

  let lifecycleState: LifecycleState = 'created';
  let startPromise: Promise<AddressInfo> | undefined;
  let closePromise: Promise<void> | undefined;
  const application: ApiApplication = {
    config,
    server,
    auth,
    exam,
    start: (port = config.port, hostname = '127.0.0.1') => {
      if (lifecycleState === 'stopping' || lifecycleState === 'stopped') {
        return Promise.reject(new Error('The API server cannot be started after shutdown begins.'));
      }

      if (lifecycleState === 'running') {
        if (server.listening) {
          const address = server.address();
          if (address !== null && typeof address !== 'string') {
            return Promise.resolve(address);
          }
        }

        return Promise.reject(new Error('The HTTP server lifecycle state is invalid.'));
      }

      if (lifecycleState === 'starting') {
        return startPromise ?? Promise.reject(new Error('The API server is already starting.'));
      }

      lifecycleState = 'starting';
      const operation = new Promise<AddressInfo>((resolveAddress, reject) => {
        const onError = (error: Error): void => {
          server.off('listening', onListening);
          reject(error);
        };
        const onListening = (): void => {
          server.off('error', onError);
          const address = server.address();
          if (address === null || typeof address === 'string') {
            reject(new Error('The HTTP server did not expose an address.'));
            return;
          }
          resolveAddress(address);
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, hostname);
      });
      const trackedOperation = operation.then(
        (address) => {
          if (lifecycleState !== 'starting') {
            throw new Error('The API server stopped while it was starting.');
          }
          lifecycleState = 'running';
          startPromise = undefined;
          return address;
        },
        (error: unknown) => {
          startPromise = undefined;
          if (lifecycleState === 'starting') {
            lifecycleState = 'created';
          }
          throw error;
        },
      );
      startPromise = trackedOperation;
      return trackedOperation;
    },
    stop: () => {
      if (closePromise !== undefined) {
        return closePromise;
      }

      lifecycleState = 'stopping';
      closePromise = new Promise<void>((resolveClose, rejectClose) => {
        let shutdownTimer: ReturnType<typeof setTimeout> | undefined;
        let settled = false;

        const finish = (error?: unknown): void => {
          if (settled) {
            return;
          }
          settled = true;
          if (shutdownTimer !== undefined) {
            clearTimeout(shutdownTimer);
          }
          activeSockets.clear();

          try {
            auth.close();
          } catch (closeError) {
            lifecycleState = 'stopped';
            rejectClose(closeError);
            return;
          }

          lifecycleState = 'stopped';
          if (error !== undefined) {
            rejectClose(error);
            return;
          }
          resolveClose();
        };

        const forceCloseConnections = (): void => {
          for (const socket of activeSockets) {
            socket.destroy();
          }
        };

        const beginClose = (): void => {
          try {
            if (!server.listening) {
              finish();
              return;
            }

            shutdownTimer = setTimeout(forceCloseConnections, MAX_BODY_DRAIN_MS);
            server.close((error) => {
              if (error !== undefined) {
                finish(error);
                return;
              }
              finish();
            });
          } catch (error) {
            finish(error);
          }
        };

        const pendingStart = startPromise;
        if (pendingStart !== undefined) {
          void pendingStart.then(beginClose, beginClose);
        } else {
          beginClose();
        }
      });

      return closePromise;
    },
  };

  return application;
}
