// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { EvidenceSnapshotMeta } from '@examguard/contracts/exam';
import type { ReviewDecision } from '@examguard/contracts/findings';

import { findingsById, reviewAttempt, triageRows } from './fixtures.js';
import type { TriageApi } from './findingsApi.js';
import {
  levelCounts,
  nextNeedingReview,
  sortForTriage,
  TriageDashboard,
} from './TriageDashboard.js';
import { pickPhotos } from './EvidenceCard.js';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const container = document.createElement('div');
document.body.append(container);
let root = createRoot(container);
afterEach(async () => {
  await act(async () => root.unmount());
  root = createRoot(container);
});

function fakeApi(overrides: Partial<TriageApi> = {}): TriageApi & { decisions: ReviewDecision[] } {
  const decisions: ReviewDecision[] = [];
  return {
    decisions,
    listAttempts: async () => triageRows,
    getFindings: async (attemptId) => findingsById[attemptId] ?? null,
    decide: async (attemptId, request) => {
      const decision: ReviewDecision = {
        attemptId,
        decision: request.decision,
        note: request.note ?? null,
        decidedBy: 'teacher',
        decidedAt: '2026-09-15T10:00:00.000Z',
      };
      decisions.push(decision);
      return decision;
    },
    ...overrides,
  };
}

const snapshots: readonly EvidenceSnapshotMeta[] = [
  {
    id: 'ev-look-1',
    source: 'webcam',
    trigger: 'look_away',
    capturedAt: '2026-09-15T09:06:30.000Z',
  },
  {
    id: 'ev-faces-1',
    source: 'webcam',
    trigger: 'multiple_faces',
    capturedAt: '2026-09-15T09:22:33.000Z',
  },
  {
    id: 'ev-phone-1',
    source: 'webcam',
    trigger: 'phone_detected',
    capturedAt: '2026-09-15T09:15:02.000Z',
  },
];
const evidence = {
  listEvidence: async () => snapshots,
  loadEvidenceImage: async (_attemptId: string, id: string) => `data:image/jpeg;base64,${id}`,
};
const fine = (attemptId: string): ReviewDecision => ({
  attemptId,
  decision: 'fine',
  note: null,
  decidedAt: '',
  decidedBy: '',
});

const press = (key: string) =>
  act(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });

describe('triage helpers', () => {
  it('sorts review → glance → none and counts levels', () => {
    expect(sortForTriage(triageRows).map((row) => row.level)).toEqual(['review', 'glance', 'none']);
    expect(levelCounts(triageRows)).toEqual({ none: 1, glance: 1, review: 1 });
  });

  it('moves to the next undecided flagged attempt, wrapping around', () => {
    const sorted = sortForTriage(triageRows);
    expect(nextNeedingReview(sorted, 0)).toBe(1);
    const decided = sorted.map((row, index) =>
      index === 1 ? { ...row, decision: fine(row.id) } : row,
    );
    // Only the clean attempt is left undecided after review and glance.
    expect(nextNeedingReview(decided, 0)).toBe(2);
    expect(
      nextNeedingReview(
        decided.map((row) => ({ ...row, decision: fine(row.id) })),
        0,
      ),
    ).toBeNull();
  });

  it('picks the finding photos first and fills with the nearest ones, at most three', async () => {
    const picked = pickPhotos(reviewAttempt.findings[1]!, snapshots);
    expect(picked.map((item) => item.id)).toEqual(['ev-faces-1', 'ev-phone-1', 'ev-look-1']);
    expect(pickPhotos(reviewAttempt.findings[1]!, snapshots, 2).map((item) => item.id)).toEqual([
      'ev-faces-1',
      'ev-phone-1',
    ]);
  });
});

describe('TriageDashboard', () => {
  it('shows counts, the sorted list and the evidence card of the first attempt needing review', async () => {
    const api = fakeApi();
    await act(async () =>
      root.render(<TriageDashboard api={api} evidence={evidence} onDetails={() => undefined} />),
    );
    expect(container.querySelector('.triage-counts')?.textContent).toBe(
      '1 no review · 1 glance · 1 review',
    );
    const rows = [...container.querySelectorAll('.triage-row')];
    expect(rows.map((row) => row.querySelector('.triage-student')?.textContent)).toEqual([
      'triage.review@example.test',
      'triage.glance@example.test',
      'triage.clean@example.test',
    ]);
    expect(rows[0]?.getAttribute('aria-current')).toBe('true');
    expect(rows[0]?.textContent).toContain('Review');
    expect(rows[0]?.textContent).toContain('Repeated glances to the same spot, then typing');
    expect(rows[0]?.textContent).toContain('Undecided');

    const card = container.querySelector('.evidence-card');
    expect(card?.textContent).toContain('Looked down for 7–11 s seven times in ten minutes.');
    expect(card?.textContent).toContain('High confidence');
    expect(card?.textContent).toContain('what did you put for number four');
    expect(card?.textContent).toContain('I keep scratch paper on my desk');
    expect(card?.querySelectorAll('.finding-photos img').length).toBeGreaterThanOrEqual(2);
    expect(card?.querySelectorAll('.clip-button')).toHaveLength(3);
  });

  it('F decides "fine" with the note and moves focus to the next attempt; J/K move; U follows up', async () => {
    const api = fakeApi();
    await act(async () =>
      root.render(<TriageDashboard api={api} evidence={evidence} onDetails={() => undefined} />),
    );
    const note = container.querySelector<HTMLInputElement>('#triage-note')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(note, 'Scratch paper, fine');
      note.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await press('f');
    expect(api.decisions).toEqual([
      expect.objectContaining({
        attemptId: 'attempt-review',
        decision: 'fine',
        note: 'Scratch paper, fine',
      }),
    ]);
    let rows = [...container.querySelectorAll('.triage-row')];
    expect(rows[0]?.textContent).toContain('✓ Fine');
    expect(rows[1]?.getAttribute('aria-current')).toBe('true');
    expect(container.querySelector('.evidence-card h3')?.textContent).toBe(
      'triage.glance@example.test',
    );

    await press('j');
    expect([...container.querySelectorAll('.triage-row')][2]?.getAttribute('aria-current')).toBe(
      'true',
    );
    await press('k');
    expect([...container.querySelectorAll('.triage-row')][1]?.getAttribute('aria-current')).toBe(
      'true',
    );

    await press('u');
    expect(api.decisions[1]).toEqual(
      expect.objectContaining({ attemptId: 'attempt-glance', decision: 'follow_up' }),
    );
    rows = [...container.querySelectorAll('.triage-row')];
    expect(rows[1]?.textContent).toContain('✓ Follow up');
    expect(rows[2]?.getAttribute('aria-current')).toBe('true');
  });

  it('ignores shortcuts while typing in the note field and keeps "Details" per attempt', async () => {
    const api = fakeApi();
    const onDetails = vi.fn();
    await act(async () =>
      root.render(<TriageDashboard api={api} evidence={evidence} onDetails={onDetails} />),
    );
    const note = container.querySelector<HTMLInputElement>('#triage-note')!;
    await act(async () => {
      note.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', bubbles: true }));
    });
    expect(api.decisions).toEqual([]);
    await act(async () => {
      [...container.querySelectorAll('button')].find((b) => b.textContent === 'Details')!.click();
    });
    expect(onDetails).toHaveBeenCalledWith('attempt-review');
  });

  it('says when findings are not available yet (404) and falls back when no clip can be played', async () => {
    const api = fakeApi({ getFindings: async () => null });
    await act(async () =>
      root.render(<TriageDashboard api={api} evidence={evidence} onDetails={() => undefined} />),
    );
    expect(container.querySelector('.evidence-card')?.textContent).toContain(
      'Findings not available yet',
    );

    const withFindings = fakeApi();
    await act(async () =>
      root.render(
        <TriageDashboard api={withFindings} evidence={evidence} onDetails={() => undefined} />,
      ),
    );
    await act(async () => {
      container.querySelector<HTMLButtonElement>('.clip-button')!.click();
    });
    expect(container.querySelector('.clip-fallback')?.textContent).toContain(
      'No playable recording',
    );
    expect(container.querySelector('video')).toBeNull();
  });
});
