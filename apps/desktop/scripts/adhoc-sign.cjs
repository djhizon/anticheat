// electron-builder afterPack hook: flip the Electron security fuses, then ad-hoc sign the app with
// the hardened runtime (no Developer ID). electron-builder 25 has no `electronFuses` option, so the
// fuses are flipped here, BEFORE signing (flipping rewrites the Electron binary).
const { existsSync, lstatSync, readdirSync, rmSync } = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

/** Fuse settings; the desktop tests assert these. */
const FUSES = {
  runAsNode: false, // ELECTRON_RUN_AS_NODE cannot turn the app binary into a plain Node.
  enableCookieEncryption: true,
  enableNodeOptionsEnvironmentVariable: false, // NODE_OPTIONS is ignored.
  enableNodeCliInspectArguments: false, // --inspect / --inspect-brk are ignored.
  enableEmbeddedAsarIntegrityValidation: true,
  onlyLoadAppFromAsar: true,
};

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

function isMachO(file) {
  try {
    return /Mach-O/.test(execFileSync('/usr/bin/file', ['-b', file], { encoding: 'utf8' }));
  } catch {
    return false;
  }
}

/** Every signable item under `root`: Mach-O files and .app/.framework bundles (symlinks skipped). */
function collectSignables(root, out = []) {
  for (const name of readdirSync(root)) {
    const full = path.join(root, name);
    const info = lstatSync(full);
    if (info.isSymbolicLink()) continue;
    if (info.isDirectory()) {
      collectSignables(full, out);
      if (/\.(app|framework)$/.test(name)) out.push(full);
    } else if (info.isFile() && isMachO(full)) {
      out.push(full);
    }
  }
  return out;
}

exports.FUSES = FUSES;

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  pruneFrameworkLocales(appPath);
  const entitlements = path.join(context.packager.projectDir, 'assets', 'entitlements.mac.plist');
  if (!require('node:fs').existsSync(entitlements))
    throw new Error('Entitlements file is missing.');
  const executable = path.join(
    appPath,
    'Contents',
    'MacOS',
    context.packager.appInfo.productFilename,
  );

  await flipFuses(executable, {
    version: FuseVersion.V1,
    [FuseV1Options.RunAsNode]: FUSES.runAsNode,
    [FuseV1Options.EnableCookieEncryption]: FUSES.enableCookieEncryption,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]:
      FUSES.enableNodeOptionsEnvironmentVariable,
    [FuseV1Options.EnableNodeCliInspectArguments]: FUSES.enableNodeCliInspectArguments,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]:
      FUSES.enableEmbeddedAsarIntegrityValidation,
    [FuseV1Options.OnlyLoadAppFromAsar]: FUSES.onlyLoadAppFromAsar,
  });

  // Inside-out: deepest items first so each parent seals already-signed children. The hardened
  // runtime flag and the entitlements go on every executable/bundle (helpers need allow-jit).
  const signables = collectSignables(appPath).sort(
    (a, b) => b.split(path.sep).length - a.split(path.sep).length,
  );
  for (const item of signables) {
    codesign([
      '--force',
      '--sign',
      '-',
      '--options',
      'runtime',
      '--entitlements',
      entitlements,
      item,
    ]);
  }
  codesign([
    '--force',
    '--sign',
    '-',
    '--options',
    'runtime',
    '--entitlements',
    entitlements,
    appPath,
  ]);

  try {
    codesign(['--verify', '--deep', '--strict', appPath]);
  } catch (error) {
    throw new Error(`Ad-hoc signature verification failed for ${appPath}: ${error.message}`);
  }
};
