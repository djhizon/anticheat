import { useEffect, useRef, useState } from 'react';

export function CompanionApp() {
  const [status, setStatus] = useState('Connecting…');
  const [microphoneStatus, setMicrophoneStatus] = useState('Microphone off');
  const [micActive, setMicActive] = useState(false);
  const token = new URLSearchParams(window.location.search).get('token');
  const audio = useRef<{ stream: MediaStream; context: AudioContext; frame: number } | null>(null);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (audio.current) {
        cancelAnimationFrame(audio.current.frame);
        audio.current.stream.getTracks().forEach((track) => track.stop());
        void audio.current.context.close().catch(() => {});
        audio.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!token) {
      setStatus('Invalid QR: missing enrollment token.');
      return;
    }
    let disposed = false;
    let pending: AbortController | null = null;
    async function heartbeat() {
      if (pending || disposed) return;
      const controller = new AbortController();
      pending = controller;
      const timeout = setTimeout(() => controller.abort(), 5000);
      try {
        const response = await fetch('/exam/phone-heartbeat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token, hidden: document.hidden, timestamp: Date.now() }),
          signal: controller.signal,
        });
        const body = await response.json();
        if (!disposed)
          setStatus(
            response.ok && body.ok === true
              ? 'Connected — heartbeat acknowledged'
              : 'Enrollment rejected. Scan a new QR code.',
          );
      } catch {
        if (!disposed) setStatus('Connection lost. Check Wi-Fi and the laptop servers.');
      } finally {
        clearTimeout(timeout);
        pending = null;
      }
    }
    void heartbeat();
    const timer = setInterval(() => void heartbeat(), 3000);
    const visibility = () => {
      void heartbeat();
    };
    document.addEventListener('visibilitychange', visibility);
    return () => {
      disposed = true;
      pending?.abort();
      clearInterval(timer);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [token]);

  async function enableMicrophone() {
    if (micActive || !window.isSecureContext) return;
    setMicActive(true);
    let stream: MediaStream | null = null;
    let context: AudioContext | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!mounted.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      context = new AudioContext();
      await context.resume();
      if (!mounted.current) {
        stream.getTracks().forEach((track) => track.stop());
        await context.close();
        return;
      }
      const analyser = context.createAnalyser();
      analyser.fftSize = 2048;
      context.createMediaStreamSource(stream).connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      const bin = Math.round((19000 / (context.sampleRate / 2)) * data.length);
      const session = { stream, context, frame: 0 };
      audio.current = session;
      function observe() {
        if (audio.current !== session) return;
        analyser.getByteFrequencyData(data);
        setMicrophoneStatus(
          (data[bin] ?? 0) > 50
            ? '19 kHz signal detected (experimental)'
            : 'Listening; no 19 kHz signal detected',
        );
        session.frame = requestAnimationFrame(observe);
      }
      observe();
    } catch {
      stream?.getTracks().forEach((track) => track.stop());
      if (context) await context.close().catch(() => {});
      if (mounted.current) {
        setMicActive(false);
        setMicrophoneStatus('Microphone unavailable or permission denied.');
      }
    }
  }

  return (
    <main style={{ padding: 24, color: '#fff', background: '#171717', minHeight: '100vh' }}>
      <h1>Exam companion phone</h1>
      <p role="status">{status}</p>
      <p>{microphoneStatus}</p>
      {!window.isSecureContext ? (
        <p role="alert">
          HTTP Wi-Fi mode: enrollment and heartbeat only. Microphone access requires a trusted HTTPS
          connection.
        </p>
      ) : (
        <button type="button" disabled={micActive} onClick={() => void enableMicrophone()}>
          Enable proximity microphone
        </button>
      )}
      <p>
        Keep this page open and the laptop servers running. This page does not currently record
        camera video.
      </p>
    </main>
  );
}
