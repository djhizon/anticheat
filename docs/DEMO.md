# 5-minute judge demo

Demo Day gives each team **5 minutes of live demo, then 3 minutes of Q&A**. The
script below runs **4:45**, leaving 15 seconds of buffer. Practise it with a
timer.

## Setup

```bash
npm run demo
```

`npm run demo` checks the machine, prepares the on-device models, seeds the demo
data and opens http://127.0.0.1:5173. No Node? `docker compose up --build` and
open http://localhost:8080 (see [DOCKER.md](DOCKER.md)).

| Role       | Email                          | Password                         |
| ---------- | ------------------------------ | -------------------------------- |
| Student    | `demo.student@example.test`    | `Demo exam password 2026!`       |
| Instructor | `demo.instructor@example.test` | `Demo instructor password 2026!` |

## Before you go on stage (10 minutes earlier)

- `npm run demo -- --reset` so the demo student's exam is "Not started" again
  (the old database is backed up, not deleted).
- Chrome window 1: signed in as the **student**. Chrome window 2 (incognito):
  signed in as the **instructor** with "Integrity review" open.
- Speak once into the audio panel so Whisper is warm, and run one liveness check
  so the camera permission is already granted.
- Close other apps, notifications on Do Not Disturb, one display only.
- Have a phone ready to hold up to the webcam for the phone-detection beat.

## If the venue Wi-Fi is bad

Everything in beats 1–6 runs on the laptop with no network. Skip beat 7 (it
needs Gemini) or show the instructor screenshots instead. For iPhone pairing, put
the laptop and phone on the laptop's own hotspot.

## The script (4:45)

| Time      | Beat                              | Do                                                                                                                                                         | Say                                                                                                                                                                                                       |
| --------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0:00–0:20 | **Hook**                          | Title slide or the sign-in page.                                                                                                                           | "Online exams either trust students blindly, or stream their webcam to a cloud proctor. We run the AI on the student's own laptop instead."                                                               |
| 0:20–0:45 | **Consent**                       | Sign in as the student, click **Start exam**. Show the "Before you begin" list, tick the box, grant camera and microphone.                                 | "Nothing starts until the student reads exactly what is monitored and agrees. Then the checks start by themselves."                                                                                       |
| 0:45–1:35 | **On-device camera**              | Point at the camera panel: face and head pose. Look away, then hold a phone up to the webcam.                                                              | "MediaPipe runs inside the browser. No frame leaves this laptop. Only a real webcam is accepted: OBS and other virtual cameras are refused."                                                              |
| 1:35–2:25 | **Liveness**                      | Click **🙋 Verify I'm here** → **Start**. The screen flashes three colours.                                                                                | "The server picks a random colour sequence and signs it; the camera must see your face reflect it in order. Too bright? There's a head-turn check, and a spoken-words option, so every student can pass." |
| 2:25–2:55 | **Audio + typing**                | Type an answer (it autosaves). Say a sentence; show the Whisper transcript. Switch tabs once to show the banner.                                           | "Speech is transcribed by Whisper running locally. Typing rhythm and tab switches are simple statistics in the browser."                                                                                  |
| 2:55–3:20 | **Pull the network**              | Turn Wi-Fi off. Hold the phone up again; detection still works.                                                                                            | "If the cloud disappears, the core keeps working." Turn Wi-Fi back on.                                                                                                                                    |
| 3:20–3:50 | **Submit + transparency**         | Click **Submit Exam**, then open **What monitoring recorded**.                                                                                             | "The student sees every event we recorded, in plain language. These are leads for a human, never automatic verdicts."                                                                                     |
| 3:50–4:30 | **Instructor (cloud, secondary)** | Switch to the instructor window: **Cross-student similarity** shows the flagged copied pair; **AI-written answer check** shows scores with quoted phrases. | "These two use Gemini and are optional extras for the teacher. Everything the student is checked with runs locally."                                                                                      |
| 4:30–4:45 | **Close**                         | Back to the student report.                                                                                                                                | "Private by design, works on bad school Wi-Fi, no per-student cloud cost. That's why the AI runs locally."                                                                                                |

**Cut first if running long:** the tab-switch in 2:25, then the AI-written
check in 3:50. **Never cut:** consent, liveness, pull the network.

**Optional extras (only if a judge asks):** the iPhone desk camera (Apple
Vision on the phone; only a people count and two yes/no flags are sent), the
desktop lockdown app, and adaptive cloud recording.

## Likely judge questions

- **What exactly runs locally?** Face, head-pose and phone detection
  (MediaPipe), speech-to-text (whisper.cpp), the liveness checks, typing and
  audio statistics, and on the iPhone, Apple Vision. Gemini only powers the
  instructor's optional similarity/AI-writing checks and exam generation. Full
  table: [LOCAL_AI.md](LOCAL_AI.md).
- **Can it detect earbuds, smart glasses or a smartwatch?** Not in the
  browser. The browser model (EfficientDet-Lite0) only knows the 80 everyday
  COCO categories. "Cell phone" is one of them; earbuds, smart glasses and
  watches aren't. OWL-ViT is "zero-shot", so it can look for anything you name
  in text, but it's heavier (about 8 s per frame warm) and only runs if
  `ENABLE_BACKEND_VISION=true`. Small items at webcam resolution are often
  missed, so these are leads, not proof.
- **What about privacy?** Camera frames never leave the device; recording is
  opt-in; the phone sends flags, not pictures; the student sees everything we
  recorded. Audio is transcribed locally by Whisper; only the text is kept
  (never the audio), for 30 days by default, and bystander speech can be captured.
- **False positives?** Every signal is a lead for a teacher to review, shown to
  the student too. Liveness has alternatives so nobody is stuck.
- **Can't a student cheat around it?** Some ways, yes: notes out of frame, a
  hidden earpiece, special hardware. We block virtual cameras, virtual machines
  and capture displays, and the optional desk camera covers the desk. We say
  plainly that it isn't tamper-proof.
- **Was this built today?** We started from our own earlier prototype and
  disclosed it: see [EXISTING_CODE.md](EXISTING_CODE.md). Every hackathon change
  is a separate commit in `git log` and listed in
  [CHANGELOG.md](../CHANGELOG.md).

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
