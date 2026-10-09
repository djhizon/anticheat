/** Second opinion from the opt-in local OWL-ViT server, for items the browser model cannot see. */
export const SERVER_VISION_INTERVAL_MS = 20_000;
export const SERVER_VISION_MAX_WIDTH = 640;
export const SERVER_VISION_QUALITY = 0.7;
/** Labels shown to the student (a subset of what the server queries). */
export const SERVER_VISION_ITEMS = ['earbuds', 'headphones', 'smart glasses', 'smart watch'];

export type ServerVisionStatus =
  | { readonly state: 'not_checked' }
  | { readonly state: 'not_seen' }
  | { readonly state: 'seen'; readonly labels: readonly string[] };

export interface ServerVisionScheduler {
  stop(): void;
}

export interface ServerVisionOptions {
  /** Returns a base64 JPEG (no data: prefix) or null when no frame is ready. */
  readonly capture: () => string | null;
  readonly send: (
    imageBase64: string,
    signal: AbortSignal,
  ) => Promise<readonly { readonly label: string }[]>;
  readonly onStatus: (status: ServerVisionStatus) => void;
  readonly intervalMs?: number;
}

/**
 * Sends one frame per interval, never overlapping requests: a tick is skipped
 * while a request is in flight. Stopping aborts the request and ignores its reply.
 */
export function startServerVision(options: ServerVisionOptions): ServerVisionScheduler {
  const controller = new AbortController();
  let inFlight = false;
  const tick = (): void => {
    if (inFlight || controller.signal.aborted) return;
    const frame = options.capture();
    if (frame === null) return;
    inFlight = true;
    options
      .send(frame, controller.signal)
      .then((detections) => {
        if (controller.signal.aborted) return;
        const labels = SERVER_VISION_ITEMS.filter((item) =>
          detections.some((detection) => detection.label === item),
        );
        options.onStatus(labels.length > 0 ? { state: 'seen', labels } : { state: 'not_seen' });
      })
      .catch(() => {
        // A failed check leaves the previous status; it is never read as "clear".
      })
      .finally(() => {
        inFlight = false;
      });
  };
  const timer = setInterval(tick, options.intervalMs ?? SERVER_VISION_INTERVAL_MS);
  return {
    stop(): void {
      controller.abort();
      clearInterval(timer);
    },
  };
}

/** Downscale the video to at most 640 px wide and return a base64 JPEG, or null if unavailable. */
export function captureVisionFrame(video: HTMLVideoElement | null): string | null {
  if (!video || video.readyState < 2 || video.videoWidth === 0 || video.videoHeight === 0) {
    return null;
  }
  const scale = Math.min(1, SERVER_VISION_MAX_WIDTH / video.videoWidth);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);
  const context = canvas.getContext('2d');
  if (!context) return null;
  try {
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const url = canvas.toDataURL('image/jpeg', SERVER_VISION_QUALITY);
    return url.startsWith('data:image/jpeg;base64,') ? url.slice(url.indexOf(',') + 1) : null;
  } catch {
    return null;
  }
}

export function serverVisionText(status: ServerVisionStatus): string {
  const base = `Second opinion (local OWL-ViT): ${SERVER_VISION_ITEMS.join(' / ')} — `;
  if (status.state === 'seen')
    return `${base}seen: ${status.labels.join(', ')} (a lead, not a verdict)`;
  return `${base}${status.state === 'not_seen' ? 'not seen' : 'not checked'}`;
}
