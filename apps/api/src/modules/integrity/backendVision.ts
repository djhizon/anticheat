import { spawn, type ChildProcess } from 'node:child_process';
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
  readonly timer: ReturnType<typeof setTimeout>;
}

const defaultScript = fileURLToPath(new URL('../../../vendor/yolo_server.py', import.meta.url));

export class VisionClient {
  private process: ChildProcess | null = null;
  private stdoutBuffer = '';
  private readonly pending: Pending[] = [];

  constructor(
    private readonly spawnVision: SpawnVision = () => spawn('python3', [defaultScript]),
    private readonly timeoutMs = 20000,
    private readonly maxPending = 16,
  ) {}

  detect(imageBase64: string): Promise<VisionResult> {
    if (this.pending.length >= this.maxPending) {
      return Promise.reject(new Error('Vision server is busy.'));
    }
    const child = this.start();
    return new Promise<VisionResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        // A timed-out request leaves the response stream out of step, so restart.
        this.fail(new Error('Vision request timed out.'));
      }, this.timeoutMs);
      this.pending.push({ resolve, reject, timer });
      child.stdin?.write(`${JSON.stringify({ image_base64: imageBase64 })}\n`);
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

    child.stdout?.on('data', (data: Buffer | string) => {
      // stdout chunks can split or merge JSON lines, so buffer until a newline.
      this.stdoutBuffer += data.toString();
      const lines = this.stdoutBuffer.split('\n');
      this.stdoutBuffer = lines.pop() ?? '';
      for (const line of lines.filter(Boolean)) this.settle(line);
    });
    child.stderr?.on('data', (data: Buffer | string) => {
      console.log('[OWL-ViT]', data.toString().trim());
    });
    child.on('exit', () => {
      if (this.process === child) this.fail(new Error('Vision server exited.'));
    });
    child.on('error', (error) => {
      if (this.process === child) this.fail(error);
    });
    return child;
  }

  private settle(line: string): void {
    const next = this.pending.shift();
    if (!next) return;
    clearTimeout(next.timer);
    try {
      next.resolve(JSON.parse(line) as VisionResult);
    } catch {
      next.reject(new Error('Vision server returned malformed output.'));
    }
  }

  private fail(error: Error): void {
    const child = this.process;
    this.process = null;
    child?.kill();
    for (const request of this.pending.splice(0)) {
      clearTimeout(request.timer);
      request.reject(error);
    }
  }
}

let shared: VisionClient | null = null;

export function detectObjectsRemotely(imageBase64: string): Promise<VisionResult> {
  shared ??= new VisionClient();
  return shared.detect(imageBase64);
}
