/* global URL */
/** Pure helpers for scripts/phone-lab.mjs (kept free of I/O so they can be unit-tested). */

const PRIVATE_IPV4 = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

/**
 * Pick the laptop's Wi-Fi LAN IPv4. macOS Wi-Fi is en0 (en1 on some Macs), so those win;
 * any other external private IPv4 is only a fallback. Returns null when nothing qualifies.
 */
export function pickLanIp(interfaces) {
  const usable = (name) =>
    (interfaces[name] ?? []).filter(
      (entry) =>
        entry &&
        !entry.internal &&
        (entry.family === 'IPv4' || entry.family === 4) &&
        PRIVATE_IPV4.test(entry.address),
    );
  for (const name of ['en0', 'en1']) {
    const found = usable(name)[0];
    if (found) return found.address;
  }
  for (const name of Object.keys(interfaces).sort()) {
    const found = usable(name)[0];
    if (found) return found.address;
  }
  return null;
}

/** Same link the web "Require iPhone" modal builds (nativePhoneUrl.ts). */
export function pairingLink(origin, code) {
  const link = new URL('examcompanion://pair');
  link.searchParams.set('origin', origin);
  link.searchParams.set('code', code);
  return link.href;
}

const ANSI = {
  reset: '\u001b[0m',
  dim: '\u001b[2m',
  red: '\u001b[31m',
  yellow: '\u001b[33m',
  green: '\u001b[32m',
  cyan: '\u001b[36m',
  magenta: '\u001b[35m',
};

export function paint(text, colour, enabled) {
  return enabled && ANSI[colour] ? `${ANSI[colour]}${text}${ANSI.reset}` : text;
}

const SEVERITY_COLOUR = { flag: 'red', notice: 'yellow', info: 'dim' };

function clock(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '??:??:??';
  const two = (n) => String(n).padStart(2, '0');
  return `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
}

/** One printable line for a timeline entry: time, source, kind, summary. */
export function formatTimelineEntry(entry, colour = false) {
  const line = `${clock(entry.at)}  ${String(entry.source).padEnd(10)} ${String(entry.kind).padEnd(26)} ${entry.summary}`;
  return paint(line, SEVERITY_COLOUR[entry.severity] ?? 'reset', colour);
}

/** One printable line for an evidence snapshot, with where the JPEG was saved. */
export function formatEvidence(item, savedPath, colour = false) {
  const where = savedPath ? `saved ${savedPath}` : 'download failed';
  const line = `${clock(item.capturedAt)}  ${'evidence'.padEnd(10)} ${String(item.trigger).padEnd(26)} ${item.source} snapshot, ${where}`;
  return paint(line, 'magenta', colour);
}

const timelineKey = (e) => `${e.at}|${e.source}|${e.kind}|${e.summary}`;

/**
 * Remembers what was already shown. Identical entries inside one response are told apart by
 * occurrence number, so two real events with the same text are both shown once.
 */
export function createDeduper(keyOf = timelineKey) {
  const seen = new Set();
  return {
    fresh(items) {
      const counts = new Map();
      const out = [];
      for (const item of items) {
        const base = keyOf(item);
        const n = (counts.get(base) ?? 0) + 1;
        counts.set(base, n);
        const key = `${base}#${n}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(item);
      }
      return out;
    },
  };
}

export const evidenceKey = (item) => String(item.id);

/** Safe, sortable file name for a downloaded snapshot. */
export function evidenceFileName(item) {
  const safe = (value) => String(value).replace(/[^A-Za-z0-9_-]/g, '-');
  const stamp = safe(String(item.capturedAt).replace(/\.\d+Z$/, 'Z'));
  return `${stamp}_${safe(item.source)}_${safe(item.trigger)}_${safe(item.id).slice(0, 8)}.jpg`;
}

/** Accept the evidence list as `{snapshots}`, `{evidence}`, `{items}` or a bare array. */
export function evidenceItems(body) {
  const list = Array.isArray(body)
    ? body
    : (body?.snapshots ?? body?.evidence ?? body?.items ?? []);
  return Array.isArray(list)
    ? list.filter((item) => item && typeof item === 'object' && item.id !== undefined)
    : [];
}

/** Read the dark modules back out of a qrcode.react SVG (second path holds the dark cells). */
export function qrMatrixFromSvg(svg) {
  const size = Number(/viewBox="0 0 (\d+) \1"/.exec(svg)?.[1]);
  const paths = [...svg.matchAll(/<path[^>]* d="([^"]*)"/g)].map((m) => m[1]);
  const dark = paths[1];
  if (!size || dark === undefined) throw new Error('Unexpected QR SVG layout.');
  const rows = Array.from({ length: size }, () => Array.from({ length: size }, () => false));
  for (const m of dark.matchAll(/M(\d+)[ ,](\d+)\s*h(\d+)/g)) {
    const [x, y, w] = [Number(m[1]), Number(m[2]), Number(m[3])];
    for (let i = 0; i < w; i += 1) rows[y][x + i] = true;
  }
  return rows;
}

/**
 * Render a QR matrix with half-block characters and explicit black/white colours, so it scans on
 * dark and light terminals alike. Includes a 2-module quiet zone.
 */
export function renderQr(matrix, quiet = 2) {
  const size = matrix.length;
  const at = (x, y) => (x >= 0 && y >= 0 && x < size && y < size ? matrix[y][x] : false);
  const colour = (dark) => (dark ? 16 : 231);
  const lines = [];
  for (let y = -quiet; y < size + quiet; y += 2) {
    let line = '';
    for (let x = -quiet; x < size + quiet; x += 1) {
      line += `\u001b[38;5;${colour(at(x, y))}m\u001b[48;5;${colour(at(x, y + 1))}m▀`;
    }
    lines.push(`${line}\u001b[0m`);
  }
  return lines.join('\n');
}
