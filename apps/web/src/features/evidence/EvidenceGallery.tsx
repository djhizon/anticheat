import { useEffect, useRef, useState } from 'react';
import type { EvidenceSnapshotMeta } from '@examguard/contracts/exam';

export const evidenceTriggerLabel: Readonly<Record<string, string>> = {
  multiple_faces: 'More than one face',
  no_face: 'No face visible',
  phone_detected: 'Phone detected',
  look_away: 'Looked away for a long time',
  overlay_detected: 'Overlay detected',
  disallowed_app_foreground: 'Another app in front',
  extra_person: 'Extra person (desk camera)',
  left_frame: 'Left the frame (desk camera)',
  hands_not_visible: 'Hands not visible (desk camera)',
  text_injected: 'Long answer appeared at once',
};

const sourceLabel: Readonly<Record<string, string>> = {
  webcam: 'Webcam',
  screen: 'Screen',
  desk_camera: 'Desk camera',
};

export interface EvidenceGalleryProps {
  readonly attemptId: string;
  readonly listEvidence: (attemptId: string) => Promise<readonly EvidenceSnapshotMeta[]>;
  /** Resolves to an image URL (usually a blob: URL). Blob URLs created here are revoked on unmount. */
  readonly loadImage: (attemptId: string, id: string) => Promise<string>;
  readonly title?: string;
  readonly note?: string;
}

/**
 * Still photos saved when local checks noticed something unusual. They are leads for a
 * human reviewer, never a verdict. Images load one at a time per thumbnail, on demand.
 */
export function EvidenceGallery({
  attemptId,
  listEvidence,
  loadImage,
  title = 'Evidence snapshots',
  note,
}: EvidenceGalleryProps) {
  const [items, setItems] = useState<readonly EvidenceSnapshotMeta[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [urls, setUrls] = useState<Readonly<Record<string, string>>>({});
  const [open, setOpen] = useState<EvidenceSnapshotMeta | null>(null);
  const lightboxRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  // The thumbnail that opened the lightbox; focus goes back to it when the lightbox closes.
  const openerRef = useRef<HTMLElement | null>(null);

  // Modal behaviour for the lightbox: focus moves to Close on open, Escape closes, Tab stays
  // inside, and focus returns to the thumbnail afterwards.
  useEffect(() => {
    if (open === null) return;
    closeButtonRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setOpen(null);
        return;
      }
      if (event.key !== 'Tab' || lightboxRef.current === null) return;
      const focusable = [
        ...lightboxRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ];
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const active = document.activeElement;
      const inside = active instanceof HTMLElement && lightboxRef.current.contains(active);
      if (!inside || focusable.length === 1) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      openerRef.current?.focus();
    };
  }, [open]);

  useEffect(() => {
    let active = true;
    setItems(null);
    setFailed(false);
    setUrls({});
    setOpen(null);
    const created: string[] = [];
    listEvidence(attemptId)
      .then((list) => {
        if (!active) return;
        setItems(list);
        for (const item of list) {
          loadImage(attemptId, item.id)
            .then((url) => {
              if (!active) {
                if (url.startsWith('blob:')) URL.revokeObjectURL(url);
                return;
              }
              created.push(url);
              setUrls((previous) => ({ ...previous, [item.id]: url }));
            })
            .catch(() => {});
        }
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
      for (const url of created) if (url.startsWith('blob:')) URL.revokeObjectURL(url);
    };
  }, [attemptId, listEvidence, loadImage]);

  const describe = (item: EvidenceSnapshotMeta) =>
    `${evidenceTriggerLabel[item.trigger] ?? item.trigger} · ${sourceLabel[item.source] ?? item.source}`;

  return (
    <section className="evidence-gallery" aria-labelledby={`evidence-title-${attemptId}`}>
      <h3 id={`evidence-title-${attemptId}`}>{title}</h3>
      {note !== undefined && <p className="transparency-note">{note}</p>}
      {failed && <p role="alert">Evidence snapshots could not be loaded.</p>}
      {!failed && items === null && <p role="status">Loading snapshots…</p>}
      {items !== null && items.length === 0 && (
        <p className="transparency-empty">No snapshots were saved for this attempt.</p>
      )}
      {items !== null && items.length > 0 && (
        <ul className="evidence-grid">
          {items.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                className="evidence-thumb"
                aria-label={`Enlarge: ${describe(item)}`}
                onClick={(event) => {
                  openerRef.current = event.currentTarget;
                  setOpen(item);
                }}
              >
                {urls[item.id] !== undefined ? (
                  <img src={urls[item.id]} alt={describe(item)} />
                ) : (
                  <span className="evidence-placeholder">Loading…</span>
                )}
              </button>
              <p className="evidence-caption">
                {describe(item)}
                <br />
                <time dateTime={item.capturedAt}>{new Date(item.capturedAt).toLocaleString()}</time>
              </p>
            </li>
          ))}
        </ul>
      )}
      {open !== null && (
        <div
          ref={lightboxRef}
          className="evidence-lightbox"
          role="dialog"
          aria-modal="true"
          aria-label={describe(open)}
        >
          {urls[open.id] !== undefined && <img src={urls[open.id]} alt={describe(open)} />}
          <p>
            {describe(open)} — {new Date(open.capturedAt).toLocaleString()}
          </p>
          <button ref={closeButtonRef} type="button" onClick={() => setOpen(null)}>
            Close
          </button>
        </div>
      )}
    </section>
  );
}
