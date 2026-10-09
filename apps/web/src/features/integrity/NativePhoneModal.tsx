import { useEffect, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import type { ExamApi, PhonePresenceStatus } from '../exam/api.js';
import { desktopAppsBridge } from './desktopApps.js';
import { nativePhoneUrl } from './nativePhoneUrl.js';
import { PhonePlacementCard } from './PhonePlacementCard.js';

export function NativePhoneModal({
  attemptId,
  api,
  onClose,
}: {
  attemptId: string;
  api: ExamApi;
  onClose: () => void;
}) {
  // In the desktop app the main process opens a LAN listener on demand and supplies the origin;
  // in a plain browser the student types the address of this computer.
  const lanBridge = desktopAppsBridge()?.startPhoneLan;
  const inDesktop = typeof lanBridge === 'function';
  const [origin, setOrigin] = useState('');
  const [consent, setConsent] = useState(false);
  const [pairing, setPairing] = useState<{ code: string; expiresAt: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());
  const [desk, setDesk] = useState<PhonePresenceStatus['deskCamera'] | null>(null);
  const request = useRef<AbortController | null>(null);
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
  const paired = pairing !== null;
  useEffect(() => {
    if (!paired || typeof api.getPhonePresence !== 'function') return;
    let disposed = false;
    const poll = async () => {
      try {
        const status = await api.getPhonePresence(attemptId);
        if (!disposed) setDesk(status.deskCamera ?? null);
      } catch {
        if (!disposed) setDesk(null);
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 3000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [paired, api, attemptId]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearInterval(timer);
      request.current?.abort();
    };
  }, []);
  let url = '';
  let guidance = '';
  try {
    url = nativePhoneUrl(origin, pairing?.code ?? 'p'.repeat(43));
  } catch (failure) {
    if (!inDesktop)
      guidance = origin.trim()
        ? failure instanceof Error
          ? failure.message
          : 'Invalid address.'
        : "Enter this computer's Wi-Fi address first (starting with http://). Checking consent alone does not create a QR.";
  }
  const expired =
    pairing !== null &&
    (!Number.isFinite(Date.parse(pairing.expiresAt)) || now >= Date.parse(pairing.expiresAt));
  async function enable() {
    if (!consent || (!inDesktop && !url) || busy) return;
    setBusy(true);
    setError('');
    setPairing(null);
    const controller = new AbortController();
    request.current = controller;
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      if (lanBridge) {
        // Opens the phone-only listener on this Mac's Wi-Fi address (macOS may ask to allow it).
        const lan = (await lanBridge.call(desktopAppsBridge())) as {
          origin?: unknown;
          error?: unknown;
        } | null;
        if (controller.signal.aborted) return;
        if (typeof lan?.origin !== 'string' || lan.origin === '') {
          setError(
            typeof lan?.error === 'string' && lan.error
              ? lan.error
              : 'The phone connection could not be opened on this network.',
          );
          return;
        }
        setOrigin(lan.origin);
      }
      const result = await api.requirePhonePresence(attemptId, controller.signal);
      if (!controller.signal.aborted) {
        setNow(Date.now());
        setPairing(result);
      }
    } catch {
      if (request.current === controller)
        setError(
          'Pairing failed or timed out. Check that this computer and your iPhone are on the same Wi-Fi, then retry. If the requirement was already enabled, it stays enabled.',
        );
    } finally {
      clearTimeout(timeout);
      setBusy(false);
    }
  }
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
      <section
        className="phone-setup"
        style={{
          background: '#18181b',
          color: 'white',
          padding: 28,
          borderRadius: 16,
          maxWidth: 520,
        }}
      >
        <h2>Require iPhone presence</h2>
        <p>
          Keep Exam Companion open on your iPhone. Going Home, locking the phone, or losing Wi-Fi
          pauses answering after 8 seconds without a fresh ping. The exam deadline continues.
        </p>
        {inDesktop ? (
          <p className="phone-origin-note">
            Your iPhone must be on the same Wi-Fi as this Mac. When you create the QR, this app
            opens a small connection on your Wi-Fi that accepts only the phone&apos;s check-ins, and
            closes it when the exam ends. macOS may ask whether to allow incoming connections:
            choose Allow. The connection is not encrypted, so use a network you trust.
          </p>
        ) : (
          <>
            <label>
              This computer&apos;s Wi-Fi address{' '}
              <input
                value={origin}
                disabled={busy || !!pairing}
                onChange={(e) => setOrigin(e.target.value)}
                placeholder="http://192.168.1.10:5173"
              />
            </label>
            {guidance && <p role="status">{guidance}</p>}
            <p className="phone-origin-note">
              Type the address your iPhone can use to reach this computer on the same Wi-Fi, for
              example http://192.168.1.10:5173. The connection is not encrypted, so use a network
              you trust.
            </p>
          </>
        )}
        <label>
          <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />{' '}
          I agree to foreground connection checks. This requirement stays on for this attempt once
          enabled. No phone audio is monitored, and the camera is used only if you switch on the
          optional desk camera in the iPhone app.
        </label>
        <section aria-label="Optional desk camera">
          <h3>Optional desk camera</h3>
          <p>
            In the iPhone app you can turn on a desk camera. Stand the phone to the side so its back
            camera sees your keyboard and screen. The phone itself checks, every few seconds, how
            many people are in view, whether hands are near the keyboard and whether the view is
            lined up. Only those simple answers (a number and two yes/no values) are sent to the
            exam. Pictures and video never leave your phone and are not stored. Seeing another
            person or no one in view is recorded as a note for your instructor to review, not as a
            verdict.
          </p>
          <p role="status">
            Desk camera: {desk?.on ? 'on' : 'off'}
            {desk?.on ? (desk.framingOk ? ', framing OK' : ', adjust framing') : ''}
          </p>
        </section>
        <PhonePlacementCard />
        <p>
          Connection loss is not a cheating verdict. Only the latest pairing works; a new QR
          disconnects the previous phone.
        </p>
        <button
          className="exam-control"
          type="button"
          disabled={!consent || (!inDesktop && !url) || busy}
          onClick={() => void enable()}
        >
          {busy
            ? 'Creating pairing…'
            : pairing
              ? 'Replace pairing / new QR'
              : 'Enable requirement & create QR'}
        </button>
        {error && <p role="alert">{error}</p>}
        {expired && <p role="alert">This QR expired. Click Replace pairing / new QR.</p>}
        {pairing && url && !expired && (
          <>
            <div
              style={{
                background: 'white',
                padding: 16,
                margin: '16px auto',
                width: 'fit-content',
              }}
            >
              <QRCodeSVG value={url} size={220} />
            </div>
            <p>
              Install Exam Companion first, then scan with the iPhone Camera app. Confirm the laptop
              address inside the app and tap Connect. QR expires at{' '}
              {new Date(pairing.expiresAt).toLocaleTimeString()}.
            </p>
            <details>
              <summary>Manual pairing link (private)</summary>
              <textarea aria-label="Private pairing link" readOnly value={url} />
            </details>
          </>
        )}
        <p>
          <button className="exam-control exam-control--secondary" type="button" onClick={onClose}>
            Close setup
          </button>
        </p>
      </section>
    </div>
  );
}
