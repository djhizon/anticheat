/** Largest JPEG the API accepts for an evidence snapshot. */
export const MAX_SNAPSHOT_BYTES = 300 * 1024;
/** One still at most this often; this is never a recording. */
export const MIN_SNAPSHOT_GAP_MS = 5000;
const MAX_WIDTH = 640;
const JPEG_QUALITY = 60;

interface ThumbnailLike {
  isEmpty(): boolean;
  toJPEG(quality: number): Buffer;
}
export interface ScreenSnapshotDeps {
  getSources(options: {
    types: ['screen'];
    thumbnailSize: { width: number; height: number };
    fetchWindowIcons: false;
  }): Promise<Array<{ display_id: string; thumbnail: ThumbnailLike }>>;
  primaryDisplay(): { id: number; size: { width: number; height: number } };
  now(): number;
}

let lastCapture = -Infinity;

/** Test seam: forget the previous capture time. */
export function resetScreenSnapshotThrottle(): void {
  lastCapture = -Infinity;
}

/**
 * One downscaled JPEG (base64) of the primary screen, or null when the OS gives no image
 * (for example screen-recording permission was not granted), it is too large, or it was
 * requested again too soon. The renderer only asks while an attempt is being watched.
 */
export async function captureScreenSnapshot(deps: ScreenSnapshotDeps): Promise<string | null> {
  const at = deps.now();
  if (at >= lastCapture && at - lastCapture < MIN_SNAPSHOT_GAP_MS) return null;
  lastCapture = at;
  try {
    const display = deps.primaryDisplay();
    const width = Math.max(1, Math.min(MAX_WIDTH, display.size.width));
    const height = Math.max(1, Math.round((width * display.size.height) / display.size.width));
    const sources = await deps.getSources({
      types: ['screen'],
      thumbnailSize: { width, height },
      fetchWindowIcons: false,
    });
    const source = sources.find((item) => item.display_id === String(display.id)) ?? sources[0];
    if (!source || source.thumbnail.isEmpty()) return null;
    const jpeg = source.thumbnail.toJPEG(JPEG_QUALITY);
    return jpeg.length > 0 && jpeg.length <= MAX_SNAPSHOT_BYTES ? jpeg.toString('base64') : null;
  } catch {
    return null;
  }
}
