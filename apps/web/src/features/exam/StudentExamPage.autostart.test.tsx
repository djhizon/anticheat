// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { ExamDeliveryProjection } from '@examguard/contracts/exam';
import type { ExamApi } from './api.js';
import { StudentExamPage } from './StudentExamPage.js';

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

it('passes autoStart to both panels for a consented in-progress attempt', async () => {
  await render('in_progress', true);
  expect(last(seen.camera)).toMatchObject({ autoStart: true });
  expect(last(seen.audio)).toMatchObject({ autoStart: true, active: true });
});
it('does not auto-start without consent and leaves submitted attempts inactive', async () => {
  await render('in_progress', false);
  expect(last(seen.camera)).toMatchObject({ autoStart: false });
  expect(last(seen.audio)).toMatchObject({ autoStart: false });
  await act(async () => root.unmount());
  root = createRoot(container);
  await render('submitted', true);
  expect(last(seen.audio)).toMatchObject({ active: false });
});
it('never opens the liveness check automatically', async () => {
  await render('in_progress', true);
  expect(seen.liveness).toBe(0);
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  expect(container.textContent).toContain("Verify I'm here");
});
