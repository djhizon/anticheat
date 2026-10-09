import { useState } from 'react';
import type { AiCheckRunResponse } from '@exam-anti-cheat/contracts/exam';

import type { InstructorApi } from './api.js';
import { QuestionPicker, useInstructorQuestions } from './QuestionPicker.js';

const HIGH = 0.7;
const MEDIUM = 0.4;

function band(score: number): 'high' | 'medium' | 'low' {
  return score >= HIGH ? 'high' : score >= MEDIUM ? 'medium' : 'low';
}

/**
 * Instructor review of AI-written answers. Gemini scores each student's saved
 * answer and quotes the phrases that read as generated, so the instructor can
 * judge for themselves. Scores are leads for a conversation, never penalties.
 */
export function AiCheckDashboard({ api }: { readonly api: InstructorApi }) {
  const { versions, selection, setSelection, picked, loadError } = useInstructorQuestions(api);
  const [result, setResult] = useState<AiCheckRunResponse | null>(null);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const error = runError ?? loadError;

  async function run() {
    if (picked === null) return;
    setRunning(true);
    setRunError(null);
    setResult(null);
    try {
      setResult(await api.runAiCheck(picked.versionId, picked.questionId));
    } catch (cause) {
      setRunError(cause instanceof Error ? cause.message : 'The AI check failed.');
    } finally {
      setRunning(false);
    }
  }

  return (
    <section className="admin-dashboard" aria-labelledby="ai-check-title">
      <h2 id="ai-check-title">🤖 AI-written answer check</h2>
      <p className="muted">
        Gemini reads each student&apos;s saved answer and quotes phrasing that looks generated.
        Treat high scores as a reason to talk with the student, not as proof.
      </p>

      {versions === null && error === null && <p role="status">Loading exams…</p>}
      {versions !== null && versions.length === 0 && (
        <p>No published exams with free-text questions yet.</p>
      )}
      {versions !== null && versions.length > 0 && (
        <div className="similarity-controls">
          <QuestionPicker
            id="ai-check-question"
            versions={versions}
            selection={selection}
            onChange={setSelection}
          />
          <button
            className="submit-button"
            type="button"
            disabled={running || picked === null}
            onClick={() => void run()}
          >
            {running ? 'Checking answers…' : 'Run AI check'}
          </button>
        </div>
      )}

      {error !== null && (
        <p role="alert" className="similarity-error">
          {error}
        </p>
      )}

      {result !== null && (
        <div role="status">
          <p className="similarity-meta">
            {result.results.length} answer{result.results.length === 1 ? '' : 's'} checked ·{' '}
            {new Date(result.checkedAt).toLocaleString()}
            {result.truncated && ' · only the first 30 answers were checked'}
          </p>
          {result.results.length === 0 ? (
            <p>No saved answers to this question yet.</p>
          ) : (
            <ul className="ai-check-list">
              {result.results.map((entry) => (
                <li
                  key={entry.studentId}
                  className={`ai-check-item ai-check-item--${entry.available ? band(entry.score) : 'unavailable'}`}
                >
                  <div className="ai-check-head">
                    <span className="pair-ids">{entry.email}</span>
                    <span className="pair-score">
                      {entry.available
                        ? `${Math.round(entry.score * 100)}% likely AI`
                        : 'Unavailable'}
                    </span>
                  </div>
                  <p className="ai-check-summary">{entry.summary}</p>
                  {entry.flags.length > 0 && (
                    <ul className="ai-check-flags">
                      {entry.flags.map((flag, index) => (
                        <li key={index}>
                          <q>{flag.phrase}</q> — {flag.reason}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
