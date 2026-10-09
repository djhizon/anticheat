import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { LivenessColour, LivenessTurnDirection } from '@exam-anti-cheat/contracts/exam';

import type { ExamApi, LivenessChallenge } from '../exam/api.js';
import { captureHeadTurn } from './headTurn.js';
import { captureColourFlash } from './livenessCapture.js';
import { captureSpokenWords } from './spokenWords.js';

interface LivenessModalProps {
  readonly attemptId: string;
  readonly examApi: ExamApi;
  readonly onComplete: (success: boolean) => void;
}

type Preferred = 'head_turn' | 'spoken_words' | undefined;
type Phase = 'loading' | 'ready' | 'running' | 'done';

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
    load();
    return () => {
      alive.current = false;
      if (closing.current) clearTimeout(closing.current);
    };
  }, [load]);

  const run = async () => {
    if (!challenge) return;
    setPhase('running');
    setError(null);
    try {
      let request: Record<string, unknown>;
      if (challenge.type === 'colour_flash') {
        setStatus('Look at the screen and keep still. The screen will change colour briefly.');
        const evidence = await captureColourFlash(
          asList(challenge.data.sequence) as LivenessColour[],
        );
        request = {
          payload: { baseline: evidence.baseline, frames: evidence.frames },
          camera: { label: evidence.cameraLabel },
        };
      } else if (challenge.type === 'head_turn') {
        const evidence = await captureHeadTurn(
          asList(challenge.data.sequence) as LivenessTurnDirection[],
          setStatus,
        );
        request = {
          payload: { samples: evidence.samples },
          camera: { label: evidence.cameraLabel },
        };
      } else {
        setStatus('Getting the microphone ready…');
        const evidence = await captureSpokenWords(undefined, () =>
          setStatus(`Recording… say: ${asList(challenge.data.words).join(', ')}`),
        );
        request = {
          payload: {},
          audioBase64: evidence.audioBase64,
          camera: { label: evidence.cameraLabel },
        };
      }
      setStatus('Checking on this computer…');
      const res = await examApi.postLivenessVerify(attemptId, {
        nonce: challenge.nonce,
        signature: challenge.signature,
        layer: 3,
        ...request,
      });
      if (!alive.current) return;
      setPassed(res.passed);
      setStatus(res.detail);
      setPhase('done');
      if (res.passed) closing.current = setTimeout(() => onComplete(true), 1800);
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
          Done on this computer. The exam timer is paused.
        </p>

        <div aria-live="polite" style={{ minHeight: '5rem', marginBottom: '1.5rem' }}>
          {phase === 'loading' && <p>Preparing your check…</p>}
          {phase === 'ready' && challenge?.type === 'colour_flash' && (
            <p style={{ fontSize: '1.15rem' }}>
              Face the screen and keep still. The screen will show three quick colours for about two
              seconds. If flashing colours bother you, choose another option below.
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
              {passed ? 'Verified. Thank you.' : (error ?? status)}
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
            <button type="button" onClick={() => load(undefined)} style={button('#2563eb')}>
              Try again
            </button>
          )}
          {phase === 'done' && passed && (
            <button type="button" onClick={() => onComplete(true)} style={button('#10b981')}>
              Continue
            </button>
          )}
        </div>

        {!busy && !passed && (
          <div
            style={{
              marginTop: '1rem',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
            }}
          >
            {challenge?.type !== 'head_turn' && (
              <button type="button" style={linkButton} onClick={() => load('head_turn')}>
                Try head turn instead
              </button>
            )}
            {challenge?.type !== 'spoken_words' && (
              <button type="button" style={linkButton} onClick={() => load('spoken_words')}>
                I can&apos;t do the visual check
              </button>
            )}
            <button type="button" style={linkButton} onClick={() => onComplete(false)}>
              Close
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
