const { mkdirSync, mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

if (process.platform !== 'darwin') throw new Error('App-control helper currently requires macOS.');
const root = path.resolve(__dirname, '..');
const cache = mkdtempSync(path.join(tmpdir(), 'exam-swift-'));
mkdirSync(path.join(root, 'native-bin'), { recursive: true });
try {
  const result = spawnSync(
    '/usr/bin/xcrun',
    [
      'swiftc',
      '-module-cache-path',
      cache,
      path.join(root, 'native/AppControl.swift'),
      '-o',
      path.join(root, 'native-bin/app-control'),
    ],
    { stdio: 'inherit', timeout: 120000 },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('Native helper compilation failed.');
} finally {
  rmSync(cache, { recursive: true, force: true });
}
