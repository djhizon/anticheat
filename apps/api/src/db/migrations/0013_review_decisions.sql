-- Instructor triage decision per attempt ("Fine" or "Follow up" plus an optional note).
-- One row per attempt; deciding again replaces the row. Findings stay leads, never verdicts.
CREATE TABLE IF NOT EXISTS review_decisions (
  attempt_id TEXT PRIMARY KEY NOT NULL REFERENCES exam_attempts (id) ON DELETE CASCADE,
  decision TEXT NOT NULL CHECK (decision IN ('fine', 'follow_up')),
  note TEXT,
  decided_by TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  decided_at TEXT NOT NULL
);
