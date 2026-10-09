/** Pure logic for the pre-exam setup stepper: ordering, gating and refresh-safe progress. */

export const SETUP_STEPS = [
  { id: 'consent', label: 'Consent' },
  { id: 'permissions', label: 'Permissions' },
  { id: 'camera', label: 'Camera' },
  { id: 'lighting', label: 'Lighting' },
  { id: 'microphone', label: 'Microphone' },
  { id: 'screen', label: 'Screen recording' },
  { id: 'phone', label: 'iPhone' },
  { id: 'identity', label: 'Identity' },
  { id: 'ready', label: 'Ready' },
] as const;

export type SetupStepId = (typeof SETUP_STEPS)[number]['id'];

export interface SetupChecks {
  readonly consent: boolean;
  /** Camera and microphone permission both granted. */
  readonly permissions: boolean;
  /** Native webcam passed the camera gate (and the desktop attestation) and its preview is live. */
  readonly camera: boolean;
  /** Exactly one face was seen on that camera for long enough. */
  readonly face: boolean;
  /** The lighting check finished (good lighting, or the student continued with a warning). */
  readonly lighting: boolean;
  /** Input level was seen on the microphone. */
  readonly microphone: boolean;
  /** Whole-screen recording is running right now (mandatory). */
  readonly screen: boolean;
  /** The iPhone is paired and its heartbeats arrive (always required; there is no skip). */
  readonly phone: boolean;
  /** The presence check passed, or the student continued after repeated failed tries. */
  readonly identity: boolean;
}

export const EMPTY_CHECKS: SetupChecks = {
  consent: false,
  permissions: false,
  camera: false,
  face: false,
  lighting: false,
  microphone: false,
  screen: false,
  phone: false,
  identity: false,
};

export function stepIndex(id: SetupStepId): number {
  return SETUP_STEPS.findIndex((step) => step.id === id);
}

export function isStepComplete(id: SetupStepId, checks: SetupChecks): boolean {
  switch (id) {
    case 'consent':
      return checks.consent;
    case 'permissions':
      return checks.permissions;
    case 'camera':
      return checks.camera && checks.face;
    case 'lighting':
      return checks.camera && checks.lighting;
    case 'microphone':
      return checks.microphone;
    case 'screen':
      return checks.screen;
    case 'phone':
      return checks.phone;
    case 'identity':
      return checks.identity;
    case 'ready':
      return SETUP_STEPS.filter((step) => step.id !== 'ready').every((step) =>
        isStepComplete(step.id, checks),
      );
  }
}

/** The earliest step that has not passed; `ready` when everything passed. */
export function firstIncompleteStep(checks: SetupChecks): SetupStepId {
  const found = SETUP_STEPS.find((step) => step.id !== 'ready' && !isStepComplete(step.id, checks));
  return found?.id ?? 'ready';
}

/** Next is enabled only when the current step passed (and there is a following step). */
export function canAdvance(from: SetupStepId, checks: SetupChecks): boolean {
  return from !== 'ready' && isStepComplete(from, checks);
}

/** A student can never sit beyond the first step that has not passed. */
export function clampStep(requested: SetupStepId, checks: SetupChecks): SetupStepId {
  const limit = stepIndex(firstIncompleteStep(checks));
  return SETUP_STEPS[Math.min(stepIndex(requested), limit)]!.id;
}

export function nextStep(from: SetupStepId): SetupStepId {
  return SETUP_STEPS[Math.min(stepIndex(from) + 1, SETUP_STEPS.length - 1)]!.id;
}

export function previousStep(from: SetupStepId): SetupStepId {
  return SETUP_STEPS[Math.max(stepIndex(from) - 1, 0)]!.id;
}

/**
 * What survives a refresh. Hardware results (camera, microphone, screen recording) are never
 * trusted from storage: streams are gone, so those steps run again.
 */
export interface SetupProgress {
  readonly step: SetupStepId;
  readonly consent: boolean;
  /** The iPhone was paired during setup. */
  readonly phone: boolean;
  readonly identity: boolean;
  /** True when identity was passed by continuing after failed tries (an instructor reviews). */
  readonly identityUnverified?: boolean;
}

export const EMPTY_PROGRESS: SetupProgress = {
  step: 'consent',
  consent: false,
  phone: false,
  identity: false,
  identityUnverified: false,
};

const KEY_PREFIX = 'exam-setup:';
type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function defaultStorage(): StorageLike | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

export function loadSetupProgress(
  assignmentId: string,
  storage: StorageLike | null = defaultStorage(),
): SetupProgress {
  try {
    const raw = storage?.getItem(KEY_PREFIX + assignmentId);
    if (!raw) return EMPTY_PROGRESS;
    const value = JSON.parse(raw) as Partial<SetupProgress>;
    const step = SETUP_STEPS.some((s) => s.id === value.step)
      ? (value.step as SetupStepId)
      : 'consent';
    return {
      step,
      consent: value.consent === true,
      phone: value.phone === true,
      identity: value.identity === true,
      identityUnverified: value.identityUnverified === true,
    };
  } catch {
    return EMPTY_PROGRESS;
  }
}

export function saveSetupProgress(
  assignmentId: string,
  progress: SetupProgress,
  storage: StorageLike | null = defaultStorage(),
): void {
  try {
    storage?.setItem(KEY_PREFIX + assignmentId, JSON.stringify(progress));
  } catch {
    // Storage can be unavailable (private mode); setup simply restarts after a refresh.
  }
}

export function clearSetupProgress(
  assignmentId: string,
  storage: StorageLike | null = defaultStorage(),
): void {
  try {
    storage?.removeItem(KEY_PREFIX + assignmentId);
  } catch {
    // ignore
  }
}

/** Per-permission fix instructions shown when the browser or OS blocks access. */
export function permissionFixSteps(
  kind: 'camera' | 'microphone' | 'screen',
  userAgent: string,
): string[] {
  const label = kind === 'camera' ? 'Camera' : kind === 'microphone' ? 'Microphone' : 'Screen';
  if (kind === 'screen') {
    if (/Electron/i.test(userAgent))
      return [
        'Open System Settings → Privacy & Security → Screen & System Audio Recording.',
        'Turn on the switch next to this exam app, then fully quit and reopen the app.',
        'Sign back in and return to this setup.',
      ];
    if (/Mac/i.test(userAgent))
      return [
        'Open System Settings → Privacy & Security → Screen & System Audio Recording.',
        'Turn on your browser, then quit and reopen it if macOS asks.',
        'Return to this page; setup resumes where you left off.',
      ];
    return [
      'Allow your browser to capture the screen in your operating system privacy settings.',
      'Press Start screen recording again and choose your entire screen.',
    ];
  }
  if (/Electron/i.test(userAgent))
    return [
      `Open System Settings → Privacy & Security → ${label}.`,
      'Turn on the switch next to this exam app, then fully quit and reopen the app.',
      'Sign back in and return to this setup.',
    ];
  if (/Mac/i.test(userAgent))
    return [
      `Click the lock icon at the left of the address bar and set ${label} to Allow.`,
      `If it is still blocked: System Settings → Privacy & Security → ${label}, and turn on your browser.`,
      'Reload this page (the browser may ask you to relaunch); setup resumes where you left off.',
    ];
  return [
    `Click the lock icon at the left of the address bar and set ${label} to Allow.`,
    `Check your operating system privacy settings allow the browser to use the ${label.toLowerCase()}.`,
    'Reload this page; setup resumes where you left off.',
  ];
}

/** What the exam page needs to know about the pre-exam setup the student just completed. */
export interface ExamSetupSummary {
  readonly identityVerified: boolean;
  readonly phoneUsed: boolean;
}
