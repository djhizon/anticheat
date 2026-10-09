import { describe, expect, it } from 'vitest';
import {
  EMPTY_CHECKS,
  SETUP_STEPS,
  canAdvance,
  clampStep,
  firstIncompleteStep,
  isStepComplete,
  loadSetupProgress,
  nextStep,
  previousStep,
  saveSetupProgress,
  type SetupChecks,
} from './setupFlow.js';

const all: SetupChecks = {
  consent: true,
  permissions: true,
  camera: true,
  face: true,
  lighting: true,
  microphone: true,
  screen: true,
  phone: true,
  identity: true,
};

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  };
}

describe('setup stepper gating', () => {
  it('runs consent, permissions, camera, lighting, microphone, screen, iPhone, identity, ready in order', () => {
    expect(SETUP_STEPS.map((s) => s.id)).toEqual([
      'consent',
      'permissions',
      'camera',
      'lighting',
      'microphone',
      'screen',
      'phone',
      'identity',
      'ready',
    ]);
  });

  it('enables Next only when the current step passed', () => {
    expect(canAdvance('consent', EMPTY_CHECKS)).toBe(false);
    expect(canAdvance('consent', { ...EMPTY_CHECKS, consent: true })).toBe(true);
    expect(canAdvance('microphone', { ...all, microphone: false })).toBe(false);
    expect(canAdvance('identity', { ...all, identity: false })).toBe(false);
    expect(canAdvance('ready', all)).toBe(false);
  });

  it('always requires a paired iPhone (there is no skip)', () => {
    expect(isStepComplete('phone', { ...all, phone: false })).toBe(false);
    expect(canAdvance('phone', { ...all, phone: false })).toBe(false);
    expect(isStepComplete('phone', all)).toBe(true);
    expect(isStepComplete('ready', { ...all, phone: false })).toBe(false);
  });

  it('passes the camera step only with a valid camera and a face in view', () => {
    expect(isStepComplete('camera', { ...all, face: false })).toBe(false);
    expect(isStepComplete('camera', { ...all, camera: false })).toBe(false);
    expect(isStepComplete('camera', all)).toBe(true);
    expect(clampStep('ready', { ...all, face: false })).toBe('camera');
  });

  it('keeps Next disabled on the screen step until recording runs, and falls back to it if recording stops', () => {
    expect(canAdvance('screen', { ...all, screen: false })).toBe(false);
    expect(canAdvance('screen', all)).toBe(true);
    // Recording stopped while the student was on a later step: they are sent back to it.
    expect(clampStep('identity', { ...all, screen: false })).toBe('screen');
    expect(isStepComplete('ready', { ...all, screen: false })).toBe(false);
    expect(nextStep('microphone')).toBe('screen');
    expect(nextStep('screen')).toBe('phone');
  });

  it('only completes Ready when every earlier step passed', () => {
    expect(isStepComplete('ready', all)).toBe(true);
    for (const key of [
      'consent',
      'permissions',
      'camera',
      'face',
      'microphone',
      'screen',
      'phone',
      'identity',
    ] as const)
      expect(isStepComplete('ready', { ...all, [key]: false })).toBe(false);
  });

  it('clamps a requested step to the first step that has not passed', () => {
    expect(firstIncompleteStep(EMPTY_CHECKS)).toBe('consent');
    expect(clampStep('ready', { ...all, camera: false })).toBe('camera');
    expect(clampStep('permissions', all)).toBe('permissions');
    expect(clampStep('ready', all)).toBe('ready');
  });

  it('moves between neighbouring steps and stops at the ends', () => {
    expect(nextStep('consent')).toBe('permissions');
    expect(nextStep('ready')).toBe('ready');
    expect(previousStep('permissions')).toBe('consent');
    expect(previousStep('consent')).toBe('consent');
  });
});

describe('setup progress persistence', () => {
  it('round-trips progress per assignment and ignores corrupt data', () => {
    const storage = memoryStorage();
    saveSetupProgress(
      'a1',
      { step: 'identity', consent: true, phone: true, identity: false },
      storage,
    );
    expect(loadSetupProgress('a1', storage)).toMatchObject({ step: 'identity', consent: true });
    expect(loadSetupProgress('other', storage).step).toBe('consent');
    storage.setItem('exam-setup:bad', '{not json');
    expect(loadSetupProgress('bad', storage).consent).toBe(false);
    storage.setItem('exam-setup:odd', JSON.stringify({ step: 'nope', consent: 'yes' }));
    expect(loadSetupProgress('odd', storage)).toMatchObject({ step: 'consent', consent: false });
  });
});
