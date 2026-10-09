import { afterEach, beforeEach, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';

import { openDatabase } from '../../db/client.js';
import { IntegrityRepository } from './integrityRepository.js';

let db!: DatabaseSync;
let repo!: IntegrityRepository;

beforeEach(() => {
  db = openDatabase(':memory:');
  // Phone enrollment queries do not depend on the attempt row itself.
  db.exec('PRAGMA foreign_keys = OFF;');
  repo = new IntegrityRepository(db);
});

afterEach(() => db.close());

it('deletes only audio transcripts older than the cutoff', () => {
  repo.insertAudioTranscript('a1', '2026-01-01T00:00:00.000Z', 'old');
  repo.insertAudioTranscript('a1', '2026-10-01T00:00:00.000Z', 'new');
  expect(repo.deleteAudioTranscriptsBefore('2026-09-01T00:00:00.000Z')).toBe(1);
  expect(repo.getAudioTranscripts('a1').map((r) => r.text)).toEqual(['new']);
});

it('looks up a phone enrollment by attempt id', () => {
  expect(repo.getPhoneEnrollmentByAttempt('attempt-1')).toBeNull();

  repo.insertPhoneEnrollment('attempt-1', 'token-1');
  repo.updatePhoneHeartbeat('token-1', '2026-10-09T00:00:00.000Z');

  const row = repo.getPhoneEnrollmentByAttempt('attempt-1');
  expect(row?.token).toBe('token-1');
  expect(row?.last_seen_at).toBe('2026-10-09T00:00:00.000Z');
});

it('counts liveness challenges issued since a cutoff', () => {
  const at = new Date().toISOString();
  repo.insertLivenessChallenge('n1', 'attempt-1', 'colour_flash', '{}', at);
  repo.insertLivenessChallenge('n2', 'attempt-1', 'head_turn', '{}', at);
  repo.insertLivenessChallenge('n3', 'attempt-2', 'head_turn', '{}', at);
  expect(repo.countLivenessChallengesSince('attempt-1', '2000-01-01T00:00:00.000Z')).toBe(2);
  expect(repo.countLivenessChallengesSince('attempt-1', '2999-01-01T00:00:00.000Z')).toBe(0);
});

it('stores, lists, reads, counts and expires evidence snapshots', () => {
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3]);
  const row = (id: string, attemptId: string, trigger: string, at: string) => ({
    id,
    attemptId,
    source: 'webcam',
    trigger,
    capturedAt: at,
    createdAt: at,
    bytes,
  });
  repo.insertEvidence(row('e1', 'a1', 'no_face', '2026-01-01T00:00:00.000Z'));
  repo.insertEvidence(row('e2', 'a1', 'look_away', '2026-10-01T00:00:00.000Z'));
  repo.insertEvidence(row('e3', 'a2', 'no_face', '2026-10-01T00:00:00.000Z'));

  expect(repo.countEvidence('a1')).toBe(2);
  expect(repo.listEvidence('a1').map((r) => r.id)).toEqual(['e1', 'e2']);
  expect(repo.listEvidence('a1')[0]).toEqual({
    id: 'e1',
    source: 'webcam',
    trigger: 'no_face',
    captured_at: '2026-01-01T00:00:00.000Z',
  });
  expect(Buffer.from(repo.getEvidence('a1', 'e1')!.bytes)).toEqual(bytes);
  expect(repo.getEvidence('a1', 'e3')).toBeNull(); // scoped to its attempt
  expect(repo.countEvidenceSince('a1', 'webcam', 'look_away', '2026-09-01T00:00:00.000Z')).toBe(1);
  expect(repo.countEvidenceSince('a1', 'screen', 'look_away', '2026-09-01T00:00:00.000Z')).toBe(0);
  expect(repo.deleteEvidenceBefore('2026-09-01T00:00:00.000Z')).toBe(1);
  expect(repo.listEvidence('a1').map((r) => r.id)).toEqual(['e2']);
});
