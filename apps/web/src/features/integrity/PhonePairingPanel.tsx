import { useEffect, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import type { ExamApi } from '../exam/api.js';
import { desktopAppsBridge } from './desktopApps.js';
import { nativePhoneUrl } from './nativePhoneUrl.js';

/** The laptop's Wi-Fi origin, when the page is not served from a loopback address. */
export function defaultPairingOrigin(): string {
  if (typeof window === 'undefined') return '';
  const { origin, hostname } = window.location;
  return /^(localhost|127\.|\[?::1\]?$)/i.test(hostname) ? '' : origin;
}

/**
 * iPhone pairing: one button, then a big QR for Exam Companion (the phone only sends presence
 * heartbeats). Used by pre-exam setup and the exam page's reconnect banner.
 */
export function PhonePairingPanel({
  attemptId,
  api,
  heading = 'Pair your iPhone',
  onPairingCreated,
}: {
  attemptId: string;
  api: ExamApi;
  heading?: string;
  /** Called whenever a fresh pairing QR was created. */
  onPairingCreated?: () => void;
}) {
  // In the desktop app the main process opens a LAN listener on demand and supplies the origin;
  // in a plain browser the student types the address of this computer.
  const lanBridge = desktopAppsBridge()?.startPhoneLan;
  const inDesktop = typeof lanBridge === 'function';
  const [origin, setOrigin] = useState(() => (inDesktop ? '' : defaultPairingOrigin()));
  const [pairing, setPairing] = useState<{ code: string; expiresAt: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());
  const request = useRef<AbortController | null>(null);
  const onCreated = useRef(onPairingCreated);
  onCreated.current = onPairingCreated;
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
        : "Enter this computer's Wi-Fi address first (starting with http://).";
  }
  const expired =
    pairing !== null &&
    (!Number.isFinite(Date.parse(pairing.expiresAt)) || now >= Date.parse(pairing.expiresAt));
  async function create() {
    if ((!inDesktop && !url) || busy) return;
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
        onCreated.current?.();
      }
    } catch {
      if (request.current === controller)
        setError(
          'Pairing failed or timed out. Check that this computer and your iPhone are on the same Wi-Fi, then retry.',
        );
    } finally {
      clearTimeout(timeout);
      setBusy(false);
    }
  }
  return (
    <section className="phone-setup" aria-label={heading}>
      <h3>{heading}</h3>
      <p className="phone-pair-instruction">
        Open Exam Companion on your iPhone and scan this code.
      </p>
      {inDesktop ? (
        <p className="phone-origin-note">
          Your iPhone must be on the same Wi-Fi as this Mac. If macOS asks whether to allow incoming
          connections, choose Allow.
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
            The address your iPhone uses to reach this computer on the same Wi-Fi, for example
            http://192.168.1.10:5173. The connection is not encrypted, so use a network you trust.
          </p>
        </>
      )}
      {(pairing === null || expired) && (
        <button
          className="exam-control"
          type="button"
          disabled={(!inDesktop && !url) || busy}
          onClick={() => void create()}
        >
          {busy ? 'Creating the code…' : pairing ? 'Show a new QR code' : 'Show QR code'}
        </button>
      )}
      {error && <p role="alert">{error}</p>}
      {expired && <p role="alert">This QR code expired. Show a new one.</p>}
      {pairing && url && !expired && (
        <>
          <div className="phone-qr">
            <QRCodeSVG value={url} size={280} />
          </div>
          <details>
            <summary>Show the link instead</summary>
            <textarea aria-label="Private pairing link" readOnly value={url} />
          </details>
          <button
            className="exam-control exam-control--secondary"
            type="button"
            disabled={busy}
            onClick={() => void create()}
          >
            Show a new QR code
          </button>
        </>
      )}
    </section>
  );
}
