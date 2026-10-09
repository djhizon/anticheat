import assert from 'node:assert/strict';
import test from 'node:test';

import { DomainError, SystemClock, problemFromError, type AuditEventInput } from './common.ts';

test('SystemClock returns a valid current date', () => {
  const now = new SystemClock().now();

  assert.equal(Number.isNaN(now.valueOf()), false);
});

test('DomainError becomes a safe problem response', () => {
  const problem = problemFromError(
    new DomainError('forbidden', 'Access denied.', { resource: 'attempt' }),
  );

  assert.deepEqual(problem, {
    code: 'forbidden',
    message: 'You do not have permission to perform this action.',
  });
});

test('DomainError messages and details never cross the public boundary', () => {
  const problem = problemFromError(
    new DomainError('invalid_state', 'secret database detail', {
      table: 'sessions',
    }),
  );

  assert.deepEqual(problem, {
    code: 'invalid_state',
    message: 'The request could not be completed.',
  });
  assert.equal('secret database detail' in problem, false);
  assert.equal('details' in problem, false);
});

test('unknown errors do not leak their message', () => {
  assert.deepEqual(problemFromError(new Error('secret database detail')), {
    code: 'invalid_state',
    message: 'The request could not be completed.',
  });
});

test('audit events have an explicit shape', () => {
  const event: AuditEventInput = {
    action: 'attempt.started',
    occurredAt: new Date('2026-01-01T00:00:00.000Z'),
    metadata: { source: 'server' },
  };

  assert.equal(event.action, 'attempt.started');
  assert.equal(event.metadata?.source, 'server');
});
