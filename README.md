# anticheat — consent-first exam integrity

[![CI](https://github.com/djhizon/anticheat/actions/workflows/ci.yml/badge.svg)](https://github.com/djhizon/anticheat/actions/workflows/ci.yml)

A browser + desktop exam platform that helps instructors keep online exams
honest **without treating students as suspects**. Students see exactly what is
monitored before they start, and exactly what was recorded after they finish.
Every signal is a lead for a human to review. Nothing is an automatic verdict.

> **Hackathon judges:** follow the 5-minute script in
> [docs/DEMO.md](docs/DEMO.md). This repo is built incrementally. Start with
> [CHANGELOG.md](CHANGELOG.md) for the story, then `git log --oneline` to see
> each fix and feature land as its own commit. The baseline audit, including
> every known bug at import, is in [docs/AUDIT.md](docs/AUDIT.md).
> Pre-existing code is disclosed in
> [docs/EXISTING_CODE.md](docs/EXISTING_CODE.md).
> Submission answers (local vs cloud, models, disclosures):
> [docs/SUBMISSION.md](docs/SUBMISSION.md).

## Local-first AI

The core AI runs on the student's own machine and keeps working if cloud
services disappear: MediaPipe face, head-pose and phone detection in the
browser, local Whisper speech-to-text, keystroke dynamics, voice activity and a
native-webcam liveness flash check. Gemini features are optional, secondary
instructor aids. See the honest per-component inventory, including limitations,
in [docs/LOCAL_AI.md](docs/LOCAL_AI.md).

## What it does

**Students**

- A consent screen that lists every monitor before the exam starts.
- One question at a time, with autosave and an idempotent submit.
- A **transparency report** after submission that lists every recorded event in
  plain language.
- Optional iPhone presence pairing with clear, non-accusatory messages, plus an
  opt-in **desk camera**: the phone uses Apple's on-device Vision framework to
  count people and check for hands near the keyboard, and sends only three
  flags (people, hands visible, framing OK), never images.
- A liveness check that students can always pass: a random colour flash read by
  the native webcam, with a head-turn option and a spoken-word option
  (checked by local Whisper) when the room or the camera makes the flash hard.
- Opt-in **adaptive cloud recording**: upload speed is measured first and
  quality (720p, 540p or 360p) is chosen to use at most about 25% of the
  student's uplink. Segments upload in the background to the school's OneDrive,
  step down if uploads fall behind, and fall back to saving on the student's
  computer. The exam never waits on an upload.
- Email account flows when Supabase is configured: confirm sign-up, forgot and
  reset password, and change password and change email from an Account panel.
  Without Supabase, offline local accounts work as before.
- An on-demand Gemini-generated exam (static questions are used without keys).

**Instructors**

- An instructor workspace with a live **cross-student similarity** check
  (Gemini embeddings over every saved free-text answer).
- Flagged answer pairs, labelled by student email, for side-by-side review.
- An instructor-only **AI-written answer check**: Gemini scores every student's
  saved answer to a chosen question, quotes the phrases that look generated, and
  colour-codes the result. These are leads for a conversation, not verdicts.

**Camera and device rules:** the camera must be a native webcam. Virtual
cameras (OBS, Camo, DroidCam and similar) are refused, the desktop shell will
not start an exam inside a virtual machine, and capture or mirroring displays
must be unplugged. If the webcam is unplugged or swapped mid-exam, that is
reported (once per device) to the transparency report. Detection failures never
block a student.

**Email:** auth emails are branded Supabase templates sent through a
`auth-mailer` edge function (Send Email hook) that delivers via Microsoft Graph.
Setup is in [supabase/templates/README.md](supabase/templates/README.md).

**Integrity signals:** tab guard (localStorage + BroadcastChannel + Web
Locks), focus loss and hidden-page detection, paste blocking, keystroke
dynamics, MediaPipe face, head-pose and phone detection, overlay
("Cluely"-style) detection, voice activity, local Whisper transcription,
colour-flash liveness, an optional server-side OWL-ViT vision check, and, in the
Electron lockdown shell, foreground-app and multi-display monitoring.

## Architecture

```
packages/contracts   shared types + validation (used by API and web)
apps/api             node:http server, SQLite (node:sqlite), Gemini, Whisper, OWL-ViT bridge
apps/web             React 19 + Vite student and instructor UI
apps/desktop         Electron lockdown shell (content protection, app watcher, recovery)
apps/ios             native iPhone presence companion
```

## Run it

No Node setup? `docker compose up --build`, then open http://localhost:8080 (see [docs/DOCKER.md](docs/DOCKER.md)).

Requires Node ≥ 24.7 (see `.nvmrc`). From a fresh clone:

```bash
git clone https://github.com/djhizon/anticheat.git && cd anticheat
npm run demo
```

`npm run demo` checks your environment, installs dependencies, prepares the
vision assets, creates a `.env.local` with blank optional credentials, seeds the
demo database (only the first time), starts the API (:3000) and web app (:5173),
prints the demo accounts and opens the browser. Ctrl+C stops everything.

- `npm run doctor` runs the environment checks only.
- `npm run demo -- --reset` moves the old demo database to a timestamped backup and re-seeds.
- `npm run demo -- --share` starts the ngrok share flow instead; `--no-open` skips the browser.
- Gemini (`GEMINI_API_KEYS`), Supabase (`SUPABASE_*`) and Microsoft Graph (`MS_*`) are all
  optional; they enable AI exam generation, email account flows, and email sending plus cloud recording.
- Whisper transcription needs `cmake` and `git`; the demo asks once (default no).

### Manual setup

```bash
npm install
npm run demo:seed      # demo student + instructor + a published exam
npm run dev            # API on :3000, web on :5173
```

Open http://127.0.0.1:5173 and sign in:

| Role       | Email                          | Password                         |
| ---------- | ------------------------------ | -------------------------------- |
| Student    | `demo.student@example.test`    | `Demo exam password 2026!`       |
| Instructor | `demo.instructor@example.test` | `Demo instructor password 2026!` |

### Optional features

```bash
npm run setup:whisper   # clones whisper.cpp v1.9.5, builds whisper-cli, downloads the base model
npm run setup:vision    # creates apps/api/vendor/venv with transformers, Pillow, torch
```

Both write into the gitignored `apps/api/vendor/`. On Intel Macs, PyTorch's last
wheel is 2.2.2 (Python ≤ 3.12), so run `PYTHON=python3.12 npm run setup:vision`.
The first vision request downloads the ~600 MB OWL-ViT model (about 90s cold,
about 8s warm).

```bash
npm run setup:desktop         # downloads Electron and builds the lockdown shell + helper
npm run share                 # app + ngrok tunnel on your static HTTPS domain (SHARE_HOST)
npm run supabase:templates    # applies the branded auth emails to your Supabase project
```

`npm run share` needs ngrok installed (`brew install ngrok`) and `SHARE_HOST`
set to your ngrok static domain. The domain is added to the API's allowed
origins and Vite's host allow-list; unknown hosts are still refused. Judges use
the browser while all AI keeps running on your machine. HTTPS also satisfies the
browser's secure-context rule for camera and microphone.

Email accounts are optional. To turn them on, set `SUPABASE_URL` and
`SUPABASE_ANON_KEY`, apply the templates with `npm run supabase:templates`, and
deploy the `auth-mailer` Send Email hook. Dashboard settings, the hook and the
Microsoft Graph secrets are described in
[supabase/templates/README.md](supabase/templates/README.md). Run
`npm run supabase:mailer-templates` after editing a template.

Put credentials in a gitignored `.env.local` at the repo root (start from
`.env.example`). The API loads it automatically; variables already set in the
shell win.

| Variable                                   | Enables                                                                                                                      |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `GEMINI_API_KEYS`                          | Optional, secondary cloud aids: AI exam generation, AI-text check, similarity check. Core on-device AI works without it.     |
| `WHISPER_BIN`, `WHISPER_MODEL_PATH`        | Local speech transcription (build [whisper.cpp](https://github.com/ggml-org/whisper.cpp) into `apps/api/vendor/whisper.cpp`) |
| `WHISPER_CONCURRENCY`, `WHISPER_MAX_QUEUE` | Transcription worker pool size and backlog                                                                                   |
| `ENABLE_BACKEND_VISION=true`               | Server OWL-ViT check (run `npm run setup:vision`)                                                                            |
| `VISION_PYTHON`                            | Python for the vision server; defaults to the setup venv                                                                     |
| `LIVENESS_SECRET`                          | HMAC secret for signing liveness challenges; random per process if unset                                                     |

[`.env.example`](.env.example) is the source of truth for configuration. Other
variables it lists: `PORT`, `NODE_ENV`, `DATABASE_PATH`, `SESSION_TTL_SECONDS`,
`COOKIE_SECURE`, `ALLOWED_ORIGINS`, `ENABLE_FRESH_EXAM_GENERATION`,
`GEMINI_MODEL`, `GEMINI_EMBEDDING_MODEL`, `GEMINI_FALLBACK_MODELS`,
`AUDIO_RETAIN_DAYS`, `LIVENESS_FLASH_THRESHOLD`, `LIVENESS_NOISE_THRESHOLD`,
`LIVENESS_JITTER_THRESHOLD`, `DEMO_STUDENT_EMAIL`, `DEMO_STUDENT_PASSWORD`,
`DEMO_INSTRUCTOR_EMAIL`, `DEMO_INSTRUCTOR_PASSWORD`, `SHARE_HOST`,
`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (seed only;
never expose it to the browser) and `SITE_URL`. The `auth-mailer` function has
its own secrets (`SEND_EMAIL_HOOK_SECRET`, `MS_TENANT_ID`, `MS_CLIENT_ID`,
`MS_CLIENT_SECRET`, `MAIL_SENDER`) set in Supabase, not in `.env.local`.

More guides: [demo performance](docs/demo-performance.md) ·
[media & phone demo](docs/media-and-phone-demo.md) ·
[iPhone presence](docs/iphone-presence.md) ·
[desktop recovery](docs/desktop-recovery.md) ·
[judge install guide (macOS .dmg)](docs/JUDGES.md)

## Quality gates

```bash
npm run validate   # prettier + eslint + tsc + all unit tests; also runs in CI on every push
```

## License

[MIT](LICENSE) © 2026 Dustin Hizon.
