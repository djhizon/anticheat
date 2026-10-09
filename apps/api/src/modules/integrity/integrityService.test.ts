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
  const result = await service(repo).verifyLiveness(
    'a',
    'nonce',
    3,
    {},
    undefined,
    validSignature,
    'FaceTime HD Camera',
  );
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

function flashRepo() {
  return {
    ...gestureRepo(),
    getLivenessChallenge: () => ({
      ...gestureRepo().getLivenessChallenge(),
      challenge_type: 'flash',
    }),
  };
}
const flashSignature = signNonce(
  { attemptId: 'a', nonce: 'nonce', type: 'flash', expiresAt },
  secret,
);

it('rejects OBS and other virtual cameras, and missing camera labels', async () => {
  for (const label of ['OBS Virtual Camera', 'Camo', 'DroidCam Source 3', undefined]) {
    const result = await service(flashRepo()).verifyLiveness(
      'a',
      'nonce',
      3,
      { brightnessDelta: 30 },
      undefined,
      flashSignature,
      label,
    );
    expect(result.passed).toBe(false);
    expect(result.detail).toMatch(/virtual camera|No native camera/i);
  }
});

it('passes a flash challenge only when the measured brightness rises on a native webcam', async () => {
  const lit = await service(flashRepo()).verifyLiveness(
    'a',
    'nonce',
    3,
    { brightnessDelta: 14.2 },
    undefined,
    flashSignature,
    'FaceTime HD Camera',
  );
  expect(lit.passed).toBe(true);
  const flat = await service(flashRepo()).verifyLiveness(
    'a',
    'nonce',
    3,
    { brightnessDelta: 0.4 },
    undefined,
    flashSignature,
    'FaceTime HD Camera',
  );
  expect(flat.passed).toBe(false);
});
