import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { connect } from 'node:net';

import { loadConfig, type ApiConfig } from './config.js';
import { hashToken } from './modules/auth/session.js';
import {
  MAX_BODY_DRAIN_MS,
  MAX_REQUEST_BODY_BYTES,
  createApiServer,
  type ApiApplication,
} from './server.js';

const origin = 'http://localhost:5173';
const password = 'correct horse battery staple';

interface CookieJar {
  readonly values: Map<string, string>;
}

function createCookieJar(): CookieJar {
  return { values: new Map() };
}

function setCookieValues(headers: Headers): readonly string[] {
  const getSetCookie = (headers as Headers & { getSetCookie?: () => readonly string[] })
    .getSetCookie;
  if (getSetCookie !== undefined) {
    return getSetCookie.call(headers);
  }

  const combined = headers.get('set-cookie');
  return combined === null ? [] : combined.split(/,\s*(?=[^;,]+=)/u);
}

function applyCookies(jar: CookieJar, headers: Headers): void {
  for (const cookie of setCookieValues(headers)) {
    const nameValue = cookie.split(';', 1)[0] ?? '';
    const separator = nameValue.indexOf('=');
    if (separator <= 0) {
      continue;
    }

    const name = nameValue.slice(0, separator);
    const value = decodeURIComponent(nameValue.slice(separator + 1));
    if (cookie.includes('Max-Age=0')) {
      jar.values.delete(name);
    } else {
      jar.values.set(name, value);
    }
  }
}

function cookieHeader(jar: CookieJar): string {
  return [...jar.values.entries()]
    .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
    .join('; ');
}

async function responseJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

describe('real HTTP API runtime', () => {
  let app!: ApiApplication;
  let config!: ApiConfig;
  let baseUrl!: string;

  beforeEach(async () => {
    config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_PATH: ':memory:',
      ALLOWED_ORIGINS: origin,
      COOKIE_SECURE: 'false',
    });
    app = createApiServer(config);
    const address = await app.start(0);
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await app.stop();
  });

  it('serializes credentialed CORS, cookies, same-origin CSRF refresh, and safe failures', async () => {
    const jar = createCookieJar();
    const preflight = await fetch(`${baseUrl}/auth/login`, {
      method: 'OPTIONS',
      headers: {
        Origin: origin,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type, x-csrf-token, x-requested-with',
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe(origin);
    expect(preflight.headers.get('access-control-allow-credentials')).toBe('true');

    const csrf = await fetch(`${baseUrl}/auth/csrf`, {
      headers: { Origin: origin },
    });
    expect(csrf.status).toBe(200);
    applyCookies(jar, csrf.headers);
    const csrfBody = await responseJson<{ csrfToken: string }>(csrf);
    expect(jar.values.has('eac_csrf')).toBe(true);

    const registered = await fetch(`${baseUrl}/auth/register`, {
      method: 'POST',
      headers: {
        Origin: origin,
        'Content-Type': 'application/json',
        Cookie: cookieHeader(jar),
        'X-CSRF-Token': csrfBody.csrfToken,
      },
      body: JSON.stringify({ email: 'http@example.test', password }),
    });
    expect(registered.status).toBe(201);
    applyCookies(jar, registered.headers);
    const sessionBody = await responseJson<{ user: { role: string }; csrfToken: string }>(
      registered,
    );
    expect(sessionBody.user.role).toBe('student');
    expect(jar.values.has('eac_session')).toBe(true);

    const sessionHash = hashToken(jar.values.get('eac_session') ?? '');
    const beforeOriginlessNavigation = app.auth.database
      .prepare('SELECT csrf_token_hash FROM sessions WHERE token_hash = ?')
      .get(sessionHash)?.csrf_token_hash;
    const originlessNavigation = await fetch(`${baseUrl}/auth/csrf`, {
      headers: { Cookie: cookieHeader(jar) },
    });
    expect(originlessNavigation.status).toBe(200);
    const afterOriginlessNavigation = app.auth.database
      .prepare('SELECT csrf_token_hash FROM sessions WHERE token_hash = ?')
      .get(sessionHash)?.csrf_token_hash;
    expect(afterOriginlessNavigation).toBe(beforeOriginlessNavigation);

    const sameOriginRefresh = await fetch(`${baseUrl}/auth/csrf`, {
      headers: {
        Cookie: cookieHeader(jar),
        'X-Requested-With': 'exam-anti-cheat-browser',
      },
    });
    expect(sameOriginRefresh.status).toBe(200);
    applyCookies(jar, sameOriginRefresh.headers);
    const refreshedBody = await responseJson<{ csrfToken: string }>(sameOriginRefresh);
    expect(refreshedBody.csrfToken).not.toBe(sessionBody.csrfToken);

    const malformed = await fetch(`${baseUrl}/auth/register`, {
      method: 'POST',
      headers: {
        Origin: origin,
        'Content-Type': 'application/json',
        Cookie: cookieHeader(jar),
        'X-CSRF-Token': refreshedBody.csrfToken,
      },
      body: '{',
    });
    expect(malformed.status).toBe(400);
    expect(await responseJson<{ code: string }>(malformed)).toEqual({
      code: 'validation_failed',
      message: 'The request contains invalid data.',
    });

    const oversized = await fetch(`${baseUrl}/auth/register`, {
      method: 'POST',
      headers: {
        Origin: origin,
        'Content-Type': 'application/json',
        Cookie: cookieHeader(jar),
        'X-CSRF-Token': refreshedBody.csrfToken,
      },
      body: 'x'.repeat(MAX_REQUEST_BODY_BYTES + 1),
    });
    expect(oversized.status).toBe(413);
    expect(oversized.headers.get('connection')).toBe('close');

    const logout = await fetch(`${baseUrl}/auth/logout`, {
      method: 'POST',
      headers: {
        Origin: origin,
        Cookie: cookieHeader(jar),
        'X-CSRF-Token': refreshedBody.csrfToken,
      },
    });
    expect(logout.status).toBe(204);
  });

  it('runs an authenticated student exam flow through real HTTP without answer keys', async () => {
    const jar = createCookieJar();
    const csrf = await fetch(`${baseUrl}/auth/csrf`, { headers: { Origin: origin } });
    applyCookies(jar, csrf.headers);
    const csrfBody = await responseJson<{ csrfToken: string }>(csrf);
    const registered = await fetch(`${baseUrl}/auth/register`, {
      method: 'POST',
      headers: {
        Origin: origin,
        'Content-Type': 'application/json',
        Cookie: cookieHeader(jar),
        'X-CSRF-Token': csrfBody.csrfToken,
      },
      body: JSON.stringify({ email: 'exam-http@example.test', password }),
    });
    applyCookies(jar, registered.headers);
    const session = await responseJson<{ csrfToken: string }>(registered);
    const user = app.auth.repository.findUserByEmail('exam-http@example.test');
    if (user === null) {
      throw new Error('The HTTP registration fixture did not create a user.');
    }

    const seeded = await app.exam.service.seedPublishedExam({
      slug: 'http-delivery',
      title: 'HTTP delivery exam',
      versionNumber: 1,
      durationSeconds: 300,
      questions: [
        {
          type: 'multiple_choice',
          prompt: 'Which option is correct?',
          options: [
            { id: 'a', text: 'Option A' },
            { id: 'b', text: 'Option B' },
          ],
          answerKey: 'a',
        },
      ],
    });
    const assignmentId = await app.exam.service.assignExam({
      examVersionId: seeded.examVersionId,
      studentId: user.id,
    });
    const headers = {
      Origin: origin,
      Cookie: cookieHeader(jar),
      'X-CSRF-Token': session.csrfToken,
    };

    const assignments = await fetch(`${baseUrl}/exam/assignments`, { headers });
    expect(assignments.status).toBe(200);
    expect(
      (await responseJson<{ assignments: Array<{ id: string }> }>(assignments)).assignments[0]?.id,
    ).toBe(assignmentId);

    const start = await fetch(`${baseUrl}/exam/assignments/${assignmentId}/start`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ seed: 'client-seed', status: 'submitted' }),
    });
    expect(start.status).toBe(201);
    const startText = await start.text();
    expect(startText).not.toContain('answerKey');
    expect(startText).not.toContain('answer_key_json');
    const delivery = JSON.parse(startText) as {
      delivery: {
        attempt: { id: string };
        questions: Array<{ id: string; options: Array<{ id: string }> }>;
      };
    };

    const firstQuestion = delivery.delivery.questions[0];
    if (firstQuestion === undefined || firstQuestion.options[0] === undefined) {
      throw new Error('The HTTP delivery fixture did not include a usable question.');
    }
    const save = await fetch(`${baseUrl}/exam/attempts/${delivery.delivery.attempt.id}/answers`, {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        revision: 0,
        idempotencyKey: 'http-save-answers-1',
        answers: { [firstQuestion.id]: firstQuestion.options[0].id },
      }),
    });
    expect(save.status).toBe(200);
    expect((await responseJson<{ revision: number }>(save)).revision).toBe(1);

    const submit = await fetch(`${baseUrl}/exam/attempts/${delivery.delivery.attempt.id}/submit`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expectedRevision: 1,
        idempotencyKey: 'http-submit-attempt-1',
      }),
    });
    expect(submit.status).toBe(200);
    const submitBody = await responseJson<{ delivery: { attempt: { status: string } } }>(submit);
    expect(submitBody.delivery.attempt.status).toBe('submitted');

    const missingAuth = await fetch(`${baseUrl}/exam/assignments`, {
      headers: { Origin: origin },
    });
    expect(missingAuth.status).toBe(401);

    const invalidOrigin = await fetch(`${baseUrl}/exam/assignments`, {
      headers: { Origin: 'https://attacker.example' },
    });
    expect(invalidOrigin.status).toBe(403);
  });

  it('rejects oversized chunked bodies on methods that do not normally carry JSON', async () => {
    const responseText = await new Promise<string>((resolveResponse, reject) => {
      const socket = connect(0 + Number(new URL(baseUrl).port), '127.0.0.1');
      let response = '';
      socket.setEncoding('utf8');
      socket.once('error', reject);
      socket.on('data', (chunk: string) => {
        response += chunk;
      });
      socket.once('end', () => resolveResponse(response));
      socket.once('connect', () => {
        const chunk = 'x'.repeat(MAX_REQUEST_BODY_BYTES + 1);
        socket.write(
          `GET /auth/csrf HTTP/1.1\r\nHost: 127.0.0.1\r\nTransfer-Encoding: chunked\r\n\r\n${chunk.length.toString(16)}\r\n${chunk}\r\n0\r\n\r\n`,
        );
      });
    });

    expect(responseText).toMatch(/^HTTP\/1\.1 413 /u);
    expect(responseText).toMatch(/connection: close/iu);
    expect(responseText).toContain('The request body is too large.');
  });

  it('allows a valid body to arrive slowly when it stays within the limit', async () => {
    const responseText = await new Promise<string>((resolveResponse, reject) => {
      const socket = connect(Number(new URL(baseUrl).port), '127.0.0.1');
      let response = '';
      socket.setEncoding('utf8');
      socket.setTimeout(MAX_BODY_DRAIN_MS + 1500, () => {
        socket.destroy(new Error('A valid slow request was incorrectly timed out.'));
      });
      socket.once('error', reject);
      socket.on('data', (chunk: string) => {
        response += chunk;
      });
      socket.once('close', () => resolveResponse(response));
      socket.once('connect', () => {
        socket.write(
          'POST /auth/csrf HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\nContent-Length: 2\r\nContent-Type: application/json\r\n\r\n[',
        );
        setTimeout(() => socket.end(']'), MAX_BODY_DRAIN_MS + 100);
      });
    });

    expect(responseText).toMatch(/^HTTP\/1\.1 404 /u);
  });

  it('bounds draining when an oversized request declares bytes that never arrive', async () => {
    const startedAt = Date.now();
    const responseText = await new Promise<string>((resolveResponse, reject) => {
      const socket = connect(Number(new URL(baseUrl).port), '127.0.0.1');
      let response = '';
      socket.setEncoding('utf8');
      socket.setTimeout(MAX_BODY_DRAIN_MS + 1000, () => {
        socket.destroy(new Error('The oversized request drain was not bounded.'));
      });
      socket.once('error', reject);
      socket.on('data', (chunk: string) => {
        response += chunk;
      });
      socket.once('close', () => resolveResponse(response));
      socket.once('connect', () => {
        socket.write(
          `POST /auth/register HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: ${MAX_REQUEST_BODY_BYTES + 1}\r\n\r\n`,
        );
      });
    });

    expect(Date.now() - startedAt).toBeLessThan(MAX_BODY_DRAIN_MS + 1000);
    expect(responseText).toBe('');
  });

  it('bounds shutdown when an in-limit request body never finishes', async () => {
    const socket = connect(Number(new URL(baseUrl).port), '127.0.0.1');
    socket.on('error', () => undefined);
    const connected = new Promise<void>((resolveConnect, rejectConnect) => {
      const onConnect = (): void => {
        socket.off('error', onError);
        resolveConnect();
      };
      const onError = (error: Error): void => {
        socket.off('connect', onConnect);
        rejectConnect(error);
      };
      socket.once('connect', onConnect);
      socket.once('error', onError);
    });
    const closed = new Promise<void>((resolveClose) => {
      socket.once('close', () => resolveClose());
    });

    await connected;
    await new Promise<void>((resolveWrite, rejectWrite) => {
      socket.write(
        'POST /auth/register HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 2\r\nContent-Type: application/json\r\n\r\n[',
        (error) => {
          if (error === undefined || error === null) {
            resolveWrite();
            return;
          }
          rejectWrite(error);
        },
      );
    });
    await new Promise<void>((resolveNextTurn) => setImmediate(resolveNextTurn));

    const startedAt = Date.now();
    await app.stop();
    await closed;

    expect(Date.now() - startedAt).toBeLessThan(MAX_BODY_DRAIN_MS + 500);
    expect(app.server.listening).toBe(false);
  });

  it('rejects start after stop closes the application', async () => {
    await app.stop();

    await expect(app.start(0)).rejects.toThrow(
      'The API server cannot be started after shutdown begins.',
    );
    expect(app.server.listening).toBe(false);
    await expect(app.stop()).resolves.toBeUndefined();
  });
});
