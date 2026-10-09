import { expect, it } from 'vitest';
import {
  createDeduper,
  evidenceFileName,
  evidenceItems,
  formatEvidence,
  formatTimelineEntry,
  pairingLink,
  pickLanIp,
  qrMatrixFromSvg,
  renderQr,
} from './phone-lab-lib.mjs';

const item = (address: string, internal = false, family = 'IPv4') => ({
  address,
  internal,
  family,
});

it('prefers en0, then en1, then any other private external IPv4', () => {
  expect(
    pickLanIp({
      utun3: [item('10.8.0.2')],
      en1: [item('192.168.1.9')],
      en0: [item('192.168.100.143')],
    }),
  ).toBe('192.168.100.143');
  expect(pickLanIp({ en1: [item('192.168.1.9')], bridge0: [item('10.0.0.5')] })).toBe(
    '192.168.1.9',
  );
  expect(pickLanIp({ en5: [item('172.20.1.4')] })).toBe('172.20.1.4');
});

it('ignores loopback, IPv6, public and link-local addresses', () => {
  expect(
    pickLanIp({
      lo0: [item('127.0.0.1', true)],
      en0: [item('fe80::1', false, 'IPv6'), item('169.254.3.3'), item('8.8.8.8')],
    }),
  ).toBeNull();
  expect(pickLanIp({})).toBeNull();
});

it('builds the same examcompanion pairing link as the web modal', () => {
  expect(pairingLink('http://192.168.100.143:5773', 'abc')).toBe(
    'examcompanion://pair?origin=http%3A%2F%2F192.168.100.143%3A5773&code=abc',
  );
});

it('formats timeline entries with time, source, kind and summary', () => {
  const line = formatTimelineEntry({
    at: '2026-10-10T01:02:03.000Z',
    source: 'camera',
    kind: 'multiple_faces',
    severity: 'flag',
    summary: 'More than one face',
  });
  expect(line).toMatch(/^\d\d:\d\d:\d\d {2}camera\s+multiple_faces\s+More than one face$/);
  expect(
    formatTimelineEntry({ at: 'x', source: 's', kind: 'k', severity: 'flag', summary: 'm' }, true),
  ).toContain('\u001b[31m');
});

it('formats evidence lines and safe file names', () => {
  const snap = {
    id: 'ab/cd-1234-xyz',
    source: 'webcam',
    trigger: 'multiple_faces',
    capturedAt: '2026-10-10T01:02:03.456Z',
  };
  expect(formatEvidence(snap, '/tmp/a.jpg')).toContain('saved /tmp/a.jpg');
  expect(formatEvidence(snap, null)).toContain('download failed');
  expect(evidenceFileName(snap)).toBe('2026-10-10T01-02-03Z_webcam_multiple_faces_ab-cd-12.jpg');
});

it('shows each entry once, including genuinely repeated identical entries', () => {
  const a = { at: '1', source: 's', kind: 'k', severity: 'info', summary: 'one' };
  const dedupe = createDeduper();
  expect(dedupe.fresh([a])).toEqual([a]);
  expect(dedupe.fresh([a])).toEqual([]);
  expect(dedupe.fresh([a, a])).toEqual([a]);
  expect(dedupe.fresh([a, a])).toEqual([]);
});

it('tolerates different evidence list shapes', () => {
  const one = { id: 'e1' };
  expect(evidenceItems({ snapshots: [one] })).toEqual([one]);
  expect(evidenceItems([one, null, {}])).toEqual([one]);
  expect(evidenceItems({ nope: true })).toEqual([]);
  expect(evidenceItems(null)).toEqual([]);
});

it('reads a qrcode.react SVG back into a matrix and renders it', () => {
  const svg =
    '<svg viewBox="0 0 3 3"><path d="M0,0 h3v3H0z"></path><path d="M0 0h2v1H0zM1,2 h1v1H1z"></path></svg>';
  const matrix = qrMatrixFromSvg(svg);
  expect(matrix).toEqual([
    [true, true, false],
    [false, false, false],
    [false, true, false],
  ]);
  expect(renderQr(matrix, 0).split('\n')).toHaveLength(2);
});
