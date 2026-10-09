// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

import type { InstructorApi } from './api.js';
import { SimilarityDashboard } from './SimilarityDashboard.js';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const container = document.createElement('div');
document.body.append(container);
let root = createRoot(container);
afterEach(async () => {
  await act(async () => root.unmount());
  root = createRoot(container);
});

it('runs a similarity check for the selected question and labels students by email', async () => {
  const api: InstructorApi = {
    listVersions: vi.fn(async () => [
      {
        id: 'v1',
        title: 'Networking',
        versionNumber: 1,
        questions: [{ id: 'q1', prompt: 'Explain TCP.', type: 'short_answer' }],
      },
    ]),
    runSimilarity: vi.fn(async () => ({
      report: {
        questionId: 'q1',
        threshold: 0.92,
        generatedAt: '2026-09-15T00:00:00.000Z',
        pairs: [
          { studentAId: 'a', studentBId: 'b', score: 0.97, flagged: true },
          { studentAId: 'a', studentBId: 'c', score: 0.4, flagged: false },
        ],
      },
      students: { a: 'ana@example.test', b: 'ben@example.test', c: 'cy@example.test' },
    })),
  };
  await act(async () => root.render(<SimilarityDashboard api={api} />));
  const button = [...container.querySelectorAll('button')].find((b) =>
    b.textContent?.includes('Run similarity'),
  )!;
  await act(async () => button.click());

  expect(api.runSimilarity).toHaveBeenCalledWith('v1', 'q1');
  const flagged = container.querySelector('.flagged-pair');
  expect(flagged?.textContent).toContain('ana@example.test ↔ ben@example.test');
  expect(flagged?.textContent).toContain('97.0%');
  expect(container.querySelectorAll('.similarity-list li')).toHaveLength(2);
});

it('shows a clear error when the check cannot run', async () => {
  const api: InstructorApi = {
    listVersions: async () => [
      {
        id: 'v1',
        title: 'T',
        versionNumber: 1,
        questions: [{ id: 'q1', prompt: 'P', type: 'short_answer' }],
      },
    ],
    runSimilarity: async () => {
      throw new Error('Check that GEMINI_API_KEYS is configured.');
    },
  };
  await act(async () => root.render(<SimilarityDashboard api={api} />));
  await act(async () => [...container.querySelectorAll('button')].at(-1)!.click());
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('GEMINI_API_KEYS');
});
