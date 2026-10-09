// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { PhonePlacementCard } from './PhonePlacementCard.js';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

it('renders an accessible placement diagram with the guidance text', async () => {
  const container = document.createElement('div');
  const root = createRoot(container);
  await act(async () => root.render(<PhonePlacementCard />));
  expect(container.querySelector('svg[role="img"]')?.getAttribute('aria-label')).toContain(
    '45 degree',
  );
  expect(container.textContent).toContain('How to place your phone');
  expect(container.textContent).toContain('about 1 m');
  await act(async () => root.unmount());
});
