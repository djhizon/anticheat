import { describe, expect, it } from 'vitest';
import {
  generateChallenge,
  PULSE_THRESHOLDS,
  normaliseSpeech,
  scoreColourResponse,
  selectChallengeType,
  verifyHeadTurns,
  verifySpokenWords,
  type Colour,
} from './liveness.js';

const sequence: Colour[] = ['red', 'green', 'blue'];
const baseline = { r: 120, g: 100, b: 90 };
const lit = {
  red: { r: 150, g: 103, b: 91 },
  green: { r: 122, g: 130, b: 92 },
  blue: { r: 121, g: 102, b: 118 },
};

const score = (base: unknown, frames: unknown, faces: unknown = [true, true, true]) =>
  scoreColourResponse(sequence, base, frames, faces);

describe('scoreColourResponse', () => {
  it('fails with the face message when no face was seen, even if colours shift', () => {
    const frames = [lit.red, lit.green, lit.blue];
    for (const faces of [[false, false, false], [true, false, false], null, [true]]) {
      const result = score(baseline, frames, faces);
      expect(result.passed).toBe(false);
      expect(result.detail).toContain("We couldn't see your face");
      expect(result.detail).not.toContain('dimmer');
    }
  });

  it('passes with a face in two of three flashes, counting only those flashes', () => {
    expect(score(baseline, [lit.red, lit.green, lit.blue], [true, true, false]).passed).toBe(true);
    expect(score(baseline, [lit.red, lit.green, lit.blue], [true, false, true]).passed).toBe(true);
  });

  it('passes when each flashed channel rises more than the others', () => {
    expect(score(baseline, [lit.red, lit.green, lit.blue]).passed).toBe(true);
  });

  it('passes when one flash is missed but two register', () => {
    const dud = { ...baseline };
    expect(score(baseline, [lit.red, dud, lit.blue]).passed).toBe(true);
  });

  it('is fair on dark skin and dim rooms because it uses ratios', () => {
    const dark = { r: 30, g: 22, b: 18 };
    const frames = [
      { r: 38, g: 22.5, b: 18.2 },
      { r: 30.5, g: 28, b: 18.4 },
      { r: 30.2, g: 22.4, b: 23.5 },
    ];
    expect(score(dark, frames).passed).toBe(true);
  });

  it('fails when the colours arrive in the wrong order', () => {
    const result = score(baseline, [lit.blue, lit.red, lit.green]);
    expect(result.passed).toBe(false);
    expect(result.detail).toContain('spoken-words');
    expect(result.detail).not.toContain('head');
  });

  it('fails on a flat feed', () => {
    const result = score(baseline, [baseline, baseline, baseline]);
    expect(result.passed).toBe(false);
    expect(result.detail).toContain('spoken-words');
  });

  it('fails in a too-bright room where the sensor is saturated', () => {
    const blown = { r: 255, g: 255, b: 255 };
    expect(score(blown, [blown, blown, blown]).passed).toBe(false);
  });

  it('fails when everything brightens equally (white light, not colours)', () => {
    const white = { r: 150, g: 130, b: 120 };
    expect(score(baseline, [white, white, white]).passed).toBe(false);
  });

  it('rejects malformed readings', () => {
    expect(score(baseline, [lit.red]).passed).toBe(false);
    expect(score(null, [lit.red, lit.green, lit.blue]).passed).toBe(false);
    expect(score(baseline, [lit.red, lit.green, { r: NaN, g: 0, b: 0 }]).passed).toBe(false);
  });
});

const run = (yaws: number[]) => yaws.map((yaw, i) => ({ t: i * 200, yaw }));

describe('verifyHeadTurns', () => {
  it('passes turns made in order with re-centring', () => {
    expect(verifyHeadTurns(['left', 'right'], run([0, -10, -22, -5, 2, 12, 24, 3])).passed).toBe(
      true,
    );
    expect(verifyHeadTurns(['left', 'left'], run([0, -20, 0, -20, 0, 0])).passed).toBe(true);
  });

  it('fails when the order is wrong', () => {
    expect(verifyHeadTurns(['left', 'right'], run([0, 20, 0, -20, 0, 0])).passed).toBe(false);
  });

  it('fails on small movements and still heads', () => {
    expect(verifyHeadTurns(['left', 'right'], run([0, -8, 0, 8, 0, 0])).passed).toBe(false);
    expect(verifyHeadTurns(['right'], run([0, 0, 0, 0, 0, 0])).passed).toBe(false);
  });

  it('requires re-centring between turns', () => {
    expect(verifyHeadTurns(['left', 'left'], run([0, -20, -25, -30, -30, -30])).passed).toBe(false);
  });

  it('rejects invalid or too-short recordings', () => {
    expect(verifyHeadTurns(['left'], 'nope').passed).toBe(false);
    expect(verifyHeadTurns(['left'], [{ t: 0, yaw: -30 }]).passed).toBe(false);
    expect(verifyHeadTurns(['left'], [{ t: 0, yaw: NaN }]).passed).toBe(false);
    expect(
      verifyHeadTurns(
        ['left'],
        [
          { t: 500, yaw: 0 },
          { t: 100, yaw: -30 },
        ],
      ).passed,
    ).toBe(false);
  });
});

describe('verifySpokenWords', () => {
  const words = ['apple', 'river', 'table'];
  it('passes with at least two normalised matches', () => {
    expect(verifySpokenWords(words, 'Apple, river!').passed).toBe(true);
    expect(verifySpokenWords(words, ' TABLE... apple ').passed).toBe(true);
  });
  it('fails with fewer than two', () => {
    expect(verifySpokenWords(words, 'apple pineapple tables').passed).toBe(false);
    expect(verifySpokenWords(words, '').passed).toBe(false);
  });
  it('normalises punctuation and case', () => {
    expect(normaliseSpeech('Hello, World-wide!')).toEqual(['hello', 'world', 'wide']);
  });
});

describe('challenge generation', () => {
  it('issues colour reflection, spoken words on request, and never head turn', () => {
    expect(selectChallengeType()).toBe('colour_flash');
    expect(selectChallengeType('gesture')).toBe('colour_flash');
    expect(selectChallengeType('head_turn')).toBe('colour_flash');
    expect(selectChallengeType('spoken_words')).toBe('spoken_words');
  });
  it('marks the mid-exam edge pulse in the signed data and scores it with lower rises', () => {
    expect(generateChallenge('colour_flash', { pulse: true }).data.mode).toBe('pulse');
    expect(generateChallenge('colour_flash').data.mode).toBeUndefined();
    // A dim edge pulse: about a 2% rise of the flashed channel.
    const base = { r: 100, g: 100, b: 100 };
    const dim = [
      { r: 102.2, g: 100, b: 100 },
      { r: 100, g: 102.2, b: 100 },
      { r: 100, g: 100, b: 102.2 },
    ];
    const faces = [true, true, true];
    const sequence = ['red', 'green', 'blue'] as const;
    expect(scoreColourResponse(sequence, base, dim, faces).passed).toBe(false);
    expect(scoreColourResponse(sequence, base, dim, faces, PULSE_THRESHOLDS).passed).toBe(true);
    expect(
      scoreColourResponse(sequence, base, [base, base, base], faces, PULSE_THRESHOLDS).passed,
    ).toBe(false);
  });
  it('generates random sequences of the right shape', () => {
    for (let i = 0; i < 30; i += 1) {
      const colours = generateChallenge('colour_flash').data.sequence as string[];
      expect(colours).toHaveLength(3);
      expect(colours.every((c, j) => j === 0 || c !== colours[j - 1])).toBe(true);
      expect(generateChallenge('head_turn').data.sequence as string[]).toHaveLength(2);
      expect(new Set(generateChallenge('spoken_words').data.words as string[]).size).toBe(3);
    }
  });
});
