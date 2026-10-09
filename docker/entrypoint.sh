#!/bin/sh
# Seeds the demo data once (when the database file does not exist yet), then
# starts the API, which also serves the built web app.
set -eu

DB="${DATABASE_PATH:-/data/exam-anti-cheat.sqlite}"
export DATABASE_PATH="$DB"

cd /app/apps/api

if [ ! -f "$DB" ]; then
  echo "[entrypoint] No database at $DB; seeding demo data..."
  /app/node_modules/.bin/vite-node src/seed-demo.ts || {
    echo "[entrypoint] Demo seed failed; removing partial database." >&2
    rm -f "$DB" "$DB-shm" "$DB-wal"
    exit 1
  }
fi

exec /app/node_modules/.bin/vite-node src/start.ts
