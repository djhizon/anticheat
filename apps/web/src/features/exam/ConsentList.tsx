import { AUDIO_CONSENT_TEXT } from '../integrity/audioSession.js';

/** Plain statement that monitoring cannot be paused once the exam begins. */
export const NO_PAUSE_STATEMENT =
  'Once the exam begins, these checks run until you submit. You cannot pause or stop them yourself.';

/** Consent copy for the screen recording, depending on where the segments go. */
export function recordingStorageStatement(recordingUpload: boolean): string {
  return recordingUpload
    ? "Segments are uploaded to the school's secure OneDrive for exam review. Quality adapts to your connection; if the connection is poor, segments are saved on your computer instead."
    : 'Recordings stay on this computer: segments are saved to your Downloads folder and are never uploaded. Your instructor may ask you for them.';
}

export interface ConsentListProps {
  /** False when the exam keeps recordings on the student's computer only. */
  readonly recordingUpload?: boolean;
}

/** Everything the exam monitors; shown in the first setup step. */
export function ConsentList({ recordingUpload = true }: ConsentListProps = {}) {
  return (
    <ul className="consent-list">
      <li>
        <span className="consent-icon" aria-hidden="true">
          📷
        </span>
        <div>
          <strong>Camera &amp; Face Detection</strong>
          <p>
            Your face will be monitored throughout the exam to verify your identity and detect phone
            use. Checks run on this computer and start the moment you press Start exam. A few times
            during the exam, right after you answer or change question, the screen edges glow
            faintly in a few colours for about two seconds and a small &ldquo;Quick presence
            check&hellip;&rdquo; note appears in a corner; you keep answering and nothing needs a
            click. The colour reflected on your face is measured on this computer.
          </p>
        </div>
      </li>
      <li>
        <span className="consent-icon" aria-hidden="true">
          🎙️
        </span>
        <div>
          <strong>Audio Monitoring</strong>
          <p>
            Audio checks also start when the exam begins. A short presence check (face or voice) is
            done during setup, before the exam.
          </p>
          <p>{AUDIO_CONSENT_TEXT}</p>
        </div>
      </li>
      <li>
        <span className="consent-icon" aria-hidden="true">
          🌐
        </span>
        <div>
          <strong>Browser Integrity</strong>
          <p>Tab switching, focus loss, and suspicious keyboard patterns will be logged.</p>
        </div>
      </li>
      <li>
        <span className="consent-icon" aria-hidden="true">
          🖱️
        </span>
        <div>
          <strong>Typing and Mouse Patterns</strong>
          <p>Typing rhythm and mouse movement patterns (not what you type).</p>
        </div>
      </li>
      <li>
        <span className="consent-icon" aria-hidden="true">
          🔒
        </span>
        <div>
          <strong>One Tab Only</strong>
          <p>Only one exam tab is permitted. Opening another will lock this session.</p>
        </div>
      </li>
      <li>
        <span className="consent-icon" aria-hidden="true">
          ☁️
        </span>
        <div>
          <strong>Screen Recording (required)</strong>
          <p>
            Your entire screen (not a single window) is recorded, with the built-in microphone, for
            the whole exam: it starts in a setup step and runs until you submit.{' '}
            {recordingStorageStatement(recordingUpload)} If recording stops, answering pauses until
            you resume it.
          </p>
        </div>
      </li>
      <li>
        <span className="consent-icon" aria-hidden="true">
          📱
        </span>
        <div>
          <strong>iPhone Presence (required)</strong>
          <p>
            Pair your iPhone with Exam Companion in setup, before the exam starts, and keep the app
            open with the phone face-down on the desk. The phone only sends a regular &ldquo;still
            here&rdquo; signal; its camera and microphone are not used. If it disconnects you can
            keep answering; the disconnection is noted for your instructor.
          </p>
        </div>
      </li>
      <li>
        <span className="consent-icon" aria-hidden="true">
          📸
        </span>
        <div>
          <strong>Evidence Photos</strong>
          <p>
            If something unusual is detected (another person, a phone, looking away for a long
            time), one still photo is saved for your instructor and shown in your report.
          </p>
        </div>
      </li>
      <li>
        <span className="consent-icon" aria-hidden="true">
          ✍️
        </span>
        <div>
          <strong>No Paste Allowed</strong>
          <p>All answers must be typed manually. Paste is blocked and logged.</p>
        </div>
      </li>
      <li>
        <span className="consent-icon" aria-hidden="true">
          🤖
        </span>
        <div>
          <strong>AI Integrity Check</strong>
          <p>
            Your instructor may ask Gemini AI to review written answers for signs of AI-generated
            text. Results are a lead for a conversation, never an automatic penalty.
          </p>
        </div>
      </li>
    </ul>
  );
}
