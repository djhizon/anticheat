import { useEffect, useState } from 'react';
import type { EvidenceSnapshotMeta } from '@examguard/contracts/exam';
import type { AttemptFindings, Finding } from '@examguard/contracts/findings';
import { REVIEW_LEVEL_LABELS } from '@examguard/contracts/findings';

import { evidenceTriggerLabel } from '../evidence/EvidenceGallery.js';
import type { EvidenceApi } from '../evidence/evidenceApi.js';
import type { FindingsApi } from './findingsApi.js';
import { noRecordings, PlayClipButton, type RecordingSource } from './ClipPlayer.js';

export const confidenceLabel: Readonly<Record<Finding['confidence'], string>> = {
  low: 'Low confidence',
  medium: 'Medium confidence',
  high: 'High confidence',
};

/** Up to three photos: the finding's own, then the nearest to its first window. */
export function pickPhotos(
  finding: Finding,
  snapshots: readonly EvidenceSnapshotMeta[],
  max = 3,
): readonly EvidenceSnapshotMeta[] {
  const own = snapshots.filter((item) => finding.evidenceIds.includes(item.id));
  if (own.length >= max) return own.slice(0, max);
  const anchor = Date.parse(finding.windows[0]?.start ?? '');
  const nearest = snapshots
    .filter((item) => !own.includes(item))
    .map((item) => ({ item, distance: Math.abs(Date.parse(item.capturedAt) - anchor) }))
    .filter(({ distance }) => Number.isFinite(distance))
    .sort((left, right) => left.distance - right.distance)
    .map(({ item }) => item);
  return [...own, ...nearest].slice(0, max);
}

const clock = (value: string): string =>
  new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/**
 * One attempt's findings with their evidence: plain reasons, confidence, 2–3 photos, a clip
 * button per window, transcript lines and the student's own note. Leads only, never verdicts.
 */
export function EvidenceCard({
  attemptId,
  studentEmail,
  api,
  evidence,
  recordings = noRecordings,
}: {
  readonly attemptId: string;
  readonly studentEmail: string;
  readonly api: FindingsApi;
  readonly evidence: Pick<EvidenceApi, 'listEvidence' | 'loadEvidenceImage'>;
  readonly recordings?: RecordingSource;
}) {
  const [findings, setFindings] = useState<AttemptFindings | null | 'loading' | 'failed'>(
    'loading',
  );
  const [snapshots, setSnapshots] = useState<readonly EvidenceSnapshotMeta[]>([]);
  const [urls, setUrls] = useState<Readonly<Record<string, string>>>({});

  useEffect(() => {
    let active = true;
    setFindings('loading');
    setSnapshots([]);
    setUrls({});
    api
      .getFindings(attemptId)
      .then((loaded) => {
        if (active) setFindings(loaded);
      })
      .catch(() => {
        if (active) setFindings('failed');
      });
    evidence
      .listEvidence(attemptId)
      .then((list) => {
        if (active) setSnapshots(list);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [attemptId, api, evidence]);

  // Load only the photos the card shows; blob URLs are revoked when the card changes attempt.
  const wanted =
    typeof findings === 'object' && findings !== null
      ? [...new Set(findings.findings.flatMap((f) => pickPhotos(f, snapshots).map((p) => p.id)))]
      : [];
  const wantedKey = wanted.join(',');
  useEffect(() => {
    if (wantedKey === '') return;
    let active = true;
    const created: string[] = [];
    for (const id of wantedKey.split(',')) {
      evidence
        .loadEvidenceImage(attemptId, id)
        .then((url) => {
          if (!active) {
            if (url.startsWith('blob:')) URL.revokeObjectURL(url);
            return;
          }
          created.push(url);
          setUrls((previous) => ({ ...previous, [id]: url }));
        })
        .catch(() => undefined);
    }
    return () => {
      active = false;
      for (const url of created) if (url.startsWith('blob:')) URL.revokeObjectURL(url);
    };
  }, [attemptId, evidence, wantedKey]);

  return (
    <article className="evidence-card" aria-labelledby={`evidence-card-${attemptId}`}>
      <h3 id={`evidence-card-${attemptId}`}>{studentEmail}</h3>
      {findings === 'loading' && <p role="status">Loading findings…</p>}
      {findings === 'failed' && <p role="alert">Findings could not be loaded.</p>}
      {findings === null && <p className="muted">Findings not available yet.</p>}
      {typeof findings === 'object' && findings !== null && (
        <>
          <p className="muted">
            <span className={`level-chip level-chip--${findings.level}`}>
              {REVIEW_LEVEL_LABELS[findings.level]}
            </span>
            {findings.findings.length === 0 && ' Nothing stood out in this attempt.'}
          </p>
          <ol className="finding-list">
            {findings.findings.map((finding) => {
              const photos = pickPhotos(finding, snapshots);
              return (
                <li key={finding.id} className="finding">
                  <header>
                    <strong>{finding.title}</strong>{' '}
                    <span className={`confidence-chip confidence-chip--${finding.confidence}`}>
                      {confidenceLabel[finding.confidence]}
                    </span>
                  </header>
                  <ul className="finding-reasons">
                    {finding.reasons.map((reason) => (
                      <li key={reason}>{reason}</li>
                    ))}
                  </ul>
                  {photos.length > 0 && (
                    <ul className="finding-photos" aria-label="Evidence photos">
                      {photos.map((photo) => (
                        <li key={photo.id}>
                          {urls[photo.id] !== undefined ? (
                            <img
                              src={urls[photo.id]}
                              alt={`${evidenceTriggerLabel[photo.trigger] ?? photo.trigger} at ${clock(photo.capturedAt)}`}
                            />
                          ) : (
                            <span className="evidence-placeholder">Loading…</span>
                          )}
                          <small>
                            {evidenceTriggerLabel[photo.trigger] ?? photo.trigger} ·{' '}
                            {clock(photo.capturedAt)}
                          </small>
                        </li>
                      ))}
                    </ul>
                  )}
                  {finding.windows.map((window) => (
                    <PlayClipButton
                      key={window.start}
                      attemptId={attemptId}
                      window={window}
                      recordings={recordings}
                    />
                  ))}
                  {finding.transcript.length > 0 && (
                    <ol className="finding-transcript" aria-label="Transcript lines">
                      {finding.transcript.map((line) => (
                        <li key={`${line.at}-${line.text}`}>
                          <time dateTime={line.at}>{clock(line.at)}</time> — {line.text}
                        </li>
                      ))}
                    </ol>
                  )}
                  <p className="finding-note">
                    <strong>Student&apos;s note:</strong>{' '}
                    {finding.studentNote ?? <span className="muted">none yet</span>}
                  </p>
                </li>
              );
            })}
          </ol>
        </>
      )}
    </article>
  );
}
