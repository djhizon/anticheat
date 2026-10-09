/* global AbortController, URL, clearTimeout, console, fetch, process, setTimeout */

import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const publicRoot = resolve(repoRoot, 'apps/web/public');
const manifestPath = resolve(repoRoot, 'scripts/vision-assets.json');
const packageJsonPath = resolve(repoRoot, 'apps/web/package.json');

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

function publicPath(target) {
  const absolutePath = resolve(publicRoot, target);
  if (absolutePath !== publicRoot && !absolutePath.startsWith(`${publicRoot}${sep}`)) {
    throw new Error(`Asset target escapes the web public directory: ${target}`);
  }
  return absolutePath;
}

function temporaryPath(target) {
  return `${target}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`;
}

async function sha256(filePath, maxBytes = Number.MAX_SAFE_INTEGER) {
  const hash = createHash('sha256');
  let bytes = 0;

  for await (const chunk of createReadStream(filePath)) {
    bytes += chunk.length;
    if (bytes > maxBytes) {
      throw new Error(`${filePath} exceeds the ${maxBytes}-byte limit`);
    }
    hash.update(chunk);
  }

  return { bytes, digest: hash.digest('hex') };
}

async function atomicCopy(source, target) {
  await mkdir(dirname(target), { recursive: true });
  const temporary = temporaryPath(target);
  try {
    await copyFile(source, temporary);
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function resolveVisionPackage(manifest) {
  const webPackageUrl = pathToFileURL(packageJsonPath).href;
  const webRequire = createRequire(webPackageUrl);
  const importEntry = fileURLToPath(import.meta.resolve(manifest.packageName, webPackageUrl));
  const requireEntry = webRequire.resolve(manifest.packageName);
  const packageRoot = dirname(importEntry);

  if (dirname(requireEntry) !== packageRoot) {
    throw new Error('MediaPipe import and require entries resolved to different package roots');
  }

  const packageInfo = await readJson(resolve(packageRoot, 'package.json'));
  const webPackage = await readJson(packageJsonPath);
  const declaredVersion = webPackage.dependencies?.[manifest.packageName];

  if (
    packageInfo.name !== manifest.packageName ||
    packageInfo.version !== manifest.packageVersion
  ) {
    throw new Error(
      `Expected ${manifest.packageName}@${manifest.packageVersion}; found ${packageInfo.name}@${packageInfo.version}`,
    );
  }
  if (declaredVersion !== manifest.packageVersion) {
    throw new Error(
      `apps/web/package.json must pin ${manifest.packageName} to ${manifest.packageVersion}`,
    );
  }

  return packageRoot;
}

async function installedWasmFiles(packageRoot, manifest) {
  const wasmRoot = resolve(packageRoot, 'wasm');
  const installed = (await readdir(wasmRoot, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /\.(?:js|wasm)$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  const listed = [...manifest.wasmFiles].sort();

  if (
    installed.length !== listed.length ||
    installed.some((file, index) => file !== listed[index])
  ) {
    throw new Error(`Manifest wasm files do not match ${relative(repoRoot, wasmRoot)}`);
  }

  return installed.map((file) => ({
    source: resolve(wasmRoot, file),
    target: publicPath(`vision/wasm/${file}`),
  }));
}

async function existingDigest(filePath, maxBytes = Number.MAX_SAFE_INTEGER) {
  try {
    return await sha256(filePath, maxBytes);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function downloadModel(model, target, limits) {
  const temporary = temporaryPath(target);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), limits.timeoutMs);
  timeout.unref?.();
  let handle;

  try {
    const response = await fetch(model.url, { signal: controller.signal, redirect: 'error' });
    if (!response.ok) {
      throw new Error(`download returned HTTP ${response.status}`);
    }
    const contentLength = Number.parseInt(response.headers.get('content-length') ?? '', 10);
    if (Number.isFinite(contentLength) && contentLength > limits.maxBytes) {
      throw new Error(`download exceeds the ${limits.maxBytes}-byte limit`);
    }
    if (!response.body) throw new Error('download returned no body');

    await mkdir(dirname(target), { recursive: true });
    handle = await open(temporary, 'wx');
    const hash = createHash('sha256');
    let bytes = 0;

    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > limits.maxBytes) {
        throw new Error(`download exceeds the ${limits.maxBytes}-byte limit`);
      }
      hash.update(chunk);
      // writeFile handles partial OS writes; write() alone need not consume the buffer.
      await handle.writeFile(chunk);
    }
    await handle.sync();

    const digest = hash.digest('hex');
    if (digest !== model.sha256) {
      throw new Error(`SHA-256 mismatch: expected ${model.sha256}, got ${digest}`);
    }
    await rename(temporary, target);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`download timed out after ${limits.timeoutMs} ms`, { cause: error });
    }
    throw new Error(`Could not prepare ${basename(target)}: ${error.message}`, { cause: error });
  } finally {
    clearTimeout(timeout);
    await handle?.close();
    await rm(temporary, { force: true });
  }
}

async function prepareModel(model, limits) {
  const target = publicPath(model.target);
  const existing = await existingDigest(target, limits.maxBytes);
  if (existing?.digest === model.sha256) {
    console.log(`Verified existing ${relative(repoRoot, target)}`);
    return;
  }

  const cacheDirectory = process.env.VISION_ASSET_CACHE_DIR;
  if (cacheDirectory) {
    const cachePath = resolve(cacheDirectory, basename(model.target));
    const cached = await existingDigest(cachePath, limits.maxBytes);
    if (cached?.digest === model.sha256) {
      await atomicCopy(cachePath, target);
      console.log(`Prepared ${relative(repoRoot, target)} from a verified cache file`);
      return;
    }
  }

  const url = new URL(model.url);
  if (url.protocol !== 'https:' || url.hostname !== 'storage.googleapis.com') {
    throw new Error(`Refusing non-official model URL: ${model.url}`);
  }
  await downloadModel(model, target, limits);
  console.log(`Downloaded and verified ${relative(repoRoot, target)}`);
}

async function verifyAssets(manifest, wasmAssets) {
  for (const { source, target } of wasmAssets) {
    const [sourceHash, targetHash] = await Promise.all([sha256(source), existingDigest(target)]);
    if (!targetHash) throw new Error(`Missing generated wasm asset: ${relative(repoRoot, target)}`);
    if (sourceHash.digest !== targetHash.digest) {
      throw new Error(`WASM SHA-256 mismatch: ${relative(repoRoot, target)}`);
    }
  }

  for (const model of manifest.models) {
    const target = publicPath(model.target);
    const targetHash = await existingDigest(target, manifest.limits.maxBytes);
    if (!targetHash) throw new Error(`Missing generated model: ${relative(repoRoot, target)}`);
    if (targetHash.digest !== model.sha256) {
      throw new Error(`Model SHA-256 mismatch: ${relative(repoRoot, target)}`);
    }
  }

  console.log(
    `Verified ${wasmAssets.length} wasm files and ${manifest.models.length} models offline`,
  );
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--verify')) {
    throw new Error('Usage: node scripts/prepare-vision-assets.mjs [--verify]');
  }

  const manifest = await readJson(manifestPath);
  const packageRoot = await resolveVisionPackage(manifest);
  const wasmAssets = await installedWasmFiles(packageRoot, manifest);

  if (args[0] === '--verify') {
    await verifyAssets(manifest, wasmAssets);
    return;
  }

  for (const { source, target } of wasmAssets) {
    await atomicCopy(source, target);
  }
  for (const model of manifest.models) {
    await prepareModel(model, manifest.limits);
  }
  console.log(`Prepared ${wasmAssets.length} wasm files and ${manifest.models.length} models`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
