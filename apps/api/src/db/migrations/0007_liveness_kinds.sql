-- Allow the real liveness challenge kinds in liveness_challenges.challenge_type.
-- SQLite cannot alter a CHECK constraint, so rebuild the table. Legacy values
-- (flash/gesture/word) stay valid so existing rows copy across unchanged.
CREATE TABLE liveness_challenges_new (
  nonce TEXT PRIMARY KEY NOT NULL CHECK (length(nonce) > 0),
  attempt_id TEXT NOT NULL REFERENCES exam_attempts (id) ON DELETE CASCADE,
  challenge_type TEXT NOT NULL CHECK (
    challenge_type IN ('flash', 'gesture', 'word', 'colour_flash', 'head_turn', 'spoken_words')
  ),
  challenge_data TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(challenge_data) = 1),
  issued_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0 CHECK (used IN (0, 1))
);

INSERT INTO liveness_challenges_new (nonce, attempt_id, challenge_type, challenge_data, issued_at, expires_at, used)
  SELECT nonce, attempt_id, challenge_type, challenge_data, issued_at, expires_at, used
  FROM liveness_challenges;

DROP TABLE liveness_challenges;
ALTER TABLE liveness_challenges_new RENAME TO liveness_challenges;

CREATE INDEX IF NOT EXISTS liveness_challenges_attempt_idx
  ON liveness_challenges (attempt_id, issued_at);
