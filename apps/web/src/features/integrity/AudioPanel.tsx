import { useEffect, useState } from 'react';
import { createAudioSession, type AudioSnapshot } from './audioSession.js';
import { createAudioRecorder } from './audioRecorder.js';
import { acquireBuiltInMicrophone } from './builtInMicrophone.js';
import type { ExamApi } from '../exam/api.js';

export function AudioPanel({
  attemptId,
  active,
  examApi,
}: {
  readonly attemptId: string;
  readonly active: boolean;
  readonly examApi?: ExamApi;
}) {
  const [enabled, setEnabled] = useState(false);
  const [snapshot, setSnapshot] = useState<AudioSnapshot | null>(null);
  const [transcript, setTranscript] = useState<string[]>([]);
  const [status, setStatus] = useState('Audio not started.');
  const [device, setDevice] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    setEnabled(false);
    setTranscript([]);
  }, [attemptId]);
  useEffect(() => {
    if (!active || !enabled) return;
    let cancelled = false;
    let stream: MediaStream | null = null;
    const monitor = createAudioSession(
      attemptId,
      (value) => {
        if (!cancelled) setSnapshot(value);
      },
      () => {},
    );
    const recorder = examApi
      ? createAudioRecorder(
          attemptId,
          examApi,
          (text) => {
            if (!cancelled) setTranscript((previous) => [...previous.slice(-19), text]);
          },
          (text) => {
            if (!cancelled) setStatus(text);
          },
        )
      : null;
    setError('');
    setSnapshot(null);
    setStatus('Starting built-in microphone…');
    const ended = () => {
      setError('Built-in microphone disconnected. Retry audio.');
      setEnabled(false);
    };
    void (async () => {
      try {
        const acquired = await acquireBuiltInMicrophone();
        if (cancelled) {
          acquired.getTracks().forEach((track) => track.stop());
          return;
        }
        stream = acquired;
        setDevice(acquired.getAudioTracks()[0]?.label ?? 'Built-in microphone');
        acquired.getAudioTracks().forEach((track) => track.addEventListener('ended', ended));
        await monitor.start(true, acquired);
        if (cancelled) return;
        await recorder?.start(acquired);
        if (!recorder) setStatus('Transcription unavailable: exam API is not connected.');
      } catch (failure) {
        if (!cancelled) {
          setError(failure instanceof Error ? failure.message : 'Audio failed to start.');
          setEnabled(false);
        }
      }
    })();
    return () => {
      cancelled = true;
      recorder?.stop();
      monitor.destroy();
      stream?.getAudioTracks().forEach((track) => track.removeEventListener('ended', ended));
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, [active, enabled, attemptId, examApi]);
  const live = active && enabled && snapshot?.phase === 'recording';
  return (
    <section className="audio-panel-compact" aria-label="Audio checks">
      <p role="status">
        {live
          ? `Microphone active: ${device}`
          : enabled && active
            ? 'Starting audio…'
            : 'Audio off'}
      </p>
      <button type="button" disabled={!active} onClick={() => setEnabled((value) => !value)}>
        {enabled ? 'Stop audio' : error ? 'Retry audio' : 'Start audio'}
      </button>
      {error && <p role="alert">{error}</p>}
      {live && (
        <p>
          Sound activity events: {snapshot.voiceDetectedCount}. This is not proof of speech or
          cheating.
        </p>
      )}
      <h3>Local clip transcript</h3>
      <p role="status">{enabled && active ? status : 'Transcription off'}</p>
      <p className="muted">
        Five-second clips; capture pauses while processing. Uses only the built-in laptop
        microphone.
      </p>
      {transcript.length > 0 && (
        <div className="transcript-feed">
          {transcript.map((text, index) => (
            <p key={index}>{text}</p>
          ))}
        </div>
      )}
    </section>
  );
}
