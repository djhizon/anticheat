// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { ExamApi } from '../exam/api.js';
import { NativePhoneModal } from './NativePhoneModal.js';

it('moves focus in, traps Tab, closes on Escape and restores focus', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const opener = document.createElement('button');
  document.body.append(opener);
  opener.focus();
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const onClose = vi.fn();
  const api = {} as unknown as ExamApi;
  await act(async () =>
    root.render(<NativePhoneModal attemptId="a" api={api} onClose={onClose} />),
  );
  const dialog = container.querySelector('[role="dialog"]')!;
  expect(dialog.contains(document.activeElement)).toBe(true);
  const buttons = Array.from(dialog.querySelectorAll('button')).filter((b) => !b.disabled);
  const last = buttons[buttons.length - 1]!;
  last.focus();
  const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
  document.dispatchEvent(tab);
  expect(tab.defaultPrevented).toBe(true);
  expect(dialog.contains(document.activeElement)).toBe(true);
  expect(document.activeElement).not.toBe(last);
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(container.textContent).not.toContain(',,');
  await act(async () => root.unmount());
  expect(document.activeElement).toBe(opener);
});
