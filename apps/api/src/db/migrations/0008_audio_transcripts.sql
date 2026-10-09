-- Structured transcript log: text only, never raw audio.
CREATE TABLE IF NOT EXISTS audio_transcripts (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) > 0),
  attempt_id TEXT NOT NULL REFERENCES exam_attempts (id) ON DELETE CASCADE,
  captured_at TEXT NOT NULL,
  text TEXT NOT NULL CHECK (length(text) > 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS audio_transcripts_attempt_idx
  ON audio_transcripts (attempt_id, captured_at);

-- Migrate earlier transcripts that were stored as app events, then remove them
-- so the transparency report lists each transcript exactly once.
INSERT INTO audio_transcripts (id, attempt_id, captured_at, text, created_at)
SELECT lower(hex(randomblob(16))), attempt_id, created_at,
       substr(foreground_app, instr(foreground_app, '"') + 1,
              length(foreground_app) - instr(foreground_app, '"') - 1),
       created_at
FROM app_events
WHERE foreground_app LIKE '%Whisper Transcript: "%"'
  AND length(foreground_app) - instr(foreground_app, '"') - 1 > 0;

DELETE FROM app_events WHERE foreground_app LIKE '%Whisper Transcript: "%"';
