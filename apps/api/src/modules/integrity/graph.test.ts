import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../../config.js';
import {
  isRecordingUploadConfigured,
  recordingSegmentPath,
  uploadRecordingChunk,
} from './graph.js';

const config = loadConfig({
  NODE_ENV: 'test',
  DATABASE_PATH: ':memory:',
  ALLOWED_ORIGINS: 'http://localhost:5173',
  COOKIE_SECURE: 'false',
  MS_TENANT_ID: 'tenant',
  MS_CLIENT_ID: 'client',
  MS_CLIENT_SECRET: 'secret',
  MS_RECORDING_TARGET_EMAIL: 'review@school.test',
});

afterEach(() => vi.unstubAllGlobals());

describe('graph recording upload', () => {
  it('names segments <studentId>/<attemptId>/segment-<index>.webm', () => {
    expect(recordingSegmentPath('stu1', 'att1', 7)).toBe(
      '/ExamAntiCheat/stu1/att1/segment-000007.webm',
    );
    expect(recordingSegmentPath('../x', 'a/b', 1)).not.toContain('..');
  });

  it('reports whether Graph is configured', () => {
    expect(isRecordingUploadConfigured({ ...config, msClientSecret: undefined })).toBe(false);
  });

  it('PUTs to the mocked Graph endpoint', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      String(url).includes('login.microsoftonline.com')
        ? new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }))
        : new Response(null, { status: 201 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await uploadRecordingChunk(config, 'stu1', 'att1', 2, Buffer.from('abc'));
    const put = fetchMock.mock.calls.find(([, init]) => (init as RequestInit)?.method === 'PUT');
    expect(String(put?.[0])).toContain(
      '/drive/root:/ExamAntiCheat/stu1/att1/segment-000002.webm:/content',
    );
  });
});
