const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

if (process.platform !== 'darwin') throw new Error('App-control helper currently requires macOS.');
const root = path.resolve(__dirname, '..');
const cache = mkdtempSync(path.join(tmpdir(), 'exam-swift-'));
mkdirSync(path.join(root, 'native-bin'), { recursive: true });
// Embedded Info.plist: lets the camera-list action discover iPhone Continuity Cameras under their
// own device type (AVFoundation hides that type from processes without this key).
const infoPlist = path.join(cache, 'Info.plist');
writeFileSync(
  infoPlist,
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>NSCameraUseContinuityCameraDeviceType</key><true/></dict></plist>
`,
);
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
      '-Xlinker',
      '-sectcreate',
      '-Xlinker',
      '__TEXT',
      '-Xlinker',
      '__info_plist',
      '-Xlinker',
      infoPlist,
    ],
    { stdio: 'inherit', timeout: 120000 },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('Native helper compilation failed.');
} finally {
  rmSync(cache, { recursive: true, force: true });
}
