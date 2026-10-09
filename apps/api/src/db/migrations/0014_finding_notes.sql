-- A student's own short note on one triage finding of their submitted attempt
-- ("What your teacher may look at"). Shown to the instructor next to the finding.
CREATE TABLE IF NOT EXISTS finding_notes (
  attempt_id TEXT NOT NULL REFERENCES exam_attempts (id) ON DELETE CASCADE,
  finding_id TEXT NOT NULL CHECK (length(finding_id) > 0),
  note TEXT NOT NULL CHECK (length(note) <= 280),
  created_at TEXT NOT NULL,
  PRIMARY KEY (attempt_id, finding_id)
);
