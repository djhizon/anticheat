import { useEffect, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import type { ExamApi, PhonePresenceStatus } from '../exam/api.js';
import { nativePhoneUrl } from './nativePhoneUrl.js';

export function NativePhoneModal({
  attemptId,
  api,
  onClose,
}: {
  attemptId: string;
  api: ExamApi;
  onClose: () => void;
}) {
  const [origin, setOrigin] = useState('');
  const [consent, setConsent] = useState(false);
  const [pairing, setPairing] = useState<{ code: string; expiresAt: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());
  const [desk, setDesk] = useState<PhonePresenceStatus['deskCamera'] | null>(null);
  const request = useRef<AbortController | null>(null);
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
    guidance = origin.trim()
      ? failure instanceof Error
        ? failure.message
        : 'Invalid laptop origin.'
      : 'Enter the laptop Wi-Fi address first (including http:// and :5173). Checking consent alone does not create a QR.';
  }
  const expired =
    pairing !== null &&
    (!Number.isFinite(Date.parse(pairing.expiresAt)) || now >= Date.parse(pairing.expiresAt));
  async function enable() {
    if (!consent || !url || busy) return;
    setBusy(true);
    setError('');
    setPairing(null);
    const controller = new AbortController();
    request.current = controller;
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const result = await api.requirePhonePresence(attemptId, controller.signal);
      if (!controller.signal.aborted) {
        setNow(Date.now());
        setPairing(result);
      }
    } catch {
      if (request.current === controller)
        setError(
          'Pairing failed or timed out. Check the API server and Wi-Fi origin, then retry. If the server already enabled the requirement, it stays enabled.',
        );
    } finally {
      clearTimeout(timeout);
      setBusy(false);
    }
  }
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Require iPhone presence"
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
        <label>
          Laptop origin{' '}
          <input
            value={origin}
            disabled={busy || !!pairing}
            onChange={(e) => setOrigin(e.target.value)}
            placeholder="http://192.168.1.10:5173"
          />
        </label>
        {guidance && <p role="status">{guidance}</p>}
        <p>
          Use the Wi-Fi origin printed by EXAM_LAN=1 npm run dev. HTTP is an unencrypted,
          trusted-Wi-Fi Debug demo only.
        </p>
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
            camera sees your keyboard and screen. The phone itself checks, every few seconds,, how
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
        <p>
          Connection loss is not a cheating verdict. Only the latest pairing works; a new QR
          disconnects the previous phone.
        </p>
        <button
          className="exam-control"
          type="button"
          disabled={!consent || !url || busy}
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
