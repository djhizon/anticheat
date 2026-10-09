// @vitest-environment jsdom
import type { InputBehaviourEvent, InputBehaviourWindow } from '@exam-anti-cheat/contracts/exam';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { createInputBehaviourCollector } from './inputCollector.js';

let clock = 0;
let events: InputBehaviourEvent[] = [];
let windows: InputBehaviourWindow[] = [];
let injections = 0;
let collector: ReturnType<typeof createInputBehaviourCollector>;
let area: HTMLTextAreaElement;

beforeEach(() => {
  vi.useFakeTimers();
  clock = 0;
  events = [];
  windows = [];
  injections = 0;
  document.body.innerHTML =
    '<p id="q">What is the capital of France? Explain.</p><textarea></textarea>';
  area = document.querySelector('textarea')!;
  collector = createInputBehaviourCollector({
    emitEvent: (e) => events.push(e),
    flushWindow: (w) => windows.push(w),
    onInjection: () => (injections += 1),
    now: () => clock,
    epoch: () => 1_700_000_000_000 + clock,
  });
});

afterEach(() => {
  collector.stop();
  vi.useRealTimers();
});

function insert(text: string, init: InputEventInit = {}): void {
  area.value += text;
  area.dispatchEvent(
    new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText', ...init }),
  );
}

function key(type: 'keydown' | 'keyup', k: string, code = `Key${k.toUpperCase()}`): void {
  area.dispatchEvent(new KeyboardEvent(type, { key: k, code, bubbles: true }));
}

it('reports text injection once and asks for an evidence snapshot', () => {
  area.focus();
  clock = 1000;
  insert('x'.repeat(120));
  expect(events).toEqual(['text_injected']);
  expect(injections).toBe(1);
  collector.flush();
  expect(windows[0]).toMatchObject({ injections: 1, idlePointerInjections: 0 });
});

it('marks an injection while the pointer was idle', () => {
  area.focus();
  clock = 30_000;
  insert('y'.repeat(100));
  collector.flush();
  expect(windows[0]).toMatchObject({ injections: 1, idlePointerInjections: 1 });
});

it('does not flag IME composition, replacement text, or normal keystrokes', () => {
  area.focus();
  clock = 1000;
  insert('こんにちは'.repeat(20), { inputType: 'insertCompositionText', isComposing: true });
  insert('z'.repeat(60), { inputType: 'insertReplacementText' });
  for (let i = 0; i < 80; i++) {
    clock += 120;
    key('keydown', 'a', 'KeyA');
    insert('a');
    clock += 60;
    key('keyup', 'a', 'KeyA');
  }
  expect(events).toEqual([]);
  collector.flush();
  expect(windows[0]).toMatchObject({ chars: 80, keys: 80, injections: 0 });
  expect(windows[0]!.meanDwellMs).toBe(60);
});

it('never puts typed text or key names into a window', () => {
  area.focus();
  clock = 500;
  key('keydown', 'q');
  key('keyup', 'q');
  insert('q');
  collector.flush();
  const serialised = JSON.stringify(windows);
  expect(serialised).not.toContain('"q"');
  expect(Object.keys(windows[0]!)).not.toContain('key');
});

it('blocks a text drop and reports it', () => {
  const drop = new Event('drop', { bubbles: true, cancelable: true });
  area.dispatchEvent(drop);
  expect(drop.defaultPrevented).toBe(true);
  expect(events).toEqual(['drop_blocked']);
});

it('reports copying page text but not copying from the answer box', () => {
  const selection = vi.spyOn(document, 'getSelection');
  selection.mockReturnValue({ toString: () => 'capital of France' } as Selection);
  document.body.focus();
  document.dispatchEvent(new Event('copy', { bubbles: true }));
  expect(events).toEqual(['copy_question']);

  events.length = 0;
  clock = 40_000;
  area.focus();
  document.dispatchEvent(new Event('copy', { bubbles: true }));
  expect(events).toEqual([]);
  selection.mockRestore();
});

it('counts context menus and leaves, and raises the long-outside event while focused', () => {
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  document.dispatchEvent(new Event('contextmenu', { bubbles: true }));
  clock = 1000;
  document.documentElement.dispatchEvent(
    new MouseEvent('mouseleave', { clientX: 1020, clientY: 300, buttons: 0 }),
  );
  clock = 7000;
  collector.tick();
  expect(events).toEqual(['pointer_outside_long']);
  clock = 13_000;
  document.documentElement.dispatchEvent(new MouseEvent('mouseenter'));
  collector.flush();
  expect(windows[0]).toMatchObject({
    contextMenus: 1,
    pointerLeaves: 1,
    pointerOutsideMs: 12_000,
    longestOutsideMs: 12_000,
  });
});

it('does not raise the long-outside event when the window is not focused', () => {
  vi.spyOn(document, 'hasFocus').mockReturnValue(false);
  document.documentElement.dispatchEvent(new MouseEvent('mouseleave', { buttons: 0 }));
  clock = 20_000;
  collector.tick();
  expect(events).toEqual([]);
});

it('uploads nothing for a window with no activity and flushes on a timer', () => {
  collector.flush();
  expect(windows).toEqual([]);
  area.focus();
  insert('hi');
  vi.advanceTimersByTime(20_000);
  expect(windows).toHaveLength(1);
});
