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
- **Fix #9 / feature** — the web client already uploaded keystroke-dynamics telemetry every 15s, but no route handled it. `POST /exam/attempts/:id/telemetry` now stores validated, capped batches for in-progress attempts the caller owns.
- **Fix #10 / feature: Transparency report** — new `GET /exam/attempts/:id/transparency` (owner only) and a post-submission panel showing students exactly what monitoring recorded (displays, apps, flagged behaviour, vision, gaze, audio), labelled clearly as not a verdict.
- **Resilience** — without `GEMINI_API_KEYS` the whole integrity service was disabled, so events, telemetry, liveness, revisions and transparency all returned 404. Monitoring now always runs; only the Gemini-backed AI checks report that keys are missing.
- **Fix #8 / feature: Collusion detection API** — the Gemini-embedding similarity detector was never called. New instructor-only routes list published exams with free-text questions and run a similarity report over every student's saved answer, returning flagged pairs with student emails.
- **Fix #12 / feature: Instructor workspace** — instructors used to hit a dead-end screen, and the similarity dashboard showed hardcoded fake data. Instructors now get a workspace where they pick an exam question and run a live collusion check, with flagged pairs highlighted by student email. The demo seed now creates an instructor account.
- **Fix #7 / feature: Server vision** — the OWL-ViT/YOLO bridge was never called. `POST /exam/attempts/:id/vision-check` (enabled with `ENABLE_BACKEND_VISION=true`) runs a camera frame through the Python detector as a second opinion and logs phones, earbuds and smart glasses to the transparency report.
- **Feature: Desktop app monitoring end-to-end** — the Electron foreground-app/display watcher was never started by the web app. The exam page now starts it in the lockdown shell and forwards only meaningful changes (another app focused, extra display) through the authenticated events endpoint, so they appear in the transparency report.
- **Code quality** — `npm run lint` went from 66 errors to 0: dead variables and imports removed, `any` replaced with real types (validated liveness/phone API responses, typed transparency rows), and the `_unused` convention adopted in the ESLint config.
- **Formatting** — applied Prettier to the 60 files that had drifted (formatting only, no behavior change), so `npm run validate` (format + lint + typecheck + tests) passes end to end.
- **CI** — GitHub Actions runs `npm run validate` on every push and pull request.
- **Docs** — README rewritten around the consent-first story, demo accounts (student + instructor), optional features and the incremental commit trail.
