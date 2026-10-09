# 5-minute judge walkthrough

## Prerequisites

- Node ≥ 24.7 (see `.nvmrc`).
- Run `npm run vision:prepare` once with a network to fetch the MediaPipe
  models used by the on-device camera panel.
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

The first five beats are on-device AI. Cloud features come last and are
optional.

1. **Consent.** Sign in as the student and start the exam. A "Before you begin"
   modal lists every monitor. Say: nothing starts until the student reads it and
   ticks the checkbox. The core AI runs on this laptop.
2. **On-device vision.** Start the camera panel. Show the face landmarks, head
   pose and phone detection. Say: MediaPipe runs in the browser on the CPU; no
   frame leaves the machine. Look away or hold up a phone to show the signal.
3. **Liveness, native webcam only.** Click **🙋 Verify I'm here** in the top
   bar. It opens the native webcam itself (no need to start the camera panel
   first), flashes the screen white and measures the brightness rise. Say: the
   challenge is HMAC-signed by the server so it cannot be forged or replayed,
   and OBS or other virtual cameras are rejected.
4. **Local Whisper transcript.** In the audio panel choose "Start audio". Speak,
   and show the local clip transcript. Say: Whisper.cpp runs on this machine;
   audio is not sent to a cloud service.
5. **Keystroke dynamics and exam.** Type an answer; answers autosave. Switch
   tabs, lose focus or paste to show the violation banner. Say: typing rhythm is
   plain statistics computed in the browser, and every signal is shown to the
   student.
6. **Optional: pull the network cable.** Turn Wi-Fi off (after
   `npm run vision:prepare` and `npm run setup:whisper`). Repeat beat 2 or 4 to
   show that they still work. Say: if cloud services disappear, the core still
   runs. Gemini features and the hand-gesture challenge will not; see
   [LOCAL_AI.md](LOCAL_AI.md). Turn Wi-Fi back on afterwards.
7. **Submit and transparency report.** Submit the exam and open the "What
   monitoring recorded" report. Say: the student sees every recorded event in
   plain language. It is a record for review, not a verdict.
8. **Secondary: cloud-assisted review (optional).** Needs `GEMINI_API_KEYS` and
   a network. Sign out and sign in as the instructor. Open "Integrity review".
   Run the **Cross-student similarity** check to show flagged answer pairs, then
   the **AI-written answer check** to show per-answer scores with quoted
   phrases. Say: these are optional instructor aids, not the core; they are
   leads for a human conversation.
9. **Optional: adaptive screen recording.** Say: recording is opt-in. Start it
   from the exam sidebar; the status line shows quality (for example "720p (fast
   network)") and uploads. Segments go to the school's OneDrive when Graph is
   configured, quality steps down on a slow connection, and segments are saved
   on the student's computer instead if the connection is poor or cloud
   recording is not configured.
10. **Optional: desktop shell.** With the web app running, `npm run dev` inside `apps/desktop` builds and launches the Electron lockdown shell (see
    [desktop recovery](desktop-recovery.md)).

## Talking points

- Local-first: the core AI runs on-device and works without cloud services;
  Gemini is secondary. Full inventory in [LOCAL_AI.md](LOCAL_AI.md).
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

- No Gemini keys: the secondary AI checks show a clear message; monitoring
  still works.
- Camera panel shows a model error: run `npm run vision:prepare`.
- Transcript stays empty: Whisper is not built. Run `npm run setup:whisper`.
- Vision is slow on the first call: it downloads the ~600 MB model (about 90s
  cold, about 8s warm).
- Camera or microphone blocked: allow access in the browser, then retry.
- Desktop shell won't start (`Electron failed to install correctly`): newer npm
  versions skip install scripts, so run `npm run setup:desktop` once.
