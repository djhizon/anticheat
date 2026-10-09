-- Optional external identity provider (Supabase Auth). Roles stay in this database.
-- External users carry password_hash = '!external', which never verifies locally.
ALTER TABLE users
  ADD COLUMN auth_provider TEXT NOT NULL DEFAULT 'local'
  CHECK (auth_provider IN ('local', 'supabase'));

ALTER TABLE users ADD COLUMN external_id TEXT CHECK (external_id IS NULL OR length(external_id) > 0);

CREATE UNIQUE INDEX IF NOT EXISTS users_external_id_idx
  ON users (external_id)
  WHERE external_id IS NOT NULL;
