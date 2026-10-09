import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createWebServer,
  isAllowedApiHost,
  isAllowedHost,
  parentHasDied,
  shouldSeedDemo,
} from './desktop-entry.js';
import { loadConfig } from './config.js';
import { createApiServer } from './server.js';

const servers: Server[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function listen(server: Server): Promise<number> {
  servers.push(server);
  return new Promise((done) =>
    server.listen(0, '127.0.0.1', () => done((server.address() as AddressInfo).port)),
  );
}

function get(port: number, path: string, host?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path, headers: host === undefined ? {} : { host } },
      (response) => {
        let body = '';
        response.on('data', (chunk: Buffer) => (body += chunk.toString()));
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('shouldSeedDemo', () => {
  it('seeds only when the judge-build flag is explicitly set', () => {
    expect(shouldSeedDemo({ EAC_SEED_DEMO: '1' })).toBe(true);
    for (const value of [undefined, '', '0', 'true', 'yes'])
      expect(shouldSeedDemo({ EAC_SEED_DEMO: value })).toBe(false);
    expect(shouldSeedDemo({})).toBe(false);
  });
});

describe('isAllowedHost', () => {
  it('allows only the app origin hosts', () => {
    expect(isAllowedHost('127.0.0.1:5173', 5173)).toBe(true);
    expect(isAllowedHost('localhost:5173', 5173)).toBe(true);
    expect(isAllowedHost('LOCALHOST:5173', 5173)).toBe(true);
    for (const host of [
      undefined,
      '',
      'evil.test',
      'evil.test:5173',
      '127.0.0.1',
      '127.0.0.1:3000',
    ])
      expect(isAllowedHost(host, 5173)).toBe(false);
  });
});

describe('local proxy', () => {
  function setup(apiPort: number, timeoutMs: number) {
    const webRoot = mkdtempSync(join(tmpdir(), 'eac-web-'));
    directories.push(webRoot);
    return listen(createWebServer(webRoot, apiPort, 5173, timeoutMs));
  }

  it('refuses foreign Host headers before reaching the API', async () => {
    let reached = false;
    const api = createServer((_req, res) => {
      reached = true;
      res.end('ok');
    });
    const apiPort = await listen(api);
    const webPort = await setup(apiPort, 1000);

    expect((await get(webPort, '/exam/x', 'evil.test:5173')).status).toBe(421);
    expect((await get(webPort, '/exam/x', 'evil.test')).status).toBe(421);
    expect(reached).toBe(false);
    const ok = await get(webPort, '/exam/x', '127.0.0.1:5173');
    expect(ok).toEqual({ status: 200, body: 'ok' });
  });

  it('answers 504 when the API does not respond in time', async () => {
    const api = createServer(() => {
      /* Never answer. */
    });
    const apiPort = await listen(api);
    const webPort = await setup(apiPort, 100);
    const result = await get(webPort, '/exam/slow', 'localhost:5173');
    expect(result.status).toBe(504);
  });
});

describe('isAllowedApiHost', () => {
  it('allows loopback API and web hosts only', () => {
    for (const host of ['127.0.0.1:3000', 'localhost:3000', 'LOCALHOST:3000', '127.0.0.1:5173'])
      expect(isAllowedApiHost(host, 3000, 5173)).toBe(true);
    for (const host of [undefined, '', 'evil.test', 'evil.test:3000', '127.0.0.1', '127.0.0.1:80'])
      expect(isAllowedApiHost(host, 3000, 5173)).toBe(false);
  });

  it('is enforced by the API server before any route runs', async () => {
    const app = createApiServer(
      loadConfig({ NODE_ENV: 'test', DATABASE_PATH: ':memory:', COOKIE_SECURE: 'false' }),
      { isAllowedHost: (host) => isAllowedApiHost(host, 3000, 5173) },
    );
    const address = await app.start(0);
    try {
      expect((await get(address.port, '/auth/csrf', 'evil.test:3000')).status).toBe(421);
      expect((await get(address.port, '/auth/csrf', 'evil.test')).status).toBe(421);
      expect((await get(address.port, '/auth/csrf', '127.0.0.1:3000')).status).not.toBe(421);
    } finally {
      await app.stop();
    }
  });
});

describe('web server marker', () => {
  it('tags responses so a stale copy of this server can be recognised', async () => {
    const webRoot = mkdtempSync(join(tmpdir(), 'eac-web-'));
    directories.push(webRoot);
    const port = await listen(createWebServer(webRoot, 1, 5173, 100));
    const status = await new Promise<string | undefined>((resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port, path: '/', headers: { host: 'evil' } },
        (r) => {
          r.resume();
          resolve(r.headers['x-eac-server'] as string | undefined);
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe('desktop');
  });
});

describe('parentHasDied', () => {
  it('detects reparenting or a vanished parent, and ignores unwatchable parents', () => {
    expect(parentHasDied({ initialPpid: 500, currentPpid: 500, parentAlive: true })).toBe(false);
    expect(parentHasDied({ initialPpid: 500, currentPpid: 1, parentAlive: true })).toBe(true);
    expect(parentHasDied({ initialPpid: 500, currentPpid: 500, parentAlive: false })).toBe(true);
    expect(parentHasDied({ initialPpid: 500, currentPpid: 777, parentAlive: true })).toBe(true);
    expect(parentHasDied({ initialPpid: 1, currentPpid: 1, parentAlive: false })).toBe(false);
    expect(parentHasDied({ initialPpid: 0, currentPpid: 0, parentAlive: false })).toBe(false);
  });
});
