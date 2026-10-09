import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, resolve, sep } from 'node:path';

import {
  isVisionWorkerPath,
  VISION_WORKER_CSP,
} from '../../web/src/features/integrity/visionPolicy.js';

/** Keep in sync with `documentPolicy` in apps/web/vite.config.ts. */
export const DOCUMENT_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://127.0.0.1:* ws://localhost:*; img-src 'self' data:; media-src 'self' blob:; worker-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'";

const MIME_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

export function isApiPath(pathname: string): boolean {
  return (
    pathname === '/auth' ||
    pathname.startsWith('/auth/') ||
    pathname === '/exam' ||
    pathname.startsWith('/exam/')
  );
}

export type StaticWebHandler = (
  request: IncomingMessage,
  response: ServerResponse,
) => Promise<boolean>;

async function fileSize(path: string): Promise<number | undefined> {
  try {
    const info = await stat(path);
    return info.isFile() ? info.size : undefined;
  } catch {
    return undefined;
  }
}

function notFound(response: ServerResponse, head: boolean): void {
  response.statusCode = 404;
  response.setHeader('content-type', 'text/plain; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  response.setHeader('x-content-type-options', 'nosniff');
  response.end(head ? undefined : 'Not found');
}

/**
 * Serves a built web app (apps/web/dist). Resolves to false when the request is
 * not for the static site (API paths, non-GET methods) so the caller can route it.
 */
export function createStaticWebHandler(webRoot: string): StaticWebHandler {
  const root = resolve(webRoot);
  const indexPath = resolve(root, 'index.html');

  return async (request, response) => {
    const method = request.method ?? 'GET';
    const rawPath = (request.url ?? '/').split('?')[0] ?? '/';
    if ((method !== 'GET' && method !== 'HEAD') || isApiPath(rawPath)) {
      return false;
    }
    const head = method === 'HEAD';

    let pathname: string;
    try {
      pathname = decodeURIComponent(rawPath);
    } catch {
      notFound(response, head);
      return true;
    }
    if (!pathname.startsWith('/') || pathname.includes('\0') || pathname.includes('\\')) {
      notFound(response, head);
      return true;
    }

    const candidate = resolve(root, `.${pathname}`);
    if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
      notFound(response, head);
      return true;
    }

    let filePath = candidate;
    let size = candidate === root ? undefined : await fileSize(candidate);
    if (size === undefined) {
      if (extname(pathname) !== '') {
        notFound(response, head); // a missing asset must 404 rather than return HTML
        return true;
      }
      filePath = indexPath; // SPA fallback (also serves /account/confirm)
      size = await fileSize(indexPath);
      if (size === undefined) {
        notFound(response, head);
        return true;
      }
    }

    const isIndex = filePath === indexPath;
    response.statusCode = 200;
    response.setHeader(
      'content-type',
      MIME_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
    );
    response.setHeader('content-length', String(size));
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader(
      'cache-control',
      pathname.startsWith('/assets/')
        ? 'public, max-age=31536000, immutable'
        : isIndex
          ? 'no-cache'
          : 'public, max-age=3600',
    );
    response.setHeader(
      'content-security-policy',
      isVisionWorkerPath(pathname) ? VISION_WORKER_CSP : DOCUMENT_CSP,
    );
    if (head) {
      response.end();
      return true;
    }
    await new Promise<void>((done) => {
      const stream = createReadStream(filePath);
      stream.once('error', () => {
        response.destroy();
        done();
      });
      stream.once('close', done);
      stream.pipe(response);
    });
    return true;
  };
}
