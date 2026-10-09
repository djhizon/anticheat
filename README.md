# anticheat — consent-first exam integrity

[![CI](https://github.com/djhizon/anticheat/actions/workflows/ci.yml/badge.svg)](https://github.com/djhizon/anticheat/actions/workflows/ci.yml)

A browser + desktop exam platform that helps instructors keep online exams
honest **without treating students as suspects**. Students see exactly what is
monitored before they start, and exactly what was recorded after they finish.
Every signal is a lead for a human to review. Nothing is an automatic verdict.

> **Hackathon judges:** this repo is built incrementally. Start with
> [CHANGELOG.md](CHANGELOG.md) for the story, then `git log --oneline` to see
> each fix and feature land as its own commit. The baseline audit, including
> every known bug at import, is in [docs/AUDIT.md](docs/AUDIT.md).

## What it does

**Students**

- A consent screen that lists every monitor before the exam starts.
- One question at a time, with autosave and an idempotent submit.
- A **transparency report** after submission that lists every recorded event in
  plain language.
- Optional iPhone presence pairing with clear, non-accusatory messages.
- An on-demand Gemini-generated exam (static questions are used without keys).

**Instructors**

- An instructor workspace with a live **cross-student similarity** check
  (Gemini embeddings over every saved free-text answer).
- Flagged answer pairs, labelled by student email, for side-by-side review.

**Integrity signals:** tab guard (localStorage + BroadcastChannel + Web
Locks), focus loss and hidden-page detection, paste blocking, keystroke
dynamics, MediaPipe face, head-pose and phone detection, overlay
("Cluely"-style) detection, voice activity, local Whisper transcription,
liveness challenges, an optional server-side OWL-ViT vision check, and, in the
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

Requires Node ≥ 24.7 (see `.nvmrc`).

```bash
npm install
npm run demo:seed      # demo student + instructor + a published exam
npm run dev            # API on :3000, web on :5173
```

Open http://127.0.0.1:5173 and sign in:

| Role | Email | Password |
| --- | --- | --- |
| Student | `demo.student@example.test` | `Demo exam password 2026!` |
| Instructor | `demo.instructor@example.test` | `Demo instructor password 2026!` |

Copy `.env.example` to `.env.local` to configure the optional features:

| Variable | Enables |
| --- | --- |
| `GEMINI_API_KEYS` | AI exam generation, AI-text check, similarity check. Monitoring works without it. |
| `WHISPER_BIN`, `WHISPER_MODEL_PATH` | Local speech transcription (build [whisper.cpp](https://github.com/ggml-org/whisper.cpp) into `apps/api/vendor/whisper.cpp`) |
| `WHISPER_CONCURRENCY`, `WHISPER_MAX_QUEUE` | Transcription worker pool size and backlog |
| `ENABLE_BACKEND_VISION=true` | Server OWL-ViT check (`pip install transformers Pillow torch`) |

More guides: [demo performance](docs/demo-performance.md) ·
[media & phone demo](docs/media-and-phone-demo.md) ·
[iPhone presence](docs/iphone-presence.md) ·
[desktop recovery](docs/desktop-recovery.md)

## Quality gates

```bash
npm run validate   # prettier + eslint + tsc + 164 tests; also runs in CI on every push
```

## License

No license has been selected yet. Until one is added, public visibility does
not grant permission to reuse the code.
