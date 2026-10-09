// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';

import { permissionFixSteps } from '../exam/setupFlow.js';
import {
  MAC_SCREEN_RECORDING_BLOCKED,
  MAC_SCREEN_RECORDING_RESET_STEPS,
  describeDesktopCaptureFailure,
  readScreenCaptureDiagnosis,
} from './screenCaptureGuidance.js';

const domError = (name: string, message: string) => Object.assign(new Error(message), { name });

afterEach(() => Reflect.deleteProperty(window, 'electronExam'));

it("maps Electron's opaque refusals and macOS capture failures to the reset guidance", () => {
  for (const error of [
    domError('NotAllowedError', 'Invalid capture constraints'),
    domError('AbortError', 'Invalid capture constraints'),
    domError('NotAllowedError', 'Permission denied'),
    domError('NotAllowedError', 'Permission denied by system'),
    domError('NotReadableError', 'Could not start video source'),
    domError('AbortError', 'Error starting screen capture'),
    new Error('invalid capture constraints'),
  ]) {
    expect(describeDesktopCaptureFailure(error, null)).toBe(MAC_SCREEN_RECORDING_BLOCKED);
  }
  // The app's own diagnosis wins even when the DOMException is unspecific.
  for (const lastRefusal of ['permission', 'no-sources', 'sources-failed']) {
    expect(
      describeDesktopCaptureFailure(new Error('x'), { permission: 'granted', lastRefusal }),
    ).toBe(MAC_SCREEN_RECORDING_BLOCKED);
  }
  for (const permission of ['denied', 'restricted', 'not-determined']) {
    expect(describeDesktopCaptureFailure(new Error('x'), { permission, lastRefusal: null })).toBe(
      MAC_SCREEN_RECORDING_BLOCKED,
    );
  }
});

it('keeps gesture, cancel and unsupported-build cases apart and leaves the rest alone', () => {
  const ok = { permission: 'granted', lastRefusal: null };
  for (const lastRefusal of ['gesture', 'busy']) {
    expect(describeDesktopCaptureFailure(new Error('x'), { ...ok, lastRefusal })).toMatch(
      /Click Start screen recording again/u,
    );
  }
  expect(describeDesktopCaptureFailure(domError('InvalidStateError', 'x'), null)).toMatch(
    /Click Start screen recording again/u,
  );
  expect(
    describeDesktopCaptureFailure(new Error('x'), { ...ok, lastRefusal: 'cancelled' }),
  ).toMatch(/cancelled/u);
  expect(describeDesktopCaptureFailure(domError('NotSupportedError', 'x'), ok)).toMatch(
    /not configured in this desktop build/u,
  );
  expect(describeDesktopCaptureFailure(new Error('Something else'), ok)).toBeNull();
  expect(describeDesktopCaptureFailure(new Error('Something else'), null)).toBeNull();
});

it('shows the ad-hoc build recovery (remove and re-add, or tccutil reset) in the setup step', () => {
  const steps = permissionFixSteps('screen', 'Mozilla/5.0 (Macintosh) Electron/44.0.0');
  expect(steps).toEqual(MAC_SCREEN_RECORDING_RESET_STEPS);
  expect(steps.join('\n')).toMatch(/Quit ExamGuard/u);
  expect(steps.join('\n')).toMatch(/tccutil reset ScreenCapture com\.examguard\.desktop/u);
  expect(steps.join('\n')).toMatch(/“–”.*“\+”/u);
  expect(steps.join('\n')).toMatch(/\/Applications\/ExamGuard\.app/u);
  // Browsers keep their own guidance.
  expect(permissionFixSteps('screen', 'Mozilla/5.0 (Macintosh) Safari').join('\n')).not.toMatch(
    /tccutil/u,
  );
});

it('reads the diagnosis from the Mac app and tolerates its absence or failure', async () => {
  expect(await readScreenCaptureDiagnosis()).toBeNull();
  Object.assign(window, {
    electronExam: {
      getScreenCaptureDiagnosis: async () => ({ permission: 'denied', lastRefusal: 'permission' }),
    },
  });
  expect(await readScreenCaptureDiagnosis()).toEqual({
    permission: 'denied',
    lastRefusal: 'permission',
  });
  Object.assign(window, {
    electronExam: {
      getScreenCaptureDiagnosis: async () => {
        throw new Error('ipc');
      },
    },
  });
  expect(await readScreenCaptureDiagnosis()).toBeNull();
  Object.assign(window, { electronExam: { getScreenCaptureDiagnosis: async () => ({}) } });
  expect(await readScreenCaptureDiagnosis()).toBeNull();
});
