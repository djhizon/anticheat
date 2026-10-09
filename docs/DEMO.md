# 5 to 7 minute judge walkthrough

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

About 5 to 7 minutes. The first six beats are on-device AI and consent. Cloud
features come last and are optional.

1. **Consent (about 30s).** Sign in as the student and start the exam. A "Before
   you begin" modal lists every monitor. Say: nothing starts until the student
   reads it and ticks the checkbox, and the core AI runs on this laptop.
2. **On-device camera, native webcam only (about 45s).** Click **Start camera
   checks**. Show face landmarks, head pose and phone detection. Say: MediaPipe
   runs in the browser; no frame leaves the machine. Say: the camera must be a
   native webcam, so OBS, Camo, DroidCam and other virtual cameras are refused,
   and the desktop shell also refuses virtual machines and capture displays.
   If the webcam is unplugged or swapped mid-exam it is noted in the report.
3. **Liveness colour flash and fallbacks (about 60s).** Click **🙋 Verify I'm
   here** in the top bar. It opens the native webcam itself, shows three random
   full-screen colours and checks that the face reflects each one. Say: the
   sequence is HMAC-signed so it cannot be forged or replayed, and scoring is
   relative to each student's own baseline. Then show the alternatives: **Try
   head turn instead** (on-device head pose, for a room that is too bright) and
   **I can't do the visual check** (say three random words, checked by local
   Whisper). Say: a student can always pass.
4. **Keystroke and tab signals (about 45s).** Type an answer; answers autosave.
   Switch tabs, lose focus or paste to show the violation banner. Optionally
   choose **Start audio** and speak to show the local Whisper transcript. Say:
   typing rhythm is plain statistics computed in the browser, and every signal
   is shown to the student.
5. **Optional: desk camera on iPhone (about 45s).** Choose **Require iPhone** to
   open the pairing modal. Its "Optional desk camera" section explains what is
   sent. Pair the iPhone app, turn on its desk camera and show "Desk camera: on".
   Say: Apple's Vision framework runs on the phone; only a people count and two
   yes/no flags are sent, never pictures. Skip if no iPhone is available.
6. **Adaptive recording status (about 30s).** Say: recording is opt-in. Under
   "Screen recording (optional)" choose **Start recording**; the status line
   shows the chosen quality (for example "720p (fast network)") and upload
   progress. Quality steps down on a slow connection. Segments go to the
   school's OneDrive when Graph is configured, and are saved on the student's
   computer if the connection is poor or cloud recording is not configured. The
   exam never waits on an upload.
7. **Submit (about 15s).** Click **Submit Exam** and confirm. Say: the receipt is
   recorded and answers are idempotent.
8. **Transparency report (about 45s).** Open "What monitoring recorded". Say:
   the student sees every recorded event in plain language. It is a record for
   review, not a verdict.
9. **Secondary: instructor similarity and AI check (about 60s, optional).** Needs
   `GEMINI_API_KEYS` and a network. Sign out, sign in as the instructor and open
   "Integrity review". Run **Cross-student similarity** to show flagged answer
   pairs, then **AI-written answer check** to show per-answer scores with quoted
   phrases. Say: these are optional cloud aids, not the core, and they are leads
   for a human conversation.
10. **Optional: pull the network (about 30s).** Turn Wi-Fi off (after
    `npm run vision:prepare` and `npm run setup:whisper`) and repeat beat 2 or 3.
    Say: if cloud services disappear, the core still runs. Gemini features will
    not; see [LOCAL_AI.md](LOCAL_AI.md). Turn Wi-Fi back on afterwards.
11. **Optional: desktop shell and live link.** `npm run setup:desktop` once, then
    `npm run dev` inside `apps/desktop` launches the Electron lockdown shell (see
    [desktop recovery](desktop-recovery.md)). To let judges try the app from a
    browser, run `npm run share` (needs `SHARE_HOST`, see the README).

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
- No confirmation or reset email: that needs Supabase configured. Check that the
  Send Email hook points at the `auth-mailer` function, that its secrets
  (`SEND_EMAIL_HOOK_SECRET`, `MS_TENANT_ID`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET`,
  `MAIL_SENDER`) are set, and the function logs. See
  [supabase/templates/README.md](../supabase/templates/README.md). Demo accounts
  are pre-confirmed by `npm run demo:seed` and need no email.
- ngrok shows a warning page ("You are about to visit...") the first time
  someone opens the `npm run share` link: click **Visit Site** once. Also check
  that `SHARE_HOST` is your static domain and ngrok is installed and signed in.
- Desktop shell won't start (`Electron failed to install correctly`): newer npm
  versions skip install scripts, so run `npm run setup:desktop` once.
