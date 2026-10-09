// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanionApp } from './CompanionApp.js';

afterEach(() => vi.unstubAllGlobals());
it.each([true, false])('reports heartbeat acknowledgement truthfully: %s', async (accepted) => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  window.history.replaceState(null, '', '/companion?token=synthetic-fixture');
  const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ({
    ok: true,
    json: async () => ({ ok: accepted }),
  }));
  vi.stubGlobal('fetch', fetch);
  vi.stubGlobal('isSecureContext', false);
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(async () => root.render(<CompanionApp />));
    expect(fetch.mock.calls[0]?.[0]).toBe('/exam/phone-heartbeat');
    expect(container.textContent).toContain(
      accepted ? 'heartbeat acknowledged' : 'Enrollment rejected',
    );
    expect(container.textContent).toContain('Microphone access requires a trusted HTTPS');
    expect(container.querySelector('button')).toBeNull();
  } finally {
    await act(async () => root.unmount());
  }
});
