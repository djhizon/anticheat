import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createStaticWebHandler, DOCUMENT_CSP } from './staticWeb.js';

let dir: string;
let server: Server;
let base: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'static-web-'));
  const root = join(dir, 'dist');
  mkdirSync(join(root, 'assets'), { recursive: true });
  writeFileSync(join(root, 'index.html'), '<!doctype html><title>spa</title>');
  writeFileSync(join(root, 'assets', 'app-abc123.js'), 'console.log(1)');
  writeFileSync(join(root, 'assets', 'vision-engine-abc123.js'), 'console.log(2)');
  writeFileSync(join(root, 'assets', 'x.wasm'), '\0asm');
  writeFileSync(join(dir, 'secret.txt'), 'top secret');
  const handler = createStaticWebHandler(root);
  server = createServer((req, res) => {
    void handler(req, res).then((handled) => {
      if (!handled) {
        res.statusCode = 418;
        res.end('api');
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('static web handler', () => {
  it('serves index.html at / with the document CSP', async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('content-security-policy')).toBe(DOCUMENT_CSP);
    expect(res.headers.get('cache-control')).toBe('no-cache');
  });

  it('document CSP forbids inline scripts and eval', () => {
    const script = /script-src ([^;]*)/u.exec(DOCUMENT_CSP)?.[1] ?? '';
    expect(script).toBe("'self'");
    expect(DOCUMENT_CSP).not.toContain('unsafe-eval');
    expect(DOCUMENT_CSP).toContain("object-src 'none'");
  });

  it('falls back to index.html for SPA routes such as /account/confirm', async () => {
    const res = await fetch(`${base}/account/confirm?token=1`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<title>spa</title>');
  });

  it('serves hashed assets with correct MIME and immutable caching', async () => {
    const res = await fetch(`${base}/assets/app-abc123.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect((await fetch(`${base}/assets/x.wasm`)).headers.get('content-type')).toBe(
      'application/wasm',
    );
  });

  it('applies the strict worker CSP to the vision worker', async () => {
    const res = await fetch(`${base}/assets/vision-engine-abc123.js`);
    expect(res.headers.get('content-security-policy')).toContain("worker-src 'none'");
  });

  it('returns 404 for missing assets instead of HTML', async () => {
    expect((await fetch(`${base}/assets/missing.js`)).status).toBe(404);
  });

  it('blocks path traversal', async () => {
    for (const path of ['/..%2Fsecret.txt', '/%2e%2e/secret.txt', '/assets/..%2F..%2Fsecret.txt']) {
      const res = await fetch(`${base}${path}`);
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain('top secret');
    }
    expect((await fetch(`${base}/%00`)).status).toBe(404);
    expect((await fetch(`${base}/%E0%A4%A`)).status).toBe(404);
  });

  it('leaves API paths and non-GET methods to the caller', async () => {
    expect((await fetch(`${base}/auth/csrf`)).status).toBe(418);
    expect((await fetch(`${base}/exam/x`)).status).toBe(418);
    expect((await fetch(`${base}/`, { method: 'POST' })).status).toBe(418);
  });
});
