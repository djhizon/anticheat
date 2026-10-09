import { describe, expect, it } from 'vitest';

import { ExamApiError } from './features/exam/api.js';
import { isSessionExpiredError } from './App.js';

describe('web session boundary', () => {
  it('recognizes only safe unauthorized exam errors as session expiry', () => {
    expect(
      isSessionExpiredError(
        new ExamApiError({ code: 'unauthorized', message: 'Authentication is required.' }),
      ),
    ).toBe(true);
    expect(
      isSessionExpiredError(
        new ExamApiError({
          code: 'forbidden',
          message: 'You do not have permission to view this exam.',
        }),
      ),
    ).toBe(false);
    expect(isSessionExpiredError(new Error('Authentication is required.'))).toBe(false);
  });
});
