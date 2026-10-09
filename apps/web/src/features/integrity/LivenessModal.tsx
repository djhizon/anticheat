import React, { useEffect, useState, useRef } from 'react';
import type { ExamApi, LivenessChallenge } from '../exam/api.js';
import { captureLivenessEvidence } from './livenessCapture.js';

interface LivenessModalProps {
  readonly attemptId: string;
  readonly examApi: ExamApi;
  readonly onComplete: (success: boolean) => void;
}

export function LivenessModal({ attemptId, examApi, onComplete }: LivenessModalProps) {
  const [loading, setLoading] = useState(true);
  const [challenge, setChallenge] = useState<LivenessChallenge | null>(null);
  const [timeLeft, setTimeLeft] = useState(30);
  const [submitting, setSubmitting] = useState(false);
  const [resultMsg, setResultMsg] = useState<string | null>(null);

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    examApi
      .postLivenessChallenge(attemptId)
      .then((res) => {
        setChallenge(res);
        setLoading(false);
        // Start 30s countdown
        timerRef.current = setInterval(() => {
          setTimeLeft((t) => {
            if (t <= 1) {
              clearInterval(timerRef.current!);
              handleCapture(res); // auto capture at 0
              return 0;
            }
            return t - 1;
          });
        }, 1000);
      })
      .catch(() => {
        onComplete(false);
      });

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [attemptId, examApi]);

  const handleCapture = async (activeChallenge: LivenessChallenge | null = challenge) => {
    if (!activeChallenge) return;
    if (timerRef.current) clearInterval(timerRef.current);
    setSubmitting(true);

    try {
      // Opens the native webcam itself; OBS/virtual cameras are refused here.
      const evidence = await captureLivenessEvidence(activeChallenge.type);
      const res = await examApi.postLivenessVerify(attemptId, {
        nonce: activeChallenge.nonce,
        signature: activeChallenge.signature,
        layer: 3,
        payload:
          evidence.brightnessDelta === undefined
            ? {}
            : { brightnessDelta: evidence.brightnessDelta },
        imageBase64: evidence.imageBase64,
        camera: { label: evidence.cameraLabel },
      });

      setResultMsg(res.passed ? '✅ Verification Passed!' : `❌ ${res.detail}`);
      setTimeout(() => onComplete(res.passed), 2500);
    } catch (error) {
      setResultMsg(
        `❌ ${error instanceof Error ? error.message : 'Error submitting verification'}`,
      );
      setTimeout(() => onComplete(false), 3000);
    }
  };

  const radius = 50;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference - (timeLeft / 30) * circumference;

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'rgba(0,0,0,0.85)',
        zIndex: 100000,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        color: '#fff',
        backdropFilter: 'blur(10px)',
      }}
    >
      <div
        style={{
          background: '#1e1e1e',
          padding: '3rem',
          borderRadius: '16px',
          border: '1px solid #333',
          textAlign: 'center',
          maxWidth: '500px',
          width: '100%',
        }}
      >
        <h2 style={{ marginBottom: '0.5rem', color: '#60a5fa' }}>Random Liveness Check</h2>
        <p style={{ color: '#aaa', marginBottom: '2rem' }}>
          Please complete this challenge to verify your presence. The exam timer is paused.
        </p>

        {loading ? (
          <p>Generating challenge...</p>
        ) : submitting ? (
          <p>{resultMsg || 'Verifying with AI...'}</p>
        ) : challenge ? (
          <div
            style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2rem' }}
          >
            {/* Circular Timer */}
            <div style={{ position: 'relative', width: '120px', height: '120px' }}>
              <svg width="120" height="120" style={{ transform: 'rotate(-90deg)' }}>
                <circle cx="60" cy="60" r={radius} stroke="#333" strokeWidth="8" fill="none" />
                <circle
                  cx="60"
                  cy="60"
                  r={radius}
                  stroke="#3b82f6"
                  strokeWidth="8"
                  fill="none"
                  strokeDasharray={circumference}
                  strokeDashoffset={strokeDashoffset}
                  style={{ transition: 'stroke-dashoffset 1s linear' }}
                />
              </svg>
              <div
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  right: 0,
                  bottom: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '2rem',
                  fontWeight: 'bold',
                }}
              >
                {timeLeft}
              </div>
            </div>

            <div
              style={{ background: '#2563eb', padding: '1rem', borderRadius: '8px', width: '100%' }}
            >
              {challenge.type === 'gesture' && (
                <>
                  <p style={{ fontWeight: 'bold', marginBottom: '0.5rem' }}>
                    Perform this gesture to the camera:
                  </p>
                  <p style={{ fontSize: '1.5rem', textTransform: 'uppercase' }}>
                    {String(challenge.data.gesture ?? '').replace('_', ' ')}
                  </p>
                </>
              )}
              {challenge.type === 'flash' && (
                <p style={{ fontSize: '1.2rem' }}>
                  Look directly at the screen. A bright flash will occur.
                </p>
              )}
            </div>

            <button
              onClick={() => void handleCapture()}
              style={{
                background: '#10b981',
                color: 'white',
                border: 'none',
                padding: '1rem 3rem',
                fontSize: '1.2rem',
                borderRadius: '8px',
                cursor: 'pointer',
                fontWeight: 'bold',
              }}
            >
              Verify Now
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
