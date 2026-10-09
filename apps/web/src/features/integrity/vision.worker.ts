import { FaceLandmarker, FilesetResolver, ObjectDetector } from '@mediapipe/tasks-vision';
import ModuleFactory from '@mediapipe/tasks-vision/vision_wasm_module_internal.js';
import { poseFromMatrix, type VisionReply } from './visionSignals.js';

let face: FaceLandmarker | null = null;
let phone: ObjectDetector | null = null;
let earbuds: ObjectDetector | null = null;
let smartGlasses: ObjectDetector | null = null;
let initializing = false;

// Rolling buffer of nose-tip x positions for jitter calculation (last 10 frames)
const noseXBuffer: number[] = [];
const JITTER_WINDOW = 10;

const worker = self as unknown as {
  ModuleFactory?: unknown;
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(value: VisionReply): void;
};

async function initialize(objects: boolean): Promise<void> {
  const resolved = await FilesetResolver.forVisionTasks('/vision/wasm', true);
  const files = { ...resolved, wasmLoaderPath: '' };
  worker.ModuleFactory = ModuleFactory;
  face = await FaceLandmarker.createFromOptions(files, {
    baseOptions: { modelAssetPath: '/vision/models/face_landmarker.task', delegate: 'CPU' },
    runningMode: 'VIDEO',
    numFaces: 2,
    outputFaceBlendshapes: true,       // ← enable blink detection
    outputFacialTransformationMatrixes: true,
  });
  if (objects) {
  worker.ModuleFactory = ModuleFactory;
  try { phone = await ObjectDetector.createFromOptions(files, {
    baseOptions: { modelAssetPath: '/vision/models/efficientdet_lite0.tflite', delegate: 'CPU' },
    runningMode: 'VIDEO',
    categoryAllowlist: ['cell phone'],
    scoreThreshold: 0.6,
    maxResults: 1,
  }); } catch { phone = null; }
  
  // Custom Earbuds Model (requires user to drop a custom earbuds.tflite model into public/vision/models)
  try {
    earbuds = await ObjectDetector.createFromOptions(files, {
      baseOptions: { modelAssetPath: '/vision/models/earbuds_custom.tflite', delegate: 'CPU' },
      runningMode: 'VIDEO',
      scoreThreshold: 0.5,
      maxResults: 2,
    });
  } catch (e) {}

  try {
    smartGlasses = await ObjectDetector.createFromOptions(files, {
      baseOptions: { modelAssetPath: '/vision/models/smart_glasses_custom.tflite', delegate: 'CPU' },
      runningMode: 'VIDEO',
      scoreThreshold: 0.5,
      maxResults: 1,
    });
  } catch (e) {}

  }

  // Warm up both engines
  const canvas = new OffscreenCanvas(640, 480);
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('Canvas unavailable');
  context.fillRect(0, 0, 640, 480);
  const timestamp = performance.now();
  face.detectForVideo(canvas, timestamp);
  phone?.detectForVideo(canvas, timestamp);
}

/** Compute std-dev of a number array — used for jitter. */
function stdDev(arr: number[]): number {
  if (arr.length < 2) return 0;
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const variance = arr.reduce((sum, v) => sum + (v - mean) ** 2, 0) / arr.length;
  return Math.sqrt(variance);
}

worker.onmessage = (event: MessageEvent<{ type: string; bitmap?: ImageBitmap; objects?: boolean }>) => {
  const { type, bitmap } = event.data;
  if (type === 'init' && !initializing) {
    initializing = true;
    void initialize(event.data.objects === true).then(
      () => worker.postMessage({ type: 'ready' }),
      () => worker.postMessage({ type: 'error' }),
    );
    return;
  }
  if (type !== 'frame' || bitmap === undefined) return;
  try {
    if (face === null) throw new Error('Face model unavailable');
    const timestamp = performance.now();
    const faces = face.detectForVideo(bitmap, timestamp);
    const objects = phone?.detectForVideo(bitmap, timestamp);
    const earbudObjects = earbuds ? earbuds.detectForVideo(bitmap, timestamp) : { detections: [] };
    const glassObjects = smartGlasses ? smartGlasses.detectForVideo(bitmap, timestamp) : { detections: [] };

    // ── Blink score from blendshapes ──────────────────────────────────────
    let blinkScore = 0;
    const blendshapes = faces.faceBlendshapes[0]?.categories;
    if (blendshapes && blendshapes.length > 0) {
      const leftBlink = blendshapes.find(c => c.categoryName === 'eyeBlinkLeft')?.score ?? 0;
      const rightBlink = blendshapes.find(c => c.categoryName === 'eyeBlinkRight')?.score ?? 0;
      blinkScore = (leftBlink + rightBlink) / 2;
    }

    // ── Landmark jitter (nose tip x variance) ────────────────────────────
    const noseTip = faces.faceLandmarks[0]?.[1]; // landmark 1 = nose tip
    if (noseTip !== undefined) {
      noseXBuffer.push(noseTip.x);
      if (noseXBuffer.length > JITTER_WINDOW) noseXBuffer.shift();
    } else {
      noseXBuffer.length = 0;
    }
    const landmarkJitter = stdDev(noseXBuffer);

    // ── Pose ─────────────────────────────────────────────────────────────
    const matrix = faces.facialTransformationMatrixes[0];

    worker.postMessage({
      type: 'observation',
      observation: {
        faces: faces.faceLandmarks.length,
        pose: faces.faceLandmarks.length === 1 && matrix ? poseFromMatrix(matrix.data) : null,
        phoneAvailable: phone !== null,
        phone: objects?.detections.some((detection) =>
          detection.categories.some(
            (category) => category.categoryName === 'cell phone' && category.score >= 0.6,
          ),
        ) ?? false,
        blinkScore,
        earbuds: earbuds ? earbudObjects.detections.length > 0 : null,
        smartGlasses: smartGlasses ? glassObjects.detections.length > 0 : null,
        landmarkJitter,
      },
    });
  } catch {
    worker.postMessage({ type: 'error' });
  } finally {
    bitmap.close();
  }
};
