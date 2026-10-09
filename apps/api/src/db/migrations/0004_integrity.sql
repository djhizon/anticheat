PRAGMA foreign_keys = ON;

-- Keystroke-level answer revision history (gdocs-style)
CREATE TABLE IF NOT EXISTS answer_revisions (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) > 0),
  attempt_id TEXT NOT NULL REFERENCES exam_attempts (id) ON DELETE CASCADE,
  question_version_id TEXT NOT NULL,
  value_text TEXT NOT NULL,
  word_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS answer_revisions_attempt_idx
  ON answer_revisions (attempt_id, question_version_id, created_at);

-- Audio session blobs
CREATE TABLE IF NOT EXISTS audio_sessions (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) > 0),
  attempt_id TEXT NOT NULL REFERENCES exam_attempts (id) ON DELETE CASCADE,
  blob_path TEXT NOT NULL CHECK (length(blob_path) > 0),
  duration_ms INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS audio_sessions_attempt_idx
  ON audio_sessions (attempt_id);

-- Native companion events (foreground app, display count)
CREATE TABLE IF NOT EXISTS app_events (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) > 0),
  attempt_id TEXT NOT NULL REFERENCES exam_attempts (id) ON DELETE CASCADE,
  foreground_app TEXT NOT NULL DEFAULT '',
  display_count INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS app_events_attempt_idx
  ON app_events (attempt_id, created_at);

-- Keystroke dynamics (dwell + flight time per keystroke)
CREATE TABLE IF NOT EXISTS keystroke_events (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) > 0),
  attempt_id TEXT NOT NULL REFERENCES exam_attempts (id) ON DELETE CASCADE,
  question_version_id TEXT NOT NULL,
  dwell_ms REAL NOT NULL CHECK (dwell_ms >= 0),
  flight_ms REAL NOT NULL CHECK (flight_ms >= 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS keystroke_events_attempt_idx
  ON keystroke_events (attempt_id, question_version_id);

-- Gaze tracking events (off-screen durations, no coordinates)
CREATE TABLE IF NOT EXISTS gaze_events (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) > 0),
  attempt_id TEXT NOT NULL REFERENCES exam_attempts (id) ON DELETE CASCADE,
  off_screen_start TEXT NOT NULL,
  duration_ms INTEGER NOT NULL CHECK (duration_ms > 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS gaze_events_attempt_idx
  ON gaze_events (attempt_id, created_at);

-- Liveness check results (all 4 layers)
CREATE TABLE IF NOT EXISTS liveness_events (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) > 0),
  attempt_id TEXT NOT NULL REFERENCES exam_attempts (id) ON DELETE CASCADE,
  layer INTEGER NOT NULL CHECK (layer BETWEEN 1 AND 4),
  -- layer 1=noise, 2=flash, 3=challenge, 4=jitter
  result TEXT NOT NULL CHECK (result IN ('pass', 'fail', 'skip')),
  nonce TEXT,
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json) = 1),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS liveness_events_attempt_idx
  ON liveness_events (attempt_id, created_at);

-- Phone enrollment + heartbeat
CREATE TABLE IF NOT EXISTS phone_enrollments (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) > 0),
  attempt_id TEXT NOT NULL REFERENCES exam_attempts (id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE CHECK (length(token) > 0),
  last_seen_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS phone_enrollments_token_idx
  ON phone_enrollments (token);

-- Voice detection events (FFT speech band, no audio content)
CREATE TABLE IF NOT EXISTS voice_events (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) > 0),
  attempt_id TEXT NOT NULL REFERENCES exam_attempts (id) ON DELETE CASCADE,
  detected_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL CHECK (duration_ms > 0),
  peak_db REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS voice_events_attempt_idx
  ON voice_events (attempt_id, created_at);

-- Liveness flash challenges (server-signed nonces)
CREATE TABLE IF NOT EXISTS liveness_challenges (
  nonce TEXT PRIMARY KEY NOT NULL CHECK (length(nonce) > 0),
  attempt_id TEXT NOT NULL REFERENCES exam_attempts (id) ON DELETE CASCADE,
  challenge_type TEXT NOT NULL CHECK (challenge_type IN ('flash', 'gesture', 'word')),
  challenge_data TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(challenge_data) = 1),
  issued_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0 CHECK (used IN (0, 1))
);
CREATE INDEX IF NOT EXISTS liveness_challenges_attempt_idx
  ON liveness_challenges (attempt_id, issued_at);
