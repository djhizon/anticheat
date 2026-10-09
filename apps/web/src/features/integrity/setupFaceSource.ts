/**
 * Face counter for the pre-exam camera step: the app's existing MediaPipe face-landmarker worker
 * run over the verified camera preview. Kept in its own module so the automated demo test (whose
 * synthetic camera shows no face) can replace it; see tests/e2e/vite.e2e.config.ts.
 */
export interface SetupFaceSource {
  /** Number of faces in the current frame, or null when the model returned nothing. */
  faces(): Promise<number | null>;
  close(): void;
}

export async function openSetupFaceSource(video: HTMLVideoElement): Promise<SetupFaceSource> {
  const { createWorkerPoseSource } = await import('./faceModelSource.js');
  const source = await createWorkerPoseSource(video);
  return {
    faces: async () => (await source.observe())?.faces ?? null,
    close: () => source.close(),
  };
}
