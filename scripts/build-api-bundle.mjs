/* global console */
// Bundles apps/api into a single ESM file for the desktop app:
//   apps/api/dist/api-server.mjs  (+ apps/api/dist/migrations/*.sql)
//   apps/api/dist/local-vision.worker.mjs  (on-device detector worker thread)
//   apps/api/dist/node_modules/onnxruntime-{node,common}  (native runtime; cannot be inlined)
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'apps/api/dist');
const apiRequire = createRequire(resolve(root, 'apps/api/package.json'));

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const shared = {
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node24',
  define: { __DESKTOP_BUNDLE__: 'true' },
  legalComments: 'none',
  logLevel: 'warning',
};

await build({
  ...shared,
  entryPoints: [resolve(root, 'apps/api/src/desktop-entry.ts')],
  outfile: resolve(dist, 'api-server.mjs'),
  // node:sqlite and other node:* builtins are resolved at runtime; contracts are inlined.
  external: ['node:*'],
});

// The detector worker is a separate thread, so it is its own entry. onnxruntime-node loads a
// native binding relative to its own package directory and stays a real package (copied below).
await build({
  ...shared,
  entryPoints: [resolve(root, 'apps/api/src/modules/integrity/localVision.worker.ts')],
  outfile: resolve(dist, 'local-vision.worker.mjs'),
  external: ['node:*', 'onnxruntime-node'],
});

/** Package directory via the main entry (exports maps hide package.json from resolve). */
function packageRoot(name) {
  let dir = dirname(apiRequire.resolve(name));
  for (;;) {
    const manifest = resolve(dir, 'package.json');
    // Nested package.json files (e.g. dist/cjs/package.json) only set "type"; skip them.
    if (existsSync(manifest) && JSON.parse(readFileSync(manifest, 'utf8')).name === name) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`Cannot locate the ${name} package directory.`);
    dir = parent;
  }
}

/** Copies the parts of a package the runtime needs (no scripts, docs or other platforms). */
function copyPackage(name, keep) {
  const source = packageRoot(name);
  const target = resolve(dist, 'node_modules', name);
  for (const entry of keep) {
    const item = resolve(source, entry);
    if (!existsSync(item)) throw new Error(`Missing ${name}/${entry}; run npm install.`);
    cpSync(item, resolve(target, entry), { recursive: true });
  }
}

// Only the Intel macOS binding ships in the dmg (the app is built for x64 only).
copyPackage('onnxruntime-node', ['package.json', 'dist', 'lib', 'bin/napi-v6/darwin/x64']);
copyPackage('onnxruntime-common', ['package.json', 'dist']);

cpSync(resolve(root, 'apps/api/src/db/migrations'), resolve(dist, 'migrations'), {
  recursive: true,
  filter: (source) => !source.endsWith('.ts'),
});
console.log(`API bundle written to ${resolve(dist, 'api-server.mjs')}`);
