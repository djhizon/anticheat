export interface QueueItem {
  readonly index: number;
  readonly blob: Blob;
}

export interface UploadQueueOptions {
  readonly upload: (item: QueueItem, signal: AbortSignal) => Promise<void>;
  readonly segmentMs: number;
  /** Waiting count above which a 'backlog' pressure signal is raised. Default 3. */
  readonly maxBacklog?: number;
  /** Hard cap on segments held in memory; beyond it new segments overflow to local saving. Default 12. */
  readonly maxWaiting?: number;
  /** Failures inside failureWindowMs that end cloud upload. Default 3. */
  readonly maxFailuresInWindow?: number;
  readonly failureWindowMs?: number;
  /** An upload that takes longer than this is aborted and counted as a failure. Default 15 s. */
  readonly uploadTimeoutMs?: number;
  readonly retryDelayMs?: number;
  /** Errors that retrying cannot fix (for example cloud recording not configured). */
  readonly isFatal?: (error: unknown) => boolean;
  readonly now?: () => number;
  readonly onChange?: () => void;
  readonly onPressure?: (reason: 'backlog' | 'slow') => void;
  /** Called once with the not-yet-uploaded segments so the caller can save them locally. */
  readonly onGiveUp?: (pending: QueueItem[], reason: 'fatal' | 'unstable') => void;
  /** A segment did not fit in the bounded queue; the caller must save it locally. */
  readonly onOverflow?: (item: QueueItem) => void;
  /** Called after each successful upload with its duration. */
  readonly onUploaded?: (item: QueueItem, durationMs: number) => void;
}

/** FIFO background upload queue: at most one upload in flight; callers never await it. */
export class RecordingUploadQueue {
  private items: QueueItem[] = [];
  private busy = false;
  private dead = false;
  private failureTimes: number[] = [];
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
    if (this.items.length >= (this.options.maxWaiting ?? 12)) {
      this.options.onOverflow?.(item);
      this.options.onPressure?.('backlog');
      return;
    }
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

  private giveUp(reason: 'fatal' | 'unstable'): void {
    const pending = this.drainPending();
    this.options.onGiveUp?.(pending, reason);
  }

  private async pump(): Promise<void> {
    if (this.busy || this.dead) return;
    const item = this.items[0];
    if (!item) return;
    this.busy = true;
    const now = this.options.now ?? Date.now;
    const started = now();
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      // The race guarantees a hung upload fails even if the uploader ignores the signal.
      await Promise.race([
        this.options.upload(item, controller.signal),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            const error = new Error('Segment upload timed out.');
            controller.abort(error);
            reject(error);
          }, this.options.uploadTimeoutMs ?? 15_000);
        }),
      ]);
    } catch (error) {
      this.busy = false;
      if (this.dead) return;
      const at = now();
      const windowMs = this.options.failureWindowMs ?? 60_000;
      this.failureTimes = this.failureTimes.filter((time) => at - time < windowMs);
      this.failureTimes.push(at);
      if (this.options.isFatal?.(error)) {
        this.giveUp('fatal');
        return;
      }
      if (this.failureTimes.length >= (this.options.maxFailuresInWindow ?? 3)) {
        this.giveUp('unstable');
        return;
      }
      this.options.onChange?.();
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        void this.pump();
      }, this.options.retryDelayMs ?? 2000);
      return;
    } finally {
      clearTimeout(timeout);
    }
    this.busy = false;
    if (this.dead) return;
    this.items.shift();
    this.uploadedCount += 1;
    this.options.onUploaded?.(item, now() - started);
    this.options.onChange?.();
    if (now() - started > this.options.segmentMs) this.options.onPressure?.('slow');
    void this.pump();
  }
}
