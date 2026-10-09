import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ExamAssignmentListResponse,
  ExamAssignmentProjection,
  ExamDeliveryProjection,
} from '@examguard/contracts/exam';

import { AccountButton } from './features/account/AccountPanel.js';
import { ConfirmPage } from './features/account/ConfirmPage.js';
import { AttemptTimelineDashboard } from './features/admin/AttemptTimelineDashboard.js';
import { AiCheckDashboard } from './features/admin/AiCheckDashboard.js';
import { createInstructorApi } from './features/admin/api.js';
import { createEvidenceApi } from './features/evidence/evidenceApi.js';
import { SimilarityDashboard } from './features/admin/SimilarityDashboard.js';
import { createTriageApi } from './features/triage/findingsApi.js';
import { TriageDashboard } from './features/triage/TriageDashboard.js';
import { AuthProvider, useAuth } from './features/auth/AuthProvider.js';
import { LoginPage } from './features/auth/LoginPage.js';
import { createExamApi, ExamApiError, type ExamApi } from './features/exam/api.js';
import { StudentExamPage } from './features/exam/StudentExamPage.js';
import { PreflightCheck } from './features/integrity/PreflightCheck.js';
import { DemoModeBanner } from './features/integrity/DemoModeBanner.js';
import { DevelopmentExemptions } from './features/integrity/DevelopmentExemptions.js';
import { ExamSetup, type SetupResult } from './features/exam/ExamSetup.js';
import { loadSetupProgress, type ExamSetupSummary } from './features/exam/setupFlow.js';
import { releaseSensorStreams } from './features/integrity/sensorHub.js';
import { stopScreenRecording } from './features/integrity/screenRecordingSession.js';

const OPEN_ASSIGNMENT_KEY = 'exam-open-assignment';

export function isSessionExpiredError(error: unknown): boolean {
  return error instanceof ExamApiError && error.problem.code === 'unauthorized';
}

export function App(): React.ReactElement {
  return (
    <AuthProvider>
      <DemoModeBanner />
      <DevelopmentExemptions />
      <AuthenticatedApp />
    </AuthProvider>
  );
}

const confirmPath = '/account/confirm';

/** Minimal pathname routing; the app has no router and only `/account/confirm` is special. */
function useLocation(): {
  readonly pathname: string;
  readonly search: string;
  readonly navigate: (path: string) => void;
} {
  const [location, setLocation] = useState(() => ({
    pathname: window.location.pathname,
    search: window.location.search,
  }));

  useEffect(() => {
    const onPop = (): void =>
      setLocation({ pathname: window.location.pathname, search: window.location.search });
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const navigate = useCallback((path: string): void => {
    // replaceState: a consumed one-time email link must not stay in the history.
    window.history.replaceState(null, '', path);
    setLocation({ pathname: window.location.pathname, search: window.location.search });
  }, []);

  return { ...location, navigate };
}

function AuthenticatedApp(): React.ReactElement {
  const { getCsrfToken, loading, logout, refresh, user } = useAuth();
  const location = useLocation();
  const examApi = useMemo<ExamApi>(() => createExamApi('', getCsrfToken), [getCsrfToken]);

  if (loading) {
    return (
      <main className="panel">
        <p role="status">Checking your session…</p>
      </main>
    );
  }
  if (location.pathname === confirmPath) {
    return <ConfirmPage onNavigate={location.navigate} search={location.search} />;
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
  const triageApi = useMemo(() => createTriageApi(getCsrfToken), [getCsrfToken]);
  const evidenceApi = useMemo(() => createEvidenceApi('', getCsrfToken), [getCsrfToken]);
  // null: triage (default). '': the detail dashboards. Otherwise the attempt opened from "Details".
  const [details, setDetails] = useState<string | null>(null);
  return (
    <main className="workspace">
      <header className="topbar">
        <div>
          <p className="eyebrow">ExamGuard</p>
          <p className="signed-in">Signed in as {email}</p>
        </div>
        <div className="topbar-actions">
          <AccountButton />
          <button className="secondary-button" onClick={() => void onLogout()} type="button">
            Sign out
          </button>
        </div>
      </header>
      <section className="hero">
        <p className="eyebrow">Instructor workspace</p>
        <h1>Integrity review</h1>
      </section>
      {details === null ? (
        <>
          <TriageDashboard api={triageApi} evidence={evidenceApi} onDetails={setDetails} />
          <p className="triage-tools">
            <button className="secondary-button" onClick={() => setDetails('')} type="button">
              Details: full logs, similarity and AI checks
            </button>
          </p>
        </>
      ) : (
        <>
          <p className="triage-tools">
            <button className="secondary-button" onClick={() => setDetails(null)} type="button">
              ← Back to triage
            </button>
          </p>
          <AttemptTimelineDashboard
            api={instructorApi}
            evidence={evidenceApi}
            initialAttemptId={details === '' ? undefined : details}
          />
          <SimilarityDashboard api={instructorApi} />
          <AiCheckDashboard api={instructorApi} />
        </>
      )}
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

  // ── Pre-exam setup state ───────────────────────────────────────────────────
  const [setupAssignment, setSetupAssignment] = useState<ExamAssignmentProjection | null>(null);
  const [setupAttemptId, setSetupAttemptId] = useState<string | null>(null);
  const [examSetup, setExamSetup] = useState<ExamSetupSummary | null>(null);
  const tabGuardRef = useRef<{ release(): void } | null>(null);
  const [violations, setViolations] = useState<
    import('./features/integrity/tabGuard.js').ViolationEvent[]
  >([]);
  const autoOpened = useRef(false);

  function rememberOpen(assignmentId: string | null): void {
    try {
      if (assignmentId === null) sessionStorage.removeItem(OPEN_ASSIGNMENT_KEY);
      else sessionStorage.setItem(OPEN_ASSIGNMENT_KEY, assignmentId);
    } catch {
      // Storage may be unavailable; a refresh then returns to the assignment list.
    }
  }

  async function enterExam(
    assignment: ExamAssignmentProjection,
    nextDelivery: ExamDeliveryProjection,
  ): Promise<void> {
    // Install the tab guard once the exam is running (use assignment ID).
    const { createTabGuard } = await import('./features/integrity/tabGuard.js');
    setViolations([]);
    const guard = createTabGuard(assignment.id, (v) => setViolations((prev) => [...prev, v]));
    tabGuardRef.current?.release();
    tabGuardRef.current = guard;
    const progress = loadSetupProgress(assignment.id);
    setExamSetup({
      identityVerified: progress.identity && progress.identityUnverified !== true,
      phoneUsed: progress.phone,
    });
    rememberOpen(assignment.id);
    setSetupAssignment(null);
    setSelectedAssignment(assignment.id);
    setError(null);
    setDelivery(nextDelivery);
  }

  async function requestOpen(assignment: ExamAssignmentProjection): Promise<void> {
    if (tabGuardRef.current !== null) {
      tabGuardRef.current.release();
      tabGuardRef.current = null;
    }
    localStorage.removeItem(`exam-tab-guard:${assignment.id}`);
    setSetupAttemptId(null);
    if (assignment.attemptStatus !== 'in_progress') {
      // Nothing is created until the student consents (first setup step).
      rememberOpen(assignment.id);
      setSetupAssignment(assignment);
      return;
    }
    // An attempt exists: setup is still pending, or the exam already began (refresh mid-exam).
    setExamLoading(true);
    try {
      const existing = await examApi.startAttempt(assignment.id, { setup: true });
      if (existing.attempt.awaitingStart === true) {
        setSetupAttemptId(existing.attempt.id);
        rememberOpen(assignment.id);
        setSetupAssignment(assignment);
      } else {
        await enterExam(assignment, existing);
      }
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

  async function createSetupAttempt(assignment: ExamAssignmentProjection): Promise<string> {
    const created = await examApi.startAttempt(assignment.id, { setup: true });
    setSetupAttemptId(created.attempt.id);
    return created.attempt.id;
  }

  async function beginExam(
    assignment: ExamAssignmentProjection,
    result: SetupResult,
  ): Promise<void> {
    const begun = await examApi.beginAttempt(result.attemptId);
    await enterExam(assignment, begun);
  }

  // After a refresh mid-setup or mid-exam, reopen the same assignment (no consent modal).
  useEffect(() => {
    if (!preflightPassed || loading || autoOpened.current) return;
    autoOpened.current = true;
    let remembered: string | null = null;
    try {
      remembered = sessionStorage.getItem(OPEN_ASSIGNMENT_KEY);
    } catch {
      remembered = null;
    }
    const match = assignments.find((a) => a.id === remembered && a.attemptStatus === 'in_progress');
    if (match !== undefined) void requestOpen(match);
    else if (remembered !== null) {
      const pending = assignments.find((a) => a.id === remembered && a.attemptStatus === null);
      if (pending !== undefined) void requestOpen(pending);
    }
  }, [preflightPassed, loading, assignments]);

  function goBack(): void {
    tabGuardRef.current?.release();
    tabGuardRef.current = null;
    releaseSensorStreams();
    stopScreenRecording();
    rememberOpen(null);
    setViolations([]);
    setSelectedAssignment(null);
    setSetupAssignment(null);
    setExamSetup(null);
    setDelivery(null);
    setError(null);
    // The attempt may have been submitted: show its real status, not the stale list.
    void loadAssignments();
  }

  if (!preflightPassed) {
    return (
      <PreflightCheck onPassed={() => setPreflightPassed(true)} onCancel={() => void onLogout()} />
    );
  }

  if (setupAssignment !== null) {
    const assignment = setupAssignment;
    return (
      <ExamSetup
        key={assignment.id}
        assignmentId={assignment.id}
        title={assignment.title}
        examApi={examApi}
        attemptId={setupAttemptId}
        ensureAttempt={() => createSetupAttempt(assignment)}
        onBegin={(result) => beginExam(assignment, result)}
        onCancel={goBack}
        recordingUpload={assignment.privacy?.recordingUpload !== false}
      />
    );
  }

  if (selectedAssignment !== null) {
    return (
      <StudentExamPage
        delivery={delivery}
        error={error}
        examApi={examApi}
        sensorsConsented
        {...(examSetup !== null ? { setup: examSetup } : {})}
        loading={examLoading}
        onBack={goBack}
        violations={violations}
        onViolation={(v) => setViolations((prev) => [...prev, v])}
      />
    );
  }

  return (
    <>
      {/* ── Assignments page ─────────────────────────────────────────────────── */}
      <main className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">ExamGuard</p>
            <p className="signed-in">Signed in as {email}</p>
          </div>
          <div className="topbar-actions">
            <AccountButton />
            <button className="secondary-button" onClick={() => void onLogout()} type="button">
              Sign out
            </button>
          </div>
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
                    onClick={() => void requestOpen(assignment)}
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
