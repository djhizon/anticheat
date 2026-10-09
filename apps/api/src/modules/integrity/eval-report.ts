import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  FINDING_TYPES,
  type FindingConfidence,
  type FindingType,
  type ReviewLevel,
} from '@examguard/contracts/findings';

import {
  EVAL_SEED,
  type EvalCohort,
  type EvalSession,
  formatSession,
  generateEvalSessions,
} from './eval-generator.js';
import { buildFindings } from './findings.js';

/**
 * Replays the synthetic evaluation sessions through `buildFindings` and reports, per finding
 * type, how many staged cheats were detected and how many honest sessions were flagged. Hard
 * borderline sessions are counted separately so they do not flatter or hide the main numbers.
 * The markdown is written between markers in docs/eval-findings.md so hand-written notes around
 * it survive a re-run.
 */

export type Outcome = 'detected' | 'missed' | 'clean' | 'false_flag';

export interface SessionResult {
  readonly id: string;
  readonly cohort: EvalCohort;
  readonly description: string;
  readonly expected: readonly FindingType[];
  readonly level: ReviewLevel;
  readonly findings: readonly { type: FindingType; confidence: FindingConfidence }[];
  readonly outcome: Outcome;
}

export interface TypeStats {
  staged: number;
  detected: number;
  falseFlags: number;
  hardStaged: number;
  hardDetected: number;
  hardFalseFlags: number;
}

export interface EvalReport {
  readonly sessions: readonly SessionResult[];
  readonly byType: Readonly<Record<FindingType, TypeStats>>;
  readonly levels: Readonly<Record<EvalCohort, Record<ReviewLevel, number>>>;
}

export const COHORTS: readonly EvalCohort[] = ['honest', 'cheat', 'hard_honest', 'hard_cheat'];
const LEVELS: readonly ReviewLevel[] = ['none', 'glance', 'review'];
const START_MARKER = '<!-- eval-findings:start -->';
const END_MARKER = '<!-- eval-findings:end -->';

export const DEFAULT_FIXTURES_DIR = 'apps/api/src/modules/integrity/eval-sessions';
export const DEFAULT_DOC_PATH = 'docs/eval-findings.md';

const isHonest = (cohort: EvalCohort): boolean => cohort === 'honest' || cohort === 'hard_honest';
const isHard = (cohort: EvalCohort): boolean => cohort.startsWith('hard_');

export function runEval(sessions: readonly EvalSession[]): EvalReport {
  const byType = Object.fromEntries(
    FINDING_TYPES.map((type) => [
      type,
      { staged: 0, detected: 0, falseFlags: 0, hardStaged: 0, hardDetected: 0, hardFalseFlags: 0 },
    ]),
  ) as Record<FindingType, TypeStats>;
  const levels = Object.fromEntries(
    COHORTS.map((cohort) => [cohort, { none: 0, glance: 0, review: 0 }]),
  ) as Record<EvalCohort, Record<ReviewLevel, number>>;

  const results = sessions.map((session): SessionResult => {
    const result = buildFindings(session.rows);
    const found = result.findings.map((f) => ({ type: f.type, confidence: f.confidence }));
    const foundTypes = new Set(found.map((f) => f.type));
    const hard = isHard(session.cohort);
    levels[session.cohort][result.level] += 1;

    let outcome: Outcome;
    if (isHonest(session.cohort)) {
      for (const type of foundTypes) {
        byType[type][hard ? 'hardFalseFlags' : 'falseFlags'] += 1;
      }
      outcome = found.length === 0 ? 'clean' : 'false_flag';
    } else {
      for (const type of session.expected) {
        byType[type][hard ? 'hardStaged' : 'staged'] += 1;
        if (foundTypes.has(type)) byType[type][hard ? 'hardDetected' : 'detected'] += 1;
      }
      outcome = session.expected.every((type) => foundTypes.has(type)) ? 'detected' : 'missed';
    }
    return {
      id: session.id,
      cohort: session.cohort,
      description: session.description,
      expected: session.expected,
      level: result.level,
      findings: found,
      outcome,
    };
  });
  return { sessions: results, byType, levels };
}

// ── Markdown ─────────────────────────────────────────────────────────────────

/** A table padded the way prettier formats markdown, so `format:check` stays green. */
function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = headers.map((h, i) =>
    Math.max(3, h.length, ...rows.map((r) => (r[i] ?? '').length)),
  );
  const line = (cells: readonly string[]) =>
    `| ${cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join(' | ')} |`;
  return [
    line(headers),
    `| ${widths.map((w) => '-'.repeat(w)).join(' | ')} |`,
    ...rows.map(line),
  ].join('\n');
}

const ratio = (hit: number, total: number): string => (total === 0 ? '-' : `${hit} / ${total}`);

const findingsText = (r: SessionResult): string =>
  r.findings.length === 0
    ? 'none'
    : r.findings.map((f) => `\`${f.type}\` (${f.confidence})`).join(', ');

const OUTCOME_TEXT: Record<Outcome, string> = {
  detected: 'detected',
  missed: 'MISSED',
  clean: 'clean',
  false_flag: 'FALSE FLAG',
};

export function renderMarkdown(report: EvalReport): string {
  const count = (filter: (c: EvalCohort) => boolean) =>
    report.sessions.filter((s) => filter(s.cohort)).length;
  const honestFlagged = report.sessions.filter(
    (s) => s.cohort === 'honest' && s.outcome === 'false_flag',
  ).length;
  const cheatsDetected = report.sessions.filter(
    (s) => s.cohort === 'cheat' && s.outcome === 'detected',
  ).length;

  const perType = table(
    ['Finding', 'Staged cheats detected', 'Honest sessions flagged', 'Hard cheats', 'Hard honest'],
    FINDING_TYPES.map((type) => {
      const s = report.byType[type];
      return [
        `\`${type}\``,
        ratio(s.detected, s.staged),
        `${s.falseFlags} / ${count((c) => c === 'honest')}`,
        ratio(s.hardDetected, s.hardStaged),
        `${s.hardFalseFlags} / ${count((c) => c === 'hard_honest')}`,
      ];
    }),
  );
  const levelTable = table(
    ['Cohort', 'Sessions', ...LEVELS],
    COHORTS.map((cohort) => [
      cohort,
      String(count((c) => c === cohort)),
      ...LEVELS.map((level) => String(report.levels[cohort][level])),
    ]),
  );
  const sessionRows = (filter: (c: EvalCohort) => boolean) =>
    report.sessions
      .filter((s) => filter(s.cohort))
      .map((s) => [`\`${s.id}\``, s.cohort, s.level, findingsText(s), OUTCOME_TEXT[s.outcome]]);
  const sessionHeaders = ['Session', 'Cohort', 'Level', 'Findings', 'Outcome'];

  return [
    START_MARKER,
    '',
    `Synthetic data only: ${report.sessions.length} generated sessions (seed ${EVAL_SEED}), not real students. ` +
      `Main set: ${cheatsDetected} of ${count((c) => c === 'cheat')} staged cheats detected, ` +
      `${honestFlagged} of ${count((c) => c === 'honest')} honest sessions flagged. ` +
      'Hard borderline cases are counted separately.',
    '',
    '### Per finding type',
    '',
    perType,
    '',
    '### Review level by cohort',
    '',
    levelTable,
    '',
    '### Hard borderline cases',
    '',
    table(sessionHeaders, sessionRows(isHard)),
    '',
    '### All sessions',
    '',
    table(
      sessionHeaders,
      sessionRows((c) => !isHard(c)),
    ),
    '',
    END_MARKER,
  ].join('\n');
}

/** Replaces the generated block between the markers, or appends it to a new document. */
export function updateDocument(existing: string | null, generated: string): string {
  if (existing !== null) {
    const start = existing.indexOf(START_MARKER);
    const end = existing.indexOf(END_MARKER);
    if (start !== -1 && end > start) {
      return `${existing.slice(0, start)}${generated}${existing.slice(end + END_MARKER.length)}`;
    }
  }
  const head =
    existing ??
    '# Findings engine: measured on synthetic sessions\n\n' +
      'Generated by `npm run eval:findings`; edit the text outside the markers only.\n\n';
  return `${head.trimEnd()}\n\n${generated}\n`;
}

// ── Fixtures on disk ─────────────────────────────────────────────────────────

const CohortValues = new Set<string>(COHORTS);

function assertSession(value: unknown, file: string): EvalSession {
  const v = value as Partial<EvalSession> | null;
  if (
    v === null ||
    typeof v !== 'object' ||
    typeof v.id !== 'string' ||
    typeof v.cohort !== 'string' ||
    !CohortValues.has(v.cohort) ||
    !Array.isArray(v.expected) ||
    typeof v.rows !== 'object' ||
    v.rows === null ||
    typeof v.rows.meta?.startedAt !== 'string'
  ) {
    throw new Error(`${file} is not an evaluation session (expected id, cohort, expected, rows).`);
  }
  return v as EvalSession;
}

export async function loadEvalSessions(dir: string): Promise<EvalSession[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();
  if (files.length === 0) throw new Error(`No evaluation sessions in ${dir}.`);
  return Promise.all(
    files.map(async (file) =>
      assertSession(JSON.parse(await readFile(path.join(dir, file), 'utf8')), file),
    ),
  );
}

export async function writeEvalSessions(dir: string, sessions: readonly EvalSession[]) {
  await mkdir(dir, { recursive: true });
  await Promise.all(
    sessions.map((s) => writeFile(path.join(dir, `${s.id}.json`), formatSession(s), 'utf8')),
  );
}

export interface EvalOptions {
  /** Repository root; fixture and document paths are resolved against it. */
  readonly root: string;
  readonly fixturesDir?: string;
  readonly docPath?: string;
  /** Rewrite the fixtures from the generator before replaying them. */
  readonly regenerate?: boolean;
  readonly log?: (line: string) => void;
}

export async function evalFindingsMain(options: EvalOptions): Promise<EvalReport> {
  const fixturesDir = path.resolve(options.root, options.fixturesDir ?? DEFAULT_FIXTURES_DIR);
  const docPath = path.resolve(options.root, options.docPath ?? DEFAULT_DOC_PATH);
  const log = options.log ?? (() => undefined);
  if (options.regenerate === true) {
    await writeEvalSessions(fixturesDir, generateEvalSessions());
    log(`Regenerated fixtures in ${fixturesDir}`);
  }
  const sessions = await loadEvalSessions(fixturesDir);
  const report = runEval(sessions);
  const markdown = renderMarkdown(report);
  const existing = await readFile(docPath, 'utf8').catch(() => null);
  await mkdir(path.dirname(docPath), { recursive: true });
  await writeFile(docPath, updateDocument(existing, markdown), 'utf8');
  log(markdown);
  log(`\nWritten to ${docPath}`);
  return report;
}
