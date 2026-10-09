import { useEffect, useRef, useState } from 'react';
import type { FindingWindow } from '@examguard/contracts/findings';

/** Clip length shown for one finding window. */
export const CLIP_SECONDS = 20;

/** A playable screen-recording source for an attempt and where the window starts in it. */
export interface RecordingClip {
  /** URL the browser can play (blob:, same-origin file, or a signed OneDrive link). */
  readonly src: string;
  /** Seconds into `src` where the finding window starts. */
  readonly offsetSeconds: number;
}

export interface RecordingSource {
  /** Resolves to null when no playable recording exists for that time (e.g. saved locally). */
  resolve(attemptId: string, window: FindingWindow): Promise<RecordingClip | null>;
}

/**
 * Screen-recording segments are uploaded to the school's OneDrive (or kept on the student's
 * computer when the cloud is not configured); the API has no playback route, so by default no
 * clip can be served. Callers that can produce a URL plug in their own source.
 */
export const noRecordings: RecordingSource = {
  resolve: () => Promise.resolve(null),
};

const time = (value: string): string =>
  new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

export function windowLabel(window: FindingWindow): string {
  return `${time(window.start)} – ${time(window.end)}`;
}

/** Plays a 20 s clip from `offsetSeconds`; pauses by itself at the end of the clip. */
export function ClipPlayer({
  clip,
  window,
}: {
  readonly clip: RecordingClip;
  readonly window: FindingWindow;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const video = videoRef.current;
    if (video === null) return;
    const end = clip.offsetSeconds + CLIP_SECONDS;
    const seek = () => {
      video.currentTime = clip.offsetSeconds;
      void video.play().catch(() => undefined);
    };
    const stop = () => {
      if (video.currentTime >= end) video.pause();
    };
    video.addEventListener('loadedmetadata', seek);
    video.addEventListener('timeupdate', stop);
    if (video.readyState >= 1) seek();
    return () => {
      video.removeEventListener('loadedmetadata', seek);
      video.removeEventListener('timeupdate', stop);
    };
  }, [clip]);
  return (
    <figure className="clip-player">
      <video
        ref={videoRef}
        src={clip.src}
        controls
        preload="metadata"
        aria-label={`Clip ${windowLabel(window)}`}
      />
      <figcaption>
        {CLIP_SECONDS} s clip from {windowLabel(window)}
      </figcaption>
    </figure>
  );
}

/**
 * "Play clip" for one finding window. Opens the screen recording at that time when a source can
 * provide one; otherwise shows the window's time range (the nearest photos are rendered by the
 * caller next to it).
 */
export function PlayClipButton({
  attemptId,
  window,
  recordings,
}: {
  readonly attemptId: string;
  readonly window: FindingWindow;
  readonly recordings: RecordingSource;
}) {
  const [state, setState] = useState<
    | { kind: 'idle' }
    | { kind: 'loading' }
    | { kind: 'clip'; clip: RecordingClip }
    | { kind: 'none' }
  >({ kind: 'idle' });

  useEffect(() => {
    setState({ kind: 'idle' });
  }, [attemptId, window.start]);

  async function open(): Promise<void> {
    setState({ kind: 'loading' });
    try {
      const clip = await recordings.resolve(attemptId, window);
      setState(clip === null ? { kind: 'none' } : { kind: 'clip', clip });
    } catch {
      setState({ kind: 'none' });
    }
  }

  return (
    <div className="clip-window">
      <button
        type="button"
        className="secondary-button clip-button"
        onClick={() => void open()}
        disabled={state.kind === 'loading'}
      >
        ▶ Play clip · {windowLabel(window)}
      </button>
      {state.kind === 'clip' && <ClipPlayer clip={state.clip} window={window} />}
      {state.kind === 'none' && (
        <p className="clip-fallback" role="status">
          No playable recording for {windowLabel(window)}: the screen recording is in the school
          OneDrive or on the student&apos;s computer. The photos nearest to this window are shown
          instead.
        </p>
      )}
    </div>
  );
}
