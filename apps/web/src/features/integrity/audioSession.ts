import { acquireBuiltInMicrophone } from './builtInMicrophone.js';

/** Default of the API's AUDIO_RETAIN_DAYS; the deployment may configure a shorter or longer window. */
export const AUDIO_RETAIN_DAYS_DEFAULT = 30;

export const AUDIO_CONSENT_TEXT =
  'Your microphone is used to detect sound activity and to transcribe short clips to text on ' +
  'this computer with Whisper. Only the text is saved, never the audio. You can see it in your ' +
  `report. The text is kept for ${AUDIO_RETAIN_DAYS_DEFAULT} days by default and then deleted ` +
  'automatically. Other people’s speech near you can also be captured and transcribed.';

export interface AudioSnapshot {
  readonly phase: 'off' | 'permission' | 'recording' | 'stopped';
  readonly reason: string;
  readonly recordingSeconds: number;
  readonly voiceDetectedCount: number;
  readonly lastVoiceAt: number | null;
}

export function createAudioSession(
  _attemptId: string,
  publish: (snapshot: AudioSnapshot) => void,
  onVoiceDetected: (durationMs: number, peakDb: number) => void,
) {
  let destroyed = false;
  let generation = 0;
  let snapshot: AudioSnapshot = {
    phase: 'off',
    reason: 'Not started',
    recordingSeconds: 0,
    voiceDetectedCount: 0,
    lastVoiceAt: null,
  };
  let stream: MediaStream | null = null;
  let ownsStream = false;
  let context: AudioContext | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let removeEnded = () => {};
  const update = (next: Partial<AudioSnapshot>) => {
    snapshot = { ...snapshot, ...next };
    if (!destroyed) publish(snapshot);
  };
  function stop(reason = 'Stopped') {
    generation++;
    if (timer) clearInterval(timer);
    timer = null;
    removeEnded();
    if (ownsStream) stream?.getTracks().forEach((track) => track.stop());
    stream = null;
    void context?.close().catch(() => {});
    context = null;
    update({ phase: 'stopped', reason });
  }
  async function start(consented: boolean, shared?: MediaStream) {
    if (!consented || destroyed || snapshot.phase === 'recording') return;
    const token = ++generation;
    update({ phase: 'permission', reason: 'Starting built-in microphone…' });
    try {
      const acquired = shared ?? (await acquireBuiltInMicrophone());
      if (destroyed || token !== generation) {
        if (!shared) acquired.getTracks().forEach((track) => track.stop());
        return;
      }
      stream = acquired;
      ownsStream = !shared;
      context = new AudioContext();
      const source = context.createMediaStreamSource(acquired);
      const analyser = context.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      await context.resume();
      if (destroyed || token !== generation) return;
      const ended = () => stop('Built-in microphone disconnected. Retry audio.');
      acquired.getAudioTracks().forEach((track) => track.addEventListener('ended', ended));
      removeEnded = () =>
        acquired.getAudioTracks().forEach((track) => track.removeEventListener('ended', ended));
      const values = new Float32Array(analyser.fftSize);
      const started = Date.now();
      // Poll at 5 Hz, publish at most once/second. No extra recorder or audible
      // output graph is necessary to display sound activity.
      timer = setInterval(() => {
        analyser.getFloatTimeDomainData(values);
        const rms = Math.sqrt(
          values.reduce((sum, value) => sum + value * value, 0) / values.length,
        );
        const seconds = Math.floor((Date.now() - started) / 1000);
        if (rms > 0.035 && Date.now() - (snapshot.lastVoiceAt ?? 0) > 1500) {
          update({
            recordingSeconds: seconds,
            voiceDetectedCount: snapshot.voiceDetectedCount + 1,
            lastVoiceAt: Date.now(),
          });
          onVoiceDetected(200, 20 * Math.log10(rms));
        } else if (seconds !== snapshot.recordingSeconds) update({ recordingSeconds: seconds });
      }, 200);
      update({ phase: 'recording', reason: 'Microphone active' });
    } catch (error) {
      if (!destroyed && token === generation) {
        stop(error instanceof Error ? error.message : 'Microphone unavailable');
        throw error;
      }
    }
  }
  return {
    start,
    stop,
    snapshot: () => snapshot,
    destroy() {
      destroyed = true;
      stop();
    },
  };
}
