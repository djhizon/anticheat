/**
 * "Light boost": use the screen as a fill light. A thick white frame around the whole window
 * lights the student's face without covering the exam. A module-level store plus one imperative
 * overlay element, so the setup check and the in-exam monitor can share it without prop drilling.
 */
import { useSyncExternalStore } from 'react';

export const LIGHT_BOOST_FRAME_ID = 'light-boost-frame';
const FRAME_PX = 36;

let enabled = false;
const listeners = new Set<() => void>();

function applyOverlay(): void {
  if (typeof document === 'undefined') return;
  const existing = document.getElementById(LIGHT_BOOST_FRAME_ID);
  if (!enabled) {
    existing?.remove();
    return;
  }
  if (existing) return;
  const frame = document.createElement('div');
  frame.id = LIGHT_BOOST_FRAME_ID;
  frame.setAttribute('aria-hidden', 'true');
  Object.assign(frame.style, {
    position: 'fixed',
    inset: '0',
    border: `${FRAME_PX}px solid #ffffff`,
    boxSizing: 'border-box',
    pointerEvents: 'none',
    zIndex: '2147483000',
  });
  document.body.append(frame);
}

export function isLightBoostOn(): boolean {
  return enabled;
}

export function setLightBoost(on: boolean): void {
  if (enabled === on) return;
  enabled = on;
  applyOverlay();
  for (const listener of listeners) listener();
}

export function subscribeLightBoost(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useLightBoost(): boolean {
  return useSyncExternalStore(subscribeLightBoost, isLightBoostOn, () => false);
}
