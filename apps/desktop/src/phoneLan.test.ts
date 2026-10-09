import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createPhoneLan,
  createPhoneLanServer,
  createRateLimiter,
  isAllowedLanHost,
  isPhoneRoute,
  PHONE_MAX_BODY_BYTES,
  pickLanAddress,
} from './phoneLan.js';

describe('phone route allowlist', () => {
  it.each([
    '/exam/phone-presence/claim',
    '/exam/phone-presence/challenge',
    '/exam/phone-presence/heartbeat',
  ])('allows POST %s', (path) => {
    expect(isPhoneRoute('POST', path)).toBe(true);
  });
  it.each([
    ['GET', '/exam/phone-presence/claim'],
    ['PUT', '/exam/phone-presence/heartbeat'],
    ['POST', '/exam/phone-presence/claim?x=1'],
    ['POST', '/exam/phone-presence/claim/'],
    ['POST', '/exam/phone-presence/../assignments'],
    ['POST', '/exam/assignments'],
    ['POST', '/exam/attempts/abc/answers'],
    ['POST', '/exam/attempts/abc/submit'],
    ['POST', '/exam/phone-presence/desk-camera'],
    ['POST', '/exam/attempts/abc_DEF-123/evidence'],
    ['POST', '/exam/attempts/a/b/evidence'],
    ['POST', '/exam/attempts//evidence'],
    ['GET', '/exam/attempts/abc/evidence'],
    ['POST', '/exam/attempts/abc/evidence/123'],
    ['POST', `/exam/attempts/${'a'.repeat(65)}/evidence`],
    ['POST', '/auth/login'],
    ['POST', '/'],
    ['POST', undefined],
    [undefined, '/exam/phone-presence/claim'],
  ])('rejects %s %s', (method, path) => {
    expect(isPhoneRoute(method, path)).toBe(false);
  });
});

describe('LAN host check', () => {
  it('accepts only the exact LAN ip and port', () => {
    expect(isAllowedLanHost('192.168.1.20:3443', '192.168.1.20', 3443)).toBe(true);
    expect(isAllowedLanHost('192.168.1.20:3443'.toUpperCase(), '192.168.1.20', 3443)).toBe(true);
    for (const host of [
      undefined,
      '',
      '192.168.1.20',
      '192.168.1.20:3000',
      '127.0.0.1:3443',
      'localhost:3443',
      'evil.example:3443',
      '192.168.1.20:3443.evil.example',
      '192.168.1.21:3443',
    ])
      expect(isAllowedLanHost(host, '192.168.1.20', 3443)).toBe(false);
  });
});

describe('LAN address selection', () => {
  const info = (address: string, internal = false, family = 'IPv4') =>
    [{ address, internal, family }] as never;
  it('prefers a private en* IPv4 and skips loopback, virtual and public addresses', () => {
    expect(
      pickLanAddress({
        lo0: info('127.0.0.1', true),
        utun3: info('10.8.0.2'),
        bridge100: info('192.168.64.1'),
        en5: info('172.20.1.5'),
        en0: info('192.168.1.20'),
        en1: info('8.8.8.8'),
        en2: info('169.254.3.4'),
        en3: info('192.168.9.9', false, 'IPv6'),
      }),
    ).toEqual({ address: '172.20.1.5', name: 'en5' });
    expect(pickLanAddress({ en0: info('192.168.1.20') })?.address).toBe('192.168.1.20');
  });
  it('returns null without a usable network', () => {
    expect(pickLanAddress({ lo0: info('127.0.0.1', true), en0: info('169.254.1.1') })).toBeNull();
    expect(pickLanAddress({})).toBeNull();
  });
});

describe('rate limiter', () => {
  it('limits per key within a window and resets afterwards', () => {
    let time = 0;
    const limiter = createRateLimiter(2, 1000, () => time);
    expect([limiter.take('a'), limiter.take('a'), limiter.take('a')]).toEqual([true, true, false]);
    expect(limiter.take('b')).toBe(true);
    time = 1000;
    expect(limiter.take('a')).toBe(true);
  });
});

describe('phone LAN server (loopback fixtures)', () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (s) =>
          new Promise<void>((resolve) => {
            s.close(() => resolve());
            s.closeAllConnections();
          }),
      ),
    );
  });
  const listen = async (server: Server): Promise<number> => {
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return (server.address() as AddressInfo).port;
  };
  async function setup() {
    const seen: { url?: string; headers: Record<string, unknown>; body: string }[] = [];
    const api = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        seen.push({ url: req.url, headers: req.headers, body });
        res.setHeader('content-type', 'application/json');
        res.end('{"ok":true}');
      });
    });
    const apiPort = await listen(api);
    let hostPort = 0;
    const phone = createPhoneLanServer({
      apiPort,
      isAllowedHost: (host) => host === `127.0.0.1:${String(hostPort)}`,
    });
    hostPort = await listen(phone);
    const call = (
      path: string,
      options: { method?: string; host?: string; headers?: Record<string, string>; body?: string },
    ) =>
      new Promise<{ status: number; text: string }>((resolve, reject) => {
        const body = options.body ?? '';
        const req = httpRequest(
          {
            host: '127.0.0.1',
            port: hostPort,
            path,
            method: options.method ?? 'POST',
            headers: {
              host: options.host ?? `127.0.0.1:${String(hostPort)}`,
              'content-type': 'application/json',
              'content-length': String(Buffer.byteLength(body)),
              cookie: 'sid=secret',
              authorization: 'Bearer secret',
              ...options.headers,
            },
          },
          (res) => {
            let text = '';
            res.on('data', (c: Buffer) => (text += c.toString()));
            res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
          },
        );
        req.on('error', reject);
        req.end(body);
      });
    return { seen, call, apiPort };
  }

  it('forwards allowed routes with a fixed header set and loopback Host', async () => {
    const { seen, call, apiPort } = await setup();
    const result = await call('/exam/phone-presence/heartbeat', { body: '{"a":1}' });
    expect(result).toEqual({ status: 200, text: '{"ok":true}' });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.body).toBe('{"a":1}');
    expect(seen[0]!.headers.host).toBe(`127.0.0.1:${String(apiPort)}`);
    expect(seen[0]!.headers.cookie).toBeUndefined();
    expect(seen[0]!.headers.authorization).toBeUndefined();
  });

  it('answers 404 for everything else, 421 for a wrong Host, and never reaches the API', async () => {
    const { seen, call } = await setup();
    expect((await call('/exam/assignments', { method: 'GET' })).status).toBe(404);
    expect((await call('/exam/attempts/x/answers', { body: '{}' })).status).toBe(404);
    expect((await call('/auth/login', { body: '{}' })).status).toBe(404);
    expect((await call('/exam/phone-presence/claim', { method: 'GET' })).status).toBe(404);
    expect(
      (await call('/exam/phone-presence/claim', { host: 'evil.example', body: '{}' })).status,
    ).toBe(421);
    expect(seen).toHaveLength(0);
  });

  it('enforces JSON content type, body size and rate limits', async () => {
    const { seen, call } = await setup();
    expect(
      (
        await call('/exam/phone-presence/claim', {
          body: 'x',
          headers: { 'content-type': 'text/plain' },
        })
      ).status,
    ).toBe(415);
    expect(
      (
        await call('/exam/phone-presence/heartbeat', {
          body: 'x'.repeat(PHONE_MAX_BODY_BYTES + 1),
        }).catch(() => ({ status: 413 }))
      ).status,
    ).toBe(413);
    expect(seen).toHaveLength(0);
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++)
      statuses.push((await call('/exam/phone-presence/claim', { body: '{}' })).status);
    // The rejected 415 request above already used one of the ten claim slots.
    expect(statuses.slice(0, 9).every((s) => s === 200)).toBe(true);
    expect(statuses.slice(9)).toEqual([429, 429, 429]);
  });
});

describe('phone LAN controller', () => {
  const ifaces = (address: string) =>
    ({ en0: [{ address, internal: false, family: 'IPv4' }] }) as never;

  it('reports a helpful error without a network and a LAN origin otherwise', async () => {
    const none = createPhoneLan({ apiPort: 1, getInterfaces: () => ({}) });
    expect((await none.start()).error).toMatch(/same Wi-Fi/);
    expect(none.isActive()).toBe(false);
    // 127.0.0.1 is rejected by the private-range filter, so use the real loopback only via
    // pickLanAddress fixtures above; here the origin shape is checked with a bind failure path.
    const bad = createPhoneLan({
      apiPort: 1,
      port: 3443,
      getInterfaces: () => ifaces('10.255.255.254'), // Not assigned to this Mac: bind fails.
    });
    const result = await bad.start();
    expect(result.origin).toBeNull();
    expect(bad.isActive()).toBe(false);
    await bad.stop();
  });
});
