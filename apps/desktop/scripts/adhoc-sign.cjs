// electron-builder afterPack hook: ad-hoc sign the unsigned macOS app (no Developer ID).
const { existsSync } = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function codesign(args) {
  execFileSync('/usr/bin/codesign', args, { stdio: 'inherit' });
}

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const resources = path.join(appPath, 'Contents', 'Resources');
  const entitlements = path.join(context.packager.projectDir, 'assets', 'entitlements.mac.plist');

  const helpers = ['app-control', 'whisper/whisper-cli', 'ffmpeg/ffmpeg'];
  for (const rel of helpers) {
    const file = path.join(resources, rel);
    if (existsSync(file)) codesign(['--force', '--sign', '-', file]);
  }
  codesign(['--force', '--deep', '--sign', '-', '--entitlements', entitlements, appPath]);
  try {
    codesign(['--verify', '--deep', '--strict', appPath]);
  } catch (error) {
    throw new Error(`Ad-hoc signature verification failed for ${appPath}: ${error.message}`);
  }
};
