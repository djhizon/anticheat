-- Pre-exam setup: an attempt created with setup=true stays "awaiting start" (questions withheld,
-- generous placeholder deadline) until the student finishes setup and begins; beginning removes
-- the row and starts the real timer. Attempts without a row are already begun.
CREATE TABLE IF NOT EXISTS attempt_setup (
  attempt_id TEXT PRIMARY KEY NOT NULL REFERENCES exam_attempts (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);
