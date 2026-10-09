import { createKeystrokeDynamics } from '../integrity/keystrokeDynamics.js';
import React, { Suspense, useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import type {
  ExamAnswerSaveResponse,
  ExamAnswerValue,
  ExamDeliveryProjection,
} from '@exam-anti-cheat/contracts/exam';

import type { ExamApi } from './api.js';
import { NativePhoneModal } from '../integrity/NativePhoneModal.js';
import { usePhonePresence } from '../integrity/usePhonePresence.js';
import { LivenessModal } from '../integrity/LivenessModal.js';
import { embedWatermark } from '../integrity/watermark.js';
import { shouldKick } from '../integrity/tabGuard.js';

const AudioPanel = React.lazy(() => import('../integrity/AudioPanel.js').then((m) => ({ default: m.AudioPanel })));
const CameraIntegrityPanel = React.lazy(() => import('../integrity/CameraIntegrityPanel.js').then((m) => ({ default: m.CameraIntegrityPanel })));

export interface StudentExamPageProps {
  readonly delivery: ExamDeliveryProjection | null;
  readonly error: string | null;
  readonly loading: boolean;
  readonly onBack: () => void;
  readonly examApi?: ExamApi;
  readonly violations?: import('../integrity/tabGuard.js').ViolationEvent[];
  readonly onViolation?: (event: import('../integrity/tabGuard.js').ViolationEvent) => void;
}

type AnswerMap = Record<string, ExamAnswerValue>;
type SaveState = 'Saved' | 'Saving…' | 'Save failed' | 'Not saved';

function formatQuestionType(type: ExamDeliveryProjection['questions'][number]['type']): string { return type.replaceAll('_', ' '); }
function formatDeadline(value: string): string { const date = new Date(value); return Number.isNaN(date.getTime()) ? 'Unavailable' : date.toLocaleString(); }
function createIdempotencyKey(prefix: string): string { const randomUuid = globalThis.crypto?.randomUUID?.(); return `${prefix}-${randomUuid ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`; }
function displayValue(value: ExamAnswerValue): string { return value === null ? '' : String(value); }

export function StudentExamPage({
  delivery,
  error,
  loading,
  onBack,
  examApi,
  violations = [],
  onViolation,
}: StudentExamPageProps): React.ReactElement {
  const [currentDelivery, setCurrentDelivery] = useState<ExamDeliveryProjection | null>(delivery);
  const [answers, setAnswers] = useState<AnswerMap>({});
  const [revision, setRevision] = useState(0);
  const [saveState, setSaveState] = useState<SaveState>('Not saved');
  const [submitting, setSubmitting] = useState(false);
  const [submissionReceipt, setSubmissionReceipt] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [receiptMessage, setReceiptMessage] = useState<string | null>(null);
  const [questionTimeLeft, setQuestionTimeLeft] = useState<Record<string, number>>({});
  const [pasteToastVisible, setPasteToastVisible] = useState(false);
  const [brightnessBanner, setBrightnessBanner] = useState(true);
  const currentDeliveryRef = useRef(delivery);
  const answersRef = useRef<AnswerMap>({});
  const revisionRef = useRef(0);
  const saveChainRef = useRef<Promise<unknown>>(Promise.resolve());

  const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);
  const [examPaused, setExamPaused] = useState(false);
  const [showPhoneModal, setShowPhoneModal] = useState(false);
  const [showLivenessModal, setShowLivenessModal] = useState(false);
  const [recordScreen, setRecordScreen] = useState(false);
  const [recordingStatus, setRecordingStatus] = useState('Screen recording off — local-only demo.');
  const [focusedMode, setFocusedMode] = useState(true);
  const phonePresence = usePhonePresence(currentDelivery?.attempt.id, currentDelivery?.attempt.status === 'in_progress', examApi);
  const phoneBlockedRef = useRef(phonePresence.blocked);
  phoneBlockedRef.current = phonePresence.blocked;

  function handleNextQuestion(): void {
    setCurrentQuestionIndex(index => Math.min(index + 1, (currentDelivery?.questions.length ?? 1) - 1));
  }

  const pendingAnswersRef = useRef<AnswerMap | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const questionRootRef = useRef<HTMLOListElement | null>(null);
  const firstKeystrokeAtRef = useRef<Record<string, number>>({});

  // ── Violation / kick tracking (tab guard is in App.tsx) ───────────────
  // Kick thresholds live in tabGuard so the exam page and the app shell agree.
  const kickViolation = shouldKick(violations);

  // ── Focus-loss and page-hide — fire violations ────────────────────────
  useEffect(() => {
    if (!currentDelivery || currentDelivery.attempt.status !== 'in_progress') return;
    let focusLostCount = 0;
    let pageHiddenCount = 0;

    const onBlur = () => {
      setExamPaused(true);
      focusLostCount += 1;
      onViolation?.({
        type: 'focus_lost',
        timestamp: Date.now(),
        count: focusLostCount,
      });
    };
    const onVisibility = () => {
      if (document.hidden) {
        setExamPaused(true);
        pageHiddenCount += 1;
        onViolation?.({
          type: 'page_hidden',
          timestamp: Date.now(),
          count: pageHiddenCount,
        });
        
        // Visibility is already reported above; it is not a measured gaze event.
      }
    };
    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', onVisibility);
    
    let stopOverlayDetector: (() => void) | null = null;
    import('../integrity/cluelyDetector.js').then(({ createOverlayDetector }) => {
      stopOverlayDetector = createOverlayDetector(() => {
        onViolation?.({ type: 'overlay_detected', timestamp: Date.now(), count: 1 });
        window.dispatchEvent(new CustomEvent('camera-violation', { detail: 'overlay_detected' }));
      });
    });

    return () => {
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onVisibility);
      stopOverlayDetector?.();
    };
  }, [currentDelivery?.attempt.status, onViolation]);

  useEffect(() => {
    setCurrentDelivery(delivery);
    currentDeliveryRef.current = delivery;
    setSubmitError(null);
    setReceiptMessage(null);
  }, [delivery]);

  useEffect(() => {
    if (currentDelivery === null) {
      answersRef.current = {};
      revisionRef.current = 0;
      setAnswers({});
      setRevision(0);
      setSaveState('Not saved');
      return;
    }

    const acknowledged: AnswerMap = Object.fromEntries(
      currentDelivery.questions.map((question) => [question.id, null]),
    );
    Object.assign(acknowledged, currentDelivery.answers.answers);
    answersRef.current = acknowledged;
    revisionRef.current = currentDelivery.answers.revision;
    setAnswers(acknowledged);
    setRevision(currentDelivery.answers.revision);
    setSaveState(
      currentDelivery.answers.savedAt === null || currentDelivery.attempt.status !== 'in_progress'
        ? 'Not saved'
        : 'Saved',
    );
    
    // Initialize question timers
    const initialTimeouts: Record<string, number> = {};
    currentDelivery.questions.forEach((q: any) => {
      if (q.timeLimitSeconds && !questionTimeLeft[q.id]) {
        initialTimeouts[q.id] = q.timeLimitSeconds;
      }
    });
    if (Object.keys(initialTimeouts).length > 0) {
      setQuestionTimeLeft(prev => ({ ...prev, ...initialTimeouts }));
    }
  }, [currentDelivery]);

  // Per-question timer
  useEffect(() => {
    if (!focusedMode || !currentDelivery || currentDelivery.attempt.status !== 'in_progress' || examPaused) return;
    const q = currentDelivery.questions[currentQuestionIndex];
    if (!q || !(q as any).timeLimitSeconds) return;

    const timer = setInterval(() => {
      setQuestionTimeLeft(prev => {
        const left = prev[q.id] ?? (q as any).timeLimitSeconds;
        if (left <= 1) {
          clearInterval(timer);
          // auto advance
          if (currentQuestionIndex < currentDelivery.questions.length - 1) {
            setCurrentQuestionIndex(i => i + 1);
          }
          return { ...prev, [q.id]: 0 };
        }
        return { ...prev, [q.id]: left - 1 };
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [focusedMode, currentQuestionIndex, currentDelivery, examPaused]);




  // --- TELEMETRY UPLOAD ENGINE ---
  const keystrokeTracker = useRef(createKeystrokeDynamics('global'));
  
  useEffect(() => {
    const tracker = keystrokeTracker.current;
    window.addEventListener('keydown', tracker.onKeyDown);
    window.addEventListener('keyup', tracker.onKeyUp);
    return () => {
      window.removeEventListener('keydown', tracker.onKeyDown);
      window.removeEventListener('keyup', tracker.onKeyUp);
    };
  }, []);

  useEffect(() => {
    if (!currentDelivery || currentDelivery.attempt.status !== 'in_progress' || !examApi) return;
    
    const interval = setInterval(() => {
      const snap = keystrokeTracker.current.snapshot();
      if (snap.events.length === 0) return;
      
      if (snap.suspiciousUniformity) {
        onViolation?.({
          type: 'keystroke_violation',
          timestamp: Date.now(),
          count: 1,
        });
      }
      
      // Upload telemetry chunk
      examApi.uploadTelemetry(currentDelivery.attempt.id, {
        keystrokes: snap.events,
        gaze: [], // Currently handled by page hidden/focus lost
        voice: []
      }).catch(console.error);
      
      keystrokeTracker.current.reset();
    }, 15000); // Upload every 15 seconds
    
    return () => clearInterval(interval);
  }, [currentDelivery?.attempt.id, currentDelivery?.attempt.status, examApi, onViolation]);

  // Explicit, local-only recording; never start expensive capture with the exam.

  useEffect(() => {
    if (!recordScreen || !currentDelivery || currentDelivery.attempt.status !== 'in_progress') return;
    
    let stopRecorder: (() => void) | null = null;
    let disposed = false;
    import('../integrity/screenRecorder.js').then(({ createScreenRecorder }) => {
      if (disposed) return;
      const recorder = createScreenRecorder(currentDelivery.attempt.id, examApi, message => { if (!disposed) setRecordingStatus(message); });
      recorder.start().catch((err) => {
        if (!disposed) { setRecordingStatus(err instanceof Error ? err.message : 'Screen recording failed. Retry.'); setRecordScreen(false); }
      });
      stopRecorder = recorder.stop;
    });

    return () => {
      disposed = true;
      stopRecorder?.();
    };
  }, [recordScreen, currentDelivery?.attempt.id, currentDelivery?.attempt.status, examApi]);


  useEffect(
    () => () => {
      if (saveTimerRef.current !== null) {
        clearTimeout(saveTimerRef.current);
      }
    },
    [],
  );

  // Ultrasound Beacon for Mobile Proximity
  useEffect(() => {
    if (delivery === null) return;
    
    let audioCtx: AudioContext | null = null;
    let oscillator: OscillatorNode | null = null;
    
    try {
      audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
      oscillator = audioCtx.createOscillator();
      oscillator.type = 'sine';
      oscillator.frequency.value = 19000; // 19kHz (inaudible but phones can hear it)
      oscillator.connect(audioCtx.destination);
      oscillator.start();
    } catch (e) {
      console.warn('Failed to start ultrasound beacon', e);
    }
    
    return () => {
      oscillator?.stop();
      oscillator?.disconnect();
      if (audioCtx?.state !== 'closed') audioCtx?.close();
    };
  }, [delivery]);

  async function enqueueSave(snapshot: AnswerMap, timingData?: { qId: string, timeDeltaMs: number, wordCount: number }): Promise<ExamAnswerSaveResponse | null> {
    if (examApi === undefined || currentDeliveryRef.current?.attempt.status !== 'in_progress') {
      return null;
    }

    if (timingData) {
      if (timingData.wordCount > 20 && timingData.timeDeltaMs < timingData.wordCount * 400) {
        examApi.patchEvents(currentDeliveryRef.current.attempt.id, {
          event: 'suspicious_timing',
          questionId: timingData.qId,
        }).catch(() => {});
      }
    }

    const task = saveChainRef.current.then(async () => {
      const activeDelivery = currentDeliveryRef.current;
      if (activeDelivery === null || activeDelivery.attempt.status !== 'in_progress') {
        return null;
      }
      if (phoneBlockedRef.current) { setSaveState('Not saved'); return null; }
      setSaveState('Saving…');
      const response = await examApi.saveAnswers(activeDelivery.attempt.id, {
        revision: revisionRef.current,
        idempotencyKey: createIdempotencyKey('save'),
        answers: snapshot,
      });
      revisionRef.current = response.revision;
      setRevision(response.revision);
      setSaveState('Saved');
      return response;
    });
    saveChainRef.current = task.catch(() => {
      setSaveState('Save failed');
      return null;
    });
    return task;
  }

  function scheduleSave(snapshot: AnswerMap, qId?: string, valStr?: string): void {
    if (examApi === undefined || currentDeliveryRef.current?.attempt.status !== 'in_progress') {
      return;
    }
    pendingAnswersRef.current = snapshot;
    setSaveState('Saving…');
    if (saveTimerRef.current !== null) {
      clearTimeout(saveTimerRef.current);
    }
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      const pending = pendingAnswersRef.current;
      pendingAnswersRef.current = null;
      if (pending !== null) {
        let timingData;
        if (qId && valStr && firstKeystrokeAtRef.current[qId]) {
          const delta = Date.now() - firstKeystrokeAtRef.current[qId];
          const wc = valStr.trim().split(/\s+/).length;
          timingData = { qId, timeDeltaMs: delta, wordCount: wc };
        }
        void enqueueSave(pending, timingData).catch(() => {});
      }
    }, 400);
  }

  async function flushSaves(): Promise<void> {
    if (saveTimerRef.current !== null) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const pending = pendingAnswersRef.current;
    pendingAnswersRef.current = null;
    if (pending !== null) {
      await enqueueSave(pending);
    }
    await saveChainRef.current;
  }

  function updateAnswer(questionId: string, value: ExamAnswerValue, valStr?: string): void {
    if (phoneBlockedRef.current) return;
    const next = { ...answersRef.current, [questionId]: value };
    answersRef.current = next;
    setAnswers(next);
    setReceiptMessage(null);
    scheduleSave(next, questionId, valStr);
  }

  function handlePaste(e: React.ClipboardEvent) {
    e.preventDefault();
    setPasteToastVisible(true);
    setTimeout(() => setPasteToastVisible(false), 3000);
  }

  const flightTimes = useRef<number[]>([]);
  const lastKeyUp = useRef<number>(0);

  function handleKeyDown(e: React.KeyboardEvent, qId: string) {
    if (!firstKeystrokeAtRef.current[qId]) {
      firstKeystrokeAtRef.current[qId] = Date.now();
    }
    const now = Date.now();
    if (lastKeyUp.current > 0) {
      const flight = now - lastKeyUp.current;
      flightTimes.current.push(flight);
      if (flightTimes.current.length >= 20) {
        const recent = flightTimes.current.slice(-20);
        const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
        const variance = recent.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / recent.length;
        const stddev = Math.sqrt(variance);
        
        const zeros = recent.filter(f => f === 0).length;
        
        if (stddev < 5 || zeros > 5) {
          examApi?.patchEvents(currentDeliveryRef.current?.attempt.id ?? '', {
            event: 'keystroke_violation',
            reason: 'suspiciously uniform flight times'
          }).catch(() => {});
          flightTimes.current = []; // reset after flagging
        }
      }
    }
  }

  function handleKeyUp(e: React.KeyboardEvent) {
    lastKeyUp.current = Date.now();
  }

  async function submit(savedOnly = false): Promise<void> {
    const activeDelivery = currentDeliveryRef.current;
    if (
      examApi === undefined ||
      activeDelivery === null ||
      activeDelivery.attempt.status !== 'in_progress' ||
      submitting || (phoneBlockedRef.current && !savedOnly)
    ) {
      return;
    }
    if (!globalThis.confirm(savedOnly ? 'Submit only the last server-saved answers? Any unsaved draft will NOT be included. This ends the exam.' : 'Submit this exam? You will not be able to change your answers.')) {
      return;
    }

    setSubmitting(true);
    setSubmitError(null);
    setReceiptMessage(null);
    try {
      if (!savedOnly) await flushSaves();
      else {
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
        pendingAnswersRef.current = null;
        await saveChainRef.current;
      }
      const latestDelivery = currentDeliveryRef.current;
      if (latestDelivery === null) {
        throw new Error('The exam delivery is no longer available.');
      }
      const response = await examApi.submitAttempt(latestDelivery.attempt.id, {
        expectedRevision: revisionRef.current,
        idempotencyKey: createIdempotencyKey('submit'),
      });
      currentDeliveryRef.current = response.delivery;
      setCurrentDelivery(response.delivery);
      answersRef.current = { ...response.delivery.answers.answers };
      revisionRef.current = response.delivery.answers.revision;
      setAnswers({ ...response.delivery.answers.answers });
      setRevision(response.delivery.answers.revision);
      setSaveState('Not saved');
      setReceiptMessage(
        response.receipt.status === 'submitted'
          ? 'Submitted successfully. Your receipt has been recorded.'
          : 'The deadline passed before submission could be recorded.',
      );
    } catch {
      setSubmitError(
        'Submission could not be completed. Your last acknowledged save is preserved.',
      );
    } finally {
      setSubmitting(false);
    }
  }

  function renderAnswerControl(
    question: ExamDeliveryProjection['questions'][number],
    isActive: boolean,
  ): React.ReactElement {
    const value = answers[question.id] ?? null;
    const timeOut = (question as any).timeLimitSeconds && questionTimeLeft[question.id] === 0;
    const disabled = !isActive || submitting || examApi === undefined || examPaused || phonePresence.blocked || timeOut;

    if (question.type === 'multiple_choice') {
      return (
        <fieldset className="answer-options" disabled={disabled}>
          <legend className="sr-only">Choose one answer</legend>
          {question.options.map((option) => (
            <label className="answer-option" key={option.id}>
              <input
                data-integrity-question-id={question.id}
                data-integrity-control="choice"
                checked={value === option.id}
                name={`question-${question.id}`}
                onChange={() => updateAnswer(question.id, option.id)}
                type="radio"
                value={option.id}
              />
              <span>{option.text}</span>
            </label>
          ))}
        </fieldset>
      );
    }
    if (question.type === 'true_false') {
      return (
        <fieldset className="answer-options" disabled={disabled}>
          <legend className="sr-only">Choose true or false</legend>
          {[true, false].map((choice) => (
            <label className="answer-option" key={String(choice)}>
              <input
                data-integrity-question-id={question.id}
                data-integrity-control="choice"
                checked={value === choice}
                name={`question-${question.id}`}
                onChange={() => updateAnswer(question.id, choice)}
                type="radio"
              />
              <span>{choice ? 'True' : 'False'}</span>
            </label>
          ))}
        </fieldset>
      );
    }
    if (question.type === 'numeric') {
      return (
        <label className="answer-input-label">
          <span className="sr-only">Numeric answer</span>
          <input
            data-integrity-question-id={question.id}
            data-integrity-control="numeric"
            aria-label="Numeric answer"
            disabled={disabled}
            inputMode="decimal"
            onPaste={handlePaste}
            onKeyDown={(e) => handleKeyDown(e, question.id)}
            onKeyUp={handleKeyUp}
            onChange={(event: ChangeEvent<HTMLInputElement>) => {
              const raw = event.currentTarget.value;
              updateAnswer(question.id, raw === '' ? null : Number(raw), raw);
            }}
            type="number"
            value={displayValue(value)}
          />
        </label>
      );
    }
    return (
      <label className="answer-input-label">
        <span className="sr-only">Written answer</span>
        <input
          data-integrity-question-id={question.id}
          data-integrity-control="written"
          aria-label="Written answer"
          disabled={disabled}
          maxLength={10000}
          onPaste={handlePaste}
          onKeyDown={(e) => handleKeyDown(e, question.id)}
          onKeyUp={handleKeyUp}
          onChange={(event: ChangeEvent<HTMLInputElement>) =>
            updateAnswer(
              question.id,
              event.currentTarget.value === '' ? null : event.currentTarget.value,
              event.currentTarget.value
            )
          }
          type="text"
          value={displayValue(value)}
        />
      </label>
    );
  }

  if (kickViolation) {
    return (
      <main className="panel singleton-blocked">
        <h2>🚫 Exam Session Terminated</h2>
        <p>Your exam was locked due to: <strong>{kickViolation.type.replaceAll('_', ' ')}</strong></p>
        <p className="muted">Contact your instructor if you believe this was an error.</p>
        <button className="secondary-button" onClick={onBack}>← Back to assignments</button>
      </main>
    );
  }

  if (loading) {
    return (
      <main aria-busy="true" className="panel">
        <p role="status">Loading your exam…</p>
      </main>
    );
  }

  if (error !== null) {
    return (
      <main className="panel">
        <button className="text-button" onClick={onBack} type="button">
          ← Back to assignments
        </button>
        <p aria-live="polite" role="alert">
          {error}
        </p>
      </main>
    );
  }

  if (delivery === null) {
    return (
      <main className="panel">
        <p role="status">Choose an assignment to view its delivery.</p>
      </main>
    );
  }

  const visibleDelivery = currentDelivery ?? delivery;
  const isActive = visibleDelivery.attempt.status === 'in_progress';

  const currentQuestion = visibleDelivery.questions[currentQuestionIndex];
  const totalQuestions = visibleDelivery.questions.length;
  const timeLeft = currentQuestion ? questionTimeLeft[currentQuestion.id] : undefined;
  const answeredCount = Object.values(answers).filter(v => v !== null && v !== '').length;

  const attemptProps = {
    id: visibleDelivery.attempt.id,
    active: isActive,
    deadline: Date.parse(visibleDelivery.attempt.effectiveDeadline),
  };

  return (
    <>
      {/* Floating overlays */}
      {pasteToastVisible && (
        <div className="paste-toast" role="alert">
          🚫 Paste is not allowed — please type your answer
        </div>
      )}
      {examPaused && !phonePresence.blocked && (
        <div className="exam-pause-overlay" onClick={() => setExamPaused(false)}>
          <div className="pause-card">
            <span className="pause-icon">⏸</span>
            <h2>Exam Paused</h2>
            <p>You navigated away from this window.</p>
            <button className="submit-button" type="button">Click to Resume</button>
          </div>
        </div>
      )}
      {isActive && phonePresence.blocked && (
        <div role="alert" className="phone-connection-notice">
          <section>
            <h2>{phonePresence.checking ? 'Checking phone connection…' : 'Phone connection lost — answering paused'}</h2>
            <p>Keep the paired iPhone app open and active. Returning to it resumes answering after a fresh ping. Your draft stays here; the exam deadline continues.</p>
            <p>Home, screen lock, permission prompts, calls, or a Wi-Fi interruption may cause a pause. This is not a cheating verdict.</p>
            <p>You can navigate questions while setting up. Answering and saving remain paused; timers are unchanged.</p>
            <div className="exam-control-group">
            <button className="exam-control" type="button" onClick={() => setShowPhoneModal(true)}>Pair / replace iPhone</button>
            <button className="exam-control exam-control--secondary" type="button" disabled={submitting} onClick={() => void submit(true)}>Submit last saved answers only</button>
            <button className="exam-control exam-control--secondary" type="button" onClick={onBack}>Back to assignments</button>
            </div>
          </section>
        </div>
      )}
      {violations.length > 0 && !kickViolation && (
        <div className="violation-banner" role="alert">
          ⚠️ {violations.length} violation{violations.length !== 1 ? 's' : ''} logged — repeated violations will lock your exam
        </div>
      )}
      {brightnessBanner && isActive && (
        <div className="brightness-banner">
          💡 For best face tracking, please increase your screen brightness to maximum.
          <button className="brightness-close" onClick={() => setBrightnessBanner(false)}>×</button>
        </div>
      )}

      {/* Full-screen exam shell */}
      <div className="exam-shell">

        {/* ── Top bar ─────────────────────────────────────────────────────── */}
        <header className="exam-topbar">
          <button className="topbar-back" onClick={onBack} type="button">
            ← Back
          </button>
          <div className="topbar-title">
            <span className="topbar-eyebrow">v{visibleDelivery.exam.versionNumber}</span>
            <span className="topbar-name">{visibleDelivery.exam.title}</span>
          </div>
          <div className="topbar-meta">
            <span className="topbar-chip topbar-chip--save" aria-live="polite" role="status">
              {saveState === 'Saved' ? '✅' : saveState === 'Saving…' ? '⏳' : '⚠️'} {saveState}
            </span>
            {submitError !== null && (
              <span className="topbar-chip topbar-chip--error" role="alert">⚠️ Submit failed</span>
            )}
            {receiptMessage !== null && (
              <span className="topbar-chip topbar-chip--ok" role="status">✅ Submitted</span>
            )}
            {isActive && examApi !== undefined && (
              <>
                <button
                  className="topbar-submit"
                  onClick={() => setShowPhoneModal(true)}
                  type="button"
                >
                  📱 {phonePresence.required ? 'Replace iPhone pairing' : 'Require iPhone'}
                </button>
                <button
                  className="topbar-submit"
                  disabled={submitting || phonePresence.blocked}
                  onClick={() => void submit()}
                  type="button"
                >
                  {submitting ? 'Submitting…' : 'Submit Exam'}
                </button>
              </>
            )}
            {isActive && phonePresence.connected && <span role="status">iPhone connected</span>}
            {isActive && !phonePresence.blocked && (saveState === 'Not saved' || saveState === 'Save failed') && (
              <button className="exam-control" type="button" disabled={submitting} onClick={() => void enqueueSave(answersRef.current).catch(() => {})}>Save retained draft</button>
            )}
            {!isActive && (
              <span className={`status status-${visibleDelivery.attempt.status}`}>
                {visibleDelivery.attempt.status}
              </span>
            )}
          </div>
        </header>

        {/* ── 3-column layout ──────────────────────────────────────────────── */}
        <div className="exam-layout">


          {/* LEFT SIDEBAR: Camera & Detection */}
          <aside className="exam-sidebar exam-sidebar--left">
            <div className="sidebar-section">
              <p className="sidebar-label">📷 Camera &amp; Detection</p>
              <Suspense fallback={<p className="sidebar-loading">Loading…</p>}>
                <CameraIntegrityPanel attempt={attemptProps} />
              </Suspense>
            </div>
          </aside>

          {/* CENTER: One question at a time */}
          <main className="exam-center" ref={questionRootRef}>
            {/* Progress bar */}
            <div className="exam-progress-bar">
              <div
                className="exam-progress-fill"
                style={{ width: `${((currentQuestionIndex + 1) / totalQuestions) * 100}%` }}
              />
            </div>

            <div className="question-stage">
              {/* Question badge */}
              <div className="question-badge">
                <span className="badge-num">{currentQuestionIndex + 1}</span>
                <span className="badge-of">/ {totalQuestions}</span>
                {answeredCount > 0 && (
                  <span className="badge-answered">{answeredCount} answered</span>
                )}
              </div>

              {currentQuestion !== undefined ? (
                <>
                  <p className="question-type-tag">{formatQuestionType(currentQuestion.type)}</p>

                  {/* Per-question timer */}
                  {timeLeft !== undefined && (
                    <div className={`question-timer-bar ${timeLeft < 10 ? 'urgent' : ''}`}>
                      <div
                        className="question-timer-fill"
                        style={{
                          width: `${Math.max(0, (timeLeft / ((currentQuestion as { timeLimitSeconds?: number }).timeLimitSeconds ?? 60)) * 100)}%`,
                        }}
                      />
                      <span className="question-timer-label">
                        {timeLeft > 0 ? `${timeLeft}s` : 'Time up'}
                      </span>
                    </div>
                  )}

                  <h2 className="question-prompt">{embedWatermark(currentQuestion.prompt, visibleDelivery.attempt.id)}</h2>

                  <div className="answer-area">
                    {renderAnswerControl(currentQuestion, isActive)}
                  </div>
                </>
              ) : (
                <p className="muted">No question at this index.</p>
              )}
            </div>

            {/* Navigation row + dot indicators */}
            <div className="question-nav">
              <button
                className="nav-btn nav-btn--prev"
                disabled={currentQuestionIndex === 0}
                onClick={() => setCurrentQuestionIndex(i => i - 1)}
                type="button"
              >
                ←
              </button>

              <div className="progress-dots">
                {visibleDelivery.questions.map((q, i) => (
                  <button
                    key={q.id}
                    className={[
                      'dot',
                      i === currentQuestionIndex ? 'dot--active' : '',
                      answers[q.id] !== null && answers[q.id] !== undefined && answers[q.id] !== ''
                        ? 'dot--answered'
                        : '',
                    ].join(' ')}
                    onClick={() => { if (i > currentQuestionIndex) { handleNextQuestion(); } else { setCurrentQuestionIndex(i); } }}
                    title={`Question ${i + 1}`}
                    type="button"
                  />
                ))}
              </div>

              <button
                className="nav-btn nav-btn--next"
                disabled={currentQuestionIndex === totalQuestions - 1}
                onClick={handleNextQuestion}
                type="button"
              >
                →
              </button>
            </div>
          </main>

          {/* RIGHT SIDEBAR: Audio + Exam Info */}
          <aside className="exam-sidebar exam-sidebar--right">
            <section className="sidebar-section">
              <p className="sidebar-label">Local screen recording</p>
              <p className="muted">Includes the built-in microphone. Saves to this Mac only; no upload. Stop to finish the last clip.</p>
              {isActive && <button className="exam-control" type="button" onClick={() => { setRecordScreen(value => !value); if (recordScreen) setRecordingStatus('Recording stopped. Check Downloads/save dialog for the final segment.'); }}>{recordScreen ? 'Stop local recording' : 'Start local recording'}</button>}
              <p role="status">{recordingStatus}</p>
            </section>
            <div className="sidebar-section">
              <p className="sidebar-label">🎙️ Audio Monitor</p>
              <Suspense fallback={<p className="sidebar-loading">Loading…</p>}>
                <AudioPanel attemptId={visibleDelivery.attempt.id} active={isActive} {...(examApi ? { examApi } : {})} />
              </Suspense>
            </div>
            <div className="sidebar-section sidebar-section--meta">
              <p className="sidebar-label">📋 Exam Info</p>
              <dl className="sidebar-meta">
                <div>
                  <dt>Duration</dt>
                  <dd>{Math.ceil(visibleDelivery.exam.durationSeconds / 60)} min</dd>
                </div>
                <div>
                  <dt>Deadline</dt>
                  <dd>{formatDeadline(visibleDelivery.attempt.effectiveDeadline)}</dd>
                </div>
                <div>
                  <dt>Revision</dt>
                  <dd>#{revision}</dd>
                </div>
              </dl>
            </div>
          </aside>
        </div>
      </div>
      
      {showPhoneModal && examApi !== undefined && (
        <NativePhoneModal
          attemptId={visibleDelivery.attempt.id}
          api={examApi}
          onClose={() => setShowPhoneModal(false)}
        />
      )}

      {showLivenessModal && examApi && (
        <LivenessModal 
          attemptId={visibleDelivery.attempt.id} 
          examApi={examApi} 
          videoEl={document.querySelector('video')} 
          onComplete={(success) => {
            setShowLivenessModal(false);
            setExamPaused(false);
            setCurrentQuestionIndex(i => i + 1);
          }} 
        />
      )}

    </>
  );
}
