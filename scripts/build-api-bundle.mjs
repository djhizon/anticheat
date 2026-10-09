/* global console */
// Bundles apps/api into a single ESM file for the desktop app:
//   apps/api/dist/api-server.mjs  (+ apps/api/dist/migrations/*.sql)
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'apps/api/dist');

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

await build({
  entryPoints: [resolve(root, 'apps/api/src/desktop-entry.ts')],
  outfile: resolve(dist, 'api-server.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node24',
  // node:sqlite and other node:* builtins are resolved at runtime; contracts are inlined.
  external: ['node:*'],
  define: { __DESKTOP_BUNDLE__: 'true' },
  legalComments: 'none',
  logLevel: 'warning',
});

cpSync(resolve(root, 'apps/api/src/db/migrations'), resolve(dist, 'migrations'), {
  recursive: true,
  filter: (source) => !source.endsWith('.ts'),
});
console.log(`API bundle written to ${resolve(dist, 'api-server.mjs')}`);
