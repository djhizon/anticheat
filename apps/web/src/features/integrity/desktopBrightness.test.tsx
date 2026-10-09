// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  brightnessTip,
  parseBrightnessReply,
  useBrightnessState,
  useExamBrightness,
} from './desktopBrightness.js';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function Probe({ attemptId }: { attemptId: string | null }) {
  useExamBrightness(attemptId);
  return <p>{brightnessTip(useBrightnessState())}</p>;
}

afterEach(() => {
  delete (window as unknown as { electronExam?: unknown }).electronExam;
});

describe('desktop brightness hook', () => {
  it('says plainly that a browser cannot change brightness and calls nothing', async () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => root.render(<Probe attemptId="a1" />));
    expect(container.textContent).toContain('Browsers cannot change your screen brightness');
    await act(async () => root.unmount());
  });

  it('boosts on exam start and restores on exit in the desktop app', async () => {
    const boostBrightness = vi.fn(async () => ({ status: 'boosted', enforcing: true }));
    const restoreBrightness = vi.fn(async () => ({ status: 'restored' }));
    (window as unknown as { electronExam: unknown }).electronExam = {
      boostBrightness,
      restoreBrightness,
    };
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => root.render(<Probe attemptId="a1" />));
    expect(boostBrightness).toHaveBeenCalledWith('a1');
    expect(container.textContent).toContain('set to maximum');
    await act(async () => root.unmount());
    expect(restoreBrightness).toHaveBeenCalledTimes(1);
  });

  it('falls back to the manual tip when the display is unsupported', async () => {
    (window as unknown as { electronExam: unknown }).electronExam = {
      boostBrightness: async () => ({ status: 'unsupported', enforcing: false }),
      restoreBrightness: async () => ({ status: 'restored' }),
    };
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => root.render(<Probe attemptId="a1" />));
    expect(container.textContent).toContain('could not change your screen brightness');
    await act(async () => root.unmount());
  });

  it('rejects malformed replies', () => {
    expect(parseBrightnessReply(null)).toBeNull();
    expect(parseBrightnessReply({ status: 'weird' })).toBeNull();
    expect(parseBrightnessReply({ status: 'boosted', enforcing: true })).toEqual({
      status: 'boosted',
      enforcing: true,
    });
  });
});
