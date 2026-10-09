-- Aggregated pointer and typing-behaviour windows (15-30 s each) for integrity review.
-- Numbers only: never which keys were pressed, never typed text, never raw pointer positions.
CREATE TABLE IF NOT EXISTS input_behaviour_windows (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) > 0),
  attempt_id TEXT NOT NULL REFERENCES exam_attempts (id) ON DELETE CASCADE,
  window_start TEXT NOT NULL,
  window_ms INTEGER NOT NULL CHECK (window_ms > 0),
  pointer_events INTEGER NOT NULL DEFAULT 0,
  pointer_leaves INTEGER NOT NULL DEFAULT 0,
  pointer_outside_ms INTEGER NOT NULL DEFAULT 0,
  longest_outside_ms INTEGER NOT NULL DEFAULT 0,
  outside_edge TEXT CHECK (outside_edge IS NULL OR outside_edge IN ('left', 'right', 'top', 'bottom')),
  untrusted_events INTEGER NOT NULL DEFAULT 0,
  teleports INTEGER NOT NULL DEFAULT 0,
  robotic_segments INTEGER NOT NULL DEFAULT 0,
  path_straightness REAL,
  velocity_cv REAL,
  context_menus INTEGER NOT NULL DEFAULT 0,
  selections INTEGER NOT NULL DEFAULT 0,
  keys INTEGER NOT NULL DEFAULT 0,
  chars INTEGER NOT NULL DEFAULT 0,
  corrections INTEGER NOT NULL DEFAULT 0,
  mean_dwell_ms REAL,
  mean_interval_ms REAL,
  interval_cv REAL,
  wpm REAL,
  injections INTEGER NOT NULL DEFAULT 0,
  idle_pointer_injections INTEGER NOT NULL DEFAULT 0,
  drift_z_dwell REAL,
  drift_z_interval REAL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS input_behaviour_windows_attempt_idx
  ON input_behaviour_windows (attempt_id, window_start);
