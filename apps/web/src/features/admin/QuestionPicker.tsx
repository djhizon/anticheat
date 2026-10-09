import { useEffect, useState } from 'react';
import type { InstructorExamVersion } from '@exam-anti-cheat/contracts/exam';

import type { InstructorApi } from './api.js';

export interface PickedQuestion {
  readonly versionId: string;
  readonly questionId: string;
}

/** Loads published exams with free-text questions and tracks the instructor's pick. */
export function useInstructorQuestions(api: InstructorApi) {
  const [versions, setVersions] = useState<readonly InstructorExamVersion[] | null>(null);
  const [selection, setSelection] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    api
      .listVersions()
      .then((loaded) => {
        if (!active) return;
        setVersions(loaded);
        const first = loaded[0];
        const firstQuestion = first?.questions[0];
        if (first && firstQuestion) setSelection(`${first.id}|${firstQuestion.id}`);
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : 'Could not load exams.');
      });
    return () => {
      active = false;
    };
  }, [api]);

  const [versionId, questionId] = selection.split('|');
  const picked: PickedQuestion | null = versionId && questionId ? { versionId, questionId } : null;
  return { versions, selection, setSelection, picked, loadError: error };
}

export function QuestionPicker({
  id,
  versions,
  selection,
  onChange,
}: {
  readonly id: string;
  readonly versions: readonly InstructorExamVersion[];
  readonly selection: string;
  readonly onChange: (selection: string) => void;
}) {
  return (
    <>
      <label htmlFor={id}>Question</label>
      <select id={id} value={selection} onChange={(event) => onChange(event.target.value)}>
        {versions.map((version) => (
          <optgroup key={version.id} label={`${version.title} (v${version.versionNumber})`}>
            {version.questions.map((question, index) => (
              <option key={question.id} value={`${version.id}|${question.id}`}>
                Q{index + 1}:{' '}
                {question.prompt.length > 80 ? `${question.prompt.slice(0, 80)}…` : question.prompt}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </>
  );
}
