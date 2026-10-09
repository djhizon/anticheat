// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

import { EvidenceGallery } from './EvidenceGallery.js';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const container = document.createElement('div');
document.body.append(container);
let root = createRoot(container);
afterEach(async () => {
  await act(async () => root.unmount());
  root = createRoot(container);
});

const snapshots = [
  {
    id: 's1',
    source: 'webcam' as const,
    trigger: 'multiple_faces' as const,
    capturedAt: '2026-10-10T01:00:00.000Z',
  },
  {
    id: 's2',
    source: 'screen' as const,
    trigger: 'overlay_detected' as const,
    capturedAt: '2026-10-10T01:05:00.000Z',
  },
];

it('lists thumbnails with trigger and time, and enlarges one on click', async () => {
  const listEvidence = vi.fn(async () => snapshots);
  const loadImage = vi.fn(async (_attempt: string, id: string) => `http://img.test/${id}.jpg`);
  await act(async () =>
    root.render(
      <EvidenceGallery attemptId="attempt-1" listEvidence={listEvidence} loadImage={loadImage} />,
    ),
  );
  expect(listEvidence).toHaveBeenCalledWith('attempt-1');
  expect(loadImage).toHaveBeenCalledTimes(2);
  expect(container.textContent).toContain('More than one face · Webcam');
  expect(container.textContent).toContain('Overlay detected · Screen');
  const images = [...container.querySelectorAll('img')];
  expect(images.map((image) => image.getAttribute('src'))).toEqual([
    'http://img.test/s1.jpg',
    'http://img.test/s2.jpg',
  ]);
  expect(container.querySelector('[role="dialog"]')).toBeNull();

  await act(async () =>
    container.querySelectorAll<HTMLButtonElement>('.evidence-thumb')[1]!.click(),
  );
  const dialog = container.querySelector('[role="dialog"]');
  expect(dialog?.querySelector('img')?.getAttribute('src')).toBe('http://img.test/s2.jpg');
  await act(async () =>
    [...dialog!.querySelectorAll('button')].find((b) => b.textContent === 'Close')!.click(),
  );
  expect(container.querySelector('[role="dialog"]')).toBeNull();
});

it('lightbox is modal: focuses Close, traps Tab, closes on Escape and returns focus', async () => {
  await act(async () =>
    root.render(
      <EvidenceGallery
        attemptId="attempt-2"
        listEvidence={async () => snapshots}
        loadImage={async (_attempt: string, id: string) => `http://img.test/${id}.jpg`}
      />,
    ),
  );
  const thumb = container.querySelectorAll<HTMLButtonElement>('.evidence-thumb')[0]!;
  thumb.focus();
  await act(async () => thumb.click());
  const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(dialog.getAttribute('aria-modal')).toBe('true');
  const close = [...dialog.querySelectorAll('button')].find((b) => b.textContent === 'Close')!;
  expect(document.activeElement).toBe(close);

  const press = (key: string, shiftKey = false) => {
    const event = new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true });
    document.activeElement!.dispatchEvent(event);
    return event;
  };
  // Tab and Shift+Tab stay inside the lightbox (Close is its only control).
  await act(async () => void press('Tab'));
  expect(document.activeElement).toBe(close);
  await act(async () => void press('Tab', true));
  expect(document.activeElement).toBe(close);
  // Focus that wandered outside is pulled back by the next Tab.
  thumb.focus();
  expect(press('Tab').defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(close);

  await act(async () => void press('Escape'));
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(thumb);

  // Closing with the button also returns focus to the thumbnail that opened it.
  const second = container.querySelectorAll<HTMLButtonElement>('.evidence-thumb')[1]!;
  await act(async () => second.click());
  const closeAgain = [...container.querySelectorAll('[role="dialog"] button')].find(
    (b) => b.textContent === 'Close',
  ) as HTMLButtonElement;
  expect(document.activeElement).toBe(closeAgain);
  await act(async () => closeAgain.click());
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(second);
});

it('shows an empty state and a load failure', async () => {
  await act(async () =>
    root.render(
      <EvidenceGallery attemptId="a" listEvidence={async () => []} loadImage={async () => ''} />,
    ),
  );
  expect(container.textContent).toContain('No snapshots were saved');
  await act(async () =>
    root.render(
      <EvidenceGallery
        attemptId="b"
        listEvidence={async () => {
          throw new Error('nope');
        }}
        loadImage={async () => ''}
      />,
    ),
  );
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('could not be loaded');
});
