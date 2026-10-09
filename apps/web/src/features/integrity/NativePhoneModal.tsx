import { useEffect, useRef } from 'react';
import type { ExamApi } from '../exam/api.js';
import { PhonePairingPanel } from './PhonePairingPanel.js';

export function NativePhoneModal({
  attemptId,
  api,
  onClose,
}: {
  attemptId: string;
  api: ExamApi;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDivElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusable = () =>
      Array.from(
        dialog.current?.querySelectorAll<HTMLElement>(
          'a[href],button,input,textarea,select,summary,[tabindex]:not([tabindex="-1"])',
        ) ?? [],
      ).filter((el) => !(el as HTMLButtonElement).disabled && el.tabIndex >= 0);
    (focusable()[0] ?? dialog.current)?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusable();
      if (!items.length) {
        event.preventDefault();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      if (!dialog.current?.contains(active)) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      opener?.focus();
    };
  }, []);
  return (
    <div
      ref={dialog}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label="Require iPhone presence"
      className="phone-modal"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 11000,
        background: '#000d',
        display: 'grid',
        placeItems: 'center',
        overflow: 'auto',
      }}
    >
      <div
        style={{
          background: '#18181b',
          color: 'white',
          padding: 28,
          borderRadius: 16,
          maxWidth: 520,
        }}
      >
        <PhonePairingPanel attemptId={attemptId} api={api} />
        <p>
          <button className="exam-control exam-control--secondary" type="button" onClick={onClose}>
            Close setup
          </button>
        </p>
      </div>
    </div>
  );
}
