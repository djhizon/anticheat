-- Separate from the legacy browser companion. Row existence is the persistent
-- opt-in requirement; replacing a pairing never disables the answering gate.
CREATE TABLE phone_presence (
  attempt_id TEXT PRIMARY KEY NOT NULL REFERENCES exam_attempts(id) ON DELETE CASCADE,
  pairing_hash TEXT UNIQUE,
  pairing_expires_ms INTEGER NOT NULL,
  credential_hash TEXT UNIQUE,
  credential_expires_ms INTEGER NOT NULL,
  sequence INTEGER NOT NULL DEFAULT 0
);
