import type { HeadPose } from './visionSignals.js';

/** Camera-relative head pose, not eye gaze or proof of attention. */
export function faceDirection(pose: HeadPose | null): string {
  if (!pose || !Number.isFinite(pose.yaw) || !Number.isFinite(pose.pitch)) return 'Not calibrated';
  const horizontal = Math.abs(pose.yaw) > 20 ? (pose.yaw > 0 ? 'right →' : 'left ←') : '';
  const vertical = Math.abs(pose.pitch) > 20 ? (pose.pitch > 0 ? 'up ↑' : 'down ↓') : '';
  return horizontal || vertical
    ? `Facing ${[vertical, horizontal].filter(Boolean).join(' and ')}`
    : 'Facing forward';
}
