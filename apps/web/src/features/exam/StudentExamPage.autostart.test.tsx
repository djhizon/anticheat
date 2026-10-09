// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { ExamDeliveryProjection } from '@examguard/contracts/exam';
import type { ExamApi } from './api.js';
import { StudentExamPage } from './StudentExamPage.js';
import { holdSensorStreams, releaseSensorStreams } from '../integrity/sensorHub.js';

const liveStream = () =>
  ({ getTracks: () => [{ readyState: 'live', stop() {} }] }) as unknown as MediaStream;

const seen = vi.hoisted(() => ({ camera: [] as unknown[], audio: [] as unknown[], liveness: 0 }));
vi.mock('../integrity/CameraIntegrityPanel.js', () => ({
  CameraIntegrityPanel: (props: unknown) => {
    seen.camera.push(props);
    return <p>camera panel</p>;
  },
}));
vi.mock('../integrity/AudioPanel.js', () => ({
  AudioPanel: (props: unknown) => {
    seen.audio.push(props);
    return <p>audio panel</p>;
  },
}));
vi.mock('../integrity/LivenessModal.js', () => ({
  LivenessModal: () => {
    seen.liveness += 1;
    return <div role="dialog">liveness</div>;
  },
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const container = document.createElement('div');
document.body.append(container);
let root = createRoot(container);
afterEach(async () => {
  await act(async () => root.unmount());
  root = createRoot(container);
  seen.camera.length = 0;
  seen.audio.length = 0;
  seen.liveness = 0;
  releaseSensorStreams();
});

function delivery(status: string): ExamDeliveryProjection {
  return {
    exam: { id: 'e', versionId: 'v', title: 'Exam', versionNumber: 1, durationSeconds: 600 },
    assignment: { id: 'as', title: 'Exam' },
    attempt: {
      id: 'a',
      status,
      effectiveDeadline: new Date(Date.now() + 600000).toISOString(),
    },
    questions: [],
    answers: { revision: 0, answers: {} },
  } as unknown as ExamDeliveryProjection;
}
const examApi = {
  patchEvents: vi.fn(async () => {}),
  requirePhonePresence: vi.fn(),
} as unknown as ExamApi;
const render = (status: string, consented: boolean) =>
  act(async () =>
    root.render(
      <StudentExamPage
        delivery={delivery(status)}
        error={null}
        loading={false}
        onBack={() => {}}
        examApi={examApi}
        sensorsConsented={consented}
      />,
    ),
  );
const last = (list: unknown[]) => list.at(-1) as Record<string, unknown>;

it('passes autoStart to both panels when setup handed its streams over', async () => {
  holdSensorStreams({ camera: liveStream(), microphone: liveStream() });
  await render('in_progress', true);
  expect(last(seen.camera)).toMatchObject({ autoStart: true });
  expect(last(seen.audio)).toMatchObject({ autoStart: true, active: true });
});
it('does not auto-start without consent and leaves submitted attempts inactive', async () => {
  holdSensorStreams({ camera: liveStream(), microphone: liveStream() });
  await render('in_progress', false);
  expect(last(seen.camera)).toMatchObject({ autoStart: false });
  expect(last(seen.audio)).toMatchObject({ autoStart: false });
  await act(async () => root.unmount());
  root = createRoot(container);
  await render('submitted', true);
  expect(last(seen.audio)).toMatchObject({ active: false });
});
const buttonLabels = () =>
  [...container.querySelectorAll('button')].map((b) => b.textContent?.trim() ?? '');

it('shows read-only status chips and no setup buttons during the exam', async () => {
  holdSensorStreams({ camera: liveStream(), microphone: liveStream() });
  await render('in_progress', true);
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  const status = container.querySelector('[aria-label="Monitoring status"]')!;
  expect(status.textContent).toContain('Camera');
  expect(status.textContent).toContain('Mic');
  expect(status.textContent).toContain('iPhone');
  expect(status.textContent).toContain('Verified');
  expect(status.querySelector('button')).toBeNull();
  const labels = buttonLabels().join('|');
  expect(labels).not.toMatch(/Verify I|iPhone|Start|Stop|Pair|Require/);
  expect(labels).not.toContain('Resume monitoring');
});
it('offers a single Resume monitoring button when streams cannot be restored silently', async () => {
  await render('in_progress', true);
  const resume = buttonLabels().filter((label) => label === 'Resume monitoring');
  expect(resume).toHaveLength(1);
  expect(last(seen.camera)).toMatchObject({ autoStart: false });
});
