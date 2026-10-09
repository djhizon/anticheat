import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Clock, UserId } from '@examguard/contracts';
import type { ExamDeliveryResponse } from '@examguard/contracts/exam';
import { FINDING_NOTE_MAX } from '@examguard/contracts/findings';

import { loadConfig, type ApiConfig } from '../../config.js';
import { createAuthPlugin, type AuthPlugin, type AuthRequest } from '../auth/auth.plugin.js';
import { createExamPlugin, type ExamPlugin } from './exam.plugin.js';
import { getFindingNotes } from './reviewRepository.js';

const origin = 'http://localhost:5173';
const password = 'correct horse battery staple';

class TestClock implements Clock {
  private current = new Date('2026-09-15T00:00:00.000Z');
  now(): Date {
    return new Date(this.current.getTime());
  }
}

interface Session {
  readonly userId: UserId;
  readonly sessionToken: string;
  readonly csrfToken: string;
}

describe('triage review decisions and finding notes', () => {
  let auth!: AuthPlugin;
  let exam!: ExamPlugin;
  let config!: ApiConfig;

  beforeEach(() => {
    config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_PATH: ':memory:',
      ALLOWED_ORIGINS: origin,
      COOKIE_SECURE: 'false',
    });
    auth = createAuthPlugin(config);
    exam = createExamPlugin(auth.database, auth.boundary, config, { clock: new TestClock() });
  });

  afterEach(() => auth.close());

  async function register(email: string, role: 'student' | 'instructor' = 'student') {
    const session = await auth.service.register({ email, password });
    if (role === 'instructor') {
      auth.database
        .prepare(`UPDATE users SET role = 'instructor' WHERE id = ?`)
        .run(session.user.id);
    }
    return {
      userId: session.user.id,
      sessionToken: session.sessionToken,
      csrfToken: session.csrfToken,
    } satisfies Session;
  }

  function as(
    session: Session,
    method: string,
    path: string,
    body?: unknown,
    options: { readonly csrf?: boolean } = {},
  ): AuthRequest {
    return {
      method,
      path,
      headers: {
        origin,
        cookie: `eac_session=${session.sessionToken}; eac_csrf=${session.csrfToken}`,
        ...(options.csrf === false ? {} : { 'x-csrf-token': session.csrfToken }),
      },
      ...(body === undefined ? {} : { body }),
    };
  }

  async function startAttempt(student: Session) {
    const seeded = await exam.service.seedPublishedExam({
      slug: `review-${student.userId}`,
      title: 'Review exam',
      versionNumber: 1,
      durationSeconds: 600,
      questions: [{ type: 'true_false', prompt: 'Synthetic?', answerKey: true }],
    });
    const assignmentId = await exam.service.assignExam({
      examVersionId: seeded.examVersionId,
      studentId: student.userId,
    });
    const started = await exam.routes.handle(
      as(student, 'POST', `/exam/assignments/${assignmentId}/start`),
    );
    return (started.body as ExamDeliveryResponse).delivery.attempt.id;
  }

  async function submit(student: Session, attemptId: string) {
    const response = await exam.routes.handle(
      as(student, 'POST', `/exam/attempts/${attemptId}/submit`, {
        expectedRevision: 0,
        idempotencyKey: `submit-${attemptId}`,
      }),
    );
    expect(response.status).toBe(200);
  }

  it('lets an instructor decide, replaces the decision, and lists it with the attempts', async () => {
    const student = await register('decide-student@example.test');
    const instructor = await register('decide-teacher@example.test', 'instructor');
    const attemptId = await startAttempt(student);
    const path = `/exam/instructor/attempts/${attemptId}/decision`;

    const first = await exam.routes.handle(
      as(instructor, 'POST', path, {
        decision: 'follow_up',
        note: '  Ask about the second voice ',
      }),
    );
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      decision: {
        attemptId,
        decision: 'follow_up',
        note: 'Ask about the second voice',
        decidedBy: instructor.userId,
      },
    });

    const second = await exam.routes.handle(as(instructor, 'POST', path, { decision: 'fine' }));
    expect(second.status).toBe(200);
    expect((second.body as { decision: { note: string | null } }).decision.note).toBeNull();

    const list = await exam.routes.handle(as(instructor, 'GET', '/exam/instructor/attempts'));
    expect(list.status).toBe(200);
    const rows = (list.body as { attempts: Array<{ id: string; decision: unknown }> }).attempts;
    expect(rows.find((row) => row.id === attemptId)?.decision).toMatchObject({
      decision: 'fine',
      note: null,
    });
  });

  it('rejects decisions from students, without CSRF, with bad values, or for unknown attempts', async () => {
    const student = await register('decide-student2@example.test');
    const instructor = await register('decide-teacher2@example.test', 'instructor');
    const attemptId = await startAttempt(student);
    const path = `/exam/instructor/attempts/${attemptId}/decision`;

    expect((await exam.routes.handle(as(student, 'POST', path, { decision: 'fine' }))).status).toBe(
      403,
    );
    expect(
      (
        await exam.routes.handle(
          as(instructor, 'POST', path, { decision: 'fine' }, { csrf: false }),
        )
      ).status,
    ).toBe(403);
    expect(
      (await exam.routes.handle(as(instructor, 'POST', path, { decision: 'maybe' }))).status,
    ).toBe(400);
    expect(
      (
        await exam.routes.handle(
          as(instructor, 'POST', path, { decision: 'fine', note: 'x'.repeat(501) }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await exam.routes.handle(
          as(instructor, 'POST', '/exam/instructor/attempts/nope/decision', { decision: 'fine' }),
        )
      ).status,
    ).toBe(404);
  });

  it('stores a student note per finding after submit, for the owner only', async () => {
    const student = await register('note-student@example.test');
    const other = await register('note-other@example.test');
    const instructor = await register('note-teacher@example.test', 'instructor');
    const attemptId = await startAttempt(student);
    const path = `/exam/attempts/${attemptId}/findings/second_person:2026-09-15T00:01:00.000Z/note`;

    // In progress: not yet.
    expect((await exam.routes.handle(as(student, 'POST', path, { note: 'early' }))).status).toBe(
      409,
    );
    await submit(student, attemptId);

    expect(
      (await exam.routes.handle(as(student, 'POST', path, { note: 'My brother walked in.' })))
        .status,
    ).toBe(200);
    expect(
      (await exam.routes.handle(as(student, 'POST', path, { note: 'x' }, { csrf: false }))).status,
    ).toBe(403);
    expect((await exam.routes.handle(as(other, 'POST', path, { note: 'x' }))).status).toBe(404);
    expect((await exam.routes.handle(as(instructor, 'POST', path, { note: 'x' }))).status).toBe(
      403,
    );
    expect(
      (
        await exam.routes.handle(
          as(student, 'POST', path, { note: 'x'.repeat(FINDING_NOTE_MAX + 1) }),
        )
      ).status,
    ).toBe(400);

    const notes = getFindingNotes(auth.database, attemptId);
    expect(notes.get('second_person:2026-09-15T00:01:00.000Z')?.note).toBe('My brother walked in.');

    // Replacing and clearing.
    await exam.routes.handle(as(student, 'POST', path, { note: 'Updated.' }));
    expect(
      getFindingNotes(auth.database, attemptId).get('second_person:2026-09-15T00:01:00.000Z')?.note,
    ).toBe('Updated.');
    await exam.routes.handle(as(student, 'POST', path, { note: '   ' }));
    expect(getFindingNotes(auth.database, attemptId).size).toBe(0);
  });

  it('getFindingNotes is empty when the notes table does not exist yet', () => {
    auth.database.exec('DROP TABLE finding_notes');
    expect(getFindingNotes(auth.database, 'anything').size).toBe(0);
  });
});
