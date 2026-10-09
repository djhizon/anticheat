import { describe, expect, it } from 'vitest';

import type { ExamDeliveryProjection } from './exam.js';
import { supportedQuestionTypes } from './exam.js';

describe('exam contracts', () => {
  it('lists only the Pack 2 question types', () => {
    expect(supportedQuestionTypes).toEqual([
      'multiple_choice',
      'true_false',
      'identification',
      'numeric',
      'short_answer',
    ]);
  });

  it('keeps the student delivery projection free of answer keys', () => {
    const delivery = {
      exam: {
        id: 'exam-1',
        versionId: 'version-1',
        title: 'Synthetic assessment',
        versionNumber: 1,
        durationSeconds: 1800,
      },
      assignment: {
        id: 'assignment-1',
        examVersionId: 'version-1',
        title: 'Synthetic assessment',
        versionNumber: 1,
        assignedAt: '2026-09-15T00:00:00.000Z',
        extraTimeSeconds: 0,
        attemptId: 'attempt-1',
        attemptStatus: 'in_progress',
      },
      attempt: {
        id: 'attempt-1',
        assignmentId: 'assignment-1',
        status: 'in_progress',
        startedAt: '2026-09-15T00:00:00.000Z',
        effectiveDeadline: '2026-09-15T00:30:00.000Z',
        submittedAt: null,
        expiredAt: null,
      },
      answers: { revision: 0, savedAt: null, answers: {} },
      questions: [
        {
          id: 'question-1',
          type: 'multiple_choice',
          prompt: 'Which option is correct?',
          options: [{ id: 'a', text: 'Option A' }],
        },
      ],
    } satisfies ExamDeliveryProjection;

    expect(Object.keys(delivery.questions[0] ?? {})).not.toContain('answerKey');
    expect(Object.keys(delivery.questions[0] ?? {})).not.toContain('gradingMetadata');
  });
});
