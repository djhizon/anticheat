import * as tf from '@tensorflow/tfjs-node';
import * as handPoseDetection from '@tensorflow-models/hand-pose-detection';

let detector: handPoseDetection.HandDetector | null = null;

async function getDetector() {
  if (!detector) {
    const model = handPoseDetection.SupportedModels.MediaPipeHands;
    const detectorConfig: handPoseDetection.MediaPipeHandsTfjsModelConfig = {
      runtime: 'tfjs',
      modelType: 'lite',
    };
    detector = await handPoseDetection.createDetector(model, detectorConfig);
  }
  return detector;
}

export async function verifyGestureLocally(imageBase64: string, expectedGesture: string): Promise<{ passed: boolean; detail: string }> {
  try {
    const buffer = Buffer.from(imageBase64, 'base64');
    const tensor = tf.node.decodeImage(buffer, 3);
    const det = await getDetector();
    
    // We need to cast the tensor to the right interface if types are strict
    const hands = await det.estimateHands(tensor as any);
    tensor.dispose();

    if (hands.length === 0) {
      return { passed: false, detail: 'No hands detected in the image.' };
    }

    const hand = hands[0]!;
    
    // Simple heuristic to count extended fingers based on landmarks
    // Landmarks array: 0 is wrist. 
    // Thumb: 1, 2, 3, 4 (tip)
    // Index: 5, 6, 7, 8 (tip)
    // Middle: 9, 10, 11, 12 (tip)
    // Ring: 13, 14, 15, 16 (tip)
    // Pinky: 17, 18, 19, 20 (tip)
    const keypoints3D = hand.keypoints3D;
    if (!keypoints3D) {
       return { passed: false, detail: 'Could not extract 3D hand keypoints.' };
    }

    const isExtended = (tipIdx: number, dipIdx: number) => {
      // Very basic: if tip is higher than dip (y is smaller since top is 0)
      return keypoints3D[tipIdx]!.y < keypoints3D[dipIdx]!.y;
    };

    const thumbExtended = isExtended(4, 3);
    const indexExtended = isExtended(8, 7);
    const middleExtended = isExtended(12, 11);
    const ringExtended = isExtended(16, 15);
    const pinkyExtended = isExtended(20, 19);

    const extendedCount = [indexExtended, middleExtended, ringExtended, pinkyExtended].filter(Boolean).length;

    let passed = false;
    let detail = `Detected ${extendedCount} fingers extended.`;

    if (expectedGesture === 'fingers_1') {
      passed = extendedCount === 1;
    } else if (expectedGesture === 'fingers_2') {
      passed = extendedCount === 2;
    } else if (expectedGesture === 'fingers_3') {
      passed = extendedCount === 3;
    } else if (expectedGesture === 'thumbs_up') {
      passed = thumbExtended && extendedCount === 0;
      detail = passed ? 'Thumbs up detected.' : 'Thumbs up not detected.';
    }

    return { passed, detail: passed ? 'Gesture confirmed.' : detail };

  } catch (err) {
    console.error(err);
    return { passed: false, detail: 'Internal model error during verification.' };
  }
}
