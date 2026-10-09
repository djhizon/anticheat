-- Privacy settings per exam.
--   retain_days: one retention window for evidence photos, screen-recording metadata and
--     transcripts. NULL = server defaults (EVIDENCE_RETAIN_DAYS / AUDIO_RETAIN_DAYS);
--     0 = keep until the attempt is removed.
--   recording_upload: 'on' uploads screen-recording segments to OneDrive, 'off' keeps them on the
--     student's computer only. NULL = server default (RECORDING_UPLOAD).
ALTER TABLE exams ADD COLUMN retain_days INTEGER
  CHECK (retain_days IS NULL OR retain_days BETWEEN 0 AND 3650);
ALTER TABLE exams ADD COLUMN recording_upload TEXT
  CHECK (recording_upload IS NULL OR recording_upload IN ('on', 'off'));

-- Metadata of uploaded screen-recording segments (the bytes live in OneDrive, never here), so the
-- retention sweep and the "marked fine" sweep can remove the remote files and forget them.
CREATE TABLE IF NOT EXISTS recording_segments (
  attempt_id TEXT NOT NULL REFERENCES exam_attempts (id) ON DELETE CASCADE,
  segment_index INTEGER NOT NULL CHECK (segment_index >= 0),
  student_id TEXT NOT NULL,
  bytes INTEGER NOT NULL CHECK (bytes >= 0),
  uploaded_at TEXT NOT NULL,
  PRIMARY KEY (attempt_id, segment_index)
);
CREATE INDEX IF NOT EXISTS recording_segments_uploaded_idx ON recording_segments (uploaded_at);
