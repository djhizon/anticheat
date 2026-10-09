# Existing code and assets (disclosure)

This project was **not** started from scratch at the hackathon. In the interest
of full transparency, this page separates what existed before the event from
what was built during it. Paste the summary below into the submission
checklist under **"Existing code and assets"**.

## Submission checklist text

> Built on our own pre-existing prototype, then named `exam-anti-cheat` (written
> 15–24 September 2026, before the hackathon). It is imported unchanged as the
> first commit (`1c94abb`) so judges can diff every hackathon change against it.
> Its known defects at import are listed in `docs/AUDIT.md`. Everything after
> that commit was built during the hackathon and is itemised in `CHANGELOG.md`.
> Third-party assets: whisper.cpp (MIT, built from upstream at setup time, not
> committed), the OpenAI Whisper `ggml-base` model, Google OWL-ViT
> (`google/owlvit-base-patch32`, Apache-2.0) via Hugging Face Transformers,
> MediaPipe Tasks Vision, Apple Vision (iOS), and npm dependencies in
> `package-lock.json`.
>
> AI development tools: Claude Code (Anthropic) was used throughout the
> hackathon for planning, implementation, tests, code review and docs, with every
> change reviewed and committed incrementally in the public history. Devin
> (Cognition) wrote one small change (the optional iPhone toolchain checks in
> `npm run doctor`), committed under its own author name.

## AI development tools

- **Claude Code (Anthropic)** — used during the hackathon as a coding assistant:
  planning, implementing fixes and features, writing tests, independent code
  and security reviews, and documentation. Work was split into small packages,
  each validated (format, lint, typecheck, tests) and committed separately, so
  every AI-assisted change is visible in `git log` and `CHANGELOG.md`.

- **Devin (Cognition)** — used once through the Devin CLI for a small, self-contained
  change: the optional iPhone toolchain checks in `npm run doctor`. Its commit is
  authored by Devin; the change was reviewed and its tests run before merging.

## Pre-existing (before the hackathon)

Imported in commit `1c94abb` from the prior prototype:

- Monorepo structure, shared contracts package, SQLite migrations.
- Authentication (sessions, Argon2id, CSRF), exam delivery engine.
- Browser integrity signals (tab guard, focus/paste, keystroke dynamics,
  MediaPipe camera checks, audio activity), consent modal.
- Electron lockdown shell, iPhone presence companion.
- Unwired or broken pieces later fixed or finished: vision bridge, Whisper
  pipeline, similarity detector, transparency report, telemetry route.

At import the prototype had 1 failing test, 6 type errors, 66 lint errors and
the defects listed in [AUDIT.md](AUDIT.md).

## Built during the hackathon

Every item is its own commit; see [CHANGELOG.md](../CHANGELOG.md) and
`git log --oneline 1c94abb..HEAD`. Highlights:

- Security: authentication, CSRF and ownership checks on every integrity
  route; HMAC-signed liveness challenges; liveness restricted to the native
  webcam, with OBS and other virtual cameras rejected.
- Local AI: Whisper.cpp transcription working end to end with a worker pool;
  server-side OWL-ViT vision with a request queue and model-load handshake;
  liveness flash check that measures real brightness on the student's face.
- New features: student transparency report, instructor workspace with
  similarity and AI-written-answer review, desktop app-watcher wiring, telemetry
  ingestion.
- Reliability: integrity monitoring works without cloud keys; Gemini retries
  and model fixes.
- Accounts: Supabase email flows (confirm sign-up, forgot, reset and change password, change email) with branded templates and a Microsoft Graph `auth-mailer` edge function.
- Recording: opt-in adaptive cloud recording that measures uplink, picks a quality tier and uploads segments in the background with local fallback.
- Liveness: passive random colour flash, with head-turn and spoken-word alternatives; hand-gesture challenge and TensorFlow dependencies removed.
- Device rules: native-webcam-only, VM and capture-display blocking, and a mid-exam camera guard.
- iPhone desk camera: on-device Apple Vision counts people and hands; only flags leave the phone.
- Sharing and setup: `npm run share` (ngrok static domain), `npm run setup:desktop`, `npm run supabase:templates`.
- Quality: green typecheck, lint and tests, CI on every push, docs and demo
  script.

## Known limitations (honest scope)

The system raises leads for human review; it is not tamper-proof. Physical
blind spots (notes below the camera, hidden earpieces), HDMI capture hardware
and virtual machines can defeat browser and desktop signals, and camera checks
rely on device labels, not hardware attestation.
