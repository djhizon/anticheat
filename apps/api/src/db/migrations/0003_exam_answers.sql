PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS attempt_answers (
  attempt_id TEXT NOT NULL REFERENCES exam_attempts (id) ON DELETE CASCADE,
  question_version_id TEXT NOT NULL REFERENCES question_versions (id) ON DELETE RESTRICT,
  answer_json TEXT NOT NULL CHECK (json_valid(answer_json) = 1),
  revision INTEGER NOT NULL CHECK (revision > 0),
  saved_at TEXT NOT NULL,
  PRIMARY KEY (attempt_id, question_version_id)
);

CREATE INDEX IF NOT EXISTS attempt_answers_revision_idx
  ON attempt_answers (attempt_id, revision);

CREATE TABLE IF NOT EXISTS attempt_mutations (
  attempt_id TEXT NOT NULL REFERENCES exam_attempts (id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 200),
  operation TEXT NOT NULL CHECK (operation IN ('save_answers', 'submit_attempt')),
  request_hash TEXT NOT NULL CHECK (length(request_hash) > 0),
  resulting_revision INTEGER NOT NULL CHECK (resulting_revision >= 0),
  response_json TEXT NOT NULL CHECK (json_valid(response_json) = 1),
  created_at TEXT NOT NULL,
  PRIMARY KEY (attempt_id, idempotency_key, operation)
);

CREATE TRIGGER IF NOT EXISTS active_attempt_answers_only_insert
BEFORE INSERT ON attempt_answers
FOR EACH ROW
WHEN COALESCE((SELECT status FROM exam_attempts WHERE id = NEW.attempt_id), '') <> 'in_progress'
BEGIN
  SELECT RAISE(ABORT, 'only in-progress attempts can receive answers');
END;

CREATE TRIGGER IF NOT EXISTS active_attempt_answers_only_update
BEFORE UPDATE ON attempt_answers
FOR EACH ROW
WHEN COALESCE((SELECT status FROM exam_attempts WHERE id = OLD.attempt_id), '') <> 'in_progress'
  OR COALESCE((SELECT status FROM exam_attempts WHERE id = NEW.attempt_id), '') <> 'in_progress'
BEGIN
  SELECT RAISE(ABORT, 'submitted or expired answers are immutable');
END;

CREATE TRIGGER IF NOT EXISTS active_attempt_answers_only_delete
BEFORE DELETE ON attempt_answers
FOR EACH ROW
WHEN COALESCE((SELECT status FROM exam_attempts WHERE id = OLD.attempt_id), '') <> 'in_progress'
BEGIN
  SELECT RAISE(ABORT, 'submitted or expired answers are immutable');
END;
