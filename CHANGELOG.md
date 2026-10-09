# Hackathon Changelog

Every improvement made during the hackathon lands as its own commit so judges
can follow the progress with `git log`. The starting point and the full list of
known issues are documented in [docs/AUDIT.md](docs/AUDIT.md).

## Baseline (initial import)

- Imported the consent-first exam anti-cheat prototype (auth, exam delivery,
  integrity monitoring, desktop lockdown shell).
- Known at import: 1 failing test, 6 web typecheck errors, 4 critical bugs,
  2 performance issues and several unwired features.

## Hackathon progress

- **Fix #1** — phone status lookup queried a non-existent `integrity_phone_enrollments` table and crashed; now uses `phone_enrollments` (with regression test).
- **Fix #2** — vision bridge split stdout on a literal `\n` and wrote one to the Python server, so no request/response ever parsed; now uses real newlines and buffers partial lines.
- **Fix #3 (security)** — `PATCH /exam/attempts/:id/events` accepted unauthenticated requests, so anyone could inject fake app events for any attempt. It now requires a student session, CSRF token and attempt ownership; the Electron watcher forwards snapshots through the authenticated renderer instead of posting from the main process.
- **Fix #4 (security)** — the AI-check endpoint ran Gemini on any client-supplied text without checking attempt ownership. It now takes a `questionId`, verifies the attempt belongs to the caller and checks only their saved answer.
- **Security hardening (found during audit follow-up)** — liveness-verify, answer-revision history and recording upload routes did not check that the attempt belonged to the caller; all three now verify ownership.
