import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Clock, UserId } from '@exam-anti-cheat/contracts';
import type {
  ExamAnswerSaveResponse,
  ExamAssignmentListResponse,
  ExamDeliveryResponse,
  ExamGenerationResponse,
  ExamSubmitResponse,
} from '@exam-anti-cheat/contracts/exam';

import { loadConfig, type ApiConfig } from '../../config.js';
import { createAuthPlugin, type AuthPlugin, type AuthRequest } from '../auth/auth.plugin.js';
import { type TokenGenerator } from '../auth/session.js';
import { createExamPlugin, type ExamPlugin } from './exam.plugin.js';
import { MAX_EXTRA_TIME_SECONDS, type SeedPublishedExamResult } from './exam.service.js';
import { ExamRoutes } from './exam.routes.js';
import { IntegrityService } from '../integrity/integrityService.js';
import { IntegrityRepository } from '../integrity/integrityRepository.js';
import type { GeminiRotatingClient } from '../integrity/gemini.js';
import { transcribeAudio } from '../integrity/whisper.js';
import { PhonePresenceService } from '../integrity/phonePresence.js';

vi.mock('../integrity/whisper.js', async (original) => ({ ...await original<typeof import('../integrity/whisper.js')>(), transcribeAudio: vi.fn() }));

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

    const generated = await exam.routes.handle(
      studentRequest(student, 'POST', '/exam/generate'),
    );
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
    const assignmentId = await exam.service.assignExam({ examVersionId: seeded.examVersionId, studentId: owner.userId });
    const started = await exam.routes.handle(studentRequest(owner, 'POST', `/exam/assignments/${assignmentId}/start`));
    const attemptId = (started.body as ExamDeliveryResponse).delivery.attempt.id;
    const integrity = { enrollPhone: vi.fn(() => ({ token: 'synthetic' })), checkPhoneStatus: vi.fn(() => ({ active: true })) };
    const routes = new ExamRoutes(exam.service, auth.boundary, config, integrity as unknown as IntegrityService);
    const enroll = studentRequest(owner, 'POST', `/exam/attempts/${attemptId}/enroll-phone`);
    const missingCsrf = { ...enroll, headers: { ...enroll.headers, 'x-csrf-token': undefined } };
    expect((await routes.handle(missingCsrf)).status).toBe(403);
    expect((await routes.handle(studentRequest(other, 'POST', enroll.path))).status).toBe(404);
    expect((await routes.handle(studentRequest(other, 'GET', `/exam/attempts/${attemptId}/phone-status`))).status).toBe(404);
    expect(integrity.enrollPhone).not.toHaveBeenCalled();
    expect(integrity.checkPhoneStatus).not.toHaveBeenCalled();
    expect((await routes.handle(enroll)).status).toBe(201);
    expect((await routes.handle(studentRequest(owner, 'GET', `/exam/attempts/${attemptId}/phone-status`))).body).toEqual({ active: true });
  });

  it('requires a session, CSRF and attempt ownership to record desktop events', async () => {
    const owner = await registerStudent('events@example.test');
    const other = await registerStudent('other@example.test');
    const seeded = await seedExam();
    const assignmentId = await exam.service.assignExam({ examVersionId: seeded.examVersionId, studentId: owner.userId });
    const started = await exam.routes.handle(studentRequest(owner, 'POST', `/exam/assignments/${assignmentId}/start`));
    const attemptId = (started.body as ExamDeliveryResponse).delivery.attempt.id;
    const integrity = { recordAppEvent: vi.fn() };
    const routes = new ExamRoutes(exam.service, auth.boundary, config, integrity as unknown as IntegrityService);
    const request = studentRequest(owner, 'PATCH', `/exam/attempts/${attemptId}/events`, { foregroundApp: 'Discord', displayCount: 2 });
    expect((await routes.handle({ method: 'PATCH', path: request.path, headers: {}, body: request.body })).status).toBe(401);
    expect((await routes.handle({ ...request, headers: { ...request.headers, 'x-csrf-token': undefined } })).status).toBe(403);
    expect((await routes.handle(studentRequest(other, 'PATCH', request.path, request.body))).status).toBe(404);
    expect(integrity.recordAppEvent).not.toHaveBeenCalled();
    expect((await routes.handle(request)).status).toBe(200);
    expect(integrity.recordAppEvent).toHaveBeenCalledWith(attemptId, 'Discord', 2);
  });

  it('runs AI checks only on the caller\'s own saved answers', async () => {
    const owner = await registerStudent('aicheck@example.test');
    const other = await registerStudent('other@example.test');
    const seeded = await seedExam();
    const assignmentId = await exam.service.assignExam({ examVersionId: seeded.examVersionId, studentId: owner.userId });
    const started = await exam.routes.handle(studentRequest(owner, 'POST', `/exam/assignments/${assignmentId}/start`));
    const delivery = (started.body as ExamDeliveryResponse).delivery;
    const attemptId = delivery.attempt.id;
    const shortAnswer = delivery.questions.find((question) => question.type === 'short_answer')!;
    const integrity = { runAiCheck: vi.fn(async () => ({ score: 0.1, flags: [], summary: 'ok', checkedAt: 'now' })) };
    const routes = new ExamRoutes(exam.service, auth.boundary, config, integrity as unknown as IntegrityService);
    const path = `/exam/attempts/${attemptId}/ai-check`;

    expect((await routes.handle(studentRequest(other, 'POST', path, { questionId: shortAnswer.id }))).status).toBe(404);
    expect((await routes.handle(studentRequest(owner, 'POST', path, { question: 'q', answer: 'arbitrary text' }))).status).toBe(400);
    expect((await routes.handle(studentRequest(owner, 'POST', path, { questionId: shortAnswer.id }))).status).toBe(400);
    expect(integrity.runAiCheck).not.toHaveBeenCalled();

    const saved = await exam.routes.handle(studentRequest(owner, 'PUT', `/exam/attempts/${attemptId}/answers`, {
      revision: 0, idempotencyKey: 'ai-check-save-key-1', answers: Object.fromEntries(delivery.questions.map((question) => [question.id, question.id === shortAnswer.id ? 'my own words' : null])),
    }));
    expect(saved.status).toBe(200);
    const checked = await routes.handle(studentRequest(owner, 'POST', path, { questionId: shortAnswer.id, answer: 'ignored' }));
    expect(checked.status).toBe(200);
    expect(integrity.runAiCheck).toHaveBeenCalledWith(shortAnswer.prompt, 'my own words');
  });

  it('scopes liveness verification, revisions and recordings to the attempt owner', async () => {
    const owner = await registerStudent('scoped@example.test');
    const other = await registerStudent('other@example.test');
    const seeded = await seedExam();
    const assignmentId = await exam.service.assignExam({ examVersionId: seeded.examVersionId, studentId: owner.userId });
    const started = await exam.routes.handle(studentRequest(owner, 'POST', `/exam/assignments/${assignmentId}/start`));
    const attemptId = (started.body as ExamDeliveryResponse).delivery.attempt.id;
    const integrity = { verifyLiveness: vi.fn(), getRevisions: vi.fn(() => []) };
    const routes = new ExamRoutes(exam.service, auth.boundary, config, integrity as unknown as IntegrityService);
    const base = `/exam/attempts/${attemptId}`;
    expect((await routes.handle(studentRequest(other, 'POST', `${base}/liveness-verify`, { nonce: 'n', layer: 2 }))).status).toBe(404);
    expect((await routes.handle(studentRequest(other, 'GET', `${base}/revisions?questionId=q`))).status).toBe(404);
    expect((await routes.handle(studentRequest(other, 'POST', `${base}/recording`, { index: 0, chunk: '' }))).status).toBe(404);
    expect(integrity.verifyLiveness).not.toHaveBeenCalled();
    expect(integrity.getRevisions).not.toHaveBeenCalled();
    expect((await routes.handle(studentRequest(owner, 'GET', `${base}/revisions?questionId=q`))).status).toBe(200);
  });

  it('answers CORS preflight for every browser-called exam route', async () => {
    const paths = ['/exam/speedtest', ...['recording', 'vision-check', 'telemetry', 'transparency', 'events', 'ai-check']
      .map((route) => `/exam/attempts/attempt-1/${route}`)];
    for (const path of paths) {
      const preflight = await exam.routes.handle({
        method: 'OPTIONS',
        path,
        headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type, x-csrf-token' },
      });
      expect({ path, status: preflight.status }).toEqual({ path, status: 204 });
    }
  });

  it('stores validated telemetry batches for the attempt owner', async () => {
    const owner = await registerStudent('telemetry@example.test');
    const other = await registerStudent('other@example.test');
    const seeded = await seedExam();
    const assignmentId = await exam.service.assignExam({ examVersionId: seeded.examVersionId, studentId: owner.userId });
    const started = await exam.routes.handle(studentRequest(owner, 'POST', `/exam/assignments/${assignmentId}/start`));
    const attemptId = (started.body as ExamDeliveryResponse).delivery.attempt.id;
    const integrity = new IntegrityService(new IntegrityRepository(auth.database), {} as GeminiRotatingClient);
    const routes = new ExamRoutes(exam.service, auth.boundary, config, integrity);
    const path = `/exam/attempts/${attemptId}/telemetry`;
    const body = {
      keystrokes: [{ questionId: 'q1', dwellMs: 80, flightMs: 120 }, { dwellMs: -5, flightMs: 'x' }],
      gaze: [{ timestamp: '2026-09-15T00:00:01.000Z', durationMs: 4200 }, { timestamp: 'never', durationMs: 10 }],
      voice: [{ timestamp: Date.parse('2026-09-15T00:00:02.000Z'), durationMs: 900, peakDb: -20 }],
    };

    expect((await routes.handle(studentRequest(other, 'POST', path, body))).status).toBe(404);
    const stored = await routes.handle(studentRequest(owner, 'POST', path, body));
    expect(stored.status).toBe(202);
    expect(stored.body).toEqual({ accepted: { keystrokes: 1, gaze: 1, voice: 1 } });
    const count = (table: string) =>
      (auth.database.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE attempt_id = ?`).get(attemptId) as { n: number }).n;
    expect([count('keystroke_events'), count('gaze_events'), count('voice_events')]).toEqual([1, 1, 1]);
  });

  it('shows the attempt owner a transparency report of recorded events', async () => {
    const owner = await registerStudent('transparency@example.test');
    const other = await registerStudent('other@example.test');
    const seeded = await seedExam();
    const assignmentId = await exam.service.assignExam({ examVersionId: seeded.examVersionId, studentId: owner.userId });
    const started = await exam.routes.handle(studentRequest(owner, 'POST', `/exam/assignments/${assignmentId}/start`));
    const attemptId = (started.body as ExamDeliveryResponse).delivery.attempt.id;
    const integrity = new IntegrityService(new IntegrityRepository(auth.database), {} as GeminiRotatingClient);
    const routes = new ExamRoutes(exam.service, auth.boundary, config, integrity);
    const base = `/exam/attempts/${attemptId}`;
    await routes.handle(studentRequest(owner, 'PATCH', `${base}/events`, { event: 'keystroke_violation' }));
    await routes.handle(studentRequest(owner, 'PATCH', `${base}/events`, { foregroundApp: 'Exam', displayCount: 2 }));

    expect((await routes.handle(studentRequest(other, 'GET', `${base}/transparency`))).status).toBe(404);
    const report = await routes.handle(studentRequest(owner, 'GET', `${base}/transparency`));
    expect(report.status).toBe(200);
    expect((report.body as { events: Array<{ type: string; description: string }> }).events).toEqual([
      expect.objectContaining({ type: 'SOFTWARE', description: 'Flagged behaviour: keystroke violation' }),
      expect.objectContaining({ type: 'HARDWARE', description: 'Multiple displays detected (2)' }),
    ]);
  });

  it('keeps integrity monitoring available without Gemini keys', async () => {
    const owner = await registerStudent('nokeys@example.test');
    const seeded = await seedExam();
    const assignmentId = await exam.service.assignExam({ examVersionId: seeded.examVersionId, studentId: owner.userId });
    const started = await exam.routes.handle(studentRequest(owner, 'POST', `/exam/assignments/${assignmentId}/start`));
    const attemptId = (started.body as ExamDeliveryResponse).delivery.attempt.id;
    expect(config.geminiKeys).toHaveLength(0);
    const telemetry = await exam.routes.handle(studentRequest(owner, 'POST', `/exam/attempts/${attemptId}/telemetry`, { keystrokes: [] }));
    expect(telemetry.status).toBe(202);
    expect((await exam.routes.handle(studentRequest(owner, 'GET', `/exam/attempts/${attemptId}/transparency`))).status).toBe(200);
  });

  it('lets instructors run cross-student similarity on saved answers', async () => {
    const seeded = await seedExam();
    const instructor = await registerStudent('teacher@example.test');
    auth.database.prepare(`UPDATE users SET role = 'instructor' WHERE id = ?`).run(instructor.userId);
    const texts = ['the same copied answer', 'the same copied answer!', 'an original thought'];
    let shortAnswerId = '';
    for (const [index, text] of texts.entries()) {
      const student = await registerStudent(`student${index}@example.test`);
      const assignmentId = await exam.service.assignExam({ examVersionId: seeded.examVersionId, studentId: student.userId });
      const start = await exam.service.startAttempt(assignmentId, student.userId);
      shortAnswerId = start.delivery.questions.find((question) => question.type === 'short_answer')!.id;
      await exam.service.saveAnswers(start.delivery.attempt.id, student.userId, {
        revision: 0,
        idempotencyKey: `similarity-save-${index}-key`,
        answers: Object.fromEntries(start.delivery.questions.map((q) => [q.id, q.id === shortAnswerId ? text : null])),
      });
    }
    const gemini = { embedText: vi.fn(async (text: string) => (text.includes('same') ? [1, 0] : [0, 1])) };
    const integrity = new IntegrityService(new IntegrityRepository(auth.database), gemini as unknown as GeminiRotatingClient);
    const routes = new ExamRoutes(exam.service, auth.boundary, config, integrity);

    const listed = await routes.handle(studentRequest(instructor, 'GET', '/exam/instructor/versions'));
    expect(listed.status).toBe(200);
    expect((listed.body as { versions: Array<{ id: string; questions: Array<{ id: string }> }> }).versions[0]).toMatchObject({
      id: seeded.examVersionId,
      questions: expect.arrayContaining([expect.objectContaining({ id: shortAnswerId })]),
    });

    const path = `/exam/instructor/versions/${seeded.examVersionId}/questions/${shortAnswerId}/similarity`;
    const student = await registerStudent('curious@example.test');
    expect((await routes.handle(studentRequest(student, 'POST', path))).status).toBe(403);
    const run = await routes.handle(studentRequest(instructor, 'POST', path));
    expect(run.status).toBe(200);
    const body = run.body as { report: { pairs: Array<{ flagged: boolean; studentAId: string; studentBId: string }> }; students: Record<string, string> };
    const flagged = body.report.pairs.filter((pair) => pair.flagged);
    expect(flagged).toHaveLength(1);
    expect([body.students[flagged[0]!.studentAId], body.students[flagged[0]!.studentBId]].sort()).toEqual([
      'student0@example.test',
      'student1@example.test',
    ]);
  });

  it('runs opt-in backend vision on in-progress attempts and logs detected devices', async () => {
    const owner = await registerStudent('vision@example.test');
    const other = await registerStudent('other@example.test');
    const seeded = await seedExam();
    const assignmentId = await exam.service.assignExam({ examVersionId: seeded.examVersionId, studentId: owner.userId });
    const started = await exam.routes.handle(studentRequest(owner, 'POST', `/exam/assignments/${assignmentId}/start`));
    const attemptId = (started.body as ExamDeliveryResponse).delivery.attempt.id;
    const integrity = { recordAppEvent: vi.fn() };
    const detector = vi.fn(async () => ({
      status: 'ok' as const,
      detections: [{ label: 'person', score: 0.99 }, { label: 'cell phone', score: 0.8 }],
    }));
    const path = `/exam/attempts/${attemptId}/vision-check`;
    const frame = { imageBase64: `data:image/jpeg;base64,${Buffer.from('jpeg').toString('base64')}` };

    expect((await exam.routes.handle(studentRequest(owner, 'POST', path, frame))).status).toBe(404); // disabled by default
    const routes = new ExamRoutes(exam.service, auth.boundary, config, integrity as unknown as IntegrityService, null, detector);
    expect((await routes.handle(studentRequest(other, 'POST', path, frame))).status).toBe(404);
    expect((await routes.handle(studentRequest(owner, 'POST', path, { imageBase64: 'not base64!' }))).status).toBe(400);
    expect(detector).not.toHaveBeenCalled();

    const checked = await routes.handle(studentRequest(owner, 'POST', path, frame));
    expect(checked.body).toEqual({ status: 'ok', detections: [{ label: 'cell phone', score: 0.8 }] });
    expect(detector).toHaveBeenCalledWith(Buffer.from('jpeg').toString('base64'));
    expect(integrity.recordAppEvent).toHaveBeenCalledWith(attemptId, 'flag:vision_cell_phone', 1);
  });

  it('checks audio ownership before inference and reports inference failures instead of empty success', async () => {
    const owner = await registerStudent('audio@example.test');
    const other = await registerStudent('other@example.test');
    const seeded = await seedExam();
    const assignmentId = await exam.service.assignExam({ examVersionId: seeded.examVersionId, studentId: owner.userId });
    const started = await exam.routes.handle(studentRequest(owner, 'POST', `/exam/assignments/${assignmentId}/start`));
    const attemptId = (started.body as ExamDeliveryResponse).delivery.attempt.id;
    const request = studentRequest(owner, 'POST', `/exam/attempts/${attemptId}/audio`, { audio: Buffer.from('synthetic audio').toString('base64'), durationMs: 5000 });
    expect((await exam.routes.handle(studentRequest(other, 'POST', request.path, request.body))).status).toBe(404);
    expect((await exam.routes.handle({ ...request, headers: { ...request.headers, 'x-csrf-token': undefined } })).status).toBe(403);
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
    const integrity = { phoneHeartbeat: vi.fn((token: string) => ({ ok: token === 'synthetic', attemptId: null })) };
    const routes = new ExamRoutes(exam.service, auth.boundary,
      { ...config, allowedOrigins: [origin, lanOrigin] }, integrity as unknown as IntegrityService);
    const request = { method: 'POST', path: '/exam/phone-heartbeat', headers: { origin: lanOrigin }, body: { token: 'synthetic' } };
    const response = await routes.handle(request);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, attemptId: null });
    expect((await routes.handle({ ...request, body: { token: 'invalid' } })).body).toMatchObject({ ok: false });
    expect((await routes.handle({ ...request, headers: { origin: 'http://untrusted.test' } })).status).toBe(403);
    expect(integrity.phoneHeartbeat).toHaveBeenCalledTimes(2);
  });

  async function phoneFixture() {
    const student = await registerStudent('phone-owner@example.test');
    const seeded = await seedExam();
    const assignmentId = await exam.service.assignExam({ examVersionId: seeded.examVersionId, studentId: student.userId });
    const started = await exam.routes.handle(studentRequest(student, 'POST', `/exam/assignments/${assignmentId}/start`));
    const delivery = (started.body as ExamDeliveryResponse).delivery;
    return { student, delivery, attemptId: delivery.attempt.id };
  }

  it('persists the native requirement, consumes pairing once, and revokes old credentials on replacement', async () => {
    const { student, attemptId } = await phoneFixture();
    const path = `/exam/attempts/${attemptId}/phone-presence`;
    expect(exam.phonePresence.status(attemptId).required).toBe(false);
    const request = studentRequest(student, 'POST', path);
    expect((await exam.routes.handle({ ...request, headers: { ...request.headers, 'x-csrf-token': undefined } })).status).toBe(403);
    const other = await registerStudent('phone-other@example.test');
    expect((await exam.routes.handle(studentRequest(other, 'POST', path))).status).toBe(404);
    expect((await exam.routes.handle(studentRequest(other, 'GET', path))).status).toBe(404);
    const enrolled = await exam.routes.handle(request);
    expect(enrolled.status).toBe(201);
    const { code } = enrolled.body as { code: string };
    const claimed = await exam.routes.handle({ method: 'POST', path: '/exam/phone-presence/claim', headers: {}, body: { code } });
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
    expect(() => exam.phonePresence.heartbeat(credential, first.challenge, first.sequence, false)).toThrow();
    clock.advance(3);
    exam.phonePresence.heartbeat(credential, first.challenge, first.sequence, true);
    expect(exam.phonePresence.status(attemptId).remainingMs).toBe(5000);
    expect(() => exam.phonePresence.heartbeat(credential, first.challenge, first.sequence, true)).toThrow();
    const second = exam.phonePresence.challenge(credential);
    expect(() => exam.phonePresence.heartbeat(credential, second.challenge, first.sequence, true)).toThrow();
    clock.advance(5);
    expect(exam.phonePresence.status(attemptId).active).toBe(false);
    expect(() => exam.phonePresence.heartbeat(credential, second.challenge, second.sequence, true)).toThrow();
    const resumed = exam.phonePresence.challenge(credential);
    exam.phonePresence.heartbeat(credential, resumed.challenge, resumed.sequence, true);
    expect(exam.phonePresence.status(attemptId).active).toBe(true);
    clock.advance(60);
    expect(() => exam.phonePresence.challenge(credential)).toThrow();
    expect(() => exam.phonePresence.enroll(attemptId)).toThrow();
    expect(exam.phonePresence.status(attemptId).active).toBe(false);
  });

  it('gates real answer writes and preserves acknowledged idempotent replay and finalization', async () => {
    const { student, attemptId, delivery } = await phoneFixture();
    const { credential } = exam.phonePresence.claim(exam.phonePresence.enroll(attemptId).code);
    const answers = Object.fromEntries(delivery.questions.map(q => [q.id, null]));
    const request = { revision: 0, idempotencyKey: 'phone-save-fixture-0001', answers };
    await expect(exam.service.saveAnswers(attemptId, student.userId, request)).rejects.toThrow('Phone connection lost');
    const challenge = exam.phonePresence.challenge(credential);
    exam.phonePresence.heartbeat(credential, challenge.challenge, challenge.sequence, true);
    const saved = await exam.service.saveAnswers(attemptId, student.userId, request);
    clock.advance(8);
    expect(await exam.service.saveAnswers(attemptId, student.userId, request)).toEqual(saved);
    const blocked = await exam.routes.handle(studentRequest(student, 'PUT', `/exam/attempts/${attemptId}/answers`, { ...request, revision: 1, idempotencyKey: 'phone-blocked-fixture-0002' }));
    expect(blocked.status).toBe(409);
    expect((await exam.service.getAttemptDelivery(attemptId, student.userId)).answers.revision).toBe(1);
    const submitted = await exam.service.submitAttemptWithAnswers(attemptId, student.userId, { expectedRevision: 1, idempotencyKey: 'phone-submit-fixture-0003' });
    expect(submitted.receipt.status).toBe('submitted');
    expect(() => exam.phonePresence.challenge(credential)).toThrow();
  });

  it('expires an unclaimed pairing QR after two minutes', async () => {
    const student = await registerStudent('pair-expiry@example.test');
    const seeded = await exam.service.seedPublishedExam({ slug: 'long-pairing', title: 'Pairing timeout', versionNumber: 1, durationSeconds: 600, questions: [{ type: 'true_false', prompt: 'Synthetic?', answerKey: true }] });
    const assignmentId = await exam.service.assignExam({ examVersionId: seeded.examVersionId, studentId: student.userId });
    const start = await exam.routes.handle(studentRequest(student, 'POST', `/exam/assignments/${assignmentId}/start`));
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
