import { describe, expect, it } from 'vitest';

import type { FetchLike } from '../auth/api.js';

import { createExamApi, ExamApiError } from './api.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
    status,
  });
}

const assignment = {
  id: 'assignment-1',
  examVersionId: 'version-1',
  title: 'Civics check-in',
  versionNumber: 1,
  assignedAt: '2026-09-15T00:00:00.000Z',
  extraTimeSeconds: 0,
  attemptId: null,
  attemptStatus: null,
} as const;

const delivery = {
  exam: {
    id: 'exam-1',
    versionId: 'version-1',
    title: 'Civics check-in',
    versionNumber: 1,
    durationSeconds: 1800,
  },
  assignment: { ...assignment, attemptId: 'attempt-1', attemptStatus: 'in_progress' },
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
      prompt: 'Which?',
      options: [
        { id: 'a', text: 'A' },
        { id: 'b', text: 'B' },
      ],
    },
  ],
} as const;

describe('browser exam API boundary', () => {
  it('uses CSRF for native pairing and validates phone status before granting access', async () => {
    const calls: Array<{ input: RequestInfo | URL; init: RequestInit | undefined }> = [];
    const fetchImpl: FetchLike = async (input, init) => {
      calls.push({ input, init });
      return init?.method === 'POST'
        ? jsonResponse({ code: 'a'.repeat(43), expiresAt: '2026-09-24T00:02:00Z' })
        : jsonResponse({ required: true, active: true, remainingMs: 6000 });
    };
    const api = createExamApi('', async () => 'csrf-fixture', fetchImpl);
    await expect(api.requirePhonePresence('attempt')).resolves.toHaveProperty('code');
    expect((calls[0]?.init?.headers as Record<string, string>)['x-csrf-token']).toBe('csrf-fixture');
    const controller = new AbortController();
    await expect(api.getPhonePresence('attempt', controller.signal)).resolves.toEqual({ required: true, active: true, remainingMs: 6000 });
    expect(calls[1]?.init?.signal).toBe(controller.signal);
    const bad = createExamApi('', async () => 'csrf', async () => jsonResponse({ required: false }));
    await expect(bad.getPhonePresence('attempt')).rejects.toBeInstanceOf(ExamApiError);
  });

  it('lists assignments and sends CSRF for starting an attempt', async () => {
    const calls: Array<{ input: RequestInfo | URL; init: RequestInit | undefined }> = [];
    const fetchImpl: FetchLike = async (input, init) => {
      calls.push({ input, init });
      return String(input).endsWith('/assignments')
        ? jsonResponse({ assignments: [assignment] })
        : jsonResponse({ delivery });
    };
    const api = createExamApi('/api', async () => 'csrf-token', fetchImpl);

    await expect(api.listAssignments()).resolves.toEqual({ assignments: [assignment] });
    await expect(api.startAttempt(assignment.id)).resolves.toEqual(delivery);
    const headers = calls[1]?.init?.headers as Record<string, string>;
    expect(headers['x-csrf-token']).toBe('csrf-token');
    expect(calls[1]?.init?.credentials).toBe('include');
  });

  it('generates a fresh exam with credentials and CSRF protection', async () => {
    const calls: Array<{ input: RequestInfo | URL; init: RequestInit | undefined }> = [];
    const fetchImpl: FetchLike = async (input, init) => {
      calls.push({ input, init });
      return jsonResponse({ assignmentId: 'assignment-fresh', source: 'fallback' }, 201);
    };
    const api = createExamApi('/api', async () => 'csrf-token', fetchImpl);

    await expect(api.generateExam()).resolves.toEqual({
      assignmentId: 'assignment-fresh',
      source: 'fallback',
    });
    expect(String(calls[0]?.input)).toBe('/api/exam/generate');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.credentials).toBe('include');
    expect((calls[0]?.init?.headers as Record<string, string>)['x-csrf-token']).toBe(
      'csrf-token',
    );
  });

  it('maps server failures to safe problems', async () => {
    const fetchImpl: FetchLike = async () => jsonResponse({ message: 'secret' }, 403);
    const api = createExamApi('', async () => 'csrf-token', fetchImpl);

    await expect(api.listAssignments()).rejects.toMatchObject({
      problem: { code: 'forbidden', message: 'You do not have permission to view this exam.' },
    });
  });

  it('rejects malformed delivery data without exposing arbitrary fields', async () => {
    const fetchImpl: FetchLike = async () => jsonResponse({ delivery: { answerKey: 'secret' } });
    const api = createExamApi('', async () => 'csrf-token', fetchImpl);

    await expect(api.getAttempt('attempt-1')).rejects.toMatchObject({
      problem: { code: 'invalid_state' },
    });
  });

  it('sanitizes extra internal fields from an otherwise valid delivery', async () => {
    const response = structuredClone(delivery) as Record<string, unknown>;
    const responseQuestion = (response.questions as Array<Record<string, unknown>>)[0];
    if (responseQuestion === undefined) {
      throw new Error('The test delivery has no question.');
    }
    responseQuestion.answerKey = 'secret';
    responseQuestion.answer_key_json = 'secret';
    response.answerKey = 'secret';
    response.answer_key_json = 'secret';
    const fetchImpl: FetchLike = async () => jsonResponse({ delivery: response });
    const api = createExamApi('', async () => 'csrf-token', fetchImpl);

    const result = await api.getAttempt('attempt-1');
    const firstQuestion = result.questions[0];
    if (firstQuestion === undefined) {
      throw new Error('The sanitized delivery has no question.');
    }
    expect(result).toEqual(delivery);
    expect('answerKey' in result).toBe(false);
    expect('answerKey' in firstQuestion).toBe(false);
  });

  it('saves answer snapshots and submits with CSRF-protected JSON requests', async () => {
    const submittedDelivery = {
      ...delivery,
      assignment: { ...delivery.assignment, attemptStatus: 'submitted' },
      attempt: {
        ...delivery.attempt,
        status: 'submitted',
        submittedAt: '2026-09-15T00:10:00.000Z',
      },
      answers: {
        revision: 1,
        savedAt: '2026-09-15T00:09:00.000Z',
        answers: { 'question-1': 'a' },
      },
    } as const;
    const calls: Array<{ input: RequestInfo | URL; init: RequestInit | undefined }> = [];
    const fetchImpl: FetchLike = async (input, init) => {
      calls.push({ input, init });
      if (init?.method === 'PUT') {
        return jsonResponse({
          attemptId: 'attempt-1',
          revision: 1,
          savedAt: '2026-09-15T00:09:00.000Z',
          answers: { 'question-1': 'a' },
        });
      }
      return jsonResponse({
        delivery: submittedDelivery,
        receipt: {
          attemptId: 'attempt-1',
          status: 'submitted',
          revision: 1,
          submittedAt: '2026-09-15T00:10:00.000Z',
          expiredAt: null,
        },
      });
    };
    const api = createExamApi('', async () => 'csrf-token', fetchImpl);

    await expect(
      api.saveAnswers('attempt-1', {
        revision: 0,
        idempotencyKey: 'save-answers-key-1',
        answers: { 'question-1': 'a' },
      }),
    ).resolves.toMatchObject({ revision: 1, answers: { 'question-1': 'a' } });
    await expect(
      api.submitAttempt('attempt-1', {
        expectedRevision: 1,
        idempotencyKey: 'submit-attempt-key-1',
      }),
    ).resolves.toMatchObject({ receipt: { status: 'submitted', revision: 1 } });

    expect(calls[0]?.init?.method).toBe('PUT');
    expect(calls[0]?.init?.body).toContain('save-answers-key-1');
    expect((calls[0]?.init?.headers as Record<string, string>)['x-csrf-token']).toBe('csrf-token');
    expect(calls[1]?.init?.method).toBe('POST');
    expect(calls[1]?.init?.body).toContain('submit-attempt-key-1');
  });
});
