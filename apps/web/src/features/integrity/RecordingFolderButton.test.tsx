// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { RecordingFolderButton } from './RecordingFolderButton.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function mount() {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<RecordingFolderButton />));
  return host;
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  delete (window as unknown as { electronExam?: unknown }).electronExam;
});

it('opens the recordings folder through the desktop bridge', async () => {
  const openRecordingsFolder = vi.fn(async () => ({
    opened: true,
    path: '/Users/x/Movies/ExamGuard Recordings',
  }));
  (window as unknown as { electronExam: unknown }).electronExam = { openRecordingsFolder };
  const view = mount();
  const button = view.querySelector('button')!;
  expect(button.textContent).toBe('View screen recording');
  await act(async () => {
    button.click();
  });
  expect(openRecordingsFolder).toHaveBeenCalledOnce();
  expect(view.querySelector('[role="status"]')?.textContent).toContain('ExamGuard Recordings');
});

it('explains where recordings went in a plain browser', () => {
  const view = mount();
  expect(view.querySelector('button')).toBeNull();
  expect(view.textContent).toContain('Downloads folder');
});
