import { useState } from 'react';

interface RecordingBridge {
  openRecordingsFolder?: () => Promise<{ opened: boolean; path?: string; error?: string }>;
}

function bridge(): RecordingBridge | undefined {
  return (window as unknown as { electronExam?: RecordingBridge }).electronExam;
}

/** After submit: opens the folder holding this Mac's screen-recording segments (Mac app only). */
export function RecordingFolderButton() {
  const open = bridge()?.openRecordingsFolder;
  const [status, setStatus] = useState<string | null>(null);
  if (typeof open !== 'function') {
    return (
      <p className="recording-folder-note">
        Your screen recording segments were saved to this computer&apos;s Downloads folder.
      </p>
    );
  }
  return (
    <div className="recording-folder">
      <button
        type="button"
        className="secondary-button"
        onClick={() => {
          setStatus('Opening…');
          open()
            .then((result) =>
              setStatus(
                result.opened
                  ? `Opened ${result.path ?? 'the recordings folder'} in Finder.`
                  : `Could not open the folder: ${result.error ?? 'unknown error'}`,
              ),
            )
            .catch(() => setStatus('Could not open the recordings folder.'));
        }}
      >
        View screen recording
      </button>
      {status && (
        <p role="status" className="recording-folder-note">
          {status}
        </p>
      )}
    </div>
  );
}
