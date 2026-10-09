// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

import { AiCheckDashboard } from './AiCheckDashboard.js';
import type { InstructorApi } from './api.js';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const container = document.createElement('div');
document.body.append(container);
let root = createRoot(container);
afterEach(async () => {
  await act(async () => root.unmount());
  root = createRoot(container);
});

const versions = async () => [
  {
    id: 'v1',
    title: 'Networking',
    versionNumber: 1,
    questions: [{ id: 'q1', prompt: 'Explain TCP.', type: 'short_answer' }],
  },
];

it('shows each student score, summary and quoted phrases', async () => {
  const api: InstructorApi = {
    listVersions: versions,
    runSimilarity: vi.fn(),
    runAiCheck: vi.fn(async () => ({
      questionId: 'q1',
      checkedAt: '2026-09-15T00:00:00.000Z',
      truncated: false,
      results: [
        {
          studentId: 'a',
          email: 'ana@example.test',
          score: 0.86,
          flags: [{ phrase: 'In conclusion', reason: 'templated phrasing' }],
          summary: 'Reads as generated.',
          available: true,
        },
        {
          studentId: 'b',
          email: 'ben@example.test',
          score: 0,
          flags: [],
          summary: 'AI check unavailable: quota',
          available: false,
        },
      ],
    })),
  };
  await act(async () => root.render(<AiCheckDashboard api={api} />));
  await act(async () => container.querySelector('button')!.click());

  expect(api.runAiCheck).toHaveBeenCalledWith('v1', 'q1');
  const high = container.querySelector('.ai-check-item--high');
  expect(high?.textContent).toContain('ana@example.test');
  expect(high?.textContent).toContain('86% likely AI');
  expect(high?.querySelector('q')?.textContent).toBe('In conclusion');
  expect(container.querySelector('.ai-check-item--unavailable')?.textContent).toContain(
    'Unavailable',
  );
});

it('disables the check with a hint when the server has no Gemini keys', async () => {
  const api: InstructorApi = {
    listVersions: versions,
    runSimilarity: vi.fn(),
    runAiCheck: vi.fn(),
    getCapabilities: async () => ({ gemini: false }),
  };
  await act(async () => root.render(<AiCheckDashboard api={api} />));
  const button = [...container.querySelectorAll('button')].find(
    (b) => b.textContent === 'Run AI check',
  )!;
  expect(button.disabled).toBe(true);
  expect(container.textContent).toContain('Needs GEMINI_API_KEYS on the server');
});
