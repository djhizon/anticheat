-- Triggered still snapshots (one JPEG per unusual event) for instructor review.
-- Never continuous video. Rows are removed by the EVIDENCE_RETAIN_DAYS sweep.
CREATE TABLE IF NOT EXISTS evidence_snapshots (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) > 0),
  attempt_id TEXT NOT NULL REFERENCES exam_attempts (id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('webcam', 'screen', 'desk_camera')),
  trigger TEXT NOT NULL CHECK (length(trigger) > 0),
  captured_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  mime TEXT NOT NULL DEFAULT 'image/jpeg',
  bytes BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS evidence_snapshots_attempt_idx
  ON evidence_snapshots (attempt_id, captured_at);
CREATE INDEX IF NOT EXISTS evidence_snapshots_rate_idx
  ON evidence_snapshots (attempt_id, source, trigger, created_at);
