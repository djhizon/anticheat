// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

import { TransparencyReport } from './TransparencyReport.js';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const container = document.createElement('div');
document.body.append(container);
let root = createRoot(container);
afterEach(async () => {
  await act(async () => root.unmount());
  root = createRoot(container);
});

it('lists every recorded event for the attempt', async () => {
  const load = vi.fn(async () => [
    {
      timestamp: '2026-09-15T00:00:01.000Z',
      type: 'HARDWARE' as const,
      severity: 'high' as const,
      description: 'Multiple displays detected (2)',
    },
    {
      timestamp: '2026-09-15T00:00:02.000Z',
      type: 'GAZE' as const,
      severity: 'low' as const,
      description: 'Looked away from screen for 4s',
    },
  ]);
  await act(async () => root.render(<TransparencyReport attemptId="attempt-1" load={load} />));
  expect(load).toHaveBeenCalledWith('attempt-1');
  const items = [...container.querySelectorAll('li')].map((item) => item.textContent);
  expect(items[0]).toContain('Multiple displays detected (2)');
  expect(items[1]).toContain('Looked away');
  expect(container.querySelector('.transparency-item--high')).not.toBeNull();
});

it('reassures the student when nothing was flagged and reports load failures', async () => {
  await act(async () =>
    root.render(<TransparencyReport attemptId="clean" load={async () => []} />),
  );
  expect(container.textContent).toContain('Nothing was flagged');
  await act(async () =>
    root.render(
      <TransparencyReport attemptId="broken" load={() => Promise.reject(new Error('x'))} />,
    ),
  );
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('could not be loaded');
});

it('shows the full transcript log once in a "What was heard" section', async () => {
  const loadTranscript = vi.fn(async () => [
    { capturedAt: new Date(2026, 9, 9, 8, 0, 1).toISOString(), text: 'hello there' },
    { capturedAt: new Date(2026, 9, 9, 8, 0, 4).toISOString(), text: 'second clip' },
  ]);
  await act(async () =>
    root.render(
      <TransparencyReport attemptId="t" load={async () => []} loadTranscript={loadTranscript} />,
    ),
  );
  expect(loadTranscript).toHaveBeenCalledWith('t');
  expect(container.textContent).toContain('What was heard');
  const items = [...container.querySelectorAll('.transcript-log li')].map((i) => i.textContent);
  expect(items).toEqual(['08:00:01 — hello there', '08:00:04 — second clip']);
  expect(container.textContent?.match(/hello there/gu)).toHaveLength(1);
  expect(container.querySelector('.transparency-list')).toBeNull();
});
