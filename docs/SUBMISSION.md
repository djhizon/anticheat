# Submission answers (AppBuildersPH Hackathon 2026)

Ready to paste into the Cerebral Valley form. Fields marked **TODO** must be
filled by the team. Every answer matches [LOCAL_AI.md](LOCAL_AI.md) and
[EXISTING_CODE.md](EXISTING_CODE.md).

## Project name

ExamGuard: consent-first exam integrity with on-device AI

## Short description

An exam platform that keeps online tests honest without streaming students to a
cloud proctor. Face, phone and head-pose detection, speech-to-text, typing
analysis and liveness checks run on the student's own laptop (and optionally on
their iPhone). Students consent to every monitor up front, see everything that
was recorded afterwards, and every signal is a lead for a teacher, never an
automatic verdict.

## Team members

**TODO**: official team name and member names exactly as listed on
appbuildersph.com/hackathon.

## Public GitHub repository

https://github.com/djhizon/examguard

## Demo video

**TODO**: link (about 1 minute; shot list below).

## X / LinkedIn video URL

**TODO**: post tagging Devin / Cognition with #AppBuildersPH.

## What runs locally

- **Camera checks in the browser:** MediaPipe Face Landmarker (face presence,
  multiple faces, head pose) and EfficientDet-Lite0 (phone detection), in a Web
  Worker. No frame leaves the device.
- **Speech-to-text:** whisper.cpp with the `ggml-base` model, run by the local
  API as a child process.
- **Liveness checks:** random colour flash (camera reads the face's colour
  response), head-turn fallback (MediaPipe head pose) and spoken-words option
  (local Whisper), all with HMAC-signed challenges scored by the local API.
- **Typing and audio statistics:** keystroke dynamics and voice-activity
  detection, plain signal processing in the browser.
- **Native-webcam rule:** OBS and other virtual cameras are refused; in strict mode the
  desktop app also refuses virtual machines and capture displays.
- **iPhone presence (optional):** the phone app only pings the laptop while it is
  open on the desk; no camera, microphone or screen data leaves the phone.
- **Server vision (optional):** OWL-ViT zero-shot detection in a local Python
  process for earbuds, headphones, smart glasses and similar items.
- **Everything else:** the API, SQLite database, transparency report and
  consent flow all run on the same machine.

## What requires internet

- **Gemini (optional, instructor-side):** exam generation, cross-student answer
  similarity (embeddings) and the AI-written answer check. Without keys,
  exam generation falls back to built-in questions and the two instructor
  checks say they need keys; student monitoring is unaffected.
- **Account emails (optional):** Supabase Auth for sign-up confirmation and
  password reset, with mail sent through Microsoft Graph. Local demo accounts
  need no email.
- **Cloud recording (optional, opt-in):** recording segments upload to the
  school's OneDrive through Microsoft Graph; on a poor connection they are saved
  locally instead.
- **First-time model downloads:** MediaPipe models (`npm run vision:prepare`),
  the Whisper model (`npm run setup:whisper`) and OWL-ViT (first use). After
  that, the core works offline.

## Models used

- MediaPipe Face Landmarker (`face_landmarker.task`, float16, a few MB)
- MediaPipe Object Detector, EfficientDet-Lite0 (`efficientdet_lite0.tflite`,
  int8, a few MB; COCO's 80 classes)
- OpenAI Whisper `base` via whisper.cpp (`ggml-base.bin`, about 148 MB)
- Google OWL-ViT `google/owlvit-base-patch32` via Hugging Face Transformers
  (optional, about 600 MB)
- Apple Vision built-in requests on iOS (`VNDetectHumanRectanglesRequest`,
  `VNDetectHumanHandPoseRequest`)
- Google Gemini (cloud, secondary): generation model set by `GEMINI_MODEL`
  (default `gemini-3.6-flash`, falling back to `gemini-3.8-flash` and
  `gemini-3.5-flash` when overloaded) and `gemini-embedding-001`

## Technologies and frameworks

TypeScript, React 19, Vite, Node.js 24 (`node:http`, `node:sqlite`), Electron
44, MediaPipe Tasks Vision (WASM), whisper.cpp, ffmpeg, Python with Hugging
Face Transformers and PyTorch (optional), Swift / SwiftUI / AVFoundation /
Vision (iOS), Docker, Vitest, ESLint, Prettier, GitHub Actions.

## APIs and cloud services

Google Gemini API (secondary), Supabase Auth and Edge Functions (optional),
Microsoft Graph: Mail.Send and OneDrive (optional), ngrok (optional, for a
public demo link). None are needed for the core on-device features.

## Existing code and assets

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
> change reviewed and committed incrementally in the public history.

## AI development tools

Claude Code (Anthropic), used during the hackathon for planning,
implementation, tests, code review and documentation. Details in
[EXISTING_CODE.md](EXISTING_CODE.md).

## Why does this product benefit from running AI locally?

Exam monitoring means a camera and microphone pointed at a student at home, so
privacy is the whole problem: running the vision and speech models on the
student's own device means no video or audio is streamed to anyone, and the
student can see exactly what was recorded. Local inference also keeps working
on weak or crowded school Wi-Fi and even fully offline, which a cloud proctor
cannot. It gives instant feedback (liveness, phone detection) without a round
trip, and it costs nothing per student, so a school can use it for every quiz,
not only high-stakes exams.

## 60-second demo video shot list

1. **0–8 s:** the problem in one line over the sign-in screen.
2. **8–18 s:** consent screen, tick, the exam opens and checks start.
3. **18–30 s:** camera panel: look away, hold a phone up, the flag appears.
4. **30–40 s:** liveness colour flash passes.
5. **40–48 s:** Wi-Fi off, phone detection still works.
6. **48–56 s:** submit, the student's transparency report.
7. **56–60 s:** the line "AI on your device, not in the cloud", plus the repo URL.
