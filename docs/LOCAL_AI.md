# Local-first AI inventory

The core integrity signals run on the student's own machine. They keep working
if every cloud service disappears. Cloud APIs (Gemini) are optional, secondary
instructor aids. This table lists every AI/ML component and where it runs.
It was written from the code, not from intent; limitations are stated.

"On-device (browser)" runs in the student's browser tab (WASM, CPU). "On-device
(server process)" runs in the API process or a child process on the same
machine as `npm run dev`; nothing leaves the machine.

| Component                                                        | What it does                                                                       | Where it runs                                                         | Model and approx size                                                                     | Works offline?                                                                                |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| MediaPipe Face Landmarker                                        | Face presence, multiple faces, head pose / gaze direction                          | On-device (browser, Web Worker, CPU)                                  | `face_landmarker.task` (float16), a few MB                                                | Yes, after `npm run vision:prepare`                                                           |
| MediaPipe Object Detector (EfficientDet-Lite0)                   | Phone and similar object detection in the camera frame                             | On-device (browser, Web Worker, CPU)                                  | `efficientdet_lite0.tflite` (int8), a few MB                                              | Yes, after `npm run vision:prepare`                                                           |
| Optional custom earbud / smart-glasses detectors                 | Extra object classes                                                               | On-device (browser)                                                   | `earbuds_custom.tflite`, `smart_glasses_custom.tflite`: not shipped, you must supply them | Yes, if you add the files; otherwise skipped                                                  |
| Whisper.cpp `base` (ggml)                                        | Speech-to-text of short audio clips                                                | On-device (server process: `whisper-cli` child process)               | `ggml-base.bin`, about 148 MB                                                             | Yes, after `npm run setup:whisper`                                                            |
| OWL-ViT zero-shot detector (opt-in `ENABLE_BACKEND_VISION=true`) | Text-prompted detection (for example earbuds) on a submitted frame                 | On-device (server process: local Python venv)                         | `google/owlvit-base-patch32`, about 600 MB, downloaded from Hugging Face on first use     | Only after the first download has been cached; the first run needs the network                |
| Keystroke dynamics                                               | Dwell and flight times, typing speed, uniformity flag                              | On-device (browser, plain statistics, no model)                       | None                                                                                      | Yes                                                                                           |
| Voice activity (FFT energy)                                      | Detects speech in the microphone stream                                            | On-device (browser, Web Audio, no model)                              | None                                                                                      | Yes                                                                                           |
| Liveness flash measurement                                       | Opens the native webcam, flashes the screen white and measures the brightness rise | On-device capture; the HMAC-signed result is checked by the local API | None (signal processing)                                                                  | Yes                                                                                           |
| Virtual-camera rejection                                         | Refuses OBS and other virtual cameras during liveness and the exam gate            | On-device (browser, camera label and device checks)                   | None                                                                                      | Yes                                                                                           |
| TensorFlow.js hand pose (gesture liveness challenge)             | Checks a requested hand gesture                                                    | On-device (server process, `@tensorflow/tfjs-node`)                   | MediaPipe Hands `lite` detector and landmark graph models                                 | **No, not as shipped** (see limitation 1)                                                     |
| Gemini exam generation (cloud, secondary)                        | Writes an exam from a topic on demand, and during `demo:seed`                      | Cloud (Google Gemini API)                                             | Model set by `GEMINI_MODEL`                                                               | No. Falls back to static questions                                                            |
| Gemini AI-written answer check (cloud, secondary)                | Instructor-only scoring of saved answers, with quoted phrases                      | Cloud (Google Gemini API)                                             | Same Gemini model                                                                         | No. Without keys the API returns a clear "needs GEMINI_API_KEYS" error; monitoring unaffected |
| Gemini similarity embeddings (cloud, secondary)                  | Embeds saved free-text answers and flags close pairs across students               | Cloud (`gemini-embedding-001` by default)                             | `gemini-embedding-001`                                                                    | No. Fewer than two answers needs no embeddings; otherwise a clear error                       |

## How the cloud parts degrade

- **No `GEMINI_API_KEYS`:** `exam.plugin.ts` logs that AI checks are disabled
  and passes `null` for the Gemini client. Integrity monitoring and phone
  presence are unaffected.
- **Exam generation:** `seed-demo.ts` uses static `FALLBACK_QUESTIONS` when no
  keys are set or the Gemini call fails. The web app (`App.tsx`) shows "A fresh
  fallback exam is ready. Gemini was unavailable or not configured."
- **AI-written answer check and similarity:** `integrityService.ts` calls
  `requireGemini()`, which throws an `invalid_state` error saying the check
  needs `GEMINI_API_KEYS`. The instructor panels surface that message. There is
  no offline substitute for these two instructor checks; they are leads for a
  human reviewer and nothing in the student flow depends on them.

## Known limitations (read these before claiming "fully offline")

1. **Hand-pose gesture challenge is not offline.** `handDetector.ts` calls
   `createDetector` with `runtime: 'tfjs'` and no model URLs. The library then
   loads its weights from `tfhub.dev` on first use. The native binding itself
   is present on this machine: `node_modules/@tensorflow/tfjs-node/lib/napi-v8/tfjs_binding.node`
   and `deps/lib/libtensorflow*.dylib` exist. On a fresh clone where npm install
   scripts are blocked the binding may be missing. In both cases a failure is
   recorded honestly as "Gesture engine unavailable" (a fail, never a pass).
   The flash liveness check does not use this component.
2. **MediaPipe models must be prepared once.** They are not committed.
   `npm run vision:prepare` downloads `face_landmarker.task` and
   `efficientdet_lite0.tflite` from `storage.googleapis.com` and verifies SHA-256
   hashes. At the time of writing `apps/web/public/vision` does not exist on
   this machine, so run it before the demo. The WASM runtime is served from
   `/vision/wasm`.
3. **OWL-ViT first run downloads about 600 MB** from Hugging Face. It is
   opt-in, and the demo does not depend on it.
4. **Whisper `base` is small.** Accuracy on noisy or accented audio is limited.
   The transcript is a lead for review, not evidence.
5. Detection models make mistakes. Every signal is shown to the student and
   labelled as a lead for a human, never an automatic verdict.

## Offline demo

Do this once with a network: `npm install`, `npm run vision:prepare`,
`npm run setup:whisper`, `npm run demo:seed`. Then start `npm run dev`, open the
app, and turn Wi-Fi off.

Keeps working:

- Sign-in, consent screen, exam, autosave, submit (local SQLite, local API).
- Tab guard, focus loss, paste blocking, overlay detection.
- Camera vision panel: face landmarks, head pose, phone detection.
- Liveness flash with native-webcam-only check (rejects OBS and virtual cameras).
- Keystroke dynamics and voice activity.
- Local Whisper transcript of audio clips.
- The student transparency report.

Stops working (and says so):

- Gemini exam generation, AI-written answer check, similarity check.
- The hand-gesture challenge (weights come from `tfhub.dev`, limitation 1).
- OWL-ViT, if the model was never cached.

Not verified in this document: a full run with the network physically
disconnected. Rehearse it before the demo.
