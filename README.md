# ExamGuard

[![CI](https://github.com/djhizon/examguard/actions/workflows/ci.yml/badge.svg)](https://github.com/djhizon/examguard/actions/workflows/ci.yml)

**A Mac exam app and an iPhone companion that keep online exams honest with on-device AI —
without streaming anyone's webcam to the cloud.** Students see every check before they start
and everything recorded after they finish. Every signal is a lead for a teacher, never a verdict.

| App                         | Platform               | Role                                                                                       |
| --------------------------- | ---------------------- | ------------------------------------------------------------------------------------------ |
| **ExamGuard** (`.dmg`)      | macOS 13+              | Locked-down exam window, local AI checks, local server, teacher review                     |
| **Exam Companion** (iPhone) | iOS 16+ (XR and newer) | Pairs by QR and pings the laptop so the phone stays on the desk, not in the student's hand |

> **Judges:** install guide [docs/JUDGES.md](docs/JUDGES.md) · 5-minute script
> [docs/DEMO.md](docs/DEMO.md) · what runs locally [docs/LOCAL_AI.md](docs/LOCAL_AI.md) ·
> submission answers [docs/SUBMISSION.md](docs/SUBMISSION.md) · pre-existing code and AI tools
> [docs/EXISTING_CODE.md](docs/EXISTING_CODE.md) · every change [CHANGELOG.md](CHANGELOG.md).

## How an exam works

1. **Setup (before the clock starts).** Consent → camera (native or verified hardware, one face
   in view; OBS and other virtual cameras refused) → lighting → microphone → screen recording
   (required) → iPhone pairing (scan a QR) → a colour-reflection presence check → **Start**.
2. **Exam.** Full-screen lockdown. Every check runs on its own; there are no Start/Stop/Verify
   buttons. Brief presence checks appear at random between questions without interrupting.
3. **After.** The student gets a transparency report of everything recorded; the teacher reviews
   leads with photos, transcript lines and the log.

## What it checks — all on the student's Mac

| Area           | Signals                                                                                                                 |
| -------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Camera         | Face present / extra faces, eye-gaze direction (self-calibrating), phone in view, lighting, frozen or virtual feeds     |
| Presence       | Random screen-colour reflection read off the face; iPhone pings (lost phone or app left is logged)                      |
| Audio          | Voice activity; speech-to-text with local Whisper (English)                                                             |
| Typing & mouse | Typing rhythm, pasted or injected text, bursts after idle, pointer leaving the window (never what you type)             |
| Desktop        | Kiosk lockdown, minimize/full-screen exits, other apps in front, capture displays, VM check, enforced screen brightness |
| Evidence       | One still photo or screenshot when something unusual holds, mandatory screen recording                                  |

Optional teacher aids (Gemini, only with an API key): cross-student similarity and an
AI-written-answer check. The core works offline.

**What leaves the device:** nothing from the camera or microphone. Recordings go to the
school's OneDrive only if upload is on; otherwise they stay on the Mac. Details:
[docs/LOCAL_AI.md](docs/LOCAL_AI.md).

## Install

**Mac app:** build the disk image with `npm run package:mac` (→ `apps/desktop/release/ExamGuard-0.1.0.dmg`),
drag ExamGuard to Applications, right-click → Open the first time (unsigned). Demo accounts are
pre-seeded. Full steps: [docs/JUDGES.md](docs/JUDGES.md).

**iPhone app:** with the iPhone plugged in and Developer Mode on, run `npm run ios:device`
(builds, installs and launches Exam Companion). Open it, scan the QR the Mac shows during setup,
put the phone face-down. Details: [docs/iphone-presence.md](docs/iphone-presence.md).

| Demo account | Email                          | Password                         |
| ------------ | ------------------------------ | -------------------------------- |
| Student      | `demo.student@example.test`    | `Demo exam password 2026!`       |
| Instructor   | `demo.instructor@example.test` | `Demo instructor password 2026!` |

Or create your own account: choose **Sign up** on the sign-in screen and register with any
email. In the Mac app the account is stored locally on that Mac; when email accounts are
configured (Supabase), a confirmation email is sent first.

## Develop

Node ≥ 24.7 (`.nvmrc`). `npm run demo` checks the machine, installs, seeds and starts the API
(:3000) and UI (:5173) in your browser. `npm run doctor` checks prerequisites only.

```bash
npm run validate         # format, lint, typecheck, unit tests (CI runs this on every push)
npm run test:e2e:demo    # full student + teacher flow in Chromium with a fake camera/mic
npm run test:electron    # same flow in the Mac app (dev and packaged builds)
npm run phone:lab        # pair a real iPhone over Wi-Fi and watch its pings live (--auto simulates one)
npm run setup:whisper    # build whisper.cpp and fetch the speech model
```

```
apps/desktop    Electron app: kiosk lockdown, local server, native Swift helper (apps, camera, brightness)
apps/web        React UI: setup, exam, transparency report, teacher review; on-device vision worker
apps/api        Local node:http + SQLite server: exams, integrity log, evidence, Whisper
apps/ios        Exam Companion (SwiftUI): QR pairing and presence pings
packages/contracts  Shared types
```

Configuration lives in a gitignored `.env.local` (see [.env.example](.env.example)); every
cloud key is optional.

## License

[MIT](LICENSE) © 2026 Dustin Hizon.
