// E2E only (aliased in vite.e2e.config.ts): Chromium's synthetic camera shows no face, so the
// pre-exam face counter reports exactly one. The face-window logic and step gating are unchanged.
import type { SetupFaceSource } from '../../apps/web/src/features/integrity/setupFaceSource.js';

export async function openSetupFaceSource(_video: HTMLVideoElement): Promise<SetupFaceSource> {
  return { faces: async () => 1, close: () => {} };
}
