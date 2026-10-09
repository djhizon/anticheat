import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { mayCloseApps, parseRunMode, planModeSwitch } from './mode';
import { readRunMode, writeRunMode } from './settings';

describe('run mode', () => {
  it('defaults to demo for missing or corrupt settings', () => {
    for (const raw of [undefined, '', 'nope', '{}', '{"mode":"x"}', '[]', 'null'])
      expect(parseRunMode(raw)).toBe('demo');
    expect(parseRunMode('{"mode":"strict"}')).toBe('strict');
  });
  it('only strict mode may close apps', () => {
    expect(mayCloseApps('demo')).toBe(false);
    expect(mayCloseApps('strict')).toBe(true);
  });
  it('asks for confirmation only when switching to strict', () => {
    expect(planModeSwitch('demo', 'strict')).toEqual({ change: true, confirm: true });
    expect(planModeSwitch('strict', 'demo')).toEqual({ change: true, confirm: false });
    expect(planModeSwitch('demo', 'demo')).toEqual({ change: false, confirm: false });
    expect(planModeSwitch('strict', 'strict')).toEqual({ change: false, confirm: false });
  });
});

describe('settings file', () => {
  it('round-trips and is owner-only, even when a looser file already exists', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'settings-'));
    try {
      expect(readRunMode(dir)).toBe('demo');
      writeFileSync(path.join(dir, 'settings.json'), '{}', { mode: 0o644 });
      writeRunMode(dir, 'strict');
      expect(readRunMode(dir)).toBe('strict');
      expect(statSync(path.join(dir, 'settings.json')).mode & 0o777).toBe(0o600);
      writeRunMode(dir, 'demo');
      expect(readRunMode(dir)).toBe('demo');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
