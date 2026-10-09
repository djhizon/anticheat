export const MAX_LOG_LINES = 50;

export interface LogLine {
  readonly key: string;
  /** Epoch milliseconds the clip was captured. */
  readonly at: number;
  readonly kind: 'text' | 'skipped';
  readonly text: string;
}

export const SKIPPED_TEXT = '(skipped while transcribing)';

export function formatClock(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** Appends in arrival order, drops empty text, and keeps only the newest lines. */
export function appendLine(
  lines: readonly LogLine[],
  line: Omit<LogLine, 'key'>,
  max = MAX_LOG_LINES,
): readonly LogLine[] {
  if (line.kind === 'text' && line.text.trim() === '') return lines;
  const key = `${line.kind}|${line.at}|${line.text}`;
  if (line.kind === 'text' && lines.some((existing) => existing.key === key)) return lines;
  return [...lines, { ...line, key }].slice(-max);
}
