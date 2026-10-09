import { useEffect, useRef, type RefObject } from 'react';
import { EVIDENCE_TRIGGERS, type EvidenceTrigger } from '@exam-anti-cheat/contracts/exam';

import type { CameraSnapshot } from '../integrity/cameraSession.js';
import {
  createEvidenceCapture,
  screenSnapshotBridge,
  type GazeLookAway,
} from './evidenceCapture.js';
import type { EvidenceApi } from './evidenceApi.js';

/** Window event other modules dispatch for event-style triggers (detail: { trigger }). */
export const EVIDENCE_TRIGGER_EVENT = 'evidence-trigger';

/**
 * Hook-in for the camera panel: saves one still snapshot when local vision (or an overlay /
 * foreground-app report) holds an unusual condition. Does nothing when the API lacks it.
 */
export function useEvidenceCapture(options: {
  readonly attemptId: string;
  /** False while the attempt is inactive or answering is paused (camera gate): no snapshots. */
  readonly active: boolean;
  readonly snapshot: CameraSnapshot;
  readonly video: RefObject<HTMLVideoElement | null>;
  /** Latest eye-gaze look-away reading (fresh only); preferred over head pose when present. */
  readonly gaze?: (() => GazeLookAway | null) | undefined;
  readonly api: { readonly postEvidence?: EvidenceApi['postEvidence'] | undefined } | undefined;
}): void {
  const { attemptId, active, snapshot, video, api, gaze } = options;
  const capture = useRef<ReturnType<typeof createEvidenceCapture> | null>(null);
  const post = api?.postEvidence;

  useEffect(() => {
    if (!active || !post) return;
    const instance = createEvidenceCapture({
      attemptId,
      getVideo: () => video.current,
      post: (id, request) => post.call(api, id, request),
      screen: screenSnapshotBridge(),
    });
    capture.current = instance;
    const onViolation = (event: Event) => {
      if ((event as CustomEvent).detail === 'overlay_detected') {
        instance.observeEvent('overlay_detected');
      }
    };
    const onTrigger = (event: Event) => {
      const trigger = (event as CustomEvent<{ trigger?: string }>).detail?.trigger;
      if (trigger !== undefined && (EVIDENCE_TRIGGERS as readonly string[]).includes(trigger)) {
        instance.observeEvent(trigger as EvidenceTrigger);
      }
    };
    window.addEventListener('camera-violation', onViolation);
    window.addEventListener(EVIDENCE_TRIGGER_EVENT, onTrigger);
    return () => {
      window.removeEventListener('camera-violation', onViolation);
      window.removeEventListener(EVIDENCE_TRIGGER_EVENT, onTrigger);
      instance.stop();
      capture.current = null;
    };
    // `api` identity is stable per session; the bound method is what matters.
  }, [attemptId, active, post, video]);

  useEffect(() => {
    capture.current?.observeCamera(snapshot, gaze?.() ?? null);
  }, [snapshot]);
}
