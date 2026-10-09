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
- **Tests** — schema test still expected only the first three migrations; updated it to cover the integrity and phone presence tables (fixes the one failing test in the suite).
- **Green build** — fixed all 6 web typecheck errors: shared similarity report types moved into `@exam-anti-cheat/contracts`, `keystroke_violation` added as a flag-only violation type, a strict-index fix in the watermark encoder and a type declaration for the MediaPipe WASM factory. `npm run typecheck` and `npm test` (147 tests) now pass.
- **Kick policy** — the exam page had its own copy of the kick thresholds that omitted `overlay_detected`, so a Cluely-style overlay never kicked the student. Both the exam page and app shell now use the single `shouldKick` policy in `tabGuard.ts` (with tests).
- **Fix #5 (performance)** — Whisper allowed one transcription across all students and returned 503 to everyone else. It now runs a configurable pool (`WHISPER_CONCURRENCY`, default 2) with a bounded wait queue (`WHISPER_MAX_QUEUE`, default 8); only overflow is rejected.
- **Fix #6 (performance)** — overlapping vision requests silently rejected each other. The bridge is now a `VisionClient` with a FIFO queue, per-request timeouts, a bounded backlog and automatic restart when the Python server exits (with tests).
- **Fix #13** — `isExamPath()` omitted the recording, speedtest, vision, telemetry and transparency routes, so browser preflights got 404 and the calls failed cross-origin. All browser-called exam routes now pass preflight (with test).
