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

it('looks up a phone enrollment by attempt id', () => {
  expect(repo.getPhoneEnrollmentByAttempt('attempt-1')).toBeNull();

  repo.insertPhoneEnrollment('attempt-1', 'token-1');
  repo.updatePhoneHeartbeat('token-1', '2026-10-09T00:00:00.000Z');

  const row = repo.getPhoneEnrollmentByAttempt('attempt-1');
  expect(row?.token).toBe('token-1');
  expect(row?.last_seen_at).toBe('2026-10-09T00:00:00.000Z');
});
