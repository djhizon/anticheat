import { useState } from 'react';
import type { SimilarityRunResponse } from '@exam-anti-cheat/contracts/exam';

import type { InstructorApi } from './api.js';
import { QuestionPicker, useInstructorQuestions } from './QuestionPicker.js';

/**
 * Instructor review of cross-student answer similarity. Answers are embedded
 * with Gemini and compared pairwise; close pairs are flagged for a human to
 * read side by side — never an automatic penalty.
 */
export function SimilarityDashboard({ api }: { readonly api: InstructorApi }) {
  const { versions, selection, setSelection, picked, loadError } = useInstructorQuestions(api);
  const [result, setResult] = useState<SimilarityRunResponse | null>(null);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const error = runError ?? loadError;

  async function run() {
    if (picked === null) return;
    setRunning(true);
    setRunError(null);
    setResult(null);
    try {
      setResult(await api.runSimilarity(picked.versionId, picked.questionId));
    } catch (cause) {
      setRunError(cause instanceof Error ? cause.message : 'The similarity check failed.');
    } finally {
      setRunning(false);
    }
  }

  const label = (id: string) => result?.students[id] ?? id;
  const flagged = result?.report.pairs.filter((pair) => pair.flagged) ?? [];

  return (
    <section className="admin-dashboard" aria-labelledby="similarity-title">
      <h2 id="similarity-title">🤝 Cross-student similarity</h2>
      <p className="muted">
        Compares every student&apos;s saved free-text answer to the same question using Gemini
        embeddings. Flagged pairs are leads for review, not verdicts.
      </p>

      {versions === null && error === null && <p role="status">Loading exams…</p>}
      {versions !== null && versions.length === 0 && (
        <p>No published exams with free-text questions yet.</p>
      )}
      {versions !== null && versions.length > 0 && (
        <div className="similarity-controls">
          <QuestionPicker
            id="similarity-question"
            versions={versions}
            selection={selection}
            onChange={setSelection}
          />
          <button
            className="submit-button"
            type="button"
            disabled={running || selection === ''}
            onClick={() => void run()}
          >
            {running ? 'Comparing answers…' : 'Run similarity check'}
          </button>
        </div>
      )}

      {error !== null && (
        <p role="alert" className="similarity-error">
          {error}
        </p>
      )}

      {result !== null && (
        <div className="similarity-card" role="status">
          <p className="similarity-meta">
            {result.report.pairs.length} pair{result.report.pairs.length === 1 ? '' : 's'} compared
            · threshold {Math.round(result.report.threshold * 100)}% · {flagged.length} flagged ·{' '}
            {new Date(result.report.generatedAt).toLocaleString()}
          </p>
          {result.report.pairs.length === 0 ? (
            <p>At least two students need saved answers to compare.</p>
          ) : (
            <ul className="similarity-list">
              {result.report.pairs.map((pair) => (
                <li
                  key={`${pair.studentAId}-${pair.studentBId}`}
                  className={pair.flagged ? 'flagged-pair' : ''}
                >
                  <span className="pair-ids">
                    {label(pair.studentAId)} ↔ {label(pair.studentBId)}
                  </span>
                  <span className="pair-score">{(pair.score * 100).toFixed(1)}%</span>
                  {pair.flagged && <span className="collusion-warning">⚠️ Review</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
