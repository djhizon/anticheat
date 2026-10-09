# 5-minute judge walkthrough

## Prerequisites

- Node ≥ 24.7 (see `.nvmrc`).
- Optional: `npm run setup:whisper` (local transcription) and
  `npm run setup:vision` (server vision check). On Intel Macs use
  `PYTHON=python3.12 npm run setup:vision`.
- Optional: `GEMINI_API_KEYS` in a gitignored `.env.local` at the repo root, for
  the AI checks. Everything else works without it.

## Setup

```bash
npm install
npm run demo:seed
npm run dev
```

Open http://127.0.0.1:5173.

| Role       | Email                          | Password                         |
| ---------- | ------------------------------ | -------------------------------- |
| Student    | `demo.student@example.test`    | `Demo exam password 2026!`       |
| Instructor | `demo.instructor@example.test` | `Demo instructor password 2026!` |

## Demo beats

1. **Consent.** Sign in as the student and start the exam. A "Before you begin"
   modal lists every monitor. Say: nothing starts until the student reads it and
   ticks the checkbox.
2. **Exam.** One question at a time; answers autosave (watch the save state).
   Switch tabs or lose window focus, or try pasting into an answer, and show the
   violation banner. Say: each signal is logged and shown to the student, not
   hidden.
3. **Liveness.** Start the camera panel, then click **🙋 Verify I'm here** in
   the top bar. Say: the challenge is HMAC-signed by the server, so a client
   cannot forge, retype or replay it on another attempt.
4. **Audio.** In the audio panel choose "Start audio". Speak, and show the local
   clip transcript. Say: Whisper runs on this machine; audio is not sent to a
   cloud service.
5. **Submit.** Submit the exam and open the "What monitoring recorded" report.
   Say: the student sees every recorded event in plain language. It is a record
   for review, not a verdict.
6. **Instructor.** Sign out and sign in as the instructor. Open "Integrity
   review". Run the **Cross-student similarity** check to show flagged answer
   pairs, then the **AI-written answer check** to show per-answer scores with
   quoted phrases. Say: these are leads for a human conversation.
7. **Optional: desktop shell.** With the web app running, `npm run dev` inside `apps/desktop` builds and launches the Electron lockdown shell (see
   [desktop recovery](desktop-recovery.md)).

## Talking points

- Consent first: students see what is monitored before, and what was recorded
  after.
- Transparency: the report lists every recorded event; nothing is an automatic
  verdict.
- Security fixes: auth, ownership and CSRF checks on every integrity route;
  signed liveness challenges. The baseline bugs are in [AUDIT.md](AUDIT.md).
- Incremental history: read [CHANGELOG.md](../CHANGELOG.md) and
  `git log --oneline`.
- CI is green on every push (`npm run validate`).

## If something fails

- No Gemini keys: the AI checks show a clear message; monitoring still works.
- Transcript stays empty: Whisper is not built. Run `npm run setup:whisper`.
- Vision is slow on the first call: it downloads the ~600 MB model (about 90s
  cold, about 8s warm).
- Camera or microphone blocked: allow access in the browser, then retry.
