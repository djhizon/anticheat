# Local-first AI inventory

The core integrity signals run on the student's own machine. They keep working
if every cloud service disappears. Cloud APIs (Gemini) are optional, secondary
instructor aids. This table lists every AI/ML component and where it runs.
It was written from the code, not from intent; limitations are stated.

"On-device (browser)" runs in the student's browser tab (WASM, CPU). "On-device
(server process)" runs in the API process or a child process on the same
machine as `npm run dev`; nothing leaves the machine.

| Component                                                        | What it does                                                                                                            | Where it runs                                                          | Model and approx size                                                                      | Works offline?                                                                                |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| MediaPipe Face Landmarker                                        | Face presence, multiple faces, head pose / gaze direction                                                               | On-device (browser, Web Worker, CPU)                                   | `face_landmarker.task` (float16), a few MB                                                 | Yes, after `npm run vision:prepare`                                                           |
| MediaPipe Object Detector (EfficientDet-Lite0)                   | Phone and similar object detection in the camera frame                                                                  | On-device (browser, Web Worker, CPU)                                   | `efficientdet_lite0.tflite` (int8), a few MB                                               | Yes, after `npm run vision:prepare`                                                           |
| Optional custom earbud / smart-glasses detectors                 | Extra object classes                                                                                                    | On-device (browser)                                                    | `earbuds_custom.tflite`, `smart_glasses_custom.tflite`: not shipped, you must supply them  | Yes, if you add the files; otherwise skipped                                                  |
| Whisper.cpp `base` (ggml)                                        | Speech-to-text of short audio clips                                                                                     | On-device (server process: `whisper-cli` child process)                | `ggml-base.bin`, about 148 MB                                                              | Yes, after `npm run setup:whisper`                                                            |
| OWL-ViT zero-shot detector (opt-in `ENABLE_BACKEND_VISION=true`) | Text-prompted detection of cell phone, earbuds, headphones, headset, smart glasses, smart watch (and person) on a frame | On-device (server process: local Python venv)                          | `google/owlvit-base-patch32`, about 600 MB, downloaded from Hugging Face on first use      | Only after the first download has been cached; the first run needs the network                |
| iOS Vision desk camera (optional, iPhone app)                    | Counts people and checks hands near the keyboard from the phone's rear camera                                           | On-device (iPhone, Apple Vision; only flags are sent, never images)    | Built-in `VNDetectHumanRectanglesRequest` and `VNDetectHumanHandPoseRequest` (OS-provided) | Yes, no network needed for analysis; flags go to the local API                                |
| Keystroke dynamics                                               | Dwell and flight times, typing speed, uniformity flag                                                                   | On-device (browser, plain statistics, no model)                        | None                                                                                       | Yes                                                                                           |
| Voice activity (FFT energy)                                      | Detects speech in the microphone stream                                                                                 | On-device (browser, Web Audio, no model)                               | None                                                                                       | Yes                                                                                           |
| Liveness colour flash (default)                                  | Opens the native webcam, shows three random full-screen colours and reads the mean RGB of the face region for each      | On-device capture; the HMAC-signed sequence is scored by the local API | None (signal processing)                                                                   | Yes                                                                                           |
| Liveness head turn (fallback)                                    | Measures head yaw with the app's MediaPipe face landmarker while the student turns left/right in a random order         | On-device (browser worker); the local API verifies the yaw samples     | MediaPipe `face_landmarker.task` (same as the camera panel)                                | Yes, after `npm run vision:prepare`                                                           |
| Liveness spoken words (accessibility)                            | Student says 3 random words; at least 2 must be transcribed                                                             | On-device recording; transcribed by local Whisper.cpp on the API       | Whisper base model (same as the audio panel)                                               | Yes, after `npm run setup:whisper`                                                            |
| Virtual-camera rejection                                         | Refuses OBS and other virtual cameras during liveness and the exam gate                                                 | On-device (browser, camera label and device checks)                    | None                                                                                       | Yes                                                                                           |
| Gemini exam generation (cloud, secondary)                        | Writes an exam from a topic on demand, and during `demo:seed`                                                           | Cloud (Google Gemini API)                                              | Model set by `GEMINI_MODEL`                                                                | No. Falls back to static questions                                                            |
| Gemini AI-written answer check (cloud, secondary)                | Instructor-only scoring of saved answers, with quoted phrases                                                           | Cloud (Google Gemini API)                                              | Same Gemini model                                                                          | No. Without keys the API returns a clear "needs GEMINI_API_KEYS" error; monitoring unaffected |
| Gemini similarity embeddings (cloud, secondary)                  | Embeds saved free-text answers and flags close pairs across students                                                    | Cloud (`gemini-embedding-001` by default)                              | `gemini-embedding-001`                                                                     | No. Fewer than two answers needs no embeddings; otherwise a clear error                       |

Note on the liveness rows: the colour flash and head turn are scored from measurements the browser reports, so a pass is recorded as "Check passed (client-measured)" and is advisory, while spoken words is verified server-side from the recording transcribed by Whisper.

### Why a second, server-side detector

The browser camera panel uses MediaPipe EfficientDet-Lite0, which only knows
COCO's 80 classes. "Cell phone" is one of them; earbuds, headphones, smart
glasses and smartwatches are not, so the browser model cannot see them.
OWL-ViT is zero-shot: it accepts any text label, so it can look for those
items. It costs about 8 s per frame warm and is opt-in
(`ENABLE_BACKEND_VISION=true`). When enabled, the camera panel sends one
downscaled frame (at most 640 px wide) about every 20 s and shows a "Second
opinion (local OWL-ViT)" line: not seen, seen, or not checked. Small items at
webcam resolution are often missed, so a result is a lead for a human
reviewer, never a verdict. Per-label score thresholds can be tuned in
`apps/api/vendor/yolo_server.py` (`LABEL_THRESHOLDS`, default 0.4).

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

1. **The hand-gesture liveness challenge was removed.** It downloaded model
   weights from `tfhub.dev` at runtime; the TensorFlow dependencies are gone.
   Every remaining liveness challenge runs without internet access.
2. **MediaPipe models must be prepared once.** They are not committed.
   `npm run vision:prepare` downloads `face_landmarker.task` and
   `efficientdet_lite0.tflite` from `storage.googleapis.com` and verifies SHA-256
   hashes. Run it once on each new machine before the demo (`npm run demo`
   does this automatically). The WASM runtime is served from
   `/vision/wasm`.
3. **OWL-ViT first run downloads about 600 MB** from Hugging Face. It is
   opt-in, and the demo does not depend on it.
4. **Whisper `base` is small.** Accuracy on noisy or accented audio is limited.
   The transcript is a lead for review, not evidence. Only transcript text is
   stored (never audio), and it is deleted after `AUDIO_RETAIN_DAYS` (default 30).
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
- Liveness (colour flash, head turn, spoken words) with native-webcam-only check (rejects OBS and virtual cameras).
- Keystroke dynamics and voice activity.
- Local Whisper transcript of audio clips.
- The student transparency report.

Stops working (and says so):

- Gemini exam generation, AI-written answer check, similarity check.
- OWL-ViT, if the model was never cached.

Not verified in this document: a full run with the network physically
disconnected. Rehearse it before the demo.
