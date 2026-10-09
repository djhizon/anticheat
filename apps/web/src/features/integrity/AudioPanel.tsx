import { useEffect, useRef, useState } from 'react';
import { createAudioSession, type AudioSnapshot } from './audioSession.js';
import { createAudioRecorder } from './audioRecorder.js';
import { acquireBuiltInMicrophone } from './builtInMicrophone.js';
import { heldMicrophoneStream } from './sensorHub.js';
import { createLevelMeter, METER_BARS, type LevelReading } from './audioLevel.js';
import { appendLine, formatClock, type LogLine } from './transcriptLog.js';
import { registerSubmitFlush } from './submitFlush.js';
import { plural } from '@examguard/contracts';
import { createVoiceReporter } from './voiceReporter.js';
import type { ExamApi } from '../exam/api.js';

export const AUTO_START_DELAY_MS = 1000;
/** After the microphone drops, audio restarts by itself this often before asking for a resume. */
export const AUTO_RETRY_DELAY_MS = 3000;
export const MAX_AUTO_RETRIES = 5;

export function AudioPanel({
  attemptId,
  active,
  examApi,
  autoStart = false,
  onLiveChange,
  onUnavailable,
}: {
  readonly attemptId: string;
  readonly active: boolean;
  readonly examApi?: ExamApi;
  /** Start once, shortly after the camera, when consent was given. Never retried. */
  readonly autoStart?: boolean;
  /** Read-only status for the exam top bar: true while the microphone is recording. */
  readonly onLiveChange?: (live: boolean) => void;
  /** Called when automatic restarts keep failing; the page offers "Resume monitoring". */
  readonly onUnavailable?: (reason: string) => void;
}) {
  const [enabled, setEnabled] = useState(false);
  const [snapshot, setSnapshot] = useState<AudioSnapshot | null>(null);
  const [log, setLog] = useState<readonly LogLine[]>([]);
  const [busy, setBusy] = useState(false);
  const [micStream, setMicStream] = useState<MediaStream | null>(null);
  const [status, setStatus] = useState('Audio not started.');
  const [device, setDevice] = useState('');
  const [error, setError] = useState('');
  const [monitorNote, setMonitorNote] = useState('');
  const [skippedClips, setSkippedClips] = useState(0);
  useEffect(() => {
    setEnabled(false);
    setLog([]);
    setSkippedClips(0);
  }, [attemptId]);
  useEffect(() => {
    // Restore the saved log after a reload. Duplicates of live lines are dropped by key.
    let cancelled = false;
    void examApi
      ?.getTranscript?.(attemptId)
      .then((saved) => {
        if (cancelled) return;
        setLog((previous) => {
          let next: readonly LogLine[] = [];
          for (const entry of saved) {
            next = appendLine(next, {
              at: Date.parse(entry.capturedAt),
              kind: 'text',
              text: entry.text,
            });
          }
          for (const line of previous) next = appendLine(next, line);
          return next;
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [attemptId, examApi]);
  useEffect(() => {
    // Deliberately independent of `enabled`/`error`: a failed start leaves the
    // manual button and error visible instead of retrying. Delay lets the camera
    // permission prompt and model loading finish first.
    if (!autoStart || !active) return;
    const timer = setTimeout(() => setEnabled(true), AUTO_START_DELAY_MS);
    return () => clearTimeout(timer);
  }, [autoStart, active, attemptId]);
  useEffect(() => {
    if (!active || !enabled) return;
    let cancelled = false;
    let stream: MediaStream | null = null;
    const voiceReporter =
      typeof examApi?.uploadTelemetry === 'function'
        ? createVoiceReporter(attemptId, examApi)
        : null;
    const monitor = createAudioSession(
      attemptId,
      (value) => {
        if (!cancelled) setSnapshot(value);
      },
      (durationMs, peakDb) => voiceReporter?.detected(durationMs, peakDb),
    );
    const recorder = examApi
      ? createAudioRecorder(
          attemptId,
          examApi,
          (text, at) => {
            if (!cancelled) setLog((previous) => appendLine(previous, { at, kind: 'text', text }));
          },
          (text) => {
            if (!cancelled) setStatus(text);
          },
          {
            // One small status instead of a log line per skipped clip.
            onSkipped: () => {
              if (!cancelled) setSkippedClips((count) => count + 1);
            },
            onBusy: (value) => {
              if (!cancelled) setBusy(value);
            },
          },
        )
      : null;
    setError('');
    setMonitorNote('');
    setSnapshot(null);
    setStatus('Starting built-in microphone…');
    const ended = () => {
      setError('Built-in microphone disconnected. Retry audio.');
      setEnabled(false);
    };
    void (async () => {
      try {
        // Reuse the stream the pre-exam setup verified; fall back to a fresh acquire.
        const acquired = heldMicrophoneStream() ?? (await acquireBuiltInMicrophone());
        if (cancelled) {
          acquired.getTracks().forEach((track) => track.stop());
          return;
        }
        stream = acquired;
        setMicStream(acquired);
        setDevice(acquired.getAudioTracks()[0]?.label ?? 'Built-in microphone');
        acquired.getAudioTracks().forEach((track) => track.addEventListener('ended', ended));
        // Each part fails independently: a monitor failure must not stop transcription.
        try {
          await monitor.start(true, acquired);
        } catch {
          if (!cancelled) setMonitorNote('Sound-activity monitor unavailable.');
        }
        if (cancelled) return;
        try {
          await recorder?.start(acquired);
          if (!recorder) setStatus('Transcription unavailable: exam API is not connected.');
        } catch {
          if (!cancelled) setStatus('Transcription could not start.');
        }
      } catch (failure) {
        if (!cancelled) {
          setError(failure instanceof Error ? failure.message : 'Audio failed to start.');
          setEnabled(false);
        }
      }
    })();
    const unregisterFlush = registerSubmitFlush(async () => {
      voiceReporter?.stop();
      await recorder?.flush?.(3000);
    });
    return () => {
      unregisterFlush();
      cancelled = true;
      setMicStream(null);
      setBusy(false);
      recorder?.stop();
      monitor.destroy();
      voiceReporter?.stop();
      stream?.getAudioTracks().forEach((track) => track.removeEventListener('ended', ended));
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, [active, enabled, attemptId, examApi]);
  const live = active && enabled && snapshot?.phase === 'recording';
  const retries = useRef(0);
  const liveRef = useRef(onLiveChange);
  liveRef.current = onLiveChange;
  const unavailableRef = useRef(onUnavailable);
  unavailableRef.current = onUnavailable;
  useEffect(() => {
    if (live) retries.current = 0;
    liveRef.current?.(live);
  }, [live]);
  // No Start/Stop control during the exam: a dropped microphone restarts by itself a few times,
  // then the page asks the student to resume monitoring.
  useEffect(() => {
    if (!autoStart || !active || enabled || !error) return;
    if (retries.current >= MAX_AUTO_RETRIES) {
      unavailableRef.current?.(error);
      return;
    }
    const timer = setTimeout(() => {
      retries.current += 1;
      setEnabled(true);
    }, AUTO_RETRY_DELAY_MS);
    return () => clearTimeout(timer);
  }, [autoStart, active, enabled, error]);
  return (
    <section className="audio-panel-compact" aria-label="Audio checks">
      <p role="status">
        {live
          ? `Microphone active: ${device}`
          : enabled && active
            ? 'Starting audio…'
            : error
              ? 'Audio interrupted — reconnecting…'
              : autoStart && active
                ? 'Starting audio…'
                : 'Audio off'}
      </p>
      {error && <p role="alert">{error}</p>}
      {monitorNote && enabled && <p className="muted">{monitorNote}</p>}
      {live && (
        <p>
          Sound activity events: {snapshot.voiceDetectedCount}. This is not proof of speech or
          cheating.
        </p>
      )}
      {live && micStream && <RecordingIndicator stream={micStream} />}
      <h3>Local clip transcript</h3>
      <p role="status">{enabled && active ? status : 'Transcription off'}</p>
      <p className="muted">
        Three-second clips transcribed on this computer; a clip is skipped while the previous one is
        still being transcribed. Uses only the built-in laptop microphone.
      </p>
      {skippedClips > 0 && enabled && active && (
        <p className="muted transcript-skipped">
          {plural(skippedClips, 'clip')} skipped so far while a previous clip was still being
          transcribed.
        </p>
      )}
      <TranscriptLog lines={log} busy={busy && enabled && active} />
    </section>
  );
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

const IDLE_READING: LevelReading = { bars: Array(METER_BARS).fill(0), level: 0 };

export function RecordingIndicator({ stream }: { readonly stream: MediaStream }) {
  const [reading, setReading] = useState<LevelReading>(IDLE_READING);
  const reduced = prefersReducedMotion();
  useEffect(() => {
    const stop = createLevelMeter(stream, setReading, reduced);
    return () => {
      stop();
      setReading(IDLE_READING);
    };
  }, [stream, reduced]);
  return (
    <div className="rec-indicator">
      <span className="rec-dot" aria-hidden="true">
        ●
      </span>
      <span className="rec-label">REC</span>
      <span className="sr-only"> Microphone is recording</span>
      {reduced ? (
        <span className="level-bar" aria-hidden="true">
          <span
            className="level-bar-fill"
            style={{ width: `${Math.round(reading.level * 100)}%` }}
          />
        </span>
      ) : (
        <svg
          className="level-meter"
          width="42"
          height="18"
          viewBox="0 0 42 18"
          aria-hidden="true"
          focusable="false"
        >
          {reading.bars.map((value, index) => {
            const height = Math.max(2, Math.round(value * 18));
            return (
              <rect
                key={index}
                x={index * 7}
                y={18 - height}
                width="5"
                height={height}
                rx="1"
                fill="#34d399"
              />
            );
          })}
        </svg>
      )}
    </div>
  );
}

const SCROLL_STICK_PX = 24;

export function TranscriptLog({
  lines,
  busy,
}: {
  readonly lines: readonly LogLine[];
  readonly busy: boolean;
}) {
  const feed = useRef<HTMLDivElement | null>(null);
  const stick = useRef(true);
  useEffect(() => {
    const element = feed.current;
    if (element && stick.current) element.scrollTop = element.scrollHeight;
  }, [lines, busy]);
  if (lines.length === 0 && !busy) return null;
  return (
    <div
      className="transcript-feed"
      ref={feed}
      onScroll={(event) => {
        const el = event.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < SCROLL_STICK_PX;
      }}
    >
      <div role="log" aria-live="polite" aria-label="Transcript log" className="transcript-lines">
        {lines.map((line) => (
          <p
            key={line.key}
            className={
              line.kind === 'skipped'
                ? 'transcript-line transcript-line--skipped'
                : 'transcript-line'
            }
          >
            <time dateTime={new Date(line.at).toISOString()}>{formatClock(new Date(line.at))}</time>
            {' — '}
            {line.text}
          </p>
        ))}
      </div>
      {busy && (
        <p className="transcript-line transcript-shimmer" aria-hidden="true">
          transcribing…
        </p>
      )}
    </div>
  );
}
