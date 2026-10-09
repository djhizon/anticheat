PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS exams (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) > 0),
  slug TEXT NOT NULL UNIQUE CHECK (length(slug) BETWEEN 2 AND 64),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS exam_versions (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) > 0),
  exam_id TEXT NOT NULL REFERENCES exams (id) ON DELETE RESTRICT,
  version_number INTEGER NOT NULL CHECK (version_number > 0),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 500),
  duration_seconds INTEGER NOT NULL CHECK (duration_seconds BETWEEN 1 AND 86400),
  status TEXT NOT NULL CHECK (status IN ('draft', 'published')),
  created_at TEXT NOT NULL,
  published_at TEXT,
  UNIQUE (exam_id, version_number),
  CHECK (
    (status = 'draft' AND published_at IS NULL) OR
    (status = 'published' AND published_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS exam_versions_exam_idx ON exam_versions (exam_id, version_number);
CREATE INDEX IF NOT EXISTS exam_versions_status_idx ON exam_versions (status);

CREATE TABLE IF NOT EXISTS question_versions (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) > 0),
  question_type TEXT NOT NULL CHECK (
    question_type IN ('multiple_choice', 'true_false', 'identification', 'numeric', 'short_answer')
  ),
  prompt TEXT NOT NULL CHECK (length(prompt) BETWEEN 1 AND 10000),
  options_json TEXT NOT NULL CHECK (json_valid(options_json) = 1),
  answer_key_json TEXT NOT NULL CHECK (json_valid(answer_key_json) = 1),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS exam_version_questions (
  exam_version_id TEXT NOT NULL REFERENCES exam_versions (id) ON DELETE CASCADE,
  question_version_id TEXT NOT NULL REFERENCES question_versions (id) ON DELETE RESTRICT,
  position INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY (exam_version_id, position),
  UNIQUE (exam_version_id, question_version_id)
);

CREATE INDEX IF NOT EXISTS exam_version_questions_question_idx
  ON exam_version_questions (question_version_id);

CREATE TABLE IF NOT EXISTS exam_assignments (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) > 0),
  exam_version_id TEXT NOT NULL REFERENCES exam_versions (id) ON DELETE RESTRICT,
  student_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  assigned_at TEXT NOT NULL,
  extra_time_seconds INTEGER NOT NULL DEFAULT 0 CHECK (extra_time_seconds BETWEEN 0 AND 86400),
  UNIQUE (exam_version_id, student_id)
);

CREATE INDEX IF NOT EXISTS exam_assignments_student_idx
  ON exam_assignments (student_id, assigned_at);

CREATE TABLE IF NOT EXISTS exam_attempts (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) > 0),
  assignment_id TEXT NOT NULL UNIQUE REFERENCES exam_assignments (id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('in_progress', 'submitted', 'expired')),
  attempt_seed TEXT NOT NULL CHECK (length(attempt_seed) > 0),
  started_at TEXT NOT NULL,
  base_deadline TEXT NOT NULL,
  effective_deadline TEXT NOT NULL,
  submitted_at TEXT,
  expired_at TEXT,
  CHECK (base_deadline > started_at),
  CHECK (effective_deadline >= base_deadline),
  CHECK (
    (status = 'in_progress' AND submitted_at IS NULL AND expired_at IS NULL) OR
    (status = 'submitted' AND submitted_at IS NOT NULL AND expired_at IS NULL) OR
    (status = 'expired' AND submitted_at IS NULL AND expired_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS exam_attempts_status_deadline_idx
  ON exam_attempts (status, effective_deadline);

CREATE TRIGGER IF NOT EXISTS published_exam_versions_immutable_update
BEFORE UPDATE ON exam_versions
FOR EACH ROW
WHEN OLD.status = 'published'
BEGIN
  SELECT RAISE(ABORT, 'published exam versions are immutable');
END;

CREATE TRIGGER IF NOT EXISTS published_exam_versions_immutable_delete
BEFORE DELETE ON exam_versions
FOR EACH ROW
WHEN OLD.status = 'published'
BEGIN
  SELECT RAISE(ABORT, 'published exam versions are immutable');
END;

CREATE TRIGGER IF NOT EXISTS published_exam_membership_immutable_insert
BEFORE INSERT ON exam_version_questions
FOR EACH ROW
WHEN COALESCE((SELECT status FROM exam_versions WHERE id = NEW.exam_version_id), '') = 'published'
BEGIN
  SELECT RAISE(ABORT, 'published exam question membership is immutable');
END;

CREATE TRIGGER IF NOT EXISTS published_exam_membership_immutable_update
BEFORE UPDATE ON exam_version_questions
FOR EACH ROW
WHEN OLD.exam_version_id IN (SELECT id FROM exam_versions WHERE status = 'published')
  OR NEW.exam_version_id IN (SELECT id FROM exam_versions WHERE status = 'published')
BEGIN
  SELECT RAISE(ABORT, 'published exam question membership is immutable');
END;

CREATE TRIGGER IF NOT EXISTS published_exam_membership_immutable_delete
BEFORE DELETE ON exam_version_questions
FOR EACH ROW
WHEN OLD.exam_version_id IN (SELECT id FROM exam_versions WHERE status = 'published')
BEGIN
  SELECT RAISE(ABORT, 'published exam question membership is immutable');
END;

CREATE TRIGGER IF NOT EXISTS published_question_versions_immutable_update
BEFORE UPDATE ON question_versions
FOR EACH ROW
WHEN EXISTS (
  SELECT 1
  FROM exam_version_questions AS membership
  JOIN exam_versions AS version ON version.id = membership.exam_version_id
  WHERE membership.question_version_id = OLD.id AND version.status = 'published'
)
BEGIN
  SELECT RAISE(ABORT, 'question versions in published exams are immutable');
END;

CREATE TRIGGER IF NOT EXISTS published_question_versions_immutable_delete
BEFORE DELETE ON question_versions
FOR EACH ROW
WHEN EXISTS (
  SELECT 1
  FROM exam_version_questions AS membership
  JOIN exam_versions AS version ON version.id = membership.exam_version_id
  WHERE membership.question_version_id = OLD.id AND version.status = 'published'
)
BEGIN
  SELECT RAISE(ABORT, 'question versions in published exams are immutable');
END;

CREATE TRIGGER IF NOT EXISTS published_assignment_only
BEFORE INSERT ON exam_assignments
FOR EACH ROW
WHEN COALESCE((SELECT status FROM exam_versions WHERE id = NEW.exam_version_id), '') <> 'published'
BEGIN
  SELECT RAISE(ABORT, 'only published exam versions can be assigned');
END;

CREATE TRIGGER IF NOT EXISTS terminal_attempts_immutable_update
BEFORE UPDATE ON exam_attempts
FOR EACH ROW
WHEN OLD.status IN ('submitted', 'expired')
BEGIN
  SELECT RAISE(ABORT, 'submitted or expired attempts are immutable');
END;

CREATE TRIGGER IF NOT EXISTS terminal_attempts_immutable_delete
BEFORE DELETE ON exam_attempts
FOR EACH ROW
WHEN OLD.status IN ('submitted', 'expired')
BEGIN
  SELECT RAISE(ABORT, 'submitted or expired attempts are immutable');
END;
