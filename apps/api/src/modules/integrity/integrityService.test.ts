import { expect, it, vi } from 'vitest';
import { IntegrityService } from './integrityService.js';
import type { IntegrityRepository } from './integrityRepository.js';
import type { GeminiRotatingClient } from './gemini.js';
import { signNonce } from './liveness.js';
vi.mock('./handDetector.js', () => {
  throw new Error('Native library unavailable');
});

const secret = 'test-liveness-secret';
const expiresAt = new Date(Date.now() + 60000).toISOString();

function gestureRepo() {
  return {
    getLivenessChallenge: () => ({
      attempt_id: 'a',
      used: false,
      expires_at: expiresAt,
      challenge_type: 'gesture',
      challenge_data: '{"gesture":"fingers_1"}',
    }),
    insertLivenessChallenge: vi.fn(),
    markLivenessChallengeUsed: vi.fn(),
    insertLivenessEvent: vi.fn(),
  };
}

function service(repo: ReturnType<typeof gestureRepo>) {
  return new IntegrityService(
    repo as unknown as IntegrityRepository,
    {} as GeminiRotatingClient,
    secret,
  );
}

const validSignature = signNonce(
  { attemptId: 'a', nonce: 'nonce', type: 'gesture', expiresAt },
  secret,
);

it('records an unavailable lazy gesture engine without passing or reusing the challenge', async () => {
  const repo = gestureRepo();
  const result = await service(repo).verifyLiveness('a', 'nonce', 3, {}, undefined, validSignature);
  expect(result.passed).toBe(false);
  expect(result.detail).toContain('Gesture engine unavailable');
  expect(repo.markLivenessChallengeUsed).toHaveBeenCalledWith('nonce');
  expect(repo.insertLivenessEvent).toHaveBeenCalledOnce();
});

it('rejects missing or forged signatures without consuming the challenge', async () => {
  const repo = gestureRepo();
  const forged = signNonce({ attemptId: 'a', nonce: 'nonce', type: 'flash', expiresAt }, secret);
  for (const signature of [undefined, 'garbage', forged]) {
    const result = await service(repo).verifyLiveness('a', 'nonce', 3, {}, undefined, signature);
    expect(result).toMatchObject({ passed: false, detail: 'Challenge signature invalid' });
  }
  expect(repo.markLivenessChallengeUsed).not.toHaveBeenCalled();
});

it('issues challenges signed for their attempt', () => {
  const repo = gestureRepo();
  const challenge = service(repo).issueLivenessChallenge('a', new Date().toISOString());
  expect(challenge.signature).toBe(signNonce({ attemptId: 'a', ...challenge }, secret));
  expect(challenge.signature).not.toBe(signNonce({ attemptId: 'other', ...challenge }, secret));
});
