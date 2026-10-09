import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Clock, UserId } from '@examguard/contracts';
import type {
  ExamAnswerSaveResponse,
  ExamAssignmentListResponse,
  ExamDeliveryResponse,
  ExamGenerationResponse,
  ExamSubmitResponse,
} from '@examguard/contracts/exam';

import { loadConfig, type ApiConfig } from '../../config.js';
import { createAuthPlugin, type AuthPlugin, type AuthRequest } from '../auth/auth.plugin.js';
import { type TokenGenerator } from '../auth/session.js';
import { createExamPlugin, type ExamPlugin } from './exam.plugin.js';
import { MAX_EXTRA_TIME_SECONDS, type SeedPublishedExamResult } from './exam.service.js';
import { ExamRoutes } from './exam.routes.js';
import {
  GeminiUnavailableError,
  IntegrityService,
  LivenessRateLimitError,
} from '../integrity/integrityService.js';
import { IntegrityRepository } from '../integrity/integrityRepository.js';
import type { GeminiRotatingClient } from '../integrity/gemini.js';
import { transcribeAudio } from '../integrity/whisper.js';
import { PhonePresenceService } from '../integrity/phonePresence.js';
import { RecordingConflictError, uploadRecordingChunk } from '../integrity/graph.js';

/** Base64 of the WebM/EBML magic bytes 1A 45 DF A3. */
const WEBM = 'GkXfow==';

vi.mock('../integrity/graph.js', async (original) => ({
  ...(await original<typeof import('../integrity/graph.js')>()),
  uploadRecordingChunk: vi.fn(async () => undefined),
}));

vi.mock('../integrity/whisper.js', async (original) => ({
  ...(await original<typeof import('../integrity/whisper.js')>()),
  transcribeAudio: vi.fn(),
}));

const origin = 'http://localhost:5173';
const password = 'correct horse battery staple';

class TestClock implements Clock {
  private current: Date;

  constructor(value = '2026-09-15T00:00:00.000Z') {
    this.current = new Date(value);
  }

  now(): Date {
    return new Date(this.current.getTime());
  }

  advance(seconds: number): void {
    this.current = new Date(this.current.getTime() + seconds * 1000);
  }
}

class SequenceTokenGenerator implements TokenGenerator {
  private next = 0;

  generate(byteLength: number): string {
    return `exam-fixture-${byteLength}-${this.next++}`;
  }
}

interface StudentSession {
  readonly userId: UserId;
  readonly sessionToken: string;
  readonly csrfToken: string;
}

describe('exam delivery boundary', () => {
  let auth!: AuthPlugin;
  let exam!: ExamPlugin;
  let clock!: TestClock;
  let config!: ApiConfig;

  beforeEach(() => {
    vi.mocked(transcribeAudio).mockReset();
    vi.mocked(uploadRecordingChunk).mockClear();
    config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_PATH: ':memory:',
      ALLOWED_ORIGINS: origin,
      COOKIE_SECURE: 'false',
    });
    auth = createAuthPlugin(config);
    clock = new TestClock();
    exam = createExamPlugin(auth.database, auth.boundary, config, {
      clock,
      idGenerator: new SequenceTokenGenerator(),
    });
  });

  afterEach(() => {
    auth.close();
  });

  it('delivers all supported question types without answer keys and stabilizes an attempt', async () => {
    const student = await registerStudent('student@example.test');
    const seeded = await seedExam();
    const assignmentId = await exam.service.assignExam({
      examVersionId: seeded.examVersionId,
      studentId: student.userId,
      extraTimeSeconds: 30,
    });

    const assignments = await exam.routes.handle(
      studentRequest(student, 'GET', '/exam/assignments'),
    );
    expect(assignments.status).toBe(200);
    const assignmentBody = assignments.body as ExamAssignmentListResponse;
    expect(assignmentBody.assignments).toHaveLength(1);
    expect(assignmentBody.assignments[0]).toMatchObject({
      id: assignmentId,
      extraTimeSeconds: 30,
      attemptId: null,
      attemptStatus: null,
    });

    const start = await exam.routes.handle(
      studentRequest(student, 'POST', `/exam/assignments/${assignmentId}/start`, {
        seed: 'client-controlled-seed',
        status: 'submitted',
        startedAt: '1900-01-01T00:00:00.000Z',
      }),
    );
    expect(start.status).toBe(201);
    const firstDelivery = (start.body as ExamDeliveryResponse).delivery;
    expect(firstDelivery.attempt.effectiveDeadline).toBe('2026-09-15T00:01:30.000Z');
    expect(new Set(firstDelivery.questions.map((question) => question.type))).toEqual(
      new Set(['multiple_choice', 'true_false', 'identification', 'numeric', 'short_answer']),
    );
    for (const question of firstDelivery.questions) {
      expect(Object.keys(question).sort()).toEqual(['id', 'options', 'prompt', 'type']);
      expect(question).not.toHaveProperty('answerKey');
      expect(question).not.toHaveProperty('answer_key_json');
    }

    const duplicateStart = await exam.routes.handle(
      studentRequest(student, 'POST', `/exam/assignments/${assignmentId}/start`, {
        seed: 'a-different-client-seed',
        status: 'expired',
      }),
    );
    expect(duplicateStart.status).toBe(200);
    const secondDelivery = (duplicateStart.body as ExamDeliveryResponse).delivery;
    expect(secondDelivery.attempt.id).toBe(firstDelivery.attempt.id);
    expect(secondDelivery.questions.map((question) => question.id)).toEqual(
      firstDelivery.questions.map((question) => question.id),
    );
    expect(auth.database.prepare('SELECT COUNT(*) AS count FROM exam_attempts').get()?.count).toBe(
      1,
    );
  });

  it('scopes assignment and attempt access to the authenticated student', async () => {
    const student = await registerStudent('student@example.test');
    const otherStudent = await registerStudent('other@example.test');
    const seeded = await seedExam();
    const assignmentId = await exam.service.assignExam({
      examVersionId: seeded.examVersionId,
      studentId: student.userId,
    });
    const start = await exam.routes.handle(
      studentRequest(student, 'POST', `/exam/assignments/${assignmentId}/start`),
    );
    const attemptId = (start.body as ExamDeliveryResponse).delivery.attempt.id;

    const otherAssignments = await exam.routes.handle(
      studentRequest(otherStudent, 'GET', '/exam/assignments'),
    );
    expect(otherAssignments.status).toBe(200);
    expect((otherAssignments.body as ExamAssignmentListResponse).assignments).toEqual([]);

    const otherAttempt = await exam.routes.handle(
      studentRequest(otherStudent, 'GET', `/exam/attempts/${attemptId}`),
    );
    expect(otherAttempt.status).toBe(404);

    const otherStart = await exam.routes.handle(
      studentRequest(otherStudent, 'POST', `/exam/assignments/${assignmentId}/start`),
    );
    expect(otherStart.status).toBe(404);
  });

  it('uses the server deadline and extra-time accommodation to expire attempts', async () => {
    const student = await registerStudent('student@example.test');
    const seeded = await seedExam();
    const assignmentId = await exam.service.assignExam({
      examVersionId: seeded.examVersionId,
      studentId: student.userId,
      extraTimeSeconds: 30,
    });
    const start = await exam.routes.handle(
      studentRequest(student, 'POST', `/exam/assignments/${assignmentId}/start`),
    );
    const attemptId = (start.body as ExamDeliveryResponse).delivery.attempt.id;

    clock.advance(91);
    const expired = await exam.routes.handle(
      studentRequest(student, 'GET', `/exam/attempts/${attemptId}`),
    );
    expect(expired.status).toBe(200);
    expect((expired.body as ExamDeliveryResponse).delivery.attempt.status).toBe('expired');

    const submitAfterExpiry = await exam.routes.handle(
      studentRequest(student, 'POST', `/exam/attempts/${attemptId}/submit`),
    );
    expect(submitAfterExpiry.status).toBe(200);
    expect((submitAfterExpiry.body as ExamDeliveryResponse).delivery.attempt.status).toBe(
      'expired',
    );

    const startAfterExpiry = await exam.routes.handle(
      studentRequest(student, 'POST', `/exam/assignments/${assignmentId}/start`),
    );
    expect(startAfterExpiry.status).toBe(200);
    expect((startAfterExpiry.body as ExamDeliveryResponse).delivery.attempt.status).toBe('expired');
    expect(auth.database.prepare('SELECT COUNT(*) AS count FROM exam_attempts').get()?.count).toBe(
      1,
    );
    expect(() =>
      auth.database
        .prepare('UPDATE exam_attempts SET attempt_seed = ? WHERE id = ?')
        .run('attempt-seed-mutation', attemptId),
    ).toThrow('submitted or expired attempts are immutable');
  });

  it('generates a fresh assignment while preserving expired exam history', async () => {
    const student = await registerStudent('fresh-exam@example.test');
    const seeded = await seedExam();
    const oldAssignmentId = await exam.service.assignExam({
      examVersionId: seeded.examVersionId,
      studentId: student.userId,
    });
    const started = await exam.routes.handle(
      studentRequest(student, 'POST', `/exam/assignments/${oldAssignmentId}/start`),
    );
    const oldAttemptId = (started.body as ExamDeliveryResponse).delivery.attempt.id;
    clock.advance(61);
    await exam.routes.handle(studentRequest(student, 'GET', `/exam/attempts/${oldAttemptId}`));

    const rejected = await exam.routes.handle({
      method: 'POST',
      path: '/exam/generate',
      headers: {
        origin,
        cookie: `eac_session=${student.sessionToken}; eac_csrf=${student.csrfToken}`,
      },
    });
    expect(rejected.status).toBe(403);
    expect(auth.database.prepare('SELECT COUNT(*) AS count FROM exams').get()?.count).toBe(1);

    const generated = await exam.routes.handle(studentRequest(student, 'POST', '/exam/generate'));
    expect(generated.status).toBe(201);
    expect((generated.body as ExamGenerationResponse).source).toBe('fallback');

    const assignments = await exam.routes.handle(
      studentRequest(student, 'GET', '/exam/assignments'),
    );
    const assignmentBody = assignments.body as ExamAssignmentListResponse;
    expect(assignmentBody.assignments).toHaveLength(2);
    expect(assignmentBody.assignments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: oldAssignmentId, attemptStatus: 'expired' }),
        expect.objectContaining({
          id: (generated.body as ExamGenerationResponse).assignmentId,
          attemptStatus: null,
        }),
      ]),
    );
    expect(
      auth.database.prepare('SELECT status FROM exam_attempts WHERE id = ?').get(oldAttemptId)
        ?.status,
    ).toBe('expired');
    expect(auth.database.prepare('SELECT COUNT(*) AS count FROM exams').get()?.count).toBe(2);
  });

  it('does not start an assignment before its persisted server assignment time', async () => {
    const student = await registerStudent('student@example.test');
    const seeded = await seedExam();
    const assignmentId = await exam.service.assignExam({
      examVersionId: seeded.examVersionId,
      studentId: student.userId,
    });
    auth.database
      .prepare('UPDATE exam_assignments SET assigned_at = ? WHERE id = ?')
      .run('2026-09-15T00:01:00.000Z', assignmentId);

    const response = await exam.routes.handle(
      studentRequest(student, 'POST', `/exam/assignments/${assignmentId}/start`),
    );
    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      code: 'conflict',
      message: 'The request conflicts with the current state.',
    });
    expect(auth.database.prepare('SELECT COUNT(*) AS count FROM exam_attempts').get()?.count).toBe(
      0,
    );
  });

  it('submits an active attempt idempotently and rejects unbounded accommodation', async () => {
    const student = await registerStudent('student@example.test');
    const seeded = await seedExam();
    await expect(
      exam.service.assignExam({
        examVersionId: seeded.examVersionId,
        studentId: student.userId,
        extraTimeSeconds: MAX_EXTRA_TIME_SECONDS + 1,
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });

    const assignmentId = await exam.service.assignExam({
      examVersionId: seeded.examVersionId,
      studentId: student.userId,
    });
    const start = await exam.routes.handle(
      studentRequest(student, 'POST', `/exam/assignments/${assignmentId}/start`),
    );
    const attemptId = (start.body as ExamDeliveryResponse).delivery.attempt.id;

    const submitted = await exam.routes.handle(
      studentRequest(student, 'POST', `/exam/attempts/${attemptId}/submit`),
    );
    expect(submitted.status).toBe(200);
    expect((submitted.body as ExamDeliveryResponse).delivery.attempt.status).toBe('submitted');
    expect(() =>
      auth.database
        .prepare('UPDATE exam_attempts SET attempt_seed = ? WHERE id = ?')
        .run('attempt-seed-mutation', attemptId),
    ).toThrow('submitted or expired attempts are immutable');

    const repeatSubmit = await exam.routes.handle(
      studentRequest(student, 'POST', `/exam/attempts/${attemptId}/submit`),
    );
    expect((repeatSubmit.body as ExamDeliveryResponse).delivery.attempt.status).toBe('submitted');

    const repeatStart = await exam.routes.handle(
      studentRequest(student, 'POST', `/exam/assignments/${assignmentId}/start`),
    );
    expect((repeatStart.body as ExamDeliveryResponse).delivery.attempt.status).toBe('submitted');
    expect(auth.database.prepare('SELECT COUNT(*) AS count FROM exam_attempts').get()?.count).toBe(
      1,
    );
  });

  it('keeps a setup attempt untimed and question-free until it begins', async () => {
    const student = await registerStudent('setup@example.test');
    const seeded = await seedExam();
    const assignmentId = await exam.service.assignExam({
      examVersionId: seeded.examVersionId,
      studentId: student.userId,
      extraTimeSeconds: 30,
    });
    const started = await exam.routes.handle(
      studentRequest(student, 'POST', `/exam/assignments/${assignmentId}/start`, { setup: true }),
    );
    const setup = (started.body as ExamDeliveryResponse).delivery;
    expect(setup.attempt.awaitingStart).toBe(true);
    expect(setup.questions).toEqual([]);
    expect(Date.parse(setup.attempt.effectiveDeadline) - clock.now().getTime()).toBeGreaterThan(
      60 * 60 * 1000,
    );
    await expect(
      exam.service.saveAnswers(setup.attempt.id, student.userId, {
        revision: 0,
        idempotencyKey: 'save-before-begin',
        answers: {},
      }),
    ).rejects.toThrow(/not begun/);

    // Time spent in setup does not count against the exam.
    clock.advance(600);
    const begun = await exam.routes.handle(
      studentRequest(student, 'POST', `/exam/attempts/${setup.attempt.id}/begin`),
    );
    expect(begun.status).toBe(200);
    const delivery = (begun.body as ExamDeliveryResponse).delivery;
    expect(delivery.attempt.awaitingStart).toBeUndefined();
    expect(delivery.attempt.startedAt).toBe(clock.now().toISOString());
    expect(delivery.attempt.effectiveDeadline).toBe('2026-09-15T00:11:30.000Z');
    expect(delivery.questions.length).toBeGreaterThan(0);

    // Beginning twice never restarts the clock.
    clock.advance(30);
    const again = await exam.service.beginAttempt(setup.attempt.id, student.userId);
    expect(again.attempt.effectiveDeadline).toBe(delivery.attempt.effectiveDeadline);
  });

  it('persists a validated answer snapshot and submits it idempotently', async () => {
    const student = await registerStudent('answers@example.test');
    const seeded = await seedExam();
    const assignmentId = await exam.service.assignExam({
      examVersionId: seeded.examVersionId,
      studentId: student.userId,
    });
    const start = await exam.service.startAttempt(assignmentId, student.userId);
    const answers: Record<string, string | number | boolean | null> = {};
    for (const question of start.delivery.questions) {
      switch (question.type) {
        case 'multiple_choice':
          answers[question.id] = question.options[0]?.id ?? null;
          break;
        case 'true_false':
          answers[question.id] = true;
          break;
        case 'identification':
          answers[question.id] = 'synthetic';
          break;
        case 'numeric':
          answers[question.id] = 42.5;
          break;
        case 'short_answer':
          answers[question.id] = 'bounded answer';
          break;
      }
    }

    const saveRequest = {
      revision: 0,
      idempotencyKey: 'save-answers-key-1',
      answers,
    } as const;
    const saved = await exam.service.saveAnswers(
      start.delivery.attempt.id,
      student.userId,
      saveRequest,
    );
    expect(saved).toMatchObject({ revision: 1, answers });
    expect(Object.keys(saved).sort()).toEqual(['answers', 'attemptId', 'revision', 'savedAt']);

    const replayed = await exam.service.saveAnswers(
      start.delivery.attempt.id,
      student.userId,
      saveRequest,
    );
    expect(replayed).toEqual(saved satisfies ExamAnswerSaveResponse);
    await expect(
      exam.service.saveAnswers(start.delivery.attempt.id, student.userId, {
        ...saveRequest,
        answers: { ...answers, [Object.keys(answers)[0] ?? 'missing']: null },
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
    await expect(
      exam.service.saveAnswers(start.delivery.attempt.id, student.userId, {
        revision: 0,
        idempotencyKey: 'save-answers-key-2',
        answers,
      }),
    ).rejects.toMatchObject({ code: 'conflict' });

    const resumed = await exam.service.getAttemptDelivery(
      start.delivery.attempt.id,
      student.userId,
    );
    expect(resumed.answers).toEqual({ revision: 1, savedAt: saved.savedAt, answers });

    const submitted = await exam.service.submitAttemptWithAnswers(
      start.delivery.attempt.id,
      student.userId,
      { expectedRevision: 1, idempotencyKey: 'submit-answers-key-1' },
    );
    expect(submitted.delivery.attempt.status).toBe('submitted');
    expect(submitted.receipt).toMatchObject({ status: 'submitted', revision: 1 });
    expect(submitted).toEqual(
      (await exam.service.submitAttemptWithAnswers(start.delivery.attempt.id, student.userId, {
        expectedRevision: 1,
        idempotencyKey: 'submit-answers-key-1',
      })) satisfies ExamSubmitResponse,
    );
    await expect(
      exam.service.saveAnswers(start.delivery.attempt.id, student.userId, {
        revision: 1,
        idempotencyKey: 'save-after-submit-1',
        answers,
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(() =>
      auth.database
        .prepare('DELETE FROM attempt_answers WHERE attempt_id = ?')
        .run(start.delivery.attempt.id),
    ).toThrow('submitted or expired answers are immutable');
  });

  it('rejects invalid answer shapes and cross-question values', async () => {
    const student = await registerStudent('invalid-answers@example.test');
    const seeded = await seedExam();
    const assignmentId = await exam.service.assignExam({
      examVersionId: seeded.examVersionId,
      studentId: student.userId,
    });
    const start = await exam.service.startAttempt(assignmentId, student.userId);
    const question = start.delivery.questions.find((item) => item.type === 'multiple_choice');
    if (question === undefined) {
      throw new Error('The fixture has no multiple-choice question.');
    }

    await expect(
      exam.service.saveAnswers(start.delivery.attempt.id, student.userId, {
        revision: 0,
        idempotencyKey: 'invalid-answers-key-1',
        answers: { [question.id]: 'not-an-option' },
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(
      exam.service.saveAnswers(start.delivery.attempt.id, student.userId, {
        revision: 0,
        idempotencyKey: 'invalid-answers-key-2',
        answers: {
          [question.id]: question.options[0]?.id ?? null,
          'unknown-question': null,
        },
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('prevents mutation of published versions and membership while allowing a new version', async () => {
    const seeded = await seedExam();
    const questionVersionId = auth.database
      .prepare(
        'SELECT question_version_id FROM exam_version_questions WHERE exam_version_id = ? LIMIT 1',
      )
      .get(seeded.examVersionId)?.question_version_id;

    expect(() =>
      auth.database
        .prepare('UPDATE exam_versions SET title = ? WHERE id = ?')
        .run('Mutated title', seeded.examVersionId),
    ).toThrow('published exam versions are immutable');
    expect(() =>
      auth.database
        .prepare('DELETE FROM exam_version_questions WHERE exam_version_id = ?')
        .run(seeded.examVersionId),
    ).toThrow('published exam question membership is immutable');
    expect(questionVersionId).toBeDefined();
    if (typeof questionVersionId !== 'string') {
      throw new Error('Expected a question version fixture row.');
    }
    expect(() =>
      auth.database
        .prepare('UPDATE question_versions SET prompt = ? WHERE id = ?')
        .run('Mutated prompt', questionVersionId),
    ).toThrow('question versions in published exams are immutable');

    const nextVersion = await seedExamVersion(seeded);
    expect(nextVersion.versionNumber).toBe(2);
    expect(nextVersion.examId).toBe(seeded.examId);
    expect(
      auth.database
        .prepare('SELECT title FROM exam_versions WHERE id = ?')
        .get(seeded.examVersionId)?.title,
    ).toBe('Synthetic delivery exam');
  });

  it('requires CSRF and attempt ownership for phone enrollment and status', async () => {
    const owner = await registerStudent('owner@example.test');
    const other = await registerStudent('other@example.test');
    const seeded = await seedExam();
    const assignmentId = await exam.service.assignExam({
      examVersionId: seeded.examVersionId,
      studentId: owner.userId,
    });
    const started = await exam.routes.handle(
      studentRequest(owner, 'POST', `/exam/assignments/${assignmentId}/start`),
    );
    const attemptId = (started.body as ExamDeliveryResponse).delivery.attempt.id;
    const integrity = {
      enrollPhone: vi.fn(() => ({ token: 'synthetic' })),
      checkPhoneStatus: vi.fn(() => ({ active: true })),
    };
    const routes = new ExamRoutes(
      exam.service,
      auth.boundary,
      config,
      integrity as unknown as IntegrityService,
    );
    const enroll = studentRequest(owner, 'POST', `/exam/attempts/${attemptId}/enroll-phone`);
    const missingCsrf = { ...enroll, headers: { ...enroll.headers, 'x-csrf-token': undefined } };
    expect((await routes.handle(missingCsrf)).status).toBe(403);
    expect((await routes.handle(studentRequest(other, 'POST', enroll.path))).status).toBe(404);
    expect(
      (
        await routes.handle(
          studentRequest(other, 'GET', `/exam/attempts/${attemptId}/phone-status`),
        )
      ).status,
    ).toBe(404);
    expect(integrity.enrollPhone).not.toHaveBeenCalled();
    expect(integrity.checkPhoneStatus).not.toHaveBeenCalled();
    expect((await routes.handle(enroll)).status).toBe(201);
    expect(
      (
        await routes.handle(
          studentRequest(owner, 'GET', `/exam/attempts/${attemptId}/phone-status`),
        )
      ).body,
    ).toEqual({ active: true });
  });

  it('requires a session, CSRF and attempt ownership to record desktop events', async () => {
    const owner = await registerStudent('events@example.test');
    const other = await registerStudent('other@example.test');
    const seeded = await seedExam();
    const assignmentId = await exam.service.assignExam({
      examVersionId: seeded.examVersionId,
      studentId: owner.userId,
    });
    const started = await exam.routes.handle(
      studentRequest(owner, 'POST', `/exam/assignments/${assignmentId}/start`),
    );
    const attemptId = (started.body as ExamDeliveryResponse).delivery.attempt.id;
    const integrity = { recordAppEvent: vi.fn() };
    const routes = new ExamRoutes(
      exam.service,
      auth.boundary,
      config,
      integrity as unknown as IntegrityService,
    );
    const request = studentRequest(owner, 'PATCH', `/exam/attempts/${attemptId}/events`, {
      foregroundApp: 'Discord',
      displayCount: 2,
    });
    expect(
      (
        await routes.handle({
          method: 'PATCH',
          path: request.path,
          headers: {},
          body: request.body,
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await routes.handle({
          ...request,
          headers: { ...request.headers, 'x-csrf-token': undefined },
        })
      ).status,
    ).toBe(403);
    expect(
      (await routes.handle(studentRequest(other, 'PATCH', request.path, request.body))).status,
    ).toBe(404);
    expect(integrity.recordAppEvent).not.toHaveBeenCalled();
    expect((await routes.handle(request)).status).toBe(200);
    expect(integrity.recordAppEvent).toHaveBeenCalledWith(attemptId, 'Discord', 2);
  });

  it('records events for a setup attempt that has not begun yet', async () => {
    const student = await registerStudent('setup-events@example.test');
    const seeded = await seedExam();
    const assignmentId = await exam.service.assignExam({
      examVersionId: seeded.examVersionId,
      studentId: student.userId,
    });
    const started = await exam.routes.handle(
      studentRequest(student, 'POST', `/exam/assignments/${assignmentId}/start`, { setup: true }),
    );
    const setup = (started.body as ExamDeliveryResponse).delivery;
    expect(setup.attempt.awaitingStart).toBe(true);
    const integrity = { recordAppEvent: vi.fn() };
    const routes = new ExamRoutes(
      exam.service,
      auth.boundary,
      config,
      integrity as unknown as IntegrityService,
    );
    for (const event of ['liveness_unverified', 'recording_started', 'iphone_paired']) {
      const response = await routes.handle(
        studentRequest(student, 'PATCH', `/exam/attempts/${setup.attempt.id}/events`, { event }),
      );
      expect(response.status).toBe(200);
      expect(integrity.recordAppEvent).toHaveBeenLastCalledWith(
        setup.attempt.id,
        `flag:${event}`,
        1,
      );
    }
    // Recording events during setup never begin the exam.
    const after = await exam.service.getAttemptDelivery(setup.attempt.id, student.userId);
    expect(after.attempt.awaitingStart).toBe(true);
  });

  it('runs instructor-only AI checks across every saved answer to a question', async () => {
    const seeded = await seedExam();
    const instructor = await registerStudent('ai-teacher@example.test');
    auth.database
      .prepare(`UPDATE users SET role = 'instructor' WHERE id = ?`)
      .run(instructor.userId);
    let shortAnswer = { id: '', prompt: '' };
    let studentAttempt = '';
    let student!: StudentSession;
    for (const [index, text] of [
      'In conclusion, it is important to note…',
      'i think tcp acks',
    ].entries()) {
      student = await registerStudent(`ai-student${index}@example.test`);
      const assignmentId = await exam.service.assignExam({
        examVersionId: seeded.examVersionId,
        studentId: student.userId,
      });
      const start = await exam.service.startAttempt(assignmentId, student.userId);
      studentAttempt = start.delivery.attempt.id;
      shortAnswer = start.delivery.questions.find((q) => q.type === 'short_answer')!;
      await exam.service.saveAnswers(start.delivery.attempt.id, student.userId, {
        revision: 0,
        idempotencyKey: `ai-check-save-${index}-key`,
        answers: Object.fromEntries(
          start.delivery.questions.map((q) => [q.id, q.id === shortAnswer.id ? text : null]),
        ),
      });
    }
    const gemini = {
      generateContent: vi.fn(async (prompt: string) =>
        JSON.stringify({
          score: prompt.includes('STUDENT ANSWER: In conclusion') ? 0.9 : 0.1,
          flags: prompt.includes('STUDENT ANSWER: In conclusion')
            ? [{ phrase: 'In conclusion', reason: 'templated' }]
            : [],
          summary: 'assessed',
        }),
      ),
    };
    const integrity = new IntegrityService(
      new IntegrityRepository(auth.database),
      gemini as unknown as GeminiRotatingClient,
    );
    const routes = new ExamRoutes(exam.service, auth.boundary, config, integrity);
    const path = `/exam/instructor/versions/${seeded.examVersionId}/questions/${shortAnswer.id}/ai-check`;

    expect((await routes.handle(studentRequest(student, 'POST', path))).status).toBe(403);
    expect(
      (
        await routes.handle(
          studentRequest(student, 'POST', `/exam/attempts/${studentAttempt}/ai-check`),
        )
      ).status,
    ).toBe(404);
    const run = await routes.handle(studentRequest(instructor, 'POST', path));
    expect(run.status).toBe(200);
    expect(run.body).toMatchObject({
      truncated: false,
      results: [
        { email: 'ai-student0@example.test', score: 0.9, available: true },
        { email: 'ai-student1@example.test', score: 0.1, available: true },
      ],
    });
    expect(gemini.generateContent).toHaveBeenCalledTimes(2);
    expect(gemini.generateContent.mock.calls[0]?.[0]).toContain(shortAnswer.prompt);
  });

  it('scopes liveness verification, revisions and recordings to the attempt owner', async () => {
    const owner = await registerStudent('scoped@example.test');
    const other = await registerStudent('other@example.test');
    const seeded = await seedExam();
    const assignmentId = await exam.service.assignExam({
      examVersionId: seeded.examVersionId,
      studentId: owner.userId,
    });
    const started = await exam.routes.handle(
      studentRequest(owner, 'POST', `/exam/assignments/${assignmentId}/start`),
    );
    const attemptId = (started.body as ExamDeliveryResponse).delivery.attempt.id;
    const integrity = { verifyLiveness: vi.fn(), getRevisions: vi.fn(() => []) };
    const routes = new ExamRoutes(
      exam.service,
      auth.boundary,
      config,
      integrity as unknown as IntegrityService,
    );
    const base = `/exam/attempts/${attemptId}`;
    expect(
      (
        await routes.handle(
          studentRequest(other, 'POST', `${base}/liveness-verify`, { nonce: 'n', layer: 2 }),
        )
      ).status,
    ).toBe(404);
    expect(
      (await routes.handle(studentRequest(other, 'GET', `${base}/revisions?questionId=q`))).status,
    ).toBe(404);
    expect(
      (
        await routes.handle(
          studentRequest(other, 'POST', `${base}/recording`, { index: 0, chunk: '' }),
        )
      ).status,
    ).toBe(404);
    expect(integrity.verifyLiveness).not.toHaveBeenCalled();
    expect(integrity.getRevisions).not.toHaveBeenCalled();
    expect(
      (await routes.handle(studentRequest(owner, 'GET', `${base}/revisions?questionId=q`))).status,
    ).toBe(200);
  });

  it('validates recording segments and answers 202, or 503 when Graph is not configured', async () => {
    const student = await registerStudent('rec@example.test');
    const seeded = await seedExam();
    const assignmentId = await exam.service.assignExam({
      examVersionId: seeded.examVersionId,
      studentId: student.userId,
    });
    const started = await exam.routes.handle(
      studentRequest(student, 'POST', `/exam/assignments/${assignmentId}/start`),
    );
    const attemptId = (started.body as ExamDeliveryResponse).delivery.attempt.id;
    const path = `/exam/attempts/${attemptId}/recording`;
    const send = (body: unknown) => exam.routes.handle(studentRequest(student, 'POST', path, body));

    for (const bad of [
      { index: -1, chunk: 'AAAA' },
      { index: 1.5, chunk: 'AAAA' },
      { index: '1', chunk: 'AAAA' },
      { index: 0, chunk: '' },
      { index: 0, chunk: '***' },
      { index: 0, chunk: 'A'.repeat(4_000_004) },
    ]) {
      expect((await send(bad)).status).toBe(400);
    }
    expect(uploadRecordingChunk).not.toHaveBeenCalled();

    // Graph not configured: clear 503 so the client falls back to local-only.
    expect((await send({ index: 0, chunk: 'AAAA' })).status).toBe(400); // not WebM
    expect((await send({ index: 720, chunk: WEBM })).status).toBe(400);
    const unconfigured = await send({ index: 0, chunk: WEBM });
    expect(unconfigured.status).toBe(503);
    expect(uploadRecordingChunk).not.toHaveBeenCalled();

    const configured = {
      ...config,
      msTenantId: 't',
      msClientId: 'c',
      msClientSecret: 's',
      msTargetEmail: 'a@b.test',
    };
    const routes = new ExamRoutes(exam.service, auth.boundary, configured);
    const accepted = await routes.handle(
      studentRequest(student, 'POST', path, { index: 3, chunk: WEBM }),
    );
    expect(accepted.status).toBe(202);
    expect(uploadRecordingChunk).toHaveBeenCalledWith(
      configured,
      student.userId,
      attemptId,
      3,
      Buffer.from(WEBM, 'base64'),
    );
  });

  describe('recording abuse controls', () => {
    async function setup(email: string) {
      const student = await registerStudent(email);
      const seeded = await seedExam();
      const assignmentId = await exam.service.assignExam({
        examVersionId: seeded.examVersionId,
        studentId: student.userId,
      });
      const started = await exam.routes.handle(
        studentRequest(student, 'POST', `/exam/assignments/${assignmentId}/start`),
      );
      const attemptId = (started.body as ExamDeliveryResponse).delivery.attempt.id;
      const configured = {
        ...config,
        msTenantId: 't',
        msClientId: 'c',
        msClientSecret: 's',
        msTargetEmail: 'a@b.test',
      };
      const routes = new ExamRoutes(exam.service, auth.boundary, configured);
      const send = (index: number) =>
        routes.handle(
          studentRequest(student, 'POST', `/exam/attempts/${attemptId}/recording`, {
            index,
            chunk: WEBM,
          }),
        );
      return { student, attemptId, routes, send };
    }

    it('refuses to overwrite an accepted segment index', async () => {
      const { send } = await setup('dup@example.test');
      expect((await send(1)).status).toBe(202);
      expect((await send(1)).status).toBe(409);
      expect(uploadRecordingChunk).toHaveBeenCalledTimes(1);
    });

    it('frees the index after a failed upload and hides Graph details', async () => {
      const { send } = await setup('fail@example.test');
      vi.mocked(uploadRecordingChunk).mockRejectedValueOnce(new Error('secret graph body'));
      const failed = await send(2);
      expect(failed.status).toBe(500);
      expect(JSON.stringify(failed.body)).not.toContain('secret graph body');
      expect((await send(2)).status).toBe(202);
    });

    it('maps a Graph conflict to 409', async () => {
      const { send } = await setup('graphdup@example.test');
      vi.mocked(uploadRecordingChunk).mockRejectedValueOnce(new RecordingConflictError());
      expect((await send(4)).status).toBe(409);
    });

    it('rate limits segments per student', async () => {
      const { send } = await setup('rate@example.test');
      const statuses: number[] = [];
      for (let i = 0; i < 7; i += 1) statuses.push((await send(i)).status);
      expect(statuses.slice(0, 5)).toEqual([202, 202, 202, 202, 202]);
      expect(statuses.slice(5)).toEqual([429, 429]);
    });

    it('rejects uploads once the attempt is no longer in progress', async () => {
      const { student, attemptId, routes, send } = await setup('state@example.test');
      expect((await send(0)).status).toBe(202);
      const submitted = await routes.handle(
        studentRequest(student, 'POST', `/exam/attempts/${attemptId}/submit`),
      );
      expect(submitted.status).toBe(200);
      expect((await send(1)).status).toBe(403);
      expect(uploadRecordingChunk).toHaveBeenCalledTimes(1);
    });

    it('enforces the per-attempt segment and byte quotas', async () => {
      const { send } = await setup('quota@example.test');
      expect((await send(719)).status).toBe(202);
      expect((await send(720)).status).toBe(400);
      expect((await send(-1)).status).toBe(400);
    });
  });

  it('passes the preferred liveness challenge and spoken audio through to the integrity service', async () => {
    const owner = await registerStudent('liveness-prefs@example.test');
    const seeded = await seedExam();
    const assignmentId = await exam.service.assignExam({
      examVersionId: seeded.examVersionId,
      studentId: owner.userId,
    });
    const started = await exam.routes.handle(
      studentRequest(owner, 'POST', `/exam/assignments/${assignmentId}/start`),
    );
    const attemptId = (started.body as ExamDeliveryResponse).delivery.attempt.id;
    const integrity = {
      issueLivenessChallenge: vi.fn(() => ({ nonce: 'n', type: 'spoken_words' })),
      verifyLiveness: vi.fn(async () => ({ passed: true, layer: 3, detail: 'ok' })),
    };
    const routes = new ExamRoutes(
      exam.service,
      auth.boundary,
      config,
      integrity as unknown as IntegrityService,
    );
    const base = `/exam/attempts/${attemptId}`;
    await routes.handle(
      studentRequest(owner, 'POST', `${base}/liveness-challenge`, { preferred: 'spoken_words' }),
    );
    expect(integrity.issueLivenessChallenge).toHaveBeenLastCalledWith(
      attemptId,
      'spoken_words',
      undefined,
    );
    await routes.handle(
      studentRequest(owner, 'POST', `${base}/liveness-challenge`, { purpose: 'spot_check' }),
    );
    expect(integrity.issueLivenessChallenge).toHaveBeenLastCalledWith(
      attemptId,
      undefined,
      'spot_check',
    );
    await routes.handle(studentRequest(owner, 'POST', `${base}/liveness-challenge`));
    expect(integrity.issueLivenessChallenge).toHaveBeenLastCalledWith(
      attemptId,
      undefined,
      undefined,
    );
    await routes.handle(
      studentRequest(owner, 'POST', `${base}/liveness-verify`, {
        nonce: 'n',
        layer: 3,
        signature: 's',
        payload: { samples: [] },
        audioBase64: 'QUJD',
        camera: { label: 'FaceTime HD Camera' },
      }),
    );
    expect(integrity.verifyLiveness).toHaveBeenCalledWith(
      attemptId,
      'n',
      3,
      { samples: [] },
      's',
      'FaceTime HD Camera',
      'QUJD',
    );
  });

  it('answers 429 when liveness challenges are requested too often', async () => {
    const owner = await registerStudent('liveness-limit@example.test');
    const seeded = await seedExam();
    const assignmentId = await exam.service.assignExam({
      examVersionId: seeded.examVersionId,
      studentId: owner.userId,
    });
    const started = await exam.routes.handle(
      studentRequest(owner, 'POST', `/exam/assignments/${assignmentId}/start`),
    );
    const attemptId = (started.body as ExamDeliveryResponse).delivery.attempt.id;
    const integrity = {
      issueLivenessChallenge: vi.fn(() => {
        throw new LivenessRateLimitError();
      }),
    };
    const routes = new ExamRoutes(
      exam.service,
      auth.boundary,
      config,
      integrity as unknown as IntegrityService,
    );
    const response = await routes.handle(
      studentRequest(owner, 'POST', `/exam/attempts/${attemptId}/liveness-challenge`),
    );
    expect(response.status).toBe(429);
  });

  it('reports vision availability to students and rate-limits and maps vision checks', async () => {
    const owner = await registerStudent('vision-limit@example.test');
    const seeded = await seedExam();
    const assignmentId = await exam.service.assignExam({
      examVersionId: seeded.examVersionId,
      studentId: owner.userId,
    });
    const started = await exam.routes.handle(
      studentRequest(owner, 'POST', `/exam/assignments/${assignmentId}/start`),
    );
    const attemptId = (started.body as ExamDeliveryResponse).delivery.attempt.id;
    const recordAppEvent = vi.fn();
    const detector = vi.fn(async () => ({
      status: 'ok' as const,
      detections: [
        { label: 'smart watch', score: 0.5 },
        { label: 'person', score: 0.9 },
        { label: 'unexpected thing', score: 0.9 },
      ],
    }));
    const routes = new ExamRoutes(
      exam.service,
      auth.boundary,
      config,
      { recordAppEvent } as unknown as IntegrityService,
      null,
      detector,
    );
    const disabled = new ExamRoutes(exam.service, auth.boundary, config);
    const status = (target: ExamRoutes) =>
      target.handle(studentRequest(owner, 'GET', '/exam/vision-status'));
    expect((await status(routes)).body).toEqual({ enabled: true });
    expect((await status(disabled)).body).toEqual({ enabled: false });
    const anonymous = await routes.handle({
      method: 'GET',
      path: '/exam/vision-status',
      headers: { origin },
    });
    expect(anonymous.status).toBeGreaterThanOrEqual(401);

    const path = `/exam/attempts/${attemptId}/vision-check`;
    const send = () => routes.handle(studentRequest(owner, 'POST', path, { imageBase64: 'QUJD' }));
    vi.useFakeTimers();
    try {
      const t0 = Date.now();
      vi.setSystemTime(t0);
      const first = await send();
      expect(first.status).toBe(200);
      expect(first.body).toEqual({
        status: 'ok',
        detections: [{ label: 'smart watch', score: 0.5 }],
      });
      expect(recordAppEvent).toHaveBeenCalledTimes(1);
      expect(recordAppEvent).toHaveBeenCalledWith(attemptId, 'flag:vision_smart_watch', 1);
      expect((await send()).status).toBe(200);
      const limited = await send();
      expect(limited.status).toBe(429);
      expect(detector).toHaveBeenCalledTimes(2);
      vi.setSystemTime(t0 + 10_000);
      expect((await send()).status).toBe(200);
      expect(detector).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
    const tooLarge = new ExamRoutes(exam.service, auth.boundary, config, null, null, detector);
    const oversized = await tooLarge.handle(
      studentRequest(owner, 'POST', path, { imageBase64: 'A'.repeat(1_000_001) }),
    );
    expect(oversized.status).toBe(400);
  });

  it('answers CORS preflight for every browser-called exam route', async () => {
    const paths = [
      '/exam/speedtest',
      ...['recording', 'vision-check', 'telemetry', 'transparency', 'events'].map(
        (route) => `/exam/attempts/attempt-1/${route}`,
      ),
    ];
    for (const path of paths) {
      const preflight = await exam.routes.handle({
        method: 'OPTIONS',
        path,
        headers: {
          origin,
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type, x-csrf-token',
        },
      });
      expect({ path, status: preflight.status }).toEqual({ path, status: 204 });
    }
  });

  it('stores validated telemetry batches for the attempt owner', async () => {
    const owner = await registerStudent('telemetry@example.test');
    const other = await registerStudent('other@example.test');
    const seeded = await seedExam();
    const assignmentId = await exam.service.assignExam({
      examVersionId: seeded.examVersionId,
      studentId: owner.userId,
    });
    const started = await exam.routes.handle(
      studentRequest(owner, 'POST', `/exam/assignments/${assignmentId}/start`),
    );
    const attemptId = (started.body as ExamDeliveryResponse).delivery.attempt.id;
    const integrity = new IntegrityService(
      new IntegrityRepository(auth.database),
      {} as GeminiRotatingClient,
    );
    const routes = new ExamRoutes(exam.service, auth.boundary, config, integrity);
    const path = `/exam/attempts/${attemptId}/telemetry`;
    const body = {
      keystrokes: [
        { questionId: 'q1', dwellMs: 80, flightMs: 120 },
        { dwellMs: -5, flightMs: 'x' },
      ],
      gaze: [
        { timestamp: '2026-09-15T00:00:01.000Z', durationMs: 4200 },
        { timestamp: 'never', durationMs: 10 },
      ],
      voice: [{ timestamp: Date.parse('2026-09-15T00:00:02.000Z'), durationMs: 900, peakDb: -20 }],
      input: [
        { windowStart: Date.parse('2026-09-15T00:00:00.000Z'), windowMs: 20_000, pointerEvents: 5 },
        { windowStart: 'never', windowMs: 20_000 },
      ],
    };

    expect((await routes.handle(studentRequest(other, 'POST', path, body))).status).toBe(404);
    const stored = await routes.handle(studentRequest(owner, 'POST', path, body));
    expect(stored.status).toBe(202);
    expect(stored.body).toEqual({ accepted: { keystrokes: 1, gaze: 1, voice: 1, input: 1 } });
    const count = (table: string) =>
      (
        auth.database
          .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE attempt_id = ?`)
          .get(attemptId) as { n: number }
      ).n;
    expect([
      count('keystroke_events'),
      count('gaze_events'),
      count('voice_events'),
      count('input_behaviour_windows'),
    ]).toEqual([1, 1, 1, 1]);
  });

  it('shows the attempt owner a transparency report of recorded events', async () => {
    const owner = await registerStudent('transparency@example.test');
    const other = await registerStudent('other@example.test');
    const seeded = await seedExam();
    const assignmentId = await exam.service.assignExam({
      examVersionId: seeded.examVersionId,
      studentId: owner.userId,
    });
    const started = await exam.routes.handle(
      studentRequest(owner, 'POST', `/exam/assignments/${assignmentId}/start`),
    );
    const attemptId = (started.body as ExamDeliveryResponse).delivery.attempt.id;
    const integrity = new IntegrityService(
      new IntegrityRepository(auth.database),
      {} as GeminiRotatingClient,
    );
    const routes = new ExamRoutes(exam.service, auth.boundary, config, integrity);
    const base = `/exam/attempts/${attemptId}`;
    await routes.handle(
      studentRequest(owner, 'PATCH', `${base}/events`, { event: 'keystroke_violation' }),
    );
    await routes.handle(
      studentRequest(owner, 'PATCH', `${base}/events`, { foregroundApp: 'Exam', displayCount: 2 }),
    );

    expect((await routes.handle(studentRequest(other, 'GET', `${base}/transparency`))).status).toBe(
      404,
    );
    const report = await routes.handle(studentRequest(owner, 'GET', `${base}/transparency`));
    expect(report.status).toBe(200);
    expect(
      (report.body as { events: Array<{ type: string; description: string }> }).events,
    ).toEqual([
      expect.objectContaining({
        type: 'SOFTWARE',
        description: 'Flagged behaviour: keystroke violation',
      }),
      expect.objectContaining({ type: 'HARDWARE', description: 'Multiple displays detected (2)' }),
    ]);
  });

  it('serves a unified, sorted integrity log to the owner and instructors only, with CSV and JSON downloads', async () => {
    const owner = await registerStudent('timeline-owner@example.test');
    const other = await registerStudent('timeline-other@example.test');
    const instructor = await registerStudent('timeline-teacher@example.test');
    auth.database
      .prepare(`UPDATE users SET role = 'instructor' WHERE id = ?`)
      .run(instructor.userId);
    const seeded = await seedExam();
    const assignmentId = await exam.service.assignExam({
      examVersionId: seeded.examVersionId,
      studentId: owner.userId,
    });
    const started = await exam.routes.handle(
      studentRequest(owner, 'POST', `/exam/assignments/${assignmentId}/start`),
    );
    const attemptId = (started.body as ExamDeliveryResponse).delivery.attempt.id;
    const integrity = new IntegrityService(
      new IntegrityRepository(auth.database),
      {} as GeminiRotatingClient,
    );
    const routes = new ExamRoutes(exam.service, auth.boundary, config, integrity);
    const base = `/exam/attempts/${attemptId}`;
    await routes.handle(
      studentRequest(owner, 'POST', `${base}/telemetry`, {
        gaze: [
          { timestamp: '2026-09-15T00:00:30.000Z', durationMs: 6000, direction: 'left', yaw: -34 },
          { timestamp: '2026-09-15T00:00:10.000Z', durationMs: 4000, direction: 'no_face' },
          { timestamp: '2026-09-15T00:00:40.000Z', durationMs: 3000, direction: 'sideways' },
        ],
      }),
    );
    await routes.handle(studentRequest(owner, 'PATCH', `${base}/events`, { event: 'focus_lost' }));
    integrity.recordTranscript(
      String(attemptId),
      '=HYPERLINK("x"), "quoted"',
      new Date('2026-09-15T00:00:20.000Z'),
    );

    expect((await routes.handle(studentRequest(other, 'GET', `${base}/timeline`))).status).toBe(
      404,
    );
    expect(
      (await routes.handle({ method: 'GET', path: `${base}/timeline`, headers: { origin } }))
        .status,
    ).toBe(401);

    const asOwner = await routes.handle(studentRequest(owner, 'GET', `${base}/timeline`));
    expect(asOwner.status).toBe(200);
    const entries = (
      asOwner.body as { entries: Array<{ at: string; source: string; kind: string }> }
    ).entries;
    const times = entries.map((e) => Date.parse(e.at));
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(entries.map((e) => e.kind)).toEqual(
      expect.arrayContaining([
        'attempt_started',
        'face_missing',
        'transcript',
        'gaze_left',
        'gaze_away',
        'focus_lost',
      ]),
    );
    expect(asOwner.headers['content-disposition']).toBeUndefined();

    const asInstructor = await routes.handle(studentRequest(instructor, 'GET', `${base}/timeline`));
    expect(asInstructor.status).toBe(200);
    expect((asInstructor.body as { entries: unknown[] }).entries).toHaveLength(entries.length);

    const filtered = await routes.handle(
      studentRequest(instructor, 'GET', `${base}/timeline?source=gaze,transcript`),
    );
    expect(
      new Set(
        (filtered.body as { entries: Array<{ source: string }> }).entries.map((e) => e.source),
      ),
    ).toEqual(new Set(['gaze', 'transcript']));
    expect(
      (await routes.handle(studentRequest(instructor, 'GET', `${base}/timeline?source=bogus`)))
        .status,
    ).toBe(400);
    expect(
      (await routes.handle(studentRequest(instructor, 'GET', `${base}/timeline?format=xml`)))
        .status,
    ).toBe(400);
    expect(
      (await routes.handle(studentRequest(instructor, 'GET', '/exam/attempts/missing/timeline')))
        .status,
    ).toBe(404);

    const csv = await routes.handle(studentRequest(owner, 'GET', `${base}/timeline?format=csv`));
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(String(csv.headers['content-disposition'])).toMatch(
      /^attachment; filename="[^"]+\.csv"$/u,
    );
    const text = csv.body as string;
    expect(text.split('\r\n')[0]).toBe('at,source,kind,severity,summary,data');
    // Embedded quotes are doubled and the cell is quoted.
    expect(text).toContain('"Heard: ""=HYPERLINK(""x""), ""quoted"""""');
    const json = await routes.handle(studentRequest(owner, 'GET', `${base}/timeline?format=json`));
    expect(String(json.headers['content-disposition'])).toMatch(/\.json"$/u);

    const list = await routes.handle(
      studentRequest(instructor, 'GET', '/exam/instructor/attempts'),
    );
    expect((list.body as { attempts: Array<{ id: string }> }).attempts.map((a) => a.id)).toEqual([
      attemptId,
    ]);
    expect(
      (await routes.handle(studentRequest(owner, 'GET', '/exam/instructor/attempts'))).status,
    ).toBe(403);
  });

  it('saves non-empty transcripts as structured events and returns them in order to the owner only', async () => {
    const owner = await registerStudent('transcript@example.test');
    const other = await registerStudent('other@example.test');
    const seeded = await seedExam();
    const assignmentId = await exam.service.assignExam({
      examVersionId: seeded.examVersionId,
      studentId: owner.userId,
    });
    const started = await exam.routes.handle(
      studentRequest(owner, 'POST', `/exam/assignments/${assignmentId}/start`),
    );
    const attemptId = (started.body as ExamDeliveryResponse).delivery.attempt.id;
    const integrity = new IntegrityService(
      new IntegrityRepository(auth.database),
      {} as GeminiRotatingClient,
    );
    const routes = new ExamRoutes(exam.service, auth.boundary, config, integrity);
    const base = `/exam/attempts/${attemptId}`;
    const post = async (transcript: string, capturedAt: string) => {
      vi.mocked(transcribeAudio).mockResolvedValueOnce(transcript);
      return routes.handle(
        studentRequest(owner, 'POST', `${base}/audio`, {
          audio: Buffer.from('synthetic audio').toString('base64'),
          durationMs: 3000,
          capturedAt,
        }),
      );
    };
    const now = Date.now();
    const iso = (offset: number) => new Date(now + offset).toISOString();
    expect((await post('second line', iso(-1000))).status).toBe(201);
    expect((await post('   ', iso(-500))).status).toBe(201);
    expect((await post('first line', iso(-5000))).status).toBe(201);

    expect((await routes.handle(studentRequest(other, 'GET', `${base}/transcript`))).status).toBe(
      404,
    );
    const response = await routes.handle(studentRequest(owner, 'GET', `${base}/transcript`));
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      entries: [
        { capturedAt: iso(-5000), text: 'first line' },
        { capturedAt: iso(-1000), text: 'second line' },
      ],
    });
    const stored = auth.database
      .prepare(`SELECT count(*) AS n FROM audio_transcripts WHERE attempt_id = ?`)
      .get(attemptId) as { n: number };
    expect(stored.n).toBe(2);
    // The transparency report no longer carries a duplicate app-event copy.
    const report = await routes.handle(studentRequest(owner, 'GET', `${base}/transparency`));
    expect((report.body as { events: unknown[] }).events).toEqual([]);
  });

  it('keeps integrity monitoring available without Gemini keys', async () => {
    const owner = await registerStudent('nokeys@example.test');
    const seeded = await seedExam();
    const assignmentId = await exam.service.assignExam({
      examVersionId: seeded.examVersionId,
      studentId: owner.userId,
    });
    const started = await exam.routes.handle(
      studentRequest(owner, 'POST', `/exam/assignments/${assignmentId}/start`),
    );
    const attemptId = (started.body as ExamDeliveryResponse).delivery.attempt.id;
    expect(config.geminiKeys).toHaveLength(0);
    const telemetry = await exam.routes.handle(
      studentRequest(owner, 'POST', `/exam/attempts/${attemptId}/telemetry`, { keystrokes: [] }),
    );
    expect(telemetry.status).toBe(202);
    expect(
      (
        await exam.routes.handle(
          studentRequest(owner, 'GET', `/exam/attempts/${attemptId}/transparency`),
        )
      ).status,
    ).toBe(200);
  });

  it('lets instructors run cross-student similarity on saved answers', async () => {
    const seeded = await seedExam();
    const instructor = await registerStudent('teacher@example.test');
    auth.database
      .prepare(`UPDATE users SET role = 'instructor' WHERE id = ?`)
      .run(instructor.userId);
    const texts = ['the same copied answer', 'the same copied answer!', 'an original thought'];
    let shortAnswerId = '';
    for (const [index, text] of texts.entries()) {
      const student = await registerStudent(`student${index}@example.test`);
      const assignmentId = await exam.service.assignExam({
        examVersionId: seeded.examVersionId,
        studentId: student.userId,
      });
      const start = await exam.service.startAttempt(assignmentId, student.userId);
      shortAnswerId = start.delivery.questions.find(
        (question) => question.type === 'short_answer',
      )!.id;
      await exam.service.saveAnswers(start.delivery.attempt.id, student.userId, {
        revision: 0,
        idempotencyKey: `similarity-save-${index}-key`,
        answers: Object.fromEntries(
          start.delivery.questions.map((q) => [q.id, q.id === shortAnswerId ? text : null]),
        ),
      });
    }
    const gemini = {
      embedText: vi.fn(async (text: string) => (text.includes('same') ? [1, 0] : [0, 1])),
    };
    const integrity = new IntegrityService(
      new IntegrityRepository(auth.database),
      gemini as unknown as GeminiRotatingClient,
    );
    const routes = new ExamRoutes(exam.service, auth.boundary, config, integrity);

    const listed = await routes.handle(
      studentRequest(instructor, 'GET', '/exam/instructor/versions'),
    );
    expect(listed.status).toBe(200);
    expect(
      (listed.body as { versions: Array<{ id: string; questions: Array<{ id: string }> }> })
        .versions[0],
    ).toMatchObject({
      id: seeded.examVersionId,
      questions: expect.arrayContaining([expect.objectContaining({ id: shortAnswerId })]),
    });

    const capabilities = await routes.handle(
      studentRequest(instructor, 'GET', '/exam/instructor/capabilities'),
    );
    expect(capabilities).toMatchObject({ status: 200, body: { gemini: true } });
    const withoutGemini = new ExamRoutes(
      exam.service,
      auth.boundary,
      config,
      new IntegrityService(new IntegrityRepository(auth.database), null),
    );
    expect(
      (
        await withoutGemini.handle(
          studentRequest(instructor, 'GET', '/exam/instructor/capabilities'),
        )
      ).body,
    ).toEqual({ gemini: false });

    const path = `/exam/instructor/versions/${seeded.examVersionId}/questions/${shortAnswerId}/similarity`;
    const student = await registerStudent('curious@example.test');
    expect((await routes.handle(studentRequest(student, 'POST', path))).status).toBe(403);
    expect(
      (await routes.handle(studentRequest(student, 'GET', '/exam/instructor/capabilities'))).status,
    ).toBe(403);
    const run = await routes.handle(studentRequest(instructor, 'POST', path));
    expect(run.status).toBe(200);
    const body = run.body as {
      report: { pairs: Array<{ flagged: boolean; studentAId: string; studentBId: string }> };
      students: Record<string, string>;
    };
    const flagged = body.report.pairs.filter((pair) => pair.flagged);
    expect(flagged).toHaveLength(1);
    expect(
      [body.students[flagged[0]!.studentAId], body.students[flagged[0]!.studentBId]].sort(),
    ).toEqual(['student0@example.test', 'student1@example.test']);
  });

  it('runs opt-in backend vision on in-progress attempts and logs detected devices', async () => {
    const owner = await registerStudent('vision@example.test');
    const other = await registerStudent('other@example.test');
    const seeded = await seedExam();
    const assignmentId = await exam.service.assignExam({
      examVersionId: seeded.examVersionId,
      studentId: owner.userId,
    });
    const started = await exam.routes.handle(
      studentRequest(owner, 'POST', `/exam/assignments/${assignmentId}/start`),
    );
    const attemptId = (started.body as ExamDeliveryResponse).delivery.attempt.id;
    const integrity = { recordAppEvent: vi.fn() };
    const detector = vi.fn(async () => ({
      status: 'ok' as const,
      detections: [
        { label: 'person', score: 0.99 },
        { label: 'cell phone', score: 0.8 },
      ],
    }));
    const path = `/exam/attempts/${attemptId}/vision-check`;
    const frame = {
      imageBase64: `data:image/jpeg;base64,${Buffer.from('jpeg').toString('base64')}`,
    };

    expect((await exam.routes.handle(studentRequest(owner, 'POST', path, frame))).status).toBe(404); // disabled by default
    const routes = new ExamRoutes(
      exam.service,
      auth.boundary,
      config,
      integrity as unknown as IntegrityService,
      null,
      detector,
    );
    expect((await routes.handle(studentRequest(other, 'POST', path, frame))).status).toBe(404);
    expect(
      (await routes.handle(studentRequest(owner, 'POST', path, { imageBase64: 'not base64!' })))
        .status,
    ).toBe(400);
    expect(detector).not.toHaveBeenCalled();

    const checked = await routes.handle(studentRequest(owner, 'POST', path, frame));
    expect(checked.body).toEqual({
      status: 'ok',
      detections: [{ label: 'cell phone', score: 0.8 }],
    });
    expect(detector).toHaveBeenCalledWith(Buffer.from('jpeg').toString('base64'));
    expect(integrity.recordAppEvent).toHaveBeenCalledWith(attemptId, 'flag:vision_cell_phone', 1);
  });

  it('only lets signed-in students run the upload speed probe', async () => {
    const student = await registerStudent('speed@example.test');
    expect(
      (
        await exam.routes.handle({
          method: 'POST',
          path: '/exam/speedtest',
          headers: { origin },
          body: { data: 'x' },
        })
      ).status,
    ).toBe(401);
    expect(
      (await exam.routes.handle(studentRequest(student, 'POST', '/exam/speedtest', { data: 'x' })))
        .status,
    ).toBe(200);
  });

  it('caps speed probe size and rate per student', async () => {
    const student = await registerStudent('speedcap@example.test');
    const probe = (data: unknown) =>
      exam.routes.handle(studentRequest(student, 'POST', '/exam/speedtest', { data }));
    expect((await probe('A'.repeat(1_500_001))).status).toBe(400);
    expect((await probe(5)).status).toBe(400);
    const statuses: number[] = [];
    for (let i = 0; i < 7; i += 1) statuses.push((await probe('x')).status);
    expect(statuses.filter((status) => status === 200)).toHaveLength(4);
    expect(statuses.filter((status) => status === 429)).toHaveLength(3);
  });

  it('answers 503 when Gemini-backed instructor checks have no keys configured', async () => {
    const instructor = await registerStudent('nogemini@example.test');
    auth.database
      .prepare(`UPDATE users SET role = 'instructor' WHERE id = ?`)
      .run(instructor.userId);
    const integrity = {
      runSimilarity: vi.fn(async () => {
        throw new GeminiUnavailableError();
      }),
      runAiCheckForQuestion: vi.fn(async () => {
        throw new GeminiUnavailableError();
      }),
    };
    const routes = new ExamRoutes(
      exam.service,
      auth.boundary,
      config,
      integrity as unknown as IntegrityService,
    );
    for (const check of ['similarity', 'ai-check']) {
      const response = await routes.handle(
        studentRequest(instructor, 'POST', `/exam/instructor/versions/v1/questions/q1/${check}`),
      );
      expect(response.status).toBe(503);
      expect(response.body).toMatchObject({ message: expect.stringContaining('GEMINI_API_KEYS') });
    }
  });

  it('checks audio ownership before inference and reports inference failures instead of empty success', async () => {
    const owner = await registerStudent('audio@example.test');
    const other = await registerStudent('other@example.test');
    const seeded = await seedExam();
    const assignmentId = await exam.service.assignExam({
      examVersionId: seeded.examVersionId,
      studentId: owner.userId,
    });
    const started = await exam.routes.handle(
      studentRequest(owner, 'POST', `/exam/assignments/${assignmentId}/start`),
    );
    const attemptId = (started.body as ExamDeliveryResponse).delivery.attempt.id;
    const request = studentRequest(owner, 'POST', `/exam/attempts/${attemptId}/audio`, {
      audio: Buffer.from('synthetic audio').toString('base64'),
      durationMs: 5000,
    });
    expect(
      (await exam.routes.handle(studentRequest(other, 'POST', request.path, request.body))).status,
    ).toBe(404);
    expect(
      (
        await exam.routes.handle({
          ...request,
          headers: { ...request.headers, 'x-csrf-token': undefined },
        })
      ).status,
    ).toBe(403);
    expect(transcribeAudio).not.toHaveBeenCalled();
    vi.mocked(transcribeAudio).mockRejectedValueOnce(new Error('fixture failure'));
    const failed = await exam.routes.handle(request);
    expect(failed.status).toBe(503);
    expect(failed.body).not.toHaveProperty('transcript');
    vi.mocked(transcribeAudio).mockResolvedValueOnce('Synthetic speech');
    const success = await exam.routes.handle(request);
    expect(success.status).toBe(201);
    expect(success.body).toEqual({ transcript: 'Synthetic speech' });
  });

  it('accepts a configured LAN heartbeat without a student cookie and rejects other origins', async () => {
    const lanOrigin = 'http://192.168.1.8:5173';
    const integrity = {
      phoneHeartbeat: vi.fn((token: string) => ({ ok: token === 'synthetic', attemptId: null })),
    };
    const routes = new ExamRoutes(
      exam.service,
      auth.boundary,
      { ...config, allowedOrigins: [origin, lanOrigin] },
      integrity as unknown as IntegrityService,
    );
    const request = {
      method: 'POST',
      path: '/exam/phone-heartbeat',
      headers: { origin: lanOrigin },
      body: { token: 'synthetic' },
    };
    const response = await routes.handle(request);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, attemptId: null });
    expect((await routes.handle({ ...request, body: { token: 'invalid' } })).body).toMatchObject({
      ok: false,
    });
    expect(
      (await routes.handle({ ...request, headers: { origin: 'http://untrusted.test' } })).status,
    ).toBe(403);
    expect(integrity.phoneHeartbeat).toHaveBeenCalledTimes(2);
  });

  async function phoneFixture() {
    const student = await registerStudent('phone-owner@example.test');
    const seeded = await seedExam();
    const assignmentId = await exam.service.assignExam({
      examVersionId: seeded.examVersionId,
      studentId: student.userId,
    });
    const started = await exam.routes.handle(
      studentRequest(student, 'POST', `/exam/assignments/${assignmentId}/start`),
    );
    const delivery = (started.body as ExamDeliveryResponse).delivery;
    return { student, delivery, attemptId: delivery.attempt.id };
  }

  it('persists the native requirement, consumes pairing once, and revokes old credentials on replacement', async () => {
    const { student, attemptId } = await phoneFixture();
    const path = `/exam/attempts/${attemptId}/phone-presence`;
    expect(exam.phonePresence.status(attemptId).required).toBe(false);
    const request = studentRequest(student, 'POST', path);
    expect(
      (
        await exam.routes.handle({
          ...request,
          headers: { ...request.headers, 'x-csrf-token': undefined },
        })
      ).status,
    ).toBe(403);
    const other = await registerStudent('phone-other@example.test');
    expect((await exam.routes.handle(studentRequest(other, 'POST', path))).status).toBe(404);
    expect((await exam.routes.handle(studentRequest(other, 'GET', path))).status).toBe(404);
    const enrolled = await exam.routes.handle(request);
    expect(enrolled.status).toBe(201);
    const { code } = enrolled.body as { code: string };
    const claimed = await exam.routes.handle({
      method: 'POST',
      path: '/exam/phone-presence/claim',
      headers: {},
      body: { code },
    });
    expect(claimed.status).toBe(200);
    const { credential } = claimed.body as { credential: string };
    expect(() => exam.phonePresence.claim(code)).toThrow();
    const challenge = exam.phonePresence.challenge(credential);
    exam.phonePresence.heartbeat(credential, challenge.challenge, challenge.sequence, true);
    expect(exam.phonePresence.status(attemptId).active).toBe(true);
    const stored = JSON.stringify(auth.database.prepare('SELECT * FROM phone_presence').all());
    expect(stored).not.toContain(code);
    expect(stored).not.toContain(credential);
    const restarted = new PhonePresenceService(auth.database, clock);
    expect(restarted.status(attemptId)).toMatchObject({ required: true, active: false });
    expect(() => restarted.assertCanAnswer(attemptId)).toThrow('Phone connection lost');
    exam.phonePresence.enroll(attemptId);
    expect(() => exam.phonePresence.challenge(credential)).toThrow();
    expect(exam.phonePresence.status(attemptId).active).toBe(false);
  });

  it('does not renew native presence from stale, duplicate, reordered or inactive heartbeats', async () => {
    const { attemptId } = await phoneFixture();
    const { credential } = exam.phonePresence.claim(exam.phonePresence.enroll(attemptId).code);
    const first = exam.phonePresence.challenge(credential);
    expect(() =>
      exam.phonePresence.heartbeat(credential, first.challenge, first.sequence, false),
    ).toThrow();
    clock.advance(3);
    exam.phonePresence.heartbeat(credential, first.challenge, first.sequence, true);
    expect(exam.phonePresence.status(attemptId).remainingMs).toBe(5000);
    expect(() =>
      exam.phonePresence.heartbeat(credential, first.challenge, first.sequence, true),
    ).toThrow();
    const second = exam.phonePresence.challenge(credential);
    expect(() =>
      exam.phonePresence.heartbeat(credential, second.challenge, first.sequence, true),
    ).toThrow();
    clock.advance(5);
    expect(exam.phonePresence.status(attemptId).active).toBe(false);
    expect(() =>
      exam.phonePresence.heartbeat(credential, second.challenge, second.sequence, true),
    ).toThrow();
    const resumed = exam.phonePresence.challenge(credential);
    exam.phonePresence.heartbeat(credential, resumed.challenge, resumed.sequence, true);
    expect(exam.phonePresence.status(attemptId).active).toBe(true);
    clock.advance(60);
    expect(() => exam.phonePresence.challenge(credential)).toThrow();
    expect(() => exam.phonePresence.enroll(attemptId)).toThrow();
    expect(exam.phonePresence.status(attemptId).active).toBe(false);
  });

  it('answers 410 Gone on the retired desk-camera route and reports no desk-camera state', async () => {
    const { attemptId } = await phoneFixture();
    const { credential } = exam.phonePresence.claim(exam.phonePresence.enroll(attemptId).code);
    for (const body of [
      { credential, people: 1, handsVisible: true, framingOk: true },
      undefined,
    ]) {
      const gone = await exam.routes.handle({
        method: 'POST',
        path: '/exam/phone-presence/desk-camera',
        headers: {},
        body,
      });
      expect(gone.status).toBe(410);
      expect(gone.body).toMatchObject({ code: 'gone' });
    }
    expect(exam.phonePresence.status(attemptId)).not.toHaveProperty('deskCamera');
    const events = auth.database
      .prepare("SELECT foreground_app FROM app_events WHERE foreground_app LIKE 'flag:desk%'")
      .all();
    expect(events).toEqual([]);
  });

  it('logs pairing, a lapsed lease, the reconnect and an app-backgrounded report exactly once each', async () => {
    const { attemptId } = await phoneFixture();
    const { credential } = exam.phonePresence.claim(exam.phonePresence.enroll(attemptId).code);
    const phoneEvents = () =>
      (
        auth.database
          .prepare(
            "SELECT foreground_app, created_at FROM app_events WHERE attempt_id=? AND foreground_app IN ('flag:iphone_paired','flag:iphone_lost','flag:iphone_reconnected','flag:phone_left_app') ORDER BY rowid",
          )
          .all(attemptId) as Array<{ foreground_app: string; created_at: string }>
      ).map((r) => r.foreground_app.slice(5));
    const beat = (extra: Record<string, unknown> = {}) => {
      const challenge = exam.phonePresence.challenge(credential);
      return exam.routes.handle({
        method: 'POST',
        path: '/exam/phone-presence/heartbeat',
        headers: {},
        body: {
          credential,
          challenge: challenge.challenge,
          sequence: challenge.sequence,
          active: true,
          ...extra,
        },
      });
    };
    expect((await beat()).status).toBe(200);
    expect(phoneEvents()).toEqual(['iphone_paired']);
    clock.advance(2);
    expect((await beat()).status).toBe(200); // a healthy heartbeat logs nothing
    clock.advance(9);
    expect(exam.phonePresence.status(attemptId).active).toBe(false);
    exam.phonePresence.status(attemptId); // observed twice, logged once
    expect(phoneEvents()).toEqual(['iphone_paired', 'iphone_lost']);
    expect((await beat({ leftApp: 'yes' })).status).toBe(400);
    expect((await beat({ leftApp: true })).status).toBe(200);
    expect(exam.phonePresence.status(attemptId).active).toBe(true);
    expect(phoneEvents()).toEqual([
      'iphone_paired',
      'iphone_lost',
      'iphone_reconnected',
      'phone_left_app',
    ]);
    clock.advance(2);
    expect((await beat({ leftApp: true })).status).toBe(200); // cooldown suppresses a repeat
    expect(phoneEvents()).toHaveLength(4);
    // The loss is stamped when the lease ran out, not when somebody looked.
    const lost = auth.database
      .prepare(
        "SELECT created_at FROM app_events WHERE attempt_id=? AND foreground_app='flag:iphone_lost'",
      )
      .get(attemptId) as { created_at: string };
    expect(Date.parse(lost.created_at)).toBeLessThan(clock.now().getTime() - 2000);
    // A lapse that nobody polled is still logged before the reconnect.
    clock.advance(10);
    expect((await beat()).status).toBe(200);
    expect(phoneEvents().slice(4)).toEqual(['iphone_lost', 'iphone_reconnected']);
    // The timeline shows them in the phone lane.
    const kinds = (exam.integrity!.getTimeline(attemptId) ?? []).map((e) => e.kind);
    expect(kinds).toEqual(
      expect.arrayContaining([
        'iphone_paired',
        'iphone_lost',
        'iphone_reconnected',
        'phone_left_app',
      ]),
    );
    clock.advance(24 * 3600);
    exam.phonePresence.status(attemptId); // observing an ended attempt drops its memory
    expect(exam.phonePresence.memorySize()).toBe(0);
  });

  it('does not block answer writes on phone loss and preserves idempotent replay and finalization', async () => {
    const { student, attemptId, delivery } = await phoneFixture();
    const { credential } = exam.phonePresence.claim(exam.phonePresence.enroll(attemptId).code);
    const answers = Object.fromEntries(delivery.questions.map((q) => [q.id, null]));
    const request = { revision: 0, idempotencyKey: 'phone-save-fixture-0001', answers };
    // The paired phone has not sent a heartbeat (lost): answering is still accepted.
    expect(exam.phonePresence.status(attemptId)).toMatchObject({ required: true, active: false });
    const saved = await exam.service.saveAnswers(attemptId, student.userId, request);
    const challenge = exam.phonePresence.challenge(credential);
    exam.phonePresence.heartbeat(credential, challenge.challenge, challenge.sequence, true);
    clock.advance(8);
    expect(await exam.service.saveAnswers(attemptId, student.userId, request)).toEqual(saved);
    const lateSave = await exam.routes.handle(
      studentRequest(student, 'PUT', `/exam/attempts/${attemptId}/answers`, {
        ...request,
        revision: 1,
        idempotencyKey: 'phone-late-fixture-0002',
      }),
    );
    expect(lateSave.status).toBe(200);
    expect(
      (await exam.service.getAttemptDelivery(attemptId, student.userId)).answers.revision,
    ).toBe(2);
    const submitted = await exam.service.submitAttemptWithAnswers(attemptId, student.userId, {
      expectedRevision: 2,
      idempotencyKey: 'phone-submit-fixture-0003',
    });
    expect(submitted.receipt.status).toBe('submitted');
    expect(() => exam.phonePresence.challenge(credential)).toThrow();
  });

  it('expires an unclaimed pairing QR after two minutes', async () => {
    const student = await registerStudent('pair-expiry@example.test');
    const seeded = await exam.service.seedPublishedExam({
      slug: 'long-pairing',
      title: 'Pairing timeout',
      versionNumber: 1,
      durationSeconds: 600,
      questions: [{ type: 'true_false', prompt: 'Synthetic?', answerKey: true }],
    });
    const assignmentId = await exam.service.assignExam({
      examVersionId: seeded.examVersionId,
      studentId: student.userId,
    });
    const start = await exam.routes.handle(
      studentRequest(student, 'POST', `/exam/assignments/${assignmentId}/start`),
    );
    const attemptId = (start.body as ExamDeliveryResponse).delivery.attempt.id;
    const { code } = exam.phonePresence.enroll(attemptId);
    clock.advance(120);
    expect(() => exam.phonePresence.claim(code)).toThrow();
    expect(exam.phonePresence.status(attemptId)).toMatchObject({ required: true, active: false });
  });

  async function registerStudent(email: string): Promise<StudentSession> {
    const session = await auth.service.register({ email, password });
    return {
      userId: session.user.id,
      sessionToken: session.sessionToken,
      csrfToken: session.csrfToken,
    };
  }

  async function seedExam(): Promise<SeedPublishedExamResult> {
    return exam.service.seedPublishedExam({
      slug: 'synthetic-delivery',
      title: 'Synthetic delivery exam',
      versionNumber: 1,
      durationSeconds: 60,
      questions: [
        {
          type: 'multiple_choice',
          prompt: 'Which option is correct?',
          options: [
            { id: 'a', text: 'Option A' },
            { id: 'b', text: 'Option B' },
          ],
          answerKey: 'b',
        },
        { type: 'true_false', prompt: 'The statement is true.', answerKey: true },
        { type: 'identification', prompt: 'Identify the term.', answerKey: 'synthetic' },
        { type: 'numeric', prompt: 'What is the value?', answerKey: 42.5 },
        { type: 'short_answer', prompt: 'Answer briefly.', answerKey: 'bounded answer' },
      ],
    });
  }

  async function seedExamVersion(previous: SeedPublishedExamResult) {
    return exam.service.seedPublishedExam({
      examId: previous.examId,
      title: 'Synthetic delivery exam v2',
      versionNumber: 2,
      durationSeconds: 90,
      questions: [{ type: 'true_false', prompt: 'A new version.', answerKey: false }],
    });
  }

  function studentRequest(
    student: StudentSession,
    method: string,
    path: string,
    body?: unknown,
  ): AuthRequest {
    const request: AuthRequest = {
      method,
      path,
      headers: {
        origin,
        cookie: `eac_session=${student.sessionToken}; eac_csrf=${student.csrfToken}`,
        'x-csrf-token': student.csrfToken,
      },
    };
    if (body !== undefined) {
      return { ...request, body };
    }
    return request;
  }
});

it('accepts the final telemetry flush shortly after submit, but not later', async () => {
  const { acceptsTelemetry } = await import('./exam.routes.js');
  const submittedAt = '2026-10-10T00:00:00.000Z';
  const at = (ms: number) => Date.parse(submittedAt) + ms;
  expect(acceptsTelemetry({ status: 'in_progress', submittedAt: null })).toBe(true);
  expect(acceptsTelemetry({ status: 'submitted', submittedAt }, at(5_000))).toBe(true);
  expect(acceptsTelemetry({ status: 'submitted', submittedAt }, at(61_000))).toBe(false);
  expect(acceptsTelemetry({ status: 'expired', submittedAt }, at(1_000))).toBe(false);
});
