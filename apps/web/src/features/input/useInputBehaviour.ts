import { useEffect, useRef } from 'react';
import type { InputBehaviourEvent, InputBehaviourWindow } from '@examguard/contracts/exam';

import { EVIDENCE_TRIGGER_EVENT } from '../evidence/useEvidenceCapture.js';
import { createInputBehaviourCollector } from './inputCollector.js';
import { loadTypingBaseline } from './typingBaseline.js';

/** The two exam API calls the hook needs; the real `ExamApi` satisfies this. */
export interface InputBehaviourApi {
  uploadTelemetry(attemptId: string, payload: unknown): Promise<unknown>;
  patchEvents(attemptId: string, body: Record<string, unknown>): Promise<unknown>;
}

/** Telemetry must never break the exam: swallow sync throws and rejected promises alike. */
function fireAndForget(call: () => Promise<unknown> | undefined): void {
  try {
    void Promise.resolve(call()).catch(() => {});
  } catch {
    // ignored on purpose
  }
}

/**
 * Pointer and typing-rhythm signals for one in-progress attempt. Pass `null` when the
 * attempt is not in progress. Uploads 20 s aggregate windows through /telemetry and
 * notable patterns through the events endpoint. Nothing typed and no coordinates are sent.
 */
export function useInputBehaviour(
  attemptId: string | null | undefined,
  api: InputBehaviourApi | undefined,
): void {
  const apiRef = useRef(api);
  apiRef.current = api;
  const enabled = attemptId !== null && attemptId !== undefined && api !== undefined;

  useEffect(() => {
    if (!enabled || attemptId === null || attemptId === undefined) return;
    const collector = createInputBehaviourCollector({
      baseline: loadTypingBaseline(),
      emitEvent: (event: InputBehaviourEvent) => {
        fireAndForget(() => apiRef.current?.patchEvents(attemptId, { event }));
      },
      flushWindow: (window: InputBehaviourWindow) => {
        fireAndForget(() => apiRef.current?.uploadTelemetry(attemptId, { input: [window] }));
      },
      onInjection: () => {
        window.dispatchEvent(
          new CustomEvent(EVIDENCE_TRIGGER_EVENT, {
            detail: { trigger: 'text_injected', immediate: true },
          }),
        );
      },
    });
    return () => collector.stop();
  }, [enabled, attemptId]);
}
