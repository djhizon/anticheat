import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  defaultRunMode,
  isJudgeBuildMetadata,
  mayCloseApps,
  parseRunMode,
  planModeSwitch,
} from './mode';
import { persistRunMode, readJudgeBuild, readRunMode, writeRunMode } from './settings';

describe('run mode', () => {
  it('build default is demo for the judge build and strict everywhere else', () => {
    expect(defaultRunMode(true)).toBe('demo');
    expect(defaultRunMode(false)).toBe('strict');
  });
  it('missing or corrupt settings fall back to the build default, never to demo in strict', () => {
    for (const raw of [undefined, '', 'nope', '{}', '{"mode":"x"}', '[]', 'null']) {
      expect(parseRunMode(raw, 'strict')).toBe('strict');
      expect(parseRunMode(raw, 'demo')).toBe('demo');
    }
    expect(parseRunMode('{"mode":"strict"}', 'demo')).toBe('strict');
    expect(parseRunMode('{"mode":"demo"}', 'strict')).toBe('demo');
  });
  it('only strict mode may close apps', () => {
    expect(mayCloseApps('demo')).toBe(false);
    expect(mayCloseApps('strict')).toBe(true);
  });
  it('asks for confirmation in both directions', () => {
    expect(planModeSwitch('demo', 'strict')).toEqual({ change: true, confirm: true });
    expect(planModeSwitch('strict', 'demo')).toEqual({ change: true, confirm: true });
    expect(planModeSwitch('demo', 'demo')).toEqual({ change: false, confirm: false });
    expect(planModeSwitch('strict', 'strict')).toEqual({ change: false, confirm: false });
  });
  it('detects the judge flag only when explicitly true', () => {
    expect(isJudgeBuildMetadata('{"examJudgeBuild":true}')).toBe(true);
    for (const raw of [undefined, '', '{', '{}', '{"examJudgeBuild":"true"}', 'null', '[]'])
      expect(isJudgeBuildMetadata(raw)).toBe(false);
  });
});

describe('settings file', () => {
  function withDir(run: (dir: string) => void) {
    const dir = mkdtempSync(path.join(tmpdir(), 'settings-'));
    try {
      run(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  it('round-trips, is owner-only, and leaves no temp file behind', () =>
    withDir((dir) => {
      expect(readRunMode(dir, 'strict', true)).toBe('strict');
      expect(readRunMode(dir, 'demo', true)).toBe('demo');
      writeFileSync(path.join(dir, 'settings.json'), '{}', { mode: 0o644 });
      writeRunMode(dir, 'demo');
      expect(readRunMode(dir, 'strict', true)).toBe('demo');
      expect(statSync(path.join(dir, 'settings.json')).mode & 0o777).toBe(0o600);
      writeRunMode(dir, 'strict');
      expect(readRunMode(dir, 'demo', true)).toBe('strict');
      expect(readdirSync(dir)).toEqual(['settings.json']);
    }));
  it('a corrupt file falls back to the build default', () =>
    withDir((dir) => {
      writeFileSync(path.join(dir, 'settings.json'), '{"mode":');
      expect(readRunMode(dir, 'strict', true)).toBe('strict');
      expect(readRunMode(dir, 'demo', true)).toBe('demo');
    }));
  it('a hand-edited demo setting is ignored by every non-judge build', () =>
    withDir((dir) => {
      writeFileSync(path.join(dir, 'settings.json'), '{"mode":"demo"}');
      expect(readRunMode(dir, 'strict')).toBe('strict');
      expect(readRunMode(dir, 'strict', false)).toBe('strict');
      expect(readRunMode(dir, 'demo', false)).toBe('strict');
      expect(readRunMode(dir, 'demo', true)).toBe('demo');
    }));
  it('persists the chosen mode only for the judge build', () => {
    expect(persistRunMode(true)).toBe(true);
    expect(persistRunMode(false)).toBe(false);
  });
  it('removes the temp file when the write cannot complete', () =>
    withDir((dir) => {
      // A directory squatting on the target makes the final rename fail.
      mkdirSync(path.join(dir, 'settings.json'));
      expect(() => writeRunMode(dir, 'demo')).toThrow();
      expect(readdirSync(dir)).toEqual(['settings.json']);
    }));
  it('reads the judge flag only from a packaged app', () =>
    withDir((dir) => {
      writeFileSync(path.join(dir, 'package.json'), '{"examJudgeBuild":true}');
      expect(readJudgeBuild(dir, true)).toBe(true);
      expect(readJudgeBuild(dir, false)).toBe(false);
      expect(readJudgeBuild(path.join(dir, 'missing'), true)).toBe(false);
    }));
});
