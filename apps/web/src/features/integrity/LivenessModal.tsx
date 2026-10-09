import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { LivenessColour, LivenessTurnDirection } from '@examguard/contracts/exam';

import type { ExamApi, LivenessChallenge } from '../exam/api.js';
import { captureHeadTurn, withTimeout } from './headTurn.js';
import { captureColourFlash } from './livenessCapture.js';
import { captureSpokenWords } from './spokenWords.js';

interface LivenessModalProps {
  readonly attemptId: string;
  readonly examApi: ExamApi;
  readonly onComplete: (success: boolean) => void;
}

type Preferred = 'head_turn' | 'spoken_words' | undefined;
type Phase = 'loading' | 'ready' | 'running' | 'done';

/** Camera permission, flash, microphone and the verify request each get this long. */
export const CHECK_TIMEOUT_MS = 30_000;
/** Head turn and colour flash load a face model on-device, so they get a longer budget. */
export const HEAD_TURN_TIMEOUT_MS = 60_000;
export const NOT_VERIFIED_COPY = 'Not verified — you can try again.';

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const asList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];

const button = (background: string): React.CSSProperties => ({
  background,
  color: 'white',
  border: 'none',
  padding: '0.9rem 2rem',
  fontSize: '1.1rem',
  borderRadius: '8px',
  cursor: 'pointer',
  fontWeight: 'bold',
});

const linkButton: React.CSSProperties = {
  background: 'none',
  border: 'none',
  color: '#93c5fd',
  textDecoration: 'underline',
  cursor: 'pointer',
  fontSize: '1rem',
  padding: '0.4rem',
};

export function LivenessModal({ attemptId, examApi, onComplete }: LivenessModalProps) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [challenge, setChallenge] = useState<LivenessChallenge | null>(null);
  const [status, setStatus] = useState('');
  const [passed, setPassed] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const closing = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);
  const completed = useRef(false);
  const abort = useRef<AbortController | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const defaultPreferred = useRef<Preferred>(prefersReducedMotion() ? 'head_turn' : undefined);

  const finish = useCallback(
    (success: boolean) => {
      if (completed.current) return;
      completed.current = true;
      if (closing.current) clearTimeout(closing.current);
      abort.current?.abort();
      onComplete(success);
    },
    [onComplete],
  );
  const passedRef = useRef(false);
  passedRef.current = passed === true;

  const load = useCallback(
    (preferred?: Preferred) => {
      setPhase('loading');
      setPassed(null);
      setStatus('');
      setError(null);
      examApi
        .postLivenessChallenge(attemptId, preferred)
        .then((res) => {
          if (!alive.current) return;
          setChallenge(res);
          setPhase('ready');
        })
        .catch(() => {
          if (!alive.current) return;
          setError('Could not get a check from the server. Close this and try again.');
          setPhase('done');
          setPassed(false);
        });
    },
    [attemptId, examApi],
  );

  useEffect(() => {
    alive.current = true;
    load(defaultPreferred.current);
    return () => {
      alive.current = false;
      abort.current?.abort();
      if (closing.current) clearTimeout(closing.current);
    };
  }, [load]);

  // Focus moves into the dialog on open and returns to the trigger on close.
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    (dialog?.querySelector<HTMLElement>(FOCUSABLE) ?? dialog)?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        finish(passedRef.current);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      previous?.focus();
    };
  }, [finish]);

  // The dialog has no focusable content while loading except Close, so keep
  // focus inside whenever the focused button disappears.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.contains(document.activeElement)) {
      (dialog.querySelector<HTMLElement>(FOCUSABLE) ?? dialog).focus();
    }
  }, [phase]);

  const trapTab = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab') return;
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (items.length === 0) {
      event.preventDefault();
      return;
    }
    const first = items[0]!;
    const last = items[items.length - 1]!;
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !event.currentTarget.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !event.currentTarget.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  };

  const run = async () => {
    if (!challenge) return;
    setPhase('running');
    setError(null);
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    const { signal } = controller;
    const capture = async (): Promise<Record<string, unknown>> => {
      if (challenge.type === 'colour_flash') {
        setStatus(
          'Warning: the screen will flash red, green and blue briefly. Keep still and face the screen.',
        );
        const evidence = await captureColourFlash(
          asList(challenge.data.sequence) as LivenessColour[],
          undefined,
          signal,
        );
        return {
          payload: {
            baseline: evidence.baseline,
            frames: evidence.frames,
            faces: evidence.faces,
          },
          camera: { label: evidence.cameraLabel },
        };
      }
      if (challenge.type === 'head_turn') {
        const evidence = await captureHeadTurn(
          asList(challenge.data.sequence) as LivenessTurnDirection[],
          setStatus,
          undefined,
          undefined,
          signal,
        );
        return {
          payload: { samples: evidence.samples },
          camera: { label: evidence.cameraLabel },
        };
      }
      setStatus('Getting the microphone ready…');
      const evidence = await captureSpokenWords(
        undefined,
        () => setStatus(`Recording… say: ${asList(challenge.data.words).join(', ')}`),
        signal,
      );
      return {
        payload: {},
        audioBase64: evidence.audioBase64,
        camera: { label: evidence.cameraLabel },
      };
    };
    try {
      const timeoutMs = challenge.type === 'spoken_words' ? CHECK_TIMEOUT_MS : HEAD_TURN_TIMEOUT_MS;
      let request: Record<string, unknown>;
      try {
        request = await withTimeout(
          capture(),
          timeoutMs,
          'The check took too long (camera or microphone did not respond).',
        );
      } catch (e) {
        controller.abort();
        throw e;
      }
      setStatus('Checking on this computer…');
      const res = await withTimeout(
        examApi.postLivenessVerify(attemptId, {
          nonce: challenge.nonce,
          signature: challenge.signature,
          layer: 3,
          ...request,
        }),
        CHECK_TIMEOUT_MS,
        'The server took too long to answer.',
      );
      if (!alive.current) return;
      setPassed(res.passed);
      setStatus(res.detail);
      setPhase('done');
      if (res.passed) closing.current = setTimeout(() => finish(true), 1800);
    } catch (e) {
      if (!alive.current) return;
      setPassed(false);
      setStatus('');
      setError(e instanceof Error ? e.message : 'The check could not be completed.');
      setPhase('done');
    }
  };

  const words = challenge?.type === 'spoken_words' ? asList(challenge.data.words) : [];
  const busy = phase === 'loading' || phase === 'running';

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="liveness-title"
      ref={dialogRef}
      tabIndex={-1}
      onKeyDown={trapTab}
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(0,0,0,0.85)',
        zIndex: 100000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: '#fff',
      }}
    >
      <div
        style={{
          background: '#1e1e1e',
          padding: '2.5rem',
          borderRadius: '16px',
          border: '1px solid #333',
          textAlign: 'center',
          maxWidth: '520px',
          width: '100%',
        }}
      >
        <h2 id="liveness-title" style={{ marginBottom: '0.5rem', color: '#60a5fa' }}>
          Quick presence check
        </h2>
        <p style={{ color: '#aaa', marginBottom: '1.5rem' }}>
          Done on this computer. Answering and question timers are paused while this is open; the
          exam deadline keeps running.
        </p>

        <div aria-live="polite" style={{ minHeight: '5rem', marginBottom: '1.5rem' }}>
          {phase === 'loading' && <p>Preparing your check…</p>}
          {phase === 'ready' && challenge?.type === 'colour_flash' && (
            <p style={{ fontSize: '1.15rem' }}>
              <strong>Warning: flashing colours.</strong> The screen will show three quick colours
              (red, green, blue) for about two seconds. If flashing bothers you, choose another
              option below.
            </p>
          )}
          {phase === 'ready' && challenge?.type === 'head_turn' && (
            <p style={{ fontSize: '1.15rem' }}>
              You will be asked to turn your head{' '}
              <strong>{asList(challenge.data.sequence).join(', then ')}</strong>, facing the screen
              again between turns.
            </p>
          )}
          {phase === 'ready' && challenge?.type === 'spoken_words' && (
            <p style={{ fontSize: '1.15rem' }}>
              When recording starts, say these words clearly: <strong>{words.join(', ')}</strong>
            </p>
          )}
          {phase === 'running' && <p style={{ fontSize: '1.15rem' }}>{status}</p>}
          {phase === 'done' && (
            <p style={{ fontSize: '1.15rem', color: passed ? '#34d399' : '#fca5a5' }}>
              {passed
                ? challenge?.type === 'spoken_words'
                  ? 'Verified. Thank you.'
                  : 'Check passed (client-measured). Thank you.'
                : `${NOT_VERIFIED_COPY} ${error ?? status}`}
            </p>
          )}
        </div>

        <div style={{ display: 'flex', gap: '1rem', justifyContent: 'center', flexWrap: 'wrap' }}>
          {phase === 'ready' && (
            <button type="button" onClick={() => void run()} style={button('#10b981')}>
              Start
            </button>
          )}
          {phase === 'done' && !passed && (
            <button
              type="button"
              onClick={() => load(defaultPreferred.current)}
              style={button('#2563eb')}
            >
              Try again
            </button>
          )}
          {phase === 'done' && passed && (
            <button type="button" onClick={() => finish(true)} style={button('#10b981')}>
              Continue
            </button>
          )}
        </div>

        <div
          style={{
            marginTop: '1rem',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
          }}
        >
          {!busy && !passed && challenge?.type !== 'head_turn' && (
            <button type="button" style={linkButton} onClick={() => load('head_turn')}>
              Try head turn instead
            </button>
          )}
          {!busy && !passed && challenge?.type !== 'spoken_words' && (
            <button type="button" style={linkButton} onClick={() => load('spoken_words')}>
              I can&apos;t do the visual check
            </button>
          )}
          <button type="button" style={linkButton} onClick={() => finish(passed === true)}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
