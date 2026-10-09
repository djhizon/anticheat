import { afterEach, expect, it, vi } from 'vitest';

import { GeminiRotatingClient } from './gemini.js';

afterEach(() => vi.unstubAllGlobals());

function reply(status: number, body: unknown = {}) {
  return new Response(JSON.stringify(body), { status });
}

it('retries transient overloads on the next key, sending keys only in a header', async () => {
  vi.useFakeTimers();
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(reply(503))
    .mockResolvedValueOnce(reply(429))
    .mockResolvedValueOnce(reply(200, { embedding: { values: [1, 2] } }));
  vi.stubGlobal('fetch', fetchMock);
  const client = new GeminiRotatingClient({
    keys: ['k1', 'k2', 'k3'],
    model: 'm',
    embeddingModel: 'e',
  });

  const pending = client.embedText('hello');
  await vi.runAllTimersAsync();
  await expect(pending).resolves.toEqual([1, 2]);

  const calls = fetchMock.mock.calls as Array<[string, { headers: Record<string, string> }]>;
  expect(calls.map(([, init]) => init.headers['x-goog-api-key'])).toEqual(['k1', 'k2', 'k3']);
  expect(calls.every(([url]) => !url.includes('key='))).toBe(true);
  vi.useRealTimers();
});

it('does not retry client errors such as a retired model', async () => {
  const fetchMock = vi.fn().mockResolvedValue(reply(404, { error: { message: 'not found' } }));
  vi.stubGlobal('fetch', fetchMock);
  const client = new GeminiRotatingClient({ keys: ['k1'], model: 'm', embeddingModel: 'gone' });
  await expect(client.embedText('x')).rejects.toThrow('Gemini API error 404');
  expect(fetchMock).toHaveBeenCalledOnce();
});

it('falls back to a second model when the primary stays overloaded', async () => {
  vi.useFakeTimers();
  const ok = { candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] };
  const fetchMock = vi.fn(async (url: string) =>
    url.includes('models/primary:') ? reply(503) : reply(200, ok),
  );
  vi.stubGlobal('fetch', fetchMock);
  const client = new GeminiRotatingClient({
    keys: ['k1'],
    model: 'primary',
    embeddingModel: 'e',
    fallbackModel: 'backup',
  });
  const pending = client.generateContent('hi');
  await vi.runAllTimersAsync();
  await expect(pending).resolves.toBe('{"ok":true}');
  expect(fetchMock.mock.calls.at(-1)?.[0]).toContain('models/backup:generateContent');
  vi.useRealTimers();
});
