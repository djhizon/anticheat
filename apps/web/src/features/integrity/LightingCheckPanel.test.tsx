// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isLightBoostOn, setLightBoost } from './lightBoost.js';
import { LightingCheckPanel, type LightingCheckResult } from './LightingCheckPanel.js';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const W = 64;
const frameOf = (bg: number, face: number): Float32Array => {
  const out = new Float32Array(W * W).fill(bg);
  // Centre region is the face stand-in when no face box is supplied.
  for (let y = Math.floor(0.2 * W); y < Math.ceil(0.75 * W); y += 1)
    for (let x = Math.floor(0.3 * W); x < Math.ceil(0.7 * W); x += 1) out[y * W + x] = face;
  return out;
};

const picture = vi.hoisted(() => ({ bg: 120, face: 130 }));
vi.mock('./lightingSampler.js', () => ({
  createStreamLightingSampler: () => ({
    sample: async () => ({
      frames: [frameOf(picture.bg, picture.face), frameOf(picture.bg, picture.face)],
      width: 64,
      height: 64,
    }),
    dispose: () => {},
  }),
}));

const stream = { getVideoTracks: () => [] } as unknown as MediaStream;
const sleep = (ms: number) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));

async function mount(props: Partial<Parameters<typeof LightingCheckPanel>[0]> = {}) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const onResult = vi.fn<(result: LightingCheckResult) => void>();
  await act(async () =>
    root.render(
      <LightingCheckPanel
        stream={stream}
        onResult={onResult}
        sampleIntervalMs={15}
        warnAfterMs={120}
        {...props}
      />,
    ),
  );
  return { container, root, onResult };
}

afterEach(() => {
  setLightBoost(false);
  document.body.innerHTML = '';
  picture.bg = 120;
  picture.face = 130;
});

describe('LightingCheckPanel', () => {
  it('shows the live classification and passes once when lighting is good', async () => {
    const { container, root, onResult } = await mount();
    await sleep(100);
    expect(container.textContent).toContain('Lighting looks good');
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult.mock.calls[0]![0]).toMatchObject({ outcome: 'good', class: 'good' });
    expect(container.textContent).not.toContain('Continue with a lighting warning');
    await act(async () => root.unmount());
  });

  it('shows specific tips for a dark face and offers Continue after the timeout', async () => {
    picture.bg = 30;
    picture.face = 25;
    const { container, root, onResult } = await mount();
    await sleep(60);
    expect(container.textContent).toContain('Your face is too dark');
    expect(container.textContent).toContain('Turn on a light in front of you');
    expect(container.textContent).toContain('Raise screen brightness');
    expect(onResult).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain('Continue with a lighting warning');
    await sleep(120);
    const button = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Continue with a lighting warning'),
    )!;
    expect(button).toBeDefined();
    await act(async () => button.click());
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult.mock.calls[0]![0]).toMatchObject({ outcome: 'warning', class: 'too_dark' });
    await act(async () => root.unmount());
  });

  it('tells a backlit student not to sit with a window behind them', async () => {
    picture.bg = 230;
    picture.face = 70;
    const { container, root } = await mount();
    await sleep(60);
    expect(container.textContent).toContain('You are backlit');
    expect(container.textContent).toContain("Don't sit with a window");
    await act(async () => root.unmount());
  });

  it('toggles the Boost light frame and removes it when unmounted', async () => {
    picture.bg = 30;
    picture.face = 25;
    const { container, root } = await mount();
    const toggle = [...container.querySelectorAll('button')].find(
      (b) => b.textContent === 'Boost light',
    )!;
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    await act(async () => toggle.click());
    expect(isLightBoostOn()).toBe(true);
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(document.getElementById('light-boost-frame')).not.toBeNull();
    await act(async () => root.unmount());
    expect(document.getElementById('light-boost-frame')).toBeNull();
  });

  it('says plainly that a browser cannot change brightness', async () => {
    const { container, root } = await mount();
    expect(container.textContent).toContain('Browsers cannot change your screen brightness');
    await act(async () => root.unmount());
  });
});
