# Submission answers (AppBuildersPH Hackathon 2026)

Ready to paste into the Cerebral Valley form. Fields marked **TODO** must be
filled by the team. Every answer matches [LOCAL_AI.md](LOCAL_AI.md) and
[EXISTING_CODE.md](EXISTING_CODE.md).

## Project name

ExamGuard: consent-first exam integrity with on-device AI

## Short description

A Mac exam app and an iPhone companion that keep online tests honest without
streaming anyone's webcam to a cloud proctor, and that give teachers a short
list instead of hours of video: **teachers see only the attempts that need a
look.** Face and gaze, phone, earbuds and glasses detection, speech-to-text,
typing and pointer patterns and presence checks run on the student's own Mac;
the iPhone only pings the laptop so it stays on the desk. Students agree to
every check before the clock starts and see the same findings as the teacher
afterwards, with room to reply. Every finding is a lead with its evidence,
never an automatic verdict.

## Team members

Team **n00bies**: Dustin Hizon, John Mhalic Pagaduan, Justen Rey Resari, Rommeniel Osorio.

## Public GitHub repository

https://github.com/djhizon/examguard

## Demo video

**TODO**: link (about 1 minute, for a general audience; shot list, voice-over and
caption strip in [DEMO.md](DEMO.md#a-the-60-second-video)).

## X / LinkedIn video URL

**TODO**: post tagging Devin / Cognition with #AppBuildersPH.

## What runs locally

- **Camera checks on the student's Mac:** MediaPipe Face Landmarker (face
  present, extra faces, eye-gaze direction that calibrates itself from where the
  student clicks and types, hidden from the student) and EfficientDet-Lite0
  (phone in view), in a Web Worker. No frame leaves the device; one downscaled
  evidence photo is saved locally when an unusual condition holds for 2 s.
- **Wearables check:** a D-FINE detector (Objects365, Apache-2.0) for earbuds,
  headphones, glasses and watch. The Mac app runs D-FINE-X with `onnxruntime-node`
  in a worker thread of its loopback-only local API; plain browsers run a lighter
  D-FINE-S copy on WASM.
- **Camera hardware rule:** OBS and other virtual cameras are refused; the Mac app
  asks macOS (AVFoundation + CoreMediaIO) whether the camera is built-in, USB or
  iPhone Continuity hardware. Strict mode also refuses virtual machines and
  capture displays.
- **Presence checks:** a required colour-reflection check in setup, then random
  server-signed screen-edge colour pulses between questions (no button, no head
  turn), read off the face by the local camera pipeline and scored by the local API.
- **Speech-to-text:** whisper.cpp with the English `ggml-small.en-q5_1` model,
  run by the local API as a child process; only the text is kept, never audio.
- **Typing, pointer and audio statistics:** keystroke dynamics, injected-text,
  burst-after-idle and pointer-outside-window checks, and voice-activity
  detection, plain signal processing in the browser (never the text typed).
- **Lighting and brightness:** lighting check with fix tips; the Mac app forces
  the built-in display to full brightness for the exam.
- **iPhone presence (required in setup):** the phone app pairs by QR and only
  pings the laptop over the local network while it is open on the desk; no
  camera, microphone or screen data leaves the phone.
- **Screen recording (required):** whole-screen recording encoded on the Mac and
  saved to Movies › ExamGuard Recordings; uploaded only if the exam's upload
  setting is on.
- **Findings engine and teacher triage:** the stored timeline becomes at most
  six plain-language findings per attempt with an overall level (none / glance /
  review); the instructor's "Who needs a look" screen, the evidence card and the
  Fine / Follow up decisions all run on the local API and SQLite database.
- **Everything else:** the API, SQLite database, student transparency report
  with per-finding notes and the consent flow all run on the same machine.
- **Server vision (optional, off by default):** OWL-ViT zero-shot detection in a
  local Python process as a second opinion (`ENABLE_BACKEND_VISION=true`).

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
  locally instead. An exam can keep recordings on the student's computer only
  (`RECORDING_UPLOAD=off` or the exam's setting), and then nothing is uploaded.
- **First-time model downloads:** MediaPipe models (`npm run vision:prepare`),
  the Whisper model (`npm run setup:whisper`) and OWL-ViT (first use). After
  that, the core works offline.

## What leaves the device

One row per data type. "Cloud" means a third-party service outside the laptop
and the classroom API; the API itself is the local server (or the Mac app).

| Data type                                                          | Where it is processed                                      | Where it is stored                                                        | Who sees it                                                  | Retention                                                                                                                               | Cloud?                                                                                                           |
| ------------------------------------------------------------------ | ---------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Camera frames (face, gaze, phone detection)                        | Browser Web Worker on the student's laptop                 | Not stored; only derived events (look-away, no face, phone) go to the API | Student (report), instructor (timeline)                      | Events: until the attempt is removed                                                                                                    | No                                                                                                               |
| Evidence photos (triggered stills)                                 | Captured in the browser, validated by the local API        | API SQLite database                                                       | Student (transparency report), instructor (Evidence gallery) | Exam retention setting (default `EVIDENCE_RETAIN_DAYS`, 30); deleted 7 days after an attempt is marked "fine"                           | No                                                                                                               |
| Microphone audio                                                   | Local Whisper.cpp child process of the API                 | Audio is discarded after transcription; only text is kept in SQLite       | Student (report), instructor (timeline)                      | Transcript text: exam retention setting (default `AUDIO_RETAIN_DAYS`, 30); deleted 7 days after "fine"                                  | No                                                                                                               |
| Screen recording segments                                          | Encoded in the browser (MediaRecorder)                     | Student's Downloads folder, or the school's OneDrive when upload is on    | Instructor (OneDrive); student (local files)                 | Uploaded metadata and files: exam retention setting (default 30 days); deleted 7 days after "fine". Local files: the student keeps them | Only when the exam's "recording upload" is on (`RECORDING_UPLOAD`, default on) and Microsoft Graph is configured |
| Typing and pointer rhythm                                          | Browser (aggregates only, never keys or text)              | API SQLite (per-window statistics)                                        | Student (report), instructor (timeline)                      | Until the attempt is removed                                                                                                            | No                                                                                                               |
| Liveness challenges                                                | Browser capture, scored by the local API                   | API SQLite (pass/fail and scores, no images)                              | Student, instructor                                          | Until the attempt is removed                                                                                                            | No                                                                                                               |
| iPhone presence pings                                              | Companion app on the phone, local API                      | API SQLite (paired, lost, reconnected events)                             | Student, instructor                                          | Until the attempt is removed                                                                                                            | No (LAN only)                                                                                                    |
| Answers and revisions                                              | Local API                                                  | API SQLite                                                                | Student, instructor                                          | Until the attempt is removed                                                                                                            | Only the instructor aids below                                                                                   |
| Instructor AI aids (AI-written check, similarity, exam generation) | Google Gemini, only when an instructor runs them           | Results in API SQLite; Gemini receives the saved answer text or the topic | Instructor                                                   | Until the attempt is removed                                                                                                            | Yes, only with `GEMINI_API_KEYS` set; never student media                                                        |
| Account email and password reset                                   | Supabase Auth (optional) with mail through Microsoft Graph | Supabase stores the email address; local accounts stay in SQLite          | The student, the school admin                                | Supabase account lifetime                                                                                                               | Yes, email address only, and only when `SUPABASE_URL` is set                                                     |

Not in the table because it never exists: continuous webcam video, raw audio
files, phone camera or microphone data, and keystroke contents.

**Retention controls.** Each exam has one retention setting (`retain_days`,
migration 0015) that covers evidence photos, uploaded-recording metadata and
transcripts; when unset, `EVIDENCE_RETAIN_DAYS` and `AUDIO_RETAIN_DAYS` apply,
and 0 keeps media until the attempt is removed. Sweeps run at API start, daily
and on read. When a teacher marks an attempt "fine", its photos, transcripts and
recording metadata (and the OneDrive files, best effort) are deleted 7 days
later; findings and timeline counts stay. Instructors read and change the
setting through `GET`/`PATCH /exam/instructor/exams/:examId/privacy`
(`{ retainDays, recordingUpload }`, `null` = server default), and the attempt
log shows it. "Keep recordings on this computer" (`recordingUpload: false`, or
`RECORDING_UPLOAD=off` as the default) makes the recorder save segments locally
only and the API refuse uploads with a 403.

## Models used

- MediaPipe Face Landmarker (`face_landmarker.task`, float16, a few MB)
- MediaPipe Object Detector, EfficientDet-Lite0 (`efficientdet_lite0.tflite`,
  int8, a few MB; COCO's 80 classes)
- OpenAI Whisper `small.en` via whisper.cpp (`ggml-small.en-q5_1.bin`, about 190 MB)
- D-FINE object detector trained on Objects365 (Apache-2.0): D-FINE-X ONNX
  (about 252 MB, bundled in the dmg, `onnxruntime-node`) in the Mac app, D-FINE-S
  uint8 on `onnxruntime-web` WASM in plain browsers
- Google OWL-ViT `google/owlvit-base-patch32` via Hugging Face Transformers
  (optional, off by default, about 600 MB)
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
> committed), the OpenAI Whisper `small.en` model (`ggml-small.en-q5_1`), the
> D-FINE Objects365 detector (Apache-2.0, ONNX weights fetched and checksummed at
> package time), Google OWL-ViT (`google/owlvit-base-patch32`, Apache-2.0) via
> Hugging Face Transformers, MediaPipe Tasks Vision, Apple Vision (iOS), and npm
> dependencies in `package-lock.json`.
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

## Measured on synthetic sessions

Synthetic data only, not real students: `npm run eval:findings` replays 22 generated attempts
(9 honest, 9 staged cheats, 2 hard borderline cases each way, seeded and noisy) through the
findings engine. The main set catches 9 of 9 staged cheats and flags 3 of 9 honest sessions; both
hard cheats are missed and one hard honest case is flagged. Thresholds were not tuned to this set;
the full tables, the honest reading and five recommendations are in
[eval-findings.md](eval-findings.md).

| Finding                  | Staged cheats detected | Honest sessions flagged | Hard cheats | Hard honest |
| ------------------------ | ---------------------- | ----------------------- | ----------- | ----------- |
| `notes_or_second_screen` | 2 / 2                  | 2 / 9                   | 0 / 1       | 0 / 2       |
| `second_person`          | 1 / 1                  | 1 / 9                   | -           | 1 / 2       |
| `external_answer_entry`  | 2 / 2                  | 0 / 9                   | -           | 0 / 2       |
| `phone_use`              | 2 / 2                  | 0 / 9                   | 0 / 1       | 0 / 2       |
| `left_exam`              | 1 / 1                  | 0 / 9                   | -           | 0 / 2       |
| `environment_risk`       | 1 / 1                  | 0 / 9                   | -           | 0 / 2       |

| Cohort      | Sessions | none | glance | review |
| ----------- | -------- | ---- | ------ | ------ |
| honest      | 9        | 6    | 1      | 2      |
| cheat       | 9        | 0    | 2      | 7      |
| hard_honest | 2        | 1    | 1      | 0      |
| hard_cheat  | 2        | 2    | 0      | 0      |

## 60-second demo video

The shot list, the ~145-word voice-over and the "show it or list it" caption strip
are in [DEMO.md](DEMO.md#a-the-60-second-video), next to the 5-minute live script
and the Q&A cheat sheet. The hero moment is the internet going off while the
phone-in-view detection and the iPhone pings keep working; the close line is
"Private by design, works offline. ExamGuard."
