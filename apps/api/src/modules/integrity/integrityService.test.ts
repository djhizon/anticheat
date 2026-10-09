import { beforeEach, expect, it, vi } from 'vitest';
import { IntegrityService } from './integrityService.js';
import type { IntegrityRepository } from './integrityRepository.js';
import type { GeminiRotatingClient } from './gemini.js';
import { signNonce } from './liveness.js';
import { transcribeAudio } from './whisper.js';

vi.mock('./whisper.js', () => ({ transcribeAudio: vi.fn() }));

const secret = 'test-liveness-secret';
const expiresAt = new Date(Date.now() + 60000).toISOString();
const label = 'FaceTime HD Camera';

const colourData = JSON.stringify({ kind: 'colour_flash', sequence: ['red', 'green', 'blue'] });
const turnData = JSON.stringify({ kind: 'head_turn', sequence: ['left', 'right'] });
const wordData = JSON.stringify({ kind: 'spoken_words', words: ['apple', 'river', 'table'] });

function repoFor(data: string, storage = 'flash') {
  return {
    getLivenessChallenge: () => ({
      attempt_id: 'a',
      used: false,
      expires_at: expiresAt,
      challenge_type: storage,
      challenge_data: data,
    }),
    insertLivenessChallenge: vi.fn(),
    countLivenessChallengesSince: vi.fn(() => 0),
    markLivenessChallengeUsed: vi.fn(),
    insertLivenessEvent: vi.fn(),
  };
}

function service(repo: ReturnType<typeof repoFor>) {
  return new IntegrityService(
    repo as unknown as IntegrityRepository,
    {} as GeminiRotatingClient,
    secret,
  );
}

function sign(type: string, data: string) {
  return signNonce({ attemptId: 'a', nonce: 'nonce', type, expiresAt, data }, secret);
}

const colourPayload = {
  faces: [true, true, true],
  baseline: { r: 120, g: 100, b: 90 },
  frames: [
    { r: 150, g: 103, b: 91 },
    { r: 122, g: 130, b: 92 },
    { r: 121, g: 102, b: 118 },
  ],
};

beforeEach(() => vi.mocked(transcribeAudio).mockReset());

it('rejects missing or forged signatures without consuming the challenge', async () => {
  const repo = repoFor(colourData);
  const forged = [
    undefined,
    'garbage',
    sign('head_turn', colourData),
    // Valid signature for another sequence: the client cannot pick its own colours.
    sign('colour_flash', JSON.stringify({ kind: 'colour_flash', sequence: ['red', 'red', 'red'] })),
  ];
  for (const signature of forged) {
    const result = await service(repo).verifyLiveness(
      'a',
      'nonce',
      3,
      colourPayload,
      signature,
      label,
    );
    expect(result).toMatchObject({ passed: false, detail: 'Challenge signature invalid' });
  }
  expect(repo.markLivenessChallengeUsed).not.toHaveBeenCalled();
});

it('issues signed challenges that cover the random sequence and are stored under its real kind', () => {
  const repo = repoFor(colourData);
  const challenge = service(repo).issueLivenessChallenge('a');
  expect(challenge.type).toBe('colour_flash');
  expect(repo.insertLivenessChallenge).toHaveBeenCalledWith(
    challenge.nonce,
    'a',
    'colour_flash',
    JSON.stringify(challenge.data),
    challenge.expiresAt,
  );
  expect(challenge.signature).toBe(
    signNonce({ attemptId: 'a', ...challenge, data: JSON.stringify(challenge.data) }, secret),
  );
  expect(service(repo).issueLivenessChallenge('a', 'head_turn').type).toBe('colour_flash');
  const pulse = service(repo).issueLivenessChallenge('a', 'spoken_words', 'spot_check');
  expect(pulse.type).toBe('colour_flash');
  expect(pulse.data.mode).toBe('pulse');
  expect(service(repo).issueLivenessChallenge('a', 'spoken_words').type).toBe('spoken_words');
});

it('rejects OBS and other virtual cameras, and missing camera labels, for every challenge', async () => {
  for (const [data, storage] of [
    [colourData, 'flash'],
    [turnData, 'gesture'],
    [wordData, 'word'],
  ] as const) {
    for (const camera of ['OBS Virtual Camera', 'Camo', 'DroidCam Source 3', undefined]) {
      const result = await service(repoFor(data, storage)).verifyLiveness(
        'a',
        'nonce',
        3,
        colourPayload,
        sign(JSON.parse(data).kind, data),
        camera,
        'AAAA',
      );
      expect(result.passed).toBe(false);
      expect(result.detail).toMatch(/virtual camera|No native camera/i);
    }
  }
  expect(transcribeAudio).not.toHaveBeenCalled();
});

it('scores a colour flash from the measured readings', async () => {
  const signature = sign('colour_flash', colourData);
  const ok = await service(repoFor(colourData)).verifyLiveness(
    'a',
    'nonce',
    3,
    colourPayload,
    signature,
    label,
  );
  expect(ok.passed).toBe(true);
  const flatPayload = {
    baseline: colourPayload.baseline,
    frames: [colourPayload.baseline, colourPayload.baseline, colourPayload.baseline],
    faces: [true, true, true],
  };
  const flat = await service(repoFor(colourData)).verifyLiveness(
    'a',
    'nonce',
    3,
    flatPayload,
    signature,
    label,
  );
  expect(flat.passed).toBe(false);
});

it('logs a passed mid-exam pulse as a presence check and never as a liveness failure', async () => {
  const pulseData = JSON.stringify({
    kind: 'colour_flash',
    sequence: ['red', 'green', 'blue'],
    mode: 'pulse',
  });
  const dim = {
    faces: [true, true, true],
    baseline: { r: 100, g: 100, b: 100 },
    frames: [
      { r: 102.2, g: 100, b: 100 },
      { r: 100, g: 102.2, b: 100 },
      { r: 100, g: 100, b: 102.2 },
    ],
  };
  const passRepo = { ...repoFor(pulseData), insertAppEvent: vi.fn() };
  const passed = await service(passRepo).verifyLiveness(
    'a',
    'nonce',
    3,
    dim,
    sign('colour_flash', pulseData),
    label,
  );
  expect(passed.passed).toBe(true);
  expect(passRepo.insertAppEvent).toHaveBeenCalledWith('a', 'flag:presence_check_passed', 1);
  expect(passRepo.insertLivenessEvent).not.toHaveBeenCalled();

  const missRepo = { ...repoFor(pulseData), insertAppEvent: vi.fn() };
  const missed = await service(missRepo).verifyLiveness(
    'a',
    'nonce',
    3,
    { ...dim, frames: [dim.baseline, dim.baseline, dim.baseline] },
    sign('colour_flash', pulseData),
    label,
  );
  expect(missed.passed).toBe(false);
  expect(missRepo.insertAppEvent).not.toHaveBeenCalled();
  expect(missRepo.insertLivenessEvent).not.toHaveBeenCalled();
});

it('still verifies head turns stored before they were retired', async () => {
  const samples = [0, -20, 0, 22, 0, 0].map((yaw, i) => ({ t: i * 250, yaw }));
  const result = await service(repoFor(turnData, 'gesture')).verifyLiveness(
    'a',
    'nonce',
    3,
    { samples },
    sign('head_turn', turnData),
    label,
  );
  expect(result.passed).toBe(true);
});

it('verifies spoken words through the mocked transcriber and consumes the challenge', async () => {
  vi.mocked(transcribeAudio).mockResolvedValueOnce('Apple... table, thanks');
  const repo = repoFor(wordData, 'word');
  const audio = Buffer.from('audio').toString('base64');
  const result = await service(repo).verifyLiveness(
    'a',
    'nonce',
    3,
    {},
    sign('spoken_words', wordData),
    label,
    audio,
  );
  expect(result.passed).toBe(true);
  expect(transcribeAudio).toHaveBeenCalledOnce();
  expect(repo.markLivenessChallengeUsed).toHaveBeenCalledWith('nonce');
  expect(JSON.stringify(repo.insertLivenessEvent.mock.calls)).not.toContain(audio);
});

it('fails spoken words on few matches or transcription errors, never passing', async () => {
  const signature = sign('spoken_words', wordData);
  vi.mocked(transcribeAudio).mockResolvedValueOnce('only apple');
  const few = await service(repoFor(wordData, 'word')).verifyLiveness(
    'a',
    'nonce',
    3,
    {},
    signature,
    label,
    'AAAA',
  );
  expect(few.passed).toBe(false);
  vi.mocked(transcribeAudio).mockRejectedValueOnce(new Error('whisper missing'));
  const broken = await service(repoFor(wordData, 'word')).verifyLiveness(
    'a',
    'nonce',
    3,
    {},
    signature,
    label,
    'AAAA',
  );
  expect(broken).toMatchObject({ passed: false });
});

it('treats retired gesture challenges as unknown', async () => {
  const legacy = JSON.stringify({ gesture: 'fingers_1' });
  const result = await service(repoFor(legacy, 'gesture')).verifyLiveness(
    'a',
    'nonce',
    3,
    {},
    sign('unknown', legacy),
    label,
  );
  expect(result).toMatchObject({ passed: false, detail: 'Unknown challenge type' });
});

it('rejects layers outside the allowlist before touching the challenge', async () => {
  const repo = repoFor(colourData);
  const signature = sign('colour_flash', colourData);
  for (const layer of [0, 5, 2.5, Number.NaN, -1]) {
    await expect(
      service(repo).verifyLiveness('a', 'nonce', layer, colourPayload, signature, label),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  }
  expect(repo.markLivenessChallengeUsed).not.toHaveBeenCalled();
});

it('rate-limits challenge issuance per attempt', () => {
  const repo = repoFor(colourData);
  repo.countLivenessChallengesSince.mockReturnValue(6);
  expect(() => service(repo).issueLivenessChallenge('a')).toThrow(/too many/i);
  expect(repo.insertLivenessChallenge).not.toHaveBeenCalled();
  repo.countLivenessChallengesSince.mockReturnValue(5);
  expect(service(repo).issueLivenessChallenge('a').type).toBe('colour_flash');
});

it('words client-scored passes as client-measured, not a confirmed live feed', async () => {
  const ok = await service(repoFor(colourData)).verifyLiveness(
    'a',
    'nonce',
    3,
    colourPayload,
    sign('colour_flash', colourData),
    label,
  );
  expect(ok.detail).toMatch(/client-measured/);
  expect(ok.detail).not.toMatch(/live feed confirmed/);
});

it('sweeps transcripts with the server default as the fallback retention window', () => {
  const deleteExpiredAudioTranscripts = vi.fn(() => 2);
  const svc = new IntegrityService(
    { deleteExpiredAudioTranscripts } as unknown as IntegrityRepository,
    null,
    secret,
    10,
  );
  expect(svc.sweepExpiredTranscripts(new Date('2026-10-11T00:00:00.000Z'))).toBe(2);
  expect(deleteExpiredAudioTranscripts).toHaveBeenCalledWith('2026-10-11T00:00:00.000Z', 10);
});

it('sweeps expired transcripts before returning a transcript', () => {
  const calls: string[] = [];
  const svc = new IntegrityService(
    {
      deleteExpiredAudioTranscripts: () => (calls.push('sweep'), 0),
      getAudioTranscripts: () => (calls.push('read'), []),
    } as unknown as IntegrityRepository,
    null,
    secret,
  );
  svc.getTranscript('a');
  expect(calls).toEqual(['sweep', 'read']);
});

it('skips the "marked fine" purge until the review_decisions table exists', () => {
  const listAttemptsMarkedFineBefore = vi.fn(() => ['a1']);
  const purgeAttemptMedia = vi.fn(() => ({ evidence: 0, transcripts: 0, segments: [] }));
  const svc = new IntegrityService(
    {
      hasReviewDecisions: () => false,
      listAttemptsMarkedFineBefore,
      purgeAttemptMedia,
    } as unknown as IntegrityRepository,
    null,
    secret,
  );
  expect(svc.sweepReviewedFine(new Date('2026-10-11T00:00:00.000Z'))).toBe(0);
  expect(listAttemptsMarkedFineBefore).not.toHaveBeenCalled();
  expect(purgeAttemptMedia).not.toHaveBeenCalled();
});

it('purges media of attempts marked fine more than 7 days ago and forgets uploaded segments', async () => {
  const segments = [{ attempt_id: 'a1', segment_index: 0, student_id: 's1' }];
  const purgeAttemptMedia = vi.fn(() => ({ evidence: 1, transcripts: 1, segments }));
  const remote = vi.fn(async () => undefined);
  const listAttemptsMarkedFineBefore = vi.fn(() => ['a1']);
  const svc = new IntegrityService(
    {
      hasReviewDecisions: () => true,
      listAttemptsMarkedFineBefore,
      purgeAttemptMedia,
    } as unknown as IntegrityRepository,
    null,
    secret,
    30,
    30,
    true,
    remote,
  );
  expect(svc.sweepReviewedFine(new Date('2026-10-11T00:00:00.000Z'))).toBe(1);
  expect(listAttemptsMarkedFineBefore).toHaveBeenCalledWith('2026-10-04T00:00:00.000Z');
  expect(purgeAttemptMedia).toHaveBeenCalledWith(['a1']);
  await Promise.resolve();
  expect(remote).toHaveBeenCalledWith(segments);
});
