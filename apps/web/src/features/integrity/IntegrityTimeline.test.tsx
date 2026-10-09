// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { IntegrityTimelineEntry } from '@exam-anti-cheat/contracts/exam';

import { IntegrityTimeline, summarizeSource } from './IntegrityTimeline.js';
import { TransparencyReport } from './TransparencyReport.js';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const container = document.createElement('div');
document.body.append(container);
let root = createRoot(container);
afterEach(async () => {
  await act(async () => root.unmount());
  root = createRoot(container);
});

const entries: IntegrityTimelineEntry[] = [
  {
    at: '2026-09-15T00:00:00.000Z',
    source: 'system',
    kind: 'attempt_started',
    severity: 'info',
    summary: 'The attempt started',
  },
  {
    at: '2026-09-15T00:01:05.000Z',
    source: 'gaze',
    kind: 'gaze_left',
    severity: 'notice',
    summary: 'Head turned to the left for 6 s',
    data: { durationMs: 6000 },
  },
  {
    at: '2026-09-15T00:01:40.000Z',
    source: 'gaze',
    kind: 'gaze_down',
    severity: 'info',
    summary: 'Head tilted down for 4 s',
    data: { durationMs: 4000 },
  },
  {
    at: '2026-09-15T00:03:00.000Z',
    source: 'browser',
    kind: 'focus_lost',
    severity: 'notice',
    summary: 'The exam window lost focus',
  },
];

function makeApi() {
  return {
    getTimeline: vi.fn(async () => entries),
    downloadTimeline: vi.fn(async () => {}),
  };
}

it('summarises counts per source with total duration', () => {
  expect(summarizeSource('gaze', entries.slice(1, 3))).toBe('Gaze away: 2 times, 10 s total');
  expect(summarizeSource('browser', entries.slice(3))).toBe('Browser: 1 time');
});

it('renders a minute-grouped log with counts, and filters by source', async () => {
  const api = makeApi();
  await act(async () => root.render(<IntegrityTimeline attemptId="a1" api={api} />));
  expect(api.getTimeline).toHaveBeenCalledWith('a1');

  expect(container.querySelector('.integrity-timeline__counts')?.textContent).toContain(
    'Gaze away: 2 times, 10 s total',
  );
  // Three distinct minutes: 00:00, 00:01, 00:03.
  expect(container.querySelectorAll('.integrity-timeline__minute')).toHaveLength(3);
  expect(container.querySelectorAll('.timeline-item')).toHaveLength(4);
  expect(container.querySelector('.timeline-item--notice')).not.toBeNull();
  expect(container.textContent).toContain('not verdicts');

  const gazeToggle = [...container.querySelectorAll('button.timeline-chip')].find((b) =>
    b.textContent?.includes('Gaze away'),
  ) as HTMLButtonElement;
  expect(gazeToggle.getAttribute('aria-pressed')).toBe('true');
  await act(async () => gazeToggle.click());
  expect(gazeToggle.getAttribute('aria-pressed')).toBe('false');
  expect(container.querySelectorAll('.timeline-item')).toHaveLength(2);
  expect(container.textContent).not.toContain('Head turned to the left');
});

it('downloads CSV and JSON through the api and reports failures', async () => {
  const api = makeApi();
  await act(async () => root.render(<IntegrityTimeline attemptId="a1" api={api} />));
  const button = (label: string) =>
    [...container.querySelectorAll('button')].find((b) => b.textContent === label)!;
  await act(async () => button('Download CSV').click());
  await act(async () => button('Download JSON').click());
  expect(api.downloadTimeline.mock.calls).toEqual([
    ['a1', 'csv'],
    ['a1', 'json'],
  ]);

  api.downloadTimeline.mockRejectedValueOnce(new Error('nope'));
  await act(async () => button('Download CSV').click());
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    'could not be downloaded',
  );
});

it('shows a calm message when the log cannot be loaded', async () => {
  const api = {
    getTimeline: vi.fn(async () => Promise.reject(new Error('x'))),
    downloadTimeline: vi.fn(),
  };
  await act(async () => root.render(<IntegrityTimeline attemptId="a1" api={api} />));
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('could not be loaded');
});

it('appears inside the student transparency report when a timeline api is provided', async () => {
  const api = makeApi();
  await act(async () =>
    root.render(<TransparencyReport attemptId="a1" load={async () => []} timelineApi={api} />),
  );
  expect(container.textContent).toContain('What monitoring recorded');
  expect(container.querySelector('.integrity-timeline')).not.toBeNull();
  expect(container.textContent).toContain('Head turned to the left for 6 s');
});

it('offers View photo on evidence entries and loads the image only on click', async () => {
  const withPhoto: IntegrityTimelineEntry[] = [
    ...entries,
    {
      at: '2026-09-15T00:04:00.000Z',
      source: 'camera',
      kind: 'evidence_snapshot',
      severity: 'notice',
      summary: 'Photo saved: another person in view',
      data: { evidenceId: 'ev1', trigger: 'multiple_faces', source: 'webcam' },
    },
  ];
  const api = {
    getTimeline: vi.fn(async () => withPhoto),
    downloadTimeline: vi.fn(async () => {}),
  };
  const loadEvidenceImage = vi.fn(async () => 'https://example.test/photo.jpg');
  await act(async () =>
    root.render(
      <IntegrityTimeline attemptId="a1" api={api} loadEvidenceImage={loadEvidenceImage} />,
    ),
  );
  const buttons = [...container.querySelectorAll('button.timeline-evidence-link')];
  expect(buttons).toHaveLength(1);
  expect(loadEvidenceImage).not.toHaveBeenCalled();
  await act(async () => (buttons[0] as HTMLButtonElement).click());
  expect(loadEvidenceImage).toHaveBeenCalledWith('a1', 'ev1');
  expect(container.querySelector('.timeline-evidence img')?.getAttribute('src')).toBe(
    'https://example.test/photo.jpg',
  );
});

it('shows no View photo button without an image loader', async () => {
  const api = {
    getTimeline: vi.fn(async () => [
      {
        at: '2026-09-15T00:04:00.000Z',
        source: 'camera' as const,
        kind: 'evidence_snapshot',
        severity: 'notice' as const,
        summary: 'Photo saved: no face in view',
        data: { evidenceId: 'ev1' },
      },
    ]),
    downloadTimeline: vi.fn(async () => {}),
  };
  await act(async () => root.render(<IntegrityTimeline attemptId="a1" api={api} />));
  expect(container.querySelector('.timeline-evidence-link')).toBeNull();
});
