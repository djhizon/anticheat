import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ExamAssignmentListResponse,
  ExamAssignmentProjection,
  ExamDeliveryProjection,
} from '@exam-anti-cheat/contracts/exam';

import { AiCheckDashboard } from './features/admin/AiCheckDashboard.js';
import { createInstructorApi } from './features/admin/api.js';
import { SimilarityDashboard } from './features/admin/SimilarityDashboard.js';
import { AuthProvider, useAuth } from './features/auth/AuthProvider.js';
import { LoginPage } from './features/auth/LoginPage.js';
import { createExamApi, ExamApiError, type ExamApi } from './features/exam/api.js';
import { StudentExamPage } from './features/exam/StudentExamPage.js';
import { PreflightCheck } from './features/integrity/PreflightCheck.js';
import { DevelopmentExemptions } from './features/integrity/DevelopmentExemptions.js';
import { acquireBuiltInMicrophone } from './features/integrity/builtInMicrophone.js';
import { acquirePhysicalCamera } from './features/integrity/physicalCamera.js';

export function isSessionExpiredError(error: unknown): boolean {
  return error instanceof ExamApiError && error.problem.code === 'unauthorized';
}

export function App(): React.ReactElement {
  return (
    <AuthProvider>
      <DevelopmentExemptions />
      <AuthenticatedApp />
    </AuthProvider>
  );
}

function AuthenticatedApp(): React.ReactElement {
  const { getCsrfToken, loading, logout, refresh, user } = useAuth();
  const examApi = useMemo<ExamApi>(() => createExamApi('', getCsrfToken), [getCsrfToken]);

  if (loading) {
    return (
      <main className="panel">
        <p role="status">Checking your session…</p>
      </main>
    );
  }
  if (user === null) {
    return <LoginPage />;
  }
  if (user.role !== 'student') {
    return <InstructorWorkspace email={user.email} getCsrfToken={getCsrfToken} onLogout={logout} />;
  }

  return (
    <StudentWorkspace
      email={user.email}
      examApi={examApi}
      onLogout={logout}
      onSessionExpired={refresh}
    />
  );
}

function InstructorWorkspace({
  email,
  getCsrfToken,
  onLogout,
}: {
  readonly email: string;
  readonly getCsrfToken: () => Promise<string>;
  readonly onLogout: () => Promise<void>;
}): React.ReactElement {
  const instructorApi = useMemo(() => createInstructorApi(getCsrfToken), [getCsrfToken]);
  return (
    <main className="workspace">
      <header className="topbar">
        <div>
          <p className="eyebrow">Exam Anti-Cheat</p>
          <p className="signed-in">Signed in as {email}</p>
        </div>
        <button className="secondary-button" onClick={() => void onLogout()} type="button">
          Sign out
        </button>
      </header>
      <section className="hero">
        <p className="eyebrow">Instructor workspace</p>
        <h1>Integrity review</h1>
      </section>
      <SimilarityDashboard api={instructorApi} />
      <AiCheckDashboard api={instructorApi} />
    </main>
  );
}

interface StudentWorkspaceProps {
  readonly email: string;
  readonly examApi: ExamApi;
  readonly onLogout: () => Promise<void>;
  readonly onSessionExpired: () => Promise<void>;
}

function StudentWorkspace({
  email,
  examApi,
  onLogout,
  onSessionExpired,
}: StudentWorkspaceProps): React.ReactElement {
  const [assignments, setAssignments] = useState<ExamAssignmentProjection[]>([]);
  const [selectedAssignment, setSelectedAssignment] = useState<string | null>(null);
  const [delivery, setDelivery] = useState<ExamDeliveryProjection | null>(null);
  const [loading, setLoading] = useState(true);
  const [examLoading, setExamLoading] = useState(false);
  const [generatingExam, setGeneratingExam] = useState(false);
  const [generationMessage, setGenerationMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [preflightPassed, setPreflightPassed] = useState(false);

  const loadAssignments = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const response: ExamAssignmentListResponse = await examApi.listAssignments();
      setAssignments([...response.assignments]);
    } catch (caught) {
      if (isSessionExpiredError(caught)) {
        await onSessionExpired();
        return;
      }
      setError('Assignments could not be loaded. Refresh and try again.');
    } finally {
      setLoading(false);
    }
  }, [examApi]);

  useEffect(() => {
    void loadAssignments();
  }, [loadAssignments]);

  async function generateExam(): Promise<void> {
    setGeneratingExam(true);
    setGenerationMessage('Generating and assigning a fresh exam…');
    setError(null);
    try {
      const result = await examApi.generateExam();
      await loadAssignments();
      setGenerationMessage(
        result.source === 'gemini'
          ? 'A fresh AI-generated exam is ready.'
          : 'A fresh fallback exam is ready. Gemini was unavailable or not configured.',
      );
    } catch (caught) {
      if (isSessionExpiredError(caught)) {
        await onSessionExpired();
        return;
      }
      setGenerationMessage(null);
      setError('A fresh exam could not be generated. Please try again.');
    } finally {
      setGeneratingExam(false);
    }
  }

  // ── Consent modal state ─────────────────────────────────────────────────────
  const [pendingAssignment, setPendingAssignment] = useState<ExamAssignmentProjection | null>(null);
  const [consentChecked, setConsentChecked] = useState(false);
  const [permissionsGranted, setPermissionsGranted] = useState(false);
  const [permissionsError, setPermissionsError] = useState<string | null>(null);
  const tabGuardRef = useRef<{ release(): void } | null>(null);
  const [violations, setViolations] = useState<
    import('./features/integrity/tabGuard.js').ViolationEvent[]
  >([]);

  function requestOpen(assignment: ExamAssignmentProjection): void {
    console.log('requestOpen called for', assignment.title);
    try {
      if (tabGuardRef.current !== null) {
        console.log('releasing old tab guard');
        tabGuardRef.current.release();
        tabGuardRef.current = null;
      }
      console.log('clearing local storage guard');
      localStorage.removeItem(`exam-tab-guard:${assignment.id}`);

      console.log('setting pending assignment', assignment.id);
      setPendingAssignment(assignment);
      setConsentChecked(false);
      setPermissionsGranted(false);
      setPermissionsError(null);
    } catch (e) {
      console.error('CRITICAL ERROR in requestOpen:', e);
      alert('Error opening exam: ' + String(e));
    }
  }

  async function requestHardwarePermissions(): Promise<void> {
    try {
      setPermissionsError(null);
      const camera = await acquirePhysicalCamera();
      camera.getTracks().forEach((track) => track.stop());
      const microphone = await acquireBuiltInMicrophone();
      microphone.getTracks().forEach((track) => track.stop());
      setPermissionsGranted(true);
    } catch (err) {
      setPermissionsError(
        err instanceof Error
          ? err.message
          : 'Camera or built-in microphone unavailable. Check macOS Privacy settings.',
      );
    }
  }

  async function confirmOpen(): Promise<void> {
    if (pendingAssignment === null) return;
    const assignment = pendingAssignment;
    setPendingAssignment(null);
    setExamLoading(true);

    // ── Install tab guard BEFORE loading the exam (use assignment ID) ────
    const { createTabGuard } = await import('./features/integrity/tabGuard.js');
    setViolations([]);
    const guard = createTabGuard(assignment.id, (v) => {
      setViolations((prev) => {
        const next = [...prev, v];
        // If this violation immediately demands a kick, it will be caught by exam page
        return next;
      });
    });
    // Release any previous guard
    tabGuardRef.current?.release();
    tabGuardRef.current = guard;

    setSelectedAssignment(assignment.id);
    setExamLoading(true);
    setDelivery(null);
    setError(null);
    try {
      setDelivery(await examApi.startAttempt(assignment.id));
    } catch (caught) {
      if (isSessionExpiredError(caught)) {
        await onSessionExpired();
        return;
      }
      setError('That exam could not be opened. Refresh and try again.');
    } finally {
      setExamLoading(false);
    }
  }

  function goBack(): void {
    tabGuardRef.current?.release();
    tabGuardRef.current = null;
    setViolations([]);
    setSelectedAssignment(null);
    setDelivery(null);
    setError(null);
  }

  if (!preflightPassed) {
    return (
      <PreflightCheck onPassed={() => setPreflightPassed(true)} onCancel={() => void onLogout()} />
    );
  }

  if (selectedAssignment !== null) {
    return (
      <StudentExamPage
        delivery={delivery}
        error={error}
        examApi={examApi}
        loading={examLoading}
        onBack={goBack}
        violations={violations}
        onViolation={(v) => setViolations((prev) => [...prev, v])}
      />
    );
  }

  return (
    <>
      {/* ── Consent modal ───────────────────────────────────────────────────── */}
      {pendingAssignment !== null && (
        <div className="modal-backdrop" onClick={() => setPendingAssignment(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-icon">🛡️</div>
            <h2 className="modal-title">Before you begin</h2>
            <p className="modal-subtitle">{pendingAssignment.title}</p>

            <ul className="consent-list">
              <li>
                <span className="consent-icon">📷</span>
                <div>
                  <strong>Camera &amp; Face Detection</strong>
                  <p>
                    Your face will be monitored throughout the exam to verify your identity and
                    detect phone use.
                  </p>
                </div>
              </li>
              <li>
                <span className="consent-icon">🎙️</span>
                <div>
                  <strong>Audio Monitoring</strong>
                  <p>
                    Microphone access is requested to detect voices other than your own during the
                    exam.
                  </p>
                </div>
              </li>
              <li>
                <span className="consent-icon">🌐</span>
                <div>
                  <strong>Browser Integrity</strong>
                  <p>Tab switching, focus loss, and suspicious keyboard patterns will be logged.</p>
                </div>
              </li>
              <li>
                <span className="consent-icon">🔒</span>
                <div>
                  <strong>One Tab Only</strong>
                  <p>Only one exam tab is permitted. Opening another will lock this session.</p>
                </div>
              </li>
              <li>
                <span className="consent-icon">☁️</span>
                <div>
                  <strong>Cloud Screen Recording</strong>
                  <p>
                    Your screen and microphone will be continuously recorded and uploaded to the
                    cloud for appeal reviews.
                  </p>
                </div>
              </li>
              <li>
                <span className="consent-icon">✍️</span>
                <div>
                  <strong>No Paste Allowed</strong>
                  <p>All answers must be typed manually. Paste is blocked and logged.</p>
                </div>
              </li>
              <li>
                <span className="consent-icon">🤖</span>
                <div>
                  <strong>AI Integrity Check</strong>
                  <p>
                    Answers may be analysed by Gemini AI for signs of AI-generated text after
                    submission.
                  </p>
                </div>
              </li>
            </ul>

            <label className="consent-checkbox">
              <input
                type="checkbox"
                checked={consentChecked}
                onChange={(e) => setConsentChecked(e.target.checked)}
              />
              <span>I understand and agree to these monitoring conditions for this exam.</span>
            </label>

            {!permissionsGranted ? (
              <div style={{ marginTop: '1rem', textAlign: 'center' }}>
                <button
                  className="topbar-submit"
                  disabled={!consentChecked}
                  onClick={() => void requestHardwarePermissions()}
                  type="button"
                  style={{ width: '100%', padding: '1rem' }}
                >
                  Grant Camera & Microphone Access
                </button>
                {permissionsError && (
                  <div style={{ marginTop: '0.5rem', textAlign: 'center' }}>
                    <p style={{ color: '#ff6b6b', fontSize: '0.9rem', marginBottom: '0.5rem' }}>
                      {permissionsError}
                    </p>
                    <button
                      onClick={requestHardwarePermissions}
                      className="btn btn-secondary"
                      style={{ fontSize: '0.8rem', padding: '0.25rem 0.75rem' }}
                    >
                      Retry Camera Connection
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <div className="modal-actions" style={{ marginTop: '1rem' }}>
                <button
                  className="secondary-button"
                  onClick={() => setPendingAssignment(null)}
                  type="button"
                >
                  Cancel
                </button>
                <button className="topbar-submit" onClick={() => void confirmOpen()} type="button">
                  I Agree — Start Exam
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Assignments page ─────────────────────────────────────────────────── */}
      <main className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">Exam Anti-Cheat</p>
            <p className="signed-in">Signed in as {email}</p>
          </div>
          <button className="secondary-button" onClick={() => void onLogout()} type="button">
            Sign out
          </button>
        </header>

        <section className="hero">
          <p className="eyebrow">Student workspace</p>
          <h1>Your assigned exams</h1>
          <button
            className="submit-button"
            disabled={generatingExam || loading}
            style={{ marginTop: '1rem', fontSize: '0.9rem' }}
            onClick={() => void generateExam()}
            type="button"
          >
            {generatingExam ? 'Generating Exam…' : '🔄 Generate New Exam'}
          </button>
          {generationMessage !== null ? (
            <p aria-live="polite" role="status" style={{ marginTop: '0.75rem' }}>
              {generationMessage}
            </p>
          ) : null}
        </section>

        {loading ? (
          <p role="status" style={{ textAlign: 'center', color: 'var(--color-muted)' }}>
            Loading assignments…
          </p>
        ) : null}
        {error !== null ? (
          <p
            aria-live="polite"
            role="alert"
            style={{ color: 'var(--color-error)', textAlign: 'center' }}
          >
            {error}
          </p>
        ) : null}
        {!loading && error === null && assignments.length === 0 ? (
          <section className="empty-state">
            <h2>No assignments yet</h2>
            <p>Click "Generate New Exam" above to create one, or wait for your instructor.</p>
          </section>
        ) : null}

        <div className="assignment-grid">
          {assignments.map((assignment) => {
            const isSubmitted = assignment.attemptStatus === 'submitted';
            const isExpired = assignment.attemptStatus === 'expired';
            const isInProgress = assignment.attemptStatus === 'in_progress';
            const isDisabled = isSubmitted || isExpired;
            return (
              <article
                className="assignment-card"
                key={assignment.id}
                style={isDisabled ? { opacity: 0.5 } : {}}
              >
                <div className="card-status-dot" data-status={assignment.attemptStatus ?? 'none'} />
                <p className="eyebrow">Version {assignment.versionNumber}</p>
                <h2>{assignment.title}</h2>
                <p className="muted">
                  Assigned {new Date(assignment.assignedAt).toLocaleDateString()}
                </p>
                <p
                  className={`assignment-status ${isSubmitted ? 'status-ok' : isInProgress ? 'status-progress' : ''}`}
                >
                  {assignment.attemptStatus === null
                    ? '○ Not started'
                    : isInProgress
                      ? '● In progress'
                      : isExpired
                        ? '✕ Expired'
                        : `✓ ${assignment.attemptStatus}`}
                </p>
                {!isDisabled ? (
                  <button
                    className="submit-button"
                    disabled={loading}
                    onClick={() => requestOpen(assignment)}
                    type="button"
                  >
                    {assignment.attemptStatus === null ? 'Start exam' : 'Open exam'}
                  </button>
                ) : (
                  <span style={{ color: '#888', fontSize: '0.85rem', fontStyle: 'italic' }}>
                    {isExpired ? 'Deadline passed' : 'Already submitted'}
                  </span>
                )}
              </article>
            );
          })}
        </div>
      </main>
    </>
  );
}
