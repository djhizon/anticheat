import { cameraAttestation, type AttestCamera } from './cameraAttestation.js';
import type { CameraBlock, CameraGateResult } from './cameraGate.js';

export interface ContinuityState {
  /** True while answering must stay disabled. */
  readonly paused: boolean;
  readonly checking: boolean;
  readonly reason: string | null;
  readonly block: CameraBlock | null;
  /** Bumped on each resume so camera consumers can remount and re-acquire. */
  readonly epoch: number;
}

export interface ContinuityOptions {
  /** Runs the camera gate; the controller stops any stream it returns. */
  readonly check: () => Promise<CameraGateResult>;
  /** Logs integrity events (camera_feed_paused_*, camera_feed_resumed). */
  readonly report: (event: string) => void;
  readonly onChange: (state: ContinuityState) => void;
  readonly getTrack: () => MediaStreamTrack | null;
  readonly media?: Pick<MediaDevices, 'addEventListener' | 'removeEventListener'>;
  /** A muted track must stay muted this long before answering pauses. */
  readonly muteGraceMs?: number;
  readonly tickMs?: number;
  /** While paused the gate re-runs every this many ticks. */
  readonly recheckEveryTicks?: number;
  /**
   * Mac app hardware attestation of the active camera, re-run when it is first watched and on
   * every device change. Defaults to the Mac app bridge; null (or a plain browser) disables it.
   */
  readonly attest?: AttestCamera | null;
}

export interface CameraContinuity {
  /** Feed cameraGuard events in: swap-to-virtual and disconnect pause immediately. */
  notify(event: string): void;
  /** Manual "Check again". */
  recheck(): Promise<void>;
  state(): ContinuityState;
  stop(): void;
}

const PAUSING_EVENTS: Record<string, string> = {
  camera_swapped_to_virtual: 'virtual_camera',
  camera_disconnected: 'disconnected',
};

export function createCameraContinuity(options: ContinuityOptions): CameraContinuity {
  const muteGraceMs = options.muteGraceMs ?? 3000;
  const recheckEvery = options.recheckEveryTicks ?? 2;
  let state: ContinuityState = {
    paused: false,
    checking: false,
    reason: null,
    block: null,
    epoch: 0,
  };
  let stopped = false;
  let inFlight: Promise<void> | null = null;
  let watched: MediaStreamTrack | null = null;
  let muteTimer: ReturnType<typeof setTimeout> | null = null;
  let ticks = 0;
  const attest = options.attest === undefined ? cameraAttestation() : options.attest;
  const unverified = new Set<string>();
  let attesting = false;
  const noteUnverified = (label: string): void => {
    if (unverified.has(label)) return;
    unverified.add(label);
    options.report('camera_unverified');
  };
  // A camera macOS reports as virtual pauses answering like a virtual-labelled one.
  const attestActive = (): void => {
    const track = options.getTrack();
    if (!attest || attesting || stopped || state.paused || !track?.label) return;
    attesting = true;
    void attest(track.label)
      .then((result) => {
        if (stopped || options.getTrack() !== track) return;
        if (result.verdict === 'virtual') pause('virtual_camera_attested');
        else if (result.verdict === 'unknown') noteUnverified(track.label);
      })
      .catch(() => {})
      .finally(() => {
        attesting = false;
      });
  };

  const set = (next: Partial<ContinuityState>): void => {
    state = { ...state, ...next };
    if (!stopped) options.onChange(state);
  };

  const clearMute = (): void => {
    if (muteTimer !== null) clearTimeout(muteTimer);
    muteTimer = null;
  };
  const onEnded = (): void => pause('track_ended');
  const onMute = (): void => {
    if (muteTimer !== null || state.paused) return;
    muteTimer = setTimeout(() => {
      muteTimer = null;
      if (watched?.muted) pause('track_muted');
    }, muteGraceMs);
  };
  const onUnmute = (): void => clearMute();
  const unwatch = (): void => {
    watched?.removeEventListener('ended', onEnded);
    watched?.removeEventListener('mute', onMute);
    watched?.removeEventListener('unmute', onUnmute);
    watched = null;
    clearMute();
  };
  const watch = (): void => {
    const track = options.getTrack();
    if (track === watched) return;
    unwatch();
    if (!track) return;
    watched = track;
    track.addEventListener('ended', onEnded);
    track.addEventListener('mute', onMute);
    track.addEventListener('unmute', onUnmute);
    if (track.readyState === 'ended') onEnded();
    else if (track.muted) onMute();
    else attestActive();
  };

  function pause(reason: string): void {
    if (stopped || state.paused) return;
    clearMute();
    set({ paused: true, reason, block: null });
    options.report(`camera_feed_paused_${reason}`);
    void recheck();
  }

  function recheck(): Promise<void> {
    if (stopped || !state.paused) return Promise.resolve();
    if (inFlight) return inFlight;
    set({ checking: true });
    inFlight = options
      .check()
      .then((result) => {
        if (result.state === 'ok') {
          result.stream.getTracks().forEach((track) => track.stop());
          if (result.attestation?.verdict === 'unknown') noteUnverified(result.label);
          unwatch();
          set({
            paused: false,
            checking: false,
            reason: null,
            block: null,
            epoch: state.epoch + 1,
          });
          options.report('camera_feed_resumed');
        } else set({ checking: false, block: result });
      })
      .catch(() => set({ checking: false }))
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }

  const onDeviceChange = (): void => {
    if (state.paused) void recheck();
    else attestActive();
  };
  options.media?.addEventListener('devicechange', onDeviceChange);
  const timer = setInterval(() => {
    ticks += 1;
    if (state.paused) {
      if (ticks % recheckEvery === 0) void recheck();
      return;
    }
    watch();
  }, options.tickMs ?? 1000);

  return {
    notify(event) {
      const reason = PAUSING_EVENTS[event];
      if (reason) pause(reason);
    },
    recheck,
    state: () => state,
    stop() {
      stopped = true;
      clearInterval(timer);
      unwatch();
      options.media?.removeEventListener('devicechange', onDeviceChange);
    },
  };
}
