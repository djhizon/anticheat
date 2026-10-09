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
// Desktop-only detector models (hundreds of MB): kept out of the web bundle and the repo.
const localRoot = resolve(repoRoot, 'apps/api/vendor/vision-models');

/** Model hosts we download from, and the CDN hosts each may redirect to. */
const OFFICIAL_HOSTS = {
  'storage.googleapis.com': () => false,
  'huggingface.co': (host) =>
    host === 'huggingface.co' || host.endsWith('.huggingface.co') || host.endsWith('.hf.co'),
};
const MAX_REDIRECTS = 3;

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

function containedPath(root, target) {
  const absolutePath = resolve(root, target);
  if (absolutePath === root || !absolutePath.startsWith(`${root}${sep}`)) {
    throw new Error(`Asset target escapes ${relative(repoRoot, root)}: ${target}`);
  }
  return absolutePath;
}

function publicPath(target) {
  return containedPath(publicRoot, target);
}

function localPath(target) {
  return containedPath(localRoot, target);
}

/** Follows at most MAX_REDIRECTS hops, each HTTPS and on the origin's allowed CDN hosts. */
async function fetchOfficial(url, signal) {
  const origin = new URL(url);
  const allowRedirect = OFFICIAL_HOSTS[origin.hostname];
  if (origin.protocol !== 'https:' || allowRedirect === undefined) {
    throw new Error(`Refusing non-official model URL: ${url}`);
  }
  let current = origin;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const response = await fetch(current, { signal, redirect: 'manual' });
    if (response.status < 300 || response.status >= 400) return response;
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location) throw new Error(`redirect without a location (HTTP ${response.status})`);
    const next = new URL(location, current);
    if (next.protocol !== 'https:' || !allowRedirect(next.hostname)) {
      throw new Error(`refusing redirect to ${next.hostname}`);
    }
    current = next;
  }
  throw new Error('too many redirects');
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

/**
 * onnxruntime-web's WASM runtime for the browser wearables worker, served from /vision/ort so
 * the worker never has to locate files next to a bundled module. Same version pin check as above.
 */
async function installedOrtFiles(manifest) {
  // The package's exports map hides package.json, so resolve its main entry and walk up.
  const entry = fileURLToPath(
    import.meta.resolve(`${manifest.ortPackageName}/wasm`, pathToFileURL(packageJsonPath).href),
  );
  const packageRoot = resolve(dirname(entry), '..');
  const packageInfo = await readJson(resolve(packageRoot, 'package.json'));
  const webPackage = await readJson(packageJsonPath);
  if (packageInfo.version !== manifest.ortPackageVersion) {
    throw new Error(
      `Expected ${manifest.ortPackageName}@${manifest.ortPackageVersion}; found ${packageInfo.version}`,
    );
  }
  if (webPackage.dependencies?.[manifest.ortPackageName] !== manifest.ortPackageVersion) {
    throw new Error(
      `apps/web/package.json must pin ${manifest.ortPackageName} to ${manifest.ortPackageVersion}`,
    );
  }
  return manifest.ortWasmFiles.map((file) => ({
    source: resolve(packageRoot, 'dist', file),
    target: publicPath(`vision/ort/${file}`),
  }));
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
    const response = await fetchOfficial(model.url, controller.signal);
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

async function prepareModel(model, limits, target = publicPath(model.target)) {
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

/**
 * `--local` adds the desktop app's on-device detector (VISION_MODEL or the manifest default);
 * `--local=dfine-x,dfine-l` or `--local=all` picks explicitly.
 */
export function selectLocalModels(manifest, value, env = process.env) {
  if (value === undefined) return [];
  const wanted =
    value === '' ? [env.VISION_MODEL?.trim() || manifest.defaultLocalModel] : value.split(',');
  if (wanted.includes('all')) return manifest.localModels;
  return wanted.map((id) => {
    const model = manifest.localModels.find((entry) => entry.id === id.trim());
    if (!model) throw new Error(`Unknown local vision model: ${id}`);
    return model;
  });
}

function localLimits(limits) {
  return { maxBytes: limits.localMaxBytes, timeoutMs: limits.localTimeoutMs };
}

async function verifyLocalModels(models, limits) {
  for (const model of models) {
    const target = localPath(model.target);
    const targetHash = await existingDigest(target, limits.maxBytes);
    if (!targetHash) throw new Error(`Missing local model: ${relative(repoRoot, target)}`);
    if (targetHash.digest !== model.sha256) {
      throw new Error(`Model SHA-256 mismatch: ${relative(repoRoot, target)}`);
    }
  }
  if (models.length > 0) console.log(`Verified ${models.length} local detector model(s)`);
}

function parseArgs(args) {
  let verify = false;
  let local;
  for (const arg of args) {
    if (arg === '--verify') verify = true;
    else if (arg === '--local') local = '';
    else if (arg.startsWith('--local=')) local = arg.slice('--local='.length);
    else {
      throw new Error(
        'Usage: node scripts/prepare-vision-assets.mjs [--verify] [--local[=all|id,...]]',
      );
    }
  }
  return { verify, local };
}

async function main() {
  const { verify, local } = parseArgs(process.argv.slice(2));
  const manifest = await readJson(manifestPath);
  const localModels = selectLocalModels(manifest, local);
  const packageRoot = await resolveVisionPackage(manifest);
  const wasmAssets = [
    ...(await installedWasmFiles(packageRoot, manifest)),
    ...(await installedOrtFiles(manifest)),
  ];

  if (verify) {
    await verifyAssets(manifest, wasmAssets);
    await verifyLocalModels(localModels, localLimits(manifest.limits));
    return;
  }

  for (const { source, target } of wasmAssets) {
    await atomicCopy(source, target);
  }
  for (const model of manifest.models) {
    await prepareModel(model, manifest.limits);
  }
  for (const model of localModels) {
    await prepareModel(model, localLimits(manifest.limits), localPath(model.target));
  }
  console.log(
    `Prepared ${wasmAssets.length} wasm files, ${manifest.models.length} browser models` +
      ` and ${localModels.length} local detector model(s)`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
