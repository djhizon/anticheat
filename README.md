# exam-anti-cheat

For the current responsive, on-demand demo controls and local-only screen recording,
see [Demo performance and hardware checks](docs/demo-performance.md). Camera/audio
checks must be started explicitly; this demo does not promise continuous monitoring.

`exam-anti-cheat` is an advanced, AI-powered exam integrity enforcement platform.

Built as a hardened kiosk application, this project utilizes aggressive native OS hardware tracking, continuous audio surveillance, machine learning vision engines (OWL-ViT), and external root-of-trust physical verification via companion phones to prevent, detect, and block advanced academic dishonesty.

## Core Capabilities

- **Strict Kiosk Confinement**: Enforces full-screen, unminimizable, unclosable OS-level lockdowns.
- **Continuous Intelligence**: Validates visual environments using semantic analysis to distinguish between standard eyeglasses and smart glasses.
- **Micro-Auditory Surveillance**: Uses real-time FFT analysis to isolate and log unrecognized speech patterns.
- **Zero-Tolerance Tab Guards**: Instantly revokes exam access upon duplicate session attempts or continuous focus loss.
- **Companion Phone Demo**: Enrolls a phone and checks its heartbeat. The current companion page does not record camera video or attest device integrity.

## Question types

The domain model is intended to support:

1. Multiple choice
2. Multiple select
3. True/false
4. Identification and fill-in-the-blank
5. Numeric answers
6. Matching
7. Short answers
8. Essays and file uploads as later extensions

The first implementation should begin with multiple choice, true/false,
identification, numeric, and short-answer questions. Matching, essays, and
uploads should follow after the core attempt and grading lifecycle is stable.

## Local development

The project uses npm workspaces, strict TypeScript, React/Vite, a small
`node:http` API runtime, and a local SQLite prototype database.

```bash
npm install
npm run demo:seed
npm run dev
npm run typecheck
npm test
npm run validate
```

`npm run dev` starts the API on port 3000 and the Vite student demo on port 5173. The Vite server proxies `/auth` and `/exam` requests to the local API.

For physical-webcam selection, local speech transcription, and opt-in phone
enrollment over trusted Wi-Fi, see the [media and phone demo guide](docs/media-and-phone-demo.md).

The [native iPhone companion guide](docs/iphone-presence.md) covers the newer
foreground-only heartbeat requirement, server-enforced answering pause, and
physical-device installation. The current laptop enrollment button uses this
native mode; the earlier browser companion remains legacy demo code.

For a local-only walkthrough, `npm run demo:seed` creates a synthetic student,
one published exam containing every currently supported question type, and an
assignment. Log in at `http://127.0.0.1:5173` with
`demo.student@example.test` / `Demo exam password 2026!`. Override
`DEMO_STUDENT_EMAIL`, `DEMO_STUDENT_PASSWORD`, or `DATABASE_PATH` for a
different development fixture. The command refuses to run when `NODE_ENV` is
`production` and is not an API route.

Packs 0 through 3 establish the repository contract, authentication, exam
delivery, and HTTP runtime. Pack 4 adds the Vite/React student workspace, and
Pack 5 makes the exam flow usable: all supported question types have accessible
answer controls, answers autosave as server-acknowledged revisions, a reload
can resume the saved snapshot, and final submission returns an idempotent
receipt. Automatic grading and result release remain later work; no answer key
or correctness signal is sent to the student browser.

Pack 7 polishes the entry experience with a responsive sign-in/sign-up shell,
accessible validation and loading states, safe demo-account autofill, and
consistent visual treatment for the student workspace. Registration still uses
the same CSRF-protected authentication boundary as sign-in.

## Pack 8: Machine Learning & Kiosk Anti-Cheat

Pack 8 completes the "Future desktop track" and introduces highly aggressive, AI-powered exam integrity enforcement. The project has moved from a basic web-form prototype to a fully-featured desktop kiosk application powered by Electron and advanced machine learning endpoints.

For a comprehensive guide covering the new `lsappinfo` macOS app whitelists, OWL-ViT smart glasses detection, WebRTC audio analysis, dynamic Gemini liveness challenges, and the Companion Phone Setup that bypasses virtual machine blindspots, please read the unified context bank:

👉 **[Architecture and Context Bank](architecture_and_context.md)**

## License

No license has been selected yet. Until one is added, public visibility does not grant permission to reuse the code.
