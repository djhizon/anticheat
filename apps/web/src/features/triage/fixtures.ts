import type { AttemptFindings, Finding } from '@examguard/contracts/findings';

import type { TriageAttemptRow } from './findingsApi.js';

/**
 * Typed fakes of the findings engine output, for component development and tests. The engine
 * itself lives in the API (GET /exam/attempts/:id/findings); these mirror its contract only.
 */

const T0 = Date.parse('2026-09-15T09:00:00.000Z');
const iso = (offsetSeconds: number): string => new Date(T0 + offsetSeconds * 1000).toISOString();

export const reviewFindings: readonly Finding[] = [
  {
    id: `notes_or_second_screen:${iso(380)}`,
    type: 'notes_or_second_screen',
    confidence: 'medium',
    title: 'Repeated glances to the same spot, then typing',
    reasons: [
      'Looked down for 7–11 s seven times in ten minutes.',
      'Each glance was followed by a burst of typing within 15 s.',
    ],
    windows: [
      { start: iso(380), end: iso(405) },
      { start: iso(860), end: iso(890) },
    ],
    evidenceIds: ['ev-look-1', 'ev-look-2'],
    transcript: [],
    studentNote: 'I keep scratch paper on my desk for working out the maths.',
  },
  {
    id: `second_person:${iso(1350)}`,
    type: 'second_person',
    confidence: 'high',
    title: 'A second person was in view while someone else spoke',
    reasons: [
      'More than one face was in the camera for 14 s.',
      'A second voice was heard in the same minute.',
    ],
    windows: [{ start: iso(1340), end: iso(1370) }],
    evidenceIds: ['ev-faces-1'],
    transcript: [
      { at: iso(1331), text: 'what did you put for number four' },
      { at: iso(1338), text: 'I think it is the network layer' },
    ],
    studentNote: null,
  },
];

export const reviewAttempt: AttemptFindings = {
  attemptId: 'attempt-review',
  level: 'review',
  findings: reviewFindings,
  topReason: reviewFindings[0]!.title,
};

export const glanceAttempt: AttemptFindings = {
  attemptId: 'attempt-glance',
  level: 'glance',
  findings: [
    {
      id: `left_exam:${iso(740)}`,
      type: 'left_exam',
      confidence: 'low',
      title: 'Left the exam window once',
      reasons: ['The exam lost focus for about 8 s.'],
      windows: [{ start: iso(740), end: iso(750) }],
      evidenceIds: [],
      transcript: [],
      studentNote: null,
    },
  ],
  topReason: 'Left the exam window once',
};

export const cleanAttempt: AttemptFindings = {
  attemptId: 'attempt-clean',
  level: 'none',
  findings: [],
  topReason: null,
};

const base = {
  examTitle: 'Quiz 1',
  status: 'submitted' as const,
  startedAt: iso(0),
};

export const triageRows: readonly TriageAttemptRow[] = [
  {
    ...base,
    id: 'attempt-clean',
    studentEmail: 'triage.clean@example.test',
    level: 'none',
    topReason: null,
    findingCount: 0,
    decision: null,
  },
  {
    ...base,
    id: 'attempt-glance',
    studentEmail: 'triage.glance@example.test',
    level: 'glance',
    topReason: glanceAttempt.topReason,
    findingCount: 1,
    decision: null,
  },
  {
    ...base,
    id: 'attempt-review',
    studentEmail: 'triage.review@example.test',
    level: 'review',
    topReason: reviewAttempt.topReason,
    findingCount: 2,
    decision: null,
  },
];

export const findingsById: Readonly<Record<string, AttemptFindings>> = {
  'attempt-clean': cleanAttempt,
  'attempt-glance': glanceAttempt,
  'attempt-review': reviewAttempt,
};
