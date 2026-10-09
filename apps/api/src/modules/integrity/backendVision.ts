import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Bridge to the Python OWL-ViT/YOLO server (`vendor/yolo_server.py`).
 *
 * The server answers one JSON line per request line, strictly in order, so
 * requests are kept in a FIFO queue and each response settles the oldest
 * pending request. Overlapping callers no longer clobber each other.
 */

export interface VisionDetection {
  readonly label: string;
  readonly score: number;
  readonly box?: Readonly<Record<string, number>>;
}

export interface VisionResult {
  readonly status: 'ok' | 'error';
  readonly detections?: readonly VisionDetection[];
  readonly message?: string;
}

type SpawnVision = () => ChildProcess;

interface Pending {
  readonly resolve: (value: VisionResult) => void;
  readonly reject: (reason: Error) => void;
  readonly payload: string;
  /** Started only once the request is actually sent to a ready server. */
  timer: ReturnType<typeof setTimeout> | null;
}

const defaultScript = fileURLToPath(new URL('../../../vendor/yolo_server.py', import.meta.url));
const venvPython = fileURLToPath(new URL('../../../vendor/venv/bin/python', import.meta.url));

/** VISION_PYTHON, else the venv from `npm run setup:vision`, else python3 on PATH. */
export function visionPython(
  env: NodeJS.ProcessEnv = process.env,
  venvExists = existsSync(venvPython),
): string {
  return env.VISION_PYTHON || (venvExists ? venvPython : 'python3');
}

export class VisionClient {
  private process: ChildProcess | null = null;
  private stdoutBuffer = '';
  private ready = false;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly pending: Pending[] = [];

  constructor(
    private readonly spawnVision: SpawnVision = () => spawn(visionPython(), [defaultScript]),
    private readonly timeoutMs = 20000,
    private readonly maxPending = 16,
    // Loading OWL-ViT takes ~10s warm and much longer on the first model download.
    private readonly startupTimeoutMs = 300000,
  ) {}

  detect(imageBase64: string): Promise<VisionResult> {
    if (this.pending.length >= this.maxPending) {
      return Promise.reject(new Error('Vision server is busy.'));
    }
    this.start();
    return new Promise<VisionResult>((resolve, reject) => {
      const request: Pending = {
        resolve,
        reject,
        payload: `${JSON.stringify({ image_base64: imageBase64 })}\n`,
        timer: null,
      };
      this.pending.push(request);
      // Until the model reports READY, requests wait unsent and untimed.
      if (this.ready) this.send(request);
    });
  }

  stop(): void {
    this.fail(new Error('Vision server stopped.'));
  }

  private start(): ChildProcess {
    if (this.process) return this.process;
    const child = this.spawnVision();
    this.process = child;
    this.stdoutBuffer = '';
    this.ready = false;
    this.startupTimer = setTimeout(
      () => this.fail(new Error('Vision model did not finish loading.')),
      this.startupTimeoutMs,
    );

    child.stdout?.on('data', (data: Buffer | string) => {
      // stdout chunks can split or merge JSON lines, so buffer until a newline.
      this.stdoutBuffer += data.toString();
      const lines = this.stdoutBuffer.split('\n');
      this.stdoutBuffer = lines.pop() ?? '';
      for (const line of lines.filter(Boolean)) this.settle(line);
    });
    child.stderr?.on('data', (data: Buffer | string) => {
      const text = data.toString();
      console.log('[OWL-ViT]', text.trim());
      if (!this.ready && this.process === child && /^READY$/mu.test(text)) {
        this.ready = true;
        if (this.startupTimer) clearTimeout(this.startupTimer);
        for (const request of this.pending) this.send(request);
      }
    });
    child.on('exit', () => {
      if (this.process === child) this.fail(new Error('Vision server exited.'));
    });
    child.on('error', (error) => {
      if (this.process === child) this.fail(error);
    });
    return child;
  }

  private send(request: Pending): void {
    request.timer = setTimeout(() => {
      // A timed-out request leaves the response stream out of step, so restart.
      this.fail(new Error('Vision request timed out.'));
    }, this.timeoutMs);
    this.process?.stdin?.write(request.payload);
  }

  private settle(line: string): void {
    const next = this.pending.shift();
    if (!next) return;
    if (next.timer) clearTimeout(next.timer);
    try {
      next.resolve(JSON.parse(line) as VisionResult);
    } catch {
      next.reject(new Error('Vision server returned malformed output.'));
    }
  }

  private fail(error: Error): void {
    const child = this.process;
    this.process = null;
    this.ready = false;
    if (this.startupTimer) clearTimeout(this.startupTimer);
    child?.kill();
    for (const request of this.pending.splice(0)) {
      if (request.timer) clearTimeout(request.timer);
      request.reject(error);
    }
  }
}

let shared: VisionClient | null = null;

export function detectObjectsRemotely(imageBase64: string): Promise<VisionResult> {
  shared ??= new VisionClient();
  return shared.detect(imageBase64);
}
