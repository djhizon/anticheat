export interface QueueItem {
  readonly index: number;
  readonly blob: Blob;
}

export interface UploadQueueOptions {
  readonly upload: (item: QueueItem) => Promise<void>;
  readonly segmentMs: number;
  readonly maxBacklog?: number;
  readonly maxConsecutiveFailures?: number;
  readonly retryDelayMs?: number;
  /** Errors that retrying cannot fix (for example cloud recording not configured). */
  readonly isFatal?: (error: unknown) => boolean;
  readonly now?: () => number;
  readonly onChange?: () => void;
  readonly onPressure?: (reason: 'backlog' | 'slow') => void;
  /** Called once with the not-yet-uploaded segments so the caller can save them locally. */
  readonly onGiveUp?: (pending: QueueItem[]) => void;
}

/** FIFO background upload queue: at most one upload in flight; callers never await it. */
export class RecordingUploadQueue {
  private items: QueueItem[] = [];
  private busy = false;
  private dead = false;
  private failures = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private uploadedCount = 0;
  private totalCount = 0;

  constructor(private readonly options: UploadQueueOptions) {}

  get uploaded(): number {
    return this.uploadedCount;
  }
  get total(): number {
    return this.totalCount;
  }
  /** Segments not yet uploaded, including the one in flight. */
  get waiting(): number {
    return this.items.length;
  }
  get isDead(): boolean {
    return this.dead;
  }

  enqueue(item: QueueItem): void {
    if (this.dead) return;
    this.items.push(item);
    this.totalCount += 1;
    this.options.onChange?.();
    if (this.items.length > (this.options.maxBacklog ?? 3)) this.options.onPressure?.('backlog');
    void this.pump();
  }

  /** Removes and returns everything not yet uploaded and stops the queue. */
  drainPending(): QueueItem[] {
    this.dead = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const pending = this.items;
    this.items = [];
    this.options.onChange?.();
    return pending;
  }

  private giveUp(): void {
    const pending = this.drainPending();
    this.options.onGiveUp?.(pending);
  }

  private async pump(): Promise<void> {
    if (this.busy || this.dead) return;
    const item = this.items[0];
    if (!item) return;
    this.busy = true;
    const now = this.options.now ?? Date.now;
    const started = now();
    try {
      await this.options.upload(item);
    } catch (error) {
      this.busy = false;
      if (this.dead) return;
      this.failures += 1;
      if (
        this.options.isFatal?.(error) ||
        this.failures >= (this.options.maxConsecutiveFailures ?? 3)
      ) {
        this.giveUp();
        return;
      }
      this.options.onChange?.();
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        void this.pump();
      }, this.options.retryDelayMs ?? 2000);
      return;
    }
    this.busy = false;
    if (this.dead) return;
    this.failures = 0;
    this.items.shift();
    this.uploadedCount += 1;
    this.options.onChange?.();
    if (now() - started > this.options.segmentMs) this.options.onPressure?.('slow');
    void this.pump();
  }
}
