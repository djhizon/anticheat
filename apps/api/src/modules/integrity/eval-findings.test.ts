import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FINDING_TYPES } from '@examguard/contracts/findings';

import { EVAL_SEED, formatSession, generateEvalSessions } from './eval-generator.js';
import {
  COHORTS,
  DEFAULT_FIXTURES_DIR,
  evalFindingsMain,
  loadEvalSessions,
  renderMarkdown,
  runEval,
  updateDocument,
} from './eval-report.js';

const ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));

describe('eval session generator', () => {
  it('is deterministic for a seed and covers every cohort', () => {
    const sessions = generateEvalSessions();
    expect(sessions).toEqual(generateEvalSessions(EVAL_SEED));
    expect(generateEvalSessions(EVAL_SEED + 1)).not.toEqual(sessions);
    const count = (cohort: string) => sessions.filter((s) => s.cohort === cohort).length;
    expect(count('honest')).toBeGreaterThanOrEqual(8);
    expect(count('cheat')).toBeGreaterThanOrEqual(8);
    expect(count('hard_honest')).toBe(2);
    expect(count('hard_cheat')).toBe(2);
    expect(new Set(sessions.map((s) => s.id)).size).toBe(sessions.length);
    for (const s of sessions) {
      expect(s.rows.keystrokes.length).toBeGreaterThan(0);
      expect(s.rows.input.length).toBeGreaterThan(0);
      expect(s.cohort.endsWith('honest') ? s.expected : [s.expected.length]).not.toEqual([0]);
    }
  });

  it('formats a session as JSON that parses back to the same session', () => {
    const session = generateEvalSessions()[0]!;
    expect(JSON.parse(formatSession(session))).toEqual(JSON.parse(JSON.stringify(session)));
  });

  it('matches the committed fixtures (run `npm run eval:findings -- --regenerate` after changes)', async () => {
    const onDisk = await loadEvalSessions(path.join(ROOT, DEFAULT_FIXTURES_DIR));
    const generated = generateEvalSessions().sort((a, b) => a.id.localeCompare(b.id));
    expect(onDisk.map((s) => s.id)).toEqual(generated.map((s) => s.id));
    expect(onDisk).toEqual(JSON.parse(JSON.stringify(generated)));
  });
});

describe('eval report', () => {
  it('replays every session and tallies each finding type and cohort', () => {
    const sessions = generateEvalSessions();
    const report = runEval(sessions);
    expect(report.sessions).toHaveLength(sessions.length);
    expect(Object.keys(report.byType).sort()).toEqual([...FINDING_TYPES].sort());
    const levelTotal = COHORTS.reduce(
      (sum, c) => sum + Object.values(report.levels[c]).reduce((a, b) => a + b, 0),
      0,
    );
    expect(levelTotal).toBe(sessions.length);
    for (const result of report.sessions) {
      expect(['none', 'glance', 'review']).toContain(result.level);
      if (result.cohort.endsWith('honest')) {
        expect(result.outcome).toBe(result.findings.length === 0 ? 'clean' : 'false_flag');
      } else {
        expect(['detected', 'missed']).toContain(result.outcome);
      }
    }
    for (const type of FINDING_TYPES) {
      const s = report.byType[type];
      expect(s.detected).toBeLessThanOrEqual(s.staged);
      expect(s.hardDetected).toBeLessThanOrEqual(s.hardStaged);
    }
  });

  it('renders the tables and keeps text outside the markers', () => {
    const markdown = renderMarkdown(runEval(generateEvalSessions()));
    expect(markdown).toContain('| Finding ');
    expect(markdown).toContain('### Review level by cohort');
    expect(markdown).toContain('### Hard borderline cases');
    for (const type of FINDING_TYPES) expect(markdown).toContain(`\`${type}\``);
    const doc = updateDocument(
      '# Title\n\nIntro.\n\n<!-- eval-findings:start -->\nold\n<!-- eval-findings:end -->\n\nNotes after.\n',
      markdown,
    );
    expect(doc).toContain('Intro.');
    expect(doc).toContain('Notes after.');
    expect(doc).not.toContain('\nold\n');
    expect(doc).toContain(markdown);
  });
});

describe('eval:findings script entry point', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'eval-findings-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('regenerates fixtures, replays them and writes the document idempotently', async () => {
    const lines: string[] = [];
    const docPath = 'docs/eval-findings.md';
    await writeFile(path.join(root, 'hand.md'), '');
    const first = await evalFindingsMain({
      root,
      docPath,
      regenerate: true,
      log: (l) => lines.push(l),
    });
    expect(first.sessions.length).toBeGreaterThanOrEqual(20);
    const written = await readFile(path.join(root, docPath), 'utf8');
    expect(written).toContain('<!-- eval-findings:start -->');
    expect(written).toContain('### Per finding type');
    expect(lines.some((l) => l.includes('| Finding '))).toBe(true);

    const second = await evalFindingsMain({ root, docPath });
    expect(second).toEqual(first);
    expect(await readFile(path.join(root, docPath), 'utf8')).toBe(written);
  });

  it('fails clearly when the fixtures folder is empty', async () => {
    await expect(evalFindingsMain({ root, fixturesDir: 'docs' })).rejects.toThrow();
  });
});
