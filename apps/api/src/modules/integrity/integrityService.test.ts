import { expect, it, vi } from 'vitest';
import { IntegrityService } from './integrityService.js';
import type { IntegrityRepository } from './integrityRepository.js';
import type { GeminiRotatingClient } from './gemini.js';
vi.mock('./handDetector.js', () => {
  throw new Error('Native library unavailable');
});
it('records an unavailable lazy gesture engine without passing or reusing the challenge', async () => {
  const repo = {
    getLivenessChallenge: () => ({
      attempt_id: 'a',
      used: false,
      expires_at: new Date(Date.now() + 60000).toISOString(),
      challenge_type: 'gesture',
      challenge_data: '{"gesture":"fingers_1"}',
    }),
    markLivenessChallengeUsed: vi.fn(),
    insertLivenessEvent: vi.fn(),
  };
  const service = new IntegrityService(
    repo as unknown as IntegrityRepository,
    {} as GeminiRotatingClient,
  );
  const result = await service.verifyLiveness('a', 'nonce', 3, {});
  expect(result.passed).toBe(false);
  expect(result.detail).toContain('Gesture engine unavailable');
  expect(repo.markLivenessChallengeUsed).toHaveBeenCalledWith('nonce');
  expect(repo.insertLivenessEvent).toHaveBeenCalledOnce();
});
