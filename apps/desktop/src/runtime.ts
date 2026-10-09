import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import { request as httpRequest } from 'http';
import * as net from 'net';
import * as path from 'path';

export const API_PORT = 3000;
export const WEB_PORT = 5173;
export const MAX_LOG_BYTES = 1024 * 1024;
const READY_TIMEOUT_MS = 90_000;
const POLL_INTERVAL_MS = 150;
const STOP_GRACE_MS = 3000;

export interface StreamLike {
  on(event: 'data', listener: (chunk: Buffer) => void): unknown;
}

/** The subset of an Electron `UtilityProcess` / Node `ChildProcess` the runtime relies on. */
export interface ServerProcess {
  readonly stdout: StreamLike | null;
  readonly stderr: StreamLike | null;
  on(event: 'exit', listener: (code: number | null) => void): unknown;
  postMessage?(message: unknown): void;
  kill(): boolean;
}

export interface RuntimePaths {
  readonly entry: string;
  readonly webRoot: string;
  readonly whisperBin: string;
  readonly whisperModel: string;
  readonly ffmpegBin: string | undefined;
}

export interface RuntimeDeps {
  readonly isPackaged: boolean;
  readonly resourcesPath: string;
  /** Repository root, used for source paths when not packaged. */
  readonly repoRoot: string;
  readonly userDataPath: string;
  /** True only for the packaged judge build: the server then seeds the demo accounts. */
  readonly judgeBuild?: boolean;
  /** Starts the bundle in an Electron utility process. */
  forkUtility(entry: string, options: { cwd: string; env: NodeJS.ProcessEnv }): ServerProcess;
  /** Starts the bundle with the Electron binary acting as plain Node. */
  forkNode?(entry: string, options: { cwd: string; env: NodeJS.ProcessEnv }): ServerProcess;
  isPortFree(port: number): Promise<boolean>;
  canConnect(port: number): Promise<boolean>;
  /** True when `port` is held by a (stale) copy of this app's own server. Defaults to an HTTP probe. */
  isOurServer?(port: number): Promise<boolean>;
  showError(title: string, message: string): Promise<void> | void;
  log(line: string): void;
  sleep?(ms: number): Promise<void>;
  readyTimeoutMs?: number;
  pollIntervalMs?: number;
}

export interface RuntimeHandle {
  /** Resolves after the server process has exited (gracefully, or killed after a grace period). */
  stop(): Promise<void>;
}

export function resolveRuntimePaths(
  deps: Pick<RuntimeDeps, 'isPackaged' | 'resourcesPath' | 'repoRoot'>,
): RuntimePaths {
  if (deps.isPackaged) {
    const base = deps.resourcesPath;
    // ffmpeg is optional: app-recorded clips are already 16 kHz WAV, so it is not bundled.
    const ffmpeg = path.join(base, 'ffmpeg', 'ffmpeg');
    return {
      entry: path.join(base, 'api', 'api-server.mjs'),
      webRoot: path.join(base, 'web'),
      whisperBin: path.join(base, 'whisper', 'whisper-cli'),
      whisperModel: path.join(base, 'whisper', 'ggml-base-q5_1.bin'),
      ffmpegBin: fs.existsSync(ffmpeg) ? ffmpeg : undefined,
    };
  }
  const api = path.join(deps.repoRoot, 'apps', 'api');
  return {
    entry: path.join(api, 'dist', 'api-server.mjs'),
    webRoot: path.join(deps.repoRoot, 'apps', 'web', 'dist'),
    whisperBin: path.join(api, 'vendor', 'whisper.cpp', 'build', 'bin', 'whisper-cli'),
    whisperModel: path.join(api, 'vendor', 'whisper.cpp', 'models', 'ggml-base.bin'),
    ffmpegBin: undefined,
  };
}

/** NODE_ENV is intentionally never set: production would demand HTTPS origins. */
export function buildServerEnv(
  deps: Pick<
    RuntimeDeps,
    'isPackaged' | 'resourcesPath' | 'repoRoot' | 'userDataPath' | 'judgeBuild'
  >,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const paths = resolveRuntimePaths(deps);
  const env: NodeJS.ProcessEnv = { ...base };
  delete env.NODE_ENV;
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  // The server exits by itself if this Electron process dies (see desktop-entry.ts).
  env.EAC_EXIT_WITH_PARENT = '1';
  // Never inherited: only the build flag decides whether demo accounts are seeded.
  delete env.EAC_SEED_DEMO;
  if (deps.judgeBuild === true) env.EAC_SEED_DEMO = '1';
  env.API_PORT = String(API_PORT);
  env.PORT = String(API_PORT);
  env.WEB_PORT = String(WEB_PORT);
  env.DATABASE_PATH = path.join(deps.userDataPath, 'data', 'exam-anti-cheat.sqlite');
  env.SERVE_WEB_DIST = paths.webRoot;
  env.WHISPER_BIN = paths.whisperBin;
  env.WHISPER_MODEL_PATH = paths.whisperModel;
  if (paths.ffmpegBin !== undefined) env.FFMPEG_BIN = paths.ffmpegBin;
  else if (deps.isPackaged) delete env.FFMPEG_BIN; // Fall back to PATH, never a stale value.
  return env;
}

/** Size-capped log: the file is rotated to `<name>.1` once it grows past `maxBytes`. */
export class CappedLog {
  private size = 0;
  constructor(
    private readonly file: string,
    private readonly maxBytes = MAX_LOG_BYTES,
  ) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      this.size = fs.statSync(file).size;
    } catch {
      this.size = 0;
    }
  }

  write(text: string): void {
    try {
      const bytes = Buffer.byteLength(text);
      if (this.size + bytes > this.maxBytes) {
        try {
          fs.renameSync(this.file, `${this.file}.1`);
        } catch {
          fs.writeFileSync(this.file, '');
        }
        this.size = 0;
      }
      fs.appendFileSync(this.file, text);
      this.size += bytes;
    } catch {
      /* Logging must never take the app down. */
    }
  }
}

export function checkPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

export function checkCanConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    const done = (result: boolean): void => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(1000, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/** The desktop server tags every web response with `x-eac-server: desktop`. */
export function probeOurServer(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path: '/', method: 'HEAD', timeout: 1000 },
      (response) => {
        response.resume();
        resolve(response.headers['x-eac-server'] === 'desktop');
      },
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
    req.end();
  });
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Wraps a Node child process so it satisfies `ServerProcess`. */
export function nodeChildProcess(
  entry: string,
  options: { cwd: string; env: NodeJS.ProcessEnv },
  execPath: string = process.execPath,
): ServerProcess {
  const child = spawn(execPath, [entry], {
    cwd: options.cwd,
    env: { ...options.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const emitter = new EventEmitter();
  child.on('exit', (code) => emitter.emit('exit', code));
  child.on('error', () => emitter.emit('exit', 1));
  return {
    stdout: child.stdout,
    stderr: child.stderr,
    on: (event, listener) => emitter.on(event, listener),
    kill: () => child.kill('SIGTERM'),
  };
}

/**
 * Starts the bundled API + web server and resolves once both ports answer. Returns `null` after
 * showing a dialog when it could not be started (busy port, crash, timeout).
 */
export async function startRuntime(deps: RuntimeDeps): Promise<RuntimeHandle | null> {
  for (const port of [API_PORT, WEB_PORT]) {
    if (!(await deps.isPortFree(port))) {
      // The API port (3000) does not carry the marker; the web port does and both belong together.
      const stale = await (deps.isOurServer ?? probeOurServer)(WEB_PORT).catch(() => false);
      if (stale) {
        deps.log(`Port ${port} is held by a stale Exam Anti-Cheat server.`);
        await deps.showError(
          'A previous Exam Anti-Cheat server is still running',
          `A server from an earlier run of Exam Anti-Cheat (for example after a crash) is still using port ${port} on 127.0.0.1. Quit "Exam Anti-Cheat" in Activity Monitor (or restart your Mac) and open the app again.`,
        );
        return null;
      }
      await deps.showError(
        `Port ${port} is already in use`,
        `Exam Anti-Cheat needs port ${port} on 127.0.0.1, but another program is using it. Close that program (for example a development server) and open the app again.`,
      );
      return null;
    }
  }

  const paths = resolveRuntimePaths(deps);
  const env = buildServerEnv(deps);
  const cwd = deps.userDataPath;
  fs.mkdirSync(cwd, { recursive: true });
  const logFile = path.join(deps.userDataPath, 'logs', 'api.log');
  const log = new CappedLog(logFile);
  const sleep = deps.sleep ?? defaultSleep;
  const pollMs = deps.pollIntervalMs ?? POLL_INTERVAL_MS;
  const timeoutMs = deps.readyTimeoutMs ?? READY_TIMEOUT_MS;

  const launch = (mode: 'utility' | 'node'): { child: ServerProcess; exited: () => boolean } => {
    const child =
      mode === 'utility'
        ? deps.forkUtility(paths.entry, { cwd, env })
        : (deps.forkNode ?? nodeChildProcess)(paths.entry, { cwd, env });
    let exited = false;
    log.write(`--- ${new Date().toISOString()} starting server (${mode}) ---\n`);
    child.stdout?.on('data', (chunk: Buffer) => log.write(chunk.toString()));
    child.stderr?.on('data', (chunk: Buffer) => log.write(chunk.toString()));
    child.on('exit', (code) => {
      exited = true;
      log.write(`--- server exited with code ${String(code)} ---\n`);
    });
    return { child, exited: () => exited };
  };

  const waitReady = async (exited: () => boolean): Promise<'ready' | 'exited' | 'timeout'> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (exited()) return 'exited';
      const [api, web] = await Promise.all([deps.canConnect(API_PORT), deps.canConnect(WEB_PORT)]);
      if (api && web) return 'ready';
      await sleep(pollMs);
    }
    return 'timeout';
  };

  // The Node-mode fallback needs ELECTRON_RUN_AS_NODE, which the packaged app's fuses disable;
  // packaged builds therefore pass no `forkNode` and always use the utility process.
  let mode: 'utility' | 'node' =
    deps.forkNode !== undefined && process.env.EAC_SERVER_FALLBACK === '1' ? 'node' : 'utility';
  let started = launch(mode);
  let outcome = await waitReady(started.exited);
  if (outcome === 'exited' && mode === 'utility' && deps.forkNode !== undefined) {
    // The utility process could not run the bundle; retry with Electron acting as plain Node.
    deps.log('Utility process exited before the server was ready; retrying with Node mode.');
    mode = 'node';
    started = launch(mode);
    outcome = await waitReady(started.exited);
  }

  if (outcome !== 'ready') {
    if (!started.exited()) started.child.kill();
    await deps.showError(
      'The local exam server could not start',
      `${
        outcome === 'timeout'
          ? 'The local server did not become ready in time.'
          : 'The local server stopped unexpectedly.'
      } Details are in ${logFile}.`,
    );
    return null;
  }

  const child = started.child;
  return {
    stop: () =>
      new Promise<void>((resolve) => {
        if (started.exited()) return resolve();
        const stopStarted = Date.now();
        const timer = setTimeout(() => {
          deps.log(`Server did not exit within ${STOP_GRACE_MS} ms; killing it.`);
          child.kill();
          resolve();
        }, STOP_GRACE_MS);
        child.on('exit', () => {
          clearTimeout(timer);
          deps.log(`Server stopped in ${Date.now() - stopStarted} ms.`);
          resolve();
        });
        try {
          child.postMessage?.('shutdown');
        } catch {
          child.kill();
        }
        if (child.postMessage === undefined) child.kill();
      }),
  };
}
