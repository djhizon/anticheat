import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'http';
import type { NetworkInterfaceInfo } from 'os';

/**
 * On-demand LAN listener for the iPhone companion app.
 *
 * The main exam server only listens on 127.0.0.1, so a phone on the same Wi-Fi cannot reach it.
 * While pairing is active this second listener is bound to the Mac's private IPv4 address and
 * serves ONLY the three presence endpoints the phone uses (claim, challenge, heartbeat).
 * Everything else answers 404, every request must
 * carry the exact LAN Host, bodies are small JSON, and callers are rate limited. Requests are
 * forwarded to the loopback API with only a fixed set of headers (never cookies).
 */

export const PHONE_LAN_PORT = 3443;
/** Largest accepted request body: presence pings are tiny JSON. */
export const PHONE_MAX_BODY_BYTES = 16 * 1024;
const UPSTREAM_TIMEOUT_MS = 15_000;
const MAX_CONNECTIONS = 32;

const PHONE_POST_PATHS: ReadonlySet<string> = new Set([
  '/exam/phone-presence/claim',
  '/exam/phone-presence/challenge',
  '/exam/phone-presence/heartbeat',
]);

/** True only for the exact POST routes the iPhone app uses; no query strings, no other methods. */
export function isPhoneRoute(method: string | undefined, url: string | undefined): boolean {
  if (method !== 'POST' || url === undefined || url.includes('?') || url.includes('#'))
    return false;
  return PHONE_POST_PATHS.has(url);
}

/** Rate-limit bucket for a phone route. */
export function routeBucket(url: string): 'claim' | 'other' {
  if (url === '/exam/phone-presence/claim') return 'claim';
  return 'other';
}

/** The LAN origin is reached only as exactly `<lan-ip>:<port>`; any other Host is refused. */
export function isAllowedLanHost(host: string | undefined, address: string, port: number): boolean {
  return host !== undefined && host.toLowerCase() === `${address}:${String(port)}`;
}

const PRIVATE_IPV4 = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/u;
const VIRTUAL_INTERFACE = /^(lo|utun|bridge|vmnet|vboxnet|awdl|llw|ap\d|gif|stf|anpi|docker|veth)/u;

/** The Mac's Wi-Fi/Ethernet private IPv4 (en* preferred); null when there is no usable network. */
export function pickLanAddress(
  interfaces: Readonly<Record<string, readonly NetworkInterfaceInfo[] | undefined>>,
): { address: string; name: string } | null {
  const candidates: { address: string; name: string }[] = [];
  for (const [name, infos] of Object.entries(interfaces)) {
    if (VIRTUAL_INTERFACE.test(name)) continue;
    for (const info of infos ?? []) {
      const ipv4 = info.family === 'IPv4' || (info.family as unknown) === 4;
      if (ipv4 && !info.internal && PRIVATE_IPV4.test(info.address))
        candidates.push({ address: info.address, name });
    }
  }
  candidates.sort((a, b) => Number(b.name.startsWith('en')) - Number(a.name.startsWith('en')));
  return candidates[0] ?? null;
}

export interface RateLimiter {
  /** True when the call is within its budget (and is counted). */
  take(key: string): boolean;
}

/** Fixed-window counter per key; stale keys are pruned so memory stays bounded. */
export function createRateLimiter(
  limit: number,
  windowMs: number,
  now: () => number = Date.now,
): RateLimiter {
  const windows = new Map<string, { start: number; count: number }>();
  return {
    take(key) {
      const at = now();
      if (windows.size > 1000) {
        for (const [k, w] of windows) if (at - w.start >= windowMs) windows.delete(k);
        if (windows.size > 1000) return false;
      }
      const current = windows.get(key);
      if (current === undefined || at - current.start >= windowMs) {
        windows.set(key, { start: at, count: 1 });
        return true;
      }
      current.count += 1;
      return current.count <= limit;
    },
  };
}

function reply(response: ServerResponse, status: number, text: string): void {
  if (response.headersSent) return;
  response.statusCode = status;
  response.setHeader('content-type', 'text/plain; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  response.setHeader('connection', 'close');
  response.end(text);
}

export interface PhoneLanServerOptions {
  readonly apiPort: number;
  readonly isAllowedHost: (host: string | undefined) => boolean;
  readonly now?: () => number;
}

function forward(
  request: IncomingMessage,
  response: ServerResponse,
  apiPort: number,
  declared: number,
): void {
  const headers: Record<string, string> = {
    host: `127.0.0.1:${String(apiPort)}`,
    'content-type': 'application/json',
    'content-length': String(declared),
    accept: 'application/json',
    connection: 'close',
  };
  const upstream = httpRequest(
    { host: '127.0.0.1', port: apiPort, method: 'POST', path: request.url, headers },
    (upstreamResponse) => {
      const type = upstreamResponse.headers['content-type'];
      response.writeHead(upstreamResponse.statusCode ?? 502, {
        'content-type': typeof type === 'string' ? type : 'application/json',
        'cache-control': 'no-store',
      });
      upstreamResponse.pipe(response);
    },
  );
  let timedOut = false;
  upstream.setTimeout(UPSTREAM_TIMEOUT_MS, () => {
    timedOut = true;
    upstream.destroy();
  });
  let received = 0;
  request.on('data', (chunk: Buffer) => {
    received += chunk.length;
    if (received > PHONE_MAX_BODY_BYTES && !upstream.destroyed) {
      upstream.destroy();
      reply(response, 413, 'The request body is too large.');
      request.destroy();
    }
  });
  upstream.on('error', () => {
    if (response.headersSent) response.destroy();
    else reply(response, timedOut ? 504 : 502, 'The exam app is not reachable.');
  });
  request.pipe(upstream);
}

/** Builds (does not start) the restricted phone server. */
export function createPhoneLanServer(options: PhoneLanServerOptions): Server {
  const now = options.now ?? Date.now;
  const limits = {
    claim: createRateLimiter(10, 60_000, now),
    other: createRateLimiter(60, 10_000, now),
  };
  const server = createServer((request, response) => {
    if (!options.isAllowedHost(request.headers.host)) {
      reply(response, 421, 'Misdirected request.');
      return;
    }
    if (!isPhoneRoute(request.method, request.url)) {
      reply(response, 404, 'Not found');
      return;
    }
    const url = request.url as string;
    const remote = request.socket.remoteAddress ?? 'unknown';
    if (!limits[routeBucket(url)].take(remote)) {
      response.setHeader('retry-after', '10');
      reply(response, 429, 'Too many requests.');
      return;
    }
    const type = request.headers['content-type'];
    if (typeof type !== 'string' || !/^application\/json\s*(;|$)/iu.test(type)) {
      reply(response, 415, 'JSON only.');
      return;
    }
    const lengthHeader = request.headers['content-length'];
    const declared = lengthHeader === undefined ? Number.NaN : Number(lengthHeader);
    if (!Number.isSafeInteger(declared) || declared < 0) {
      reply(response, 411, 'A Content-Length is required.');
      return;
    }
    if (declared > PHONE_MAX_BODY_BYTES) {
      reply(response, 413, 'The request body is too large.');
      request.destroy();
      return;
    }
    forward(request, response, options.apiPort, declared);
  });
  server.maxConnections = MAX_CONNECTIONS;
  server.headersTimeout = 5000;
  server.requestTimeout = 20_000;
  server.keepAliveTimeout = 3000;
  return server;
}

export type PhoneLanStart =
  | { readonly origin: string; readonly error?: undefined }
  | { readonly origin: null; readonly error: string };

export interface PhoneLanDeps {
  readonly apiPort: number;
  readonly port?: number;
  readonly getInterfaces: () => Parameters<typeof pickLanAddress>[0];
  readonly log?: (event: string, detail?: string | number) => void;
}

/** Starts the LAN listener when pairing is requested and stops it when the exam ends or the app quits. */
export function createPhoneLan(deps: PhoneLanDeps) {
  const port = deps.port ?? PHONE_LAN_PORT;
  let active: { server: Server; address: string } | null = null;
  let starting: Promise<PhoneLanStart> | null = null;

  const closeServer = (server: Server): Promise<void> =>
    new Promise((resolve) => {
      if (!server.listening) return resolve();
      server.close(() => resolve());
      server.closeAllConnections();
    });

  async function open(): Promise<PhoneLanStart> {
    const lan = pickLanAddress(deps.getInterfaces());
    if (lan === null)
      return {
        origin: null,
        error:
          'No Wi-Fi or Ethernet network was found. Connect this Mac to the same Wi-Fi as your iPhone.',
      };
    if (active?.address === lan.address) return { origin: `http://${lan.address}:${String(port)}` };
    if (active) await closeServer(active.server); // The network changed: rebind to the new address.
    active = null;
    const server = createPhoneLanServer({
      apiPort: deps.apiPort,
      isAllowedHost: (host) => isAllowedLanHost(host, lan.address, port),
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, lan.address, () => {
          server.off('error', reject);
          resolve();
        });
      });
    } catch (error) {
      deps.log?.('phone-lan-failed', (error as NodeJS.ErrnoException).code ?? 'error');
      return {
        origin: null,
        error:
          (error as NodeJS.ErrnoException).code === 'EADDRINUSE'
            ? `Port ${String(port)} is in use by another program, so the iPhone cannot connect. Close it and try again.`
            : 'The phone connection could not be opened on this network.',
      };
    }
    active = { server, address: lan.address };
    deps.log?.('phone-lan-started');
    return { origin: `http://${lan.address}:${String(port)}` };
  }

  return {
    start(): Promise<PhoneLanStart> {
      starting ??= open().finally(() => {
        starting = null;
      });
      return starting;
    },
    async stop(): Promise<void> {
      await starting?.catch(() => undefined);
      const current = active;
      active = null;
      if (current) {
        await closeServer(current.server);
        deps.log?.('phone-lan-stopped');
      }
    },
    isActive: (): boolean => active !== null,
  };
}
