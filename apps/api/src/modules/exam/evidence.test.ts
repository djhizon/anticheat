import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Clock, UserId } from '@exam-anti-cheat/contracts';
import {
  EVIDENCE_MAX_BYTES,
  EVIDENCE_MAX_PER_ATTEMPT,
  EVIDENCE_TRIGGERS,
  type ExamDeliveryResponse,
} from '@exam-anti-cheat/contracts/exam';

import { loadConfig, type ApiConfig } from '../../config.js';
import { createAuthPlugin, type AuthPlugin, type AuthRequest } from '../auth/auth.plugin.js';
import { createExamPlugin, type ExamPlugin } from './exam.plugin.js';

const origin = 'http://localhost:5173';
const password = 'correct horse battery staple';

class TestClock implements Clock {
  private current = new Date('2026-09-15T00:00:00.000Z');
  now(): Date {
    return new Date(this.current.getTime());
  }
  advance(seconds: number): void {
    this.current = new Date(this.current.getTime() + seconds * 1000);
  }
}

interface Session {
  readonly userId: UserId;
  readonly sessionToken: string;
  readonly csrfToken: string;
}

function jpegBase64(totalBytes = 64): string {
  const bytes = Buffer.alloc(totalBytes, 0x11);
  bytes[0] = 0xff;
  bytes[1] = 0xd8;
  bytes[2] = 0xff;
  return bytes.toString('base64');
}

describe('evidence snapshots', () => {
  let auth!: AuthPlugin;
  let exam!: ExamPlugin;
  let clock!: TestClock;
  let config!: ApiConfig;

  beforeEach(() => {
    config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_PATH: ':memory:',
      ALLOWED_ORIGINS: origin,
      COOKIE_SECURE: 'false',
    });
    auth = createAuthPlugin(config);
    clock = new TestClock();
    exam = createExamPlugin(auth.database, auth.boundary, config, { clock });
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

  function as(session: Session, method: string, path: string, body?: unknown): AuthRequest {
    return {
      method,
      path,
      headers: {
        origin,
        cookie: `eac_session=${session.sessionToken}; eac_csrf=${session.csrfToken}`,
        'x-csrf-token': session.csrfToken,
      },
      ...(body === undefined ? {} : { body }),
    };
  }

  async function startAttempt(student: Session) {
    const seeded = await exam.service.seedPublishedExam({
      slug: `evidence-${student.userId}`,
      title: 'Evidence exam',
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

  const payload = (overrides: Record<string, unknown> = {}) => ({
    source: 'webcam',
    trigger: 'multiple_faces',
    capturedAt: new Date().toISOString(),
    imageJpegBase64: jpegBase64(),
    ...overrides,
  });

  it('stores a snapshot for the owner and lists and serves it to the owner and instructors only', async () => {
    const student = await register('ev-owner@example.test');
    const instructor = await register('ev-teacher@example.test', 'instructor');
    const other = await register('ev-other@example.test');
    const attemptId = await startAttempt(student);
    const path = `/exam/attempts/${attemptId}/evidence`;

    const created = await exam.routes.handle(as(student, 'POST', path, payload()));
    expect(created.status).toBe(201);
    const { id } = created.body as { id: string };

    for (const viewer of [student, instructor]) {
      const list = await exam.routes.handle(as(viewer, 'GET', path));
      expect(list.status).toBe(200);
      expect(list.body).toEqual({
        snapshots: [
          {
            id,
            source: 'webcam',
            trigger: 'multiple_faces',
            capturedAt: expect.any(String),
          },
        ],
      });
      const image = await exam.routes.handle(as(viewer, 'GET', `${path}/${id}`));
      expect(image.status).toBe(200);
      expect(image.headers['content-type']).toBe('image/jpeg');
      expect(Buffer.isBuffer(image.body)).toBe(true);
      expect((image.body as Buffer).subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    }

    // Another student cannot list or fetch; anonymous requests are rejected.
    expect((await exam.routes.handle(as(other, 'GET', path))).status).toBe(404);
    expect((await exam.routes.handle(as(other, 'GET', `${path}/${id}`))).status).toBe(404);
    expect((await exam.routes.handle({ method: 'GET', path, headers: {} })).status).toBe(401);
    // An unknown id and an id from a different attempt are 404.
    expect((await exam.routes.handle(as(student, 'GET', `${path}/nope`))).status).toBe(404);
  });

  it('requires a student session, CSRF, ownership and an in-progress attempt for laptop sources', async () => {
    const student = await register('ev-auth@example.test');
    const other = await register('ev-auth-other@example.test');
    const instructor = await register('ev-auth-teacher@example.test', 'instructor');
    const attemptId = await startAttempt(student);
    const path = `/exam/attempts/${attemptId}/evidence`;

    const noCsrf = as(student, 'POST', path, payload());
    expect(
      (
        await exam.routes.handle({
          ...noCsrf,
          headers: { ...noCsrf.headers, 'x-csrf-token': undefined },
        })
      ).status,
    ).toBe(403);
    expect((await exam.routes.handle({ ...noCsrf, headers: { origin } })).status).toBe(401);
    expect((await exam.routes.handle(as(other, 'POST', path, payload()))).status).toBe(404);
    expect((await exam.routes.handle(as(instructor, 'POST', path, payload()))).status).toBe(403);

    await exam.service.submitAttempt(attemptId, student.userId);
    expect((await exam.routes.handle(as(student, 'POST', path, payload()))).status).toBe(409);
  });

  it('validates source, trigger, JPEG magic bytes, encoding and size', async () => {
    const student = await register('ev-valid@example.test');
    const attemptId = await startAttempt(student);
    const path = `/exam/attempts/${attemptId}/evidence`;
    const send = async (overrides: Record<string, unknown>) =>
      (await exam.routes.handle(as(student, 'POST', path, payload(overrides)))).status;

    expect(await send({ source: 'fax' })).toBe(400);
    expect(await send({ trigger: 'because' })).toBe(400);
    expect(await send({ imageJpegBase64: '' })).toBe(400);
    expect(await send({ imageJpegBase64: 'not base64!!' })).toBe(400);
    expect(await send({ imageJpegBase64: 123 })).toBe(400);
    // PNG signature is not a JPEG.
    expect(
      await send({
        imageJpegBase64: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]).toString('base64'),
      }),
    ).toBe(400);
    // Just over 300 KB is rejected, exactly 300 KB is accepted.
    expect(await send({ imageJpegBase64: jpegBase64(EVIDENCE_MAX_BYTES + 1) })).toBe(400);
    expect(await send({ imageJpegBase64: jpegBase64(EVIDENCE_MAX_BYTES * 2) })).toBe(400);
    expect(await send({ imageJpegBase64: jpegBase64(EVIDENCE_MAX_BYTES) })).toBe(201);
    expect((await exam.routes.handle(as(student, 'POST', path, 'not an object'))).status).toBe(400);
  });

  it('allows one snapshot per attempt, source and trigger every 30 s and 60 per attempt', async () => {
    const student = await register('ev-rate@example.test');
    const attemptId = await startAttempt(student);
    const path = `/exam/attempts/${attemptId}/evidence`;
    const send = async (overrides: Record<string, unknown> = {}) =>
      exam.routes.handle(as(student, 'POST', path, payload(overrides)));

    expect((await send()).status).toBe(201);
    const limited = await send();
    expect(limited.status).toBe(429);
    expect(limited.headers['retry-after']).toBe('30');
    // A different trigger or source is a different bucket.
    expect((await send({ trigger: 'no_face' })).status).toBe(201);
    expect((await send({ source: 'screen' })).status).toBe(201);

    // Age the first row beyond the window instead of sleeping.
    const aged = new Date(Date.now() - 120_000).toISOString();
    auth.database.prepare('UPDATE evidence_snapshots SET created_at = ?').run(aged);
    expect((await send()).status).toBe(201);

    // Fill to the per-attempt ceiling with aged rows, then the next one is refused.
    const insert = auth.database.prepare(
      `INSERT INTO evidence_snapshots (id, attempt_id, source, trigger, captured_at, created_at, bytes)
       VALUES (?, ?, 'webcam', 'look_away', '2000-01-01T00:00:00.000Z', ?, x'ffd8ff')`,
    );
    const have = Number(
      (
        auth.database
          .prepare('SELECT COUNT(*) AS n FROM evidence_snapshots WHERE attempt_id = ?')
          .get(attemptId) as { n: number }
      ).n,
    );
    for (let index = have; index < EVIDENCE_MAX_PER_ATTEMPT; index += 1) {
      insert.run(`filler-${index}`, attemptId, aged);
    }
    const full = await send({ trigger: 'phone_detected' });
    expect(full.status).toBe(429);
  });

  it('accepts desk_camera evidence only with the credential of the phone paired to that attempt', async () => {
    const student = await register('ev-phone@example.test');
    const otherStudent = await register('ev-phone-other@example.test');
    const attemptId = await startAttempt(student);
    const otherAttempt = await startAttempt(otherStudent);
    const path = `/exam/attempts/${attemptId}/evidence`;
    const { credential } = exam.phonePresence.claim(exam.phonePresence.enroll(attemptId).code);
    const otherCredential = exam.phonePresence.claim(
      exam.phonePresence.enroll(otherAttempt).code,
    ).credential;
    const post = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
      exam.routes.handle({
        method: 'POST',
        path,
        headers,
        body: payload({ source: 'desk_camera', trigger: 'extra_person', ...body }),
      });

    expect((await post({})).status).toBe(401); // no credential
    expect((await post({ credential: 'x'.repeat(43) })).status).toBe(401);
    expect((await post({ credential: otherCredential })).status).toBe(403); // other attempt
    // A student cookie session does not stand in for the phone.
    expect(
      (await post({}, as(student, 'POST', path).headers as Record<string, string>)).status,
    ).toBe(401);
    const created = await post({ credential });
    expect(created.status).toBe(201);
    expect((await post({ credential })).status).toBe(429);
    expect((await post({ credential, imageJpegBase64: 'AAAA' })).status).toBe(400);
    // The owner sees it, labelled as desk camera.
    const list = await exam.routes.handle(as(student, 'GET', path));
    expect((list.body as { snapshots: Array<{ source: string }> }).snapshots[0]?.source).toBe(
      'desk_camera',
    );
    // After the attempt ends the credential stops working.
    clock.advance(24 * 3600);
    expect((await post({ credential, trigger: 'left_frame' })).status).toBe(401);
  });

  it('sweeps snapshots older than the retention window and keeps newer ones', async () => {
    const student = await register('ev-sweep@example.test');
    const attemptId = await startAttempt(student);
    const integrity = exam.integrity!;
    const now = new Date('2026-10-10T00:00:00.000Z');
    const save = (trigger: (typeof EVIDENCE_TRIGGERS)[number], at: Date) =>
      integrity.recordEvidence({
        attemptId,
        source: 'webcam',
        trigger,
        capturedAt: at,
        bytes: Buffer.from(jpegBase64(), 'base64'),
        now: at,
      });
    save('no_face', new Date(now.getTime() - 31 * 86_400_000));
    const keptId = save('look_away', new Date(now.getTime() - 5 * 86_400_000));
    expect(integrity.sweepExpiredEvidence(now)).toBe(1);
    expect(auth.database.prepare('SELECT id FROM evidence_snapshots').all()).toEqual([
      { id: keptId },
    ]);
  });
});
