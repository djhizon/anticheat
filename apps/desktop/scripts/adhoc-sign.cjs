// electron-builder afterPack hook: ad-hoc sign the unsigned macOS app (no Developer ID).
const { existsSync, readdirSync, rmSync } = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function codesign(args) {
  execFileSync('/usr/bin/codesign', args, { stdio: 'inherit' });
}

// electron-builder's electronLanguages only prunes Contents/Resources; Electron keeps its ~220
// locale folders inside the framework. The UI is English only, so drop the rest (about 60 MB).
function pruneFrameworkLocales(appPath) {
  const dir = path.join(
    appPath,
    'Contents/Frameworks/Electron Framework.framework/Versions/A/Resources',
  );
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (name.endsWith('.lproj') && !/^en[_.]/.test(name)) {
      rmSync(path.join(dir, name), { recursive: true, force: true });
    }
  }
}

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  pruneFrameworkLocales(appPath);
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
