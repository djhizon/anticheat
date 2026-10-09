# Local-first AI inventory

The core integrity signals run on the student's own machine. They keep working
if every cloud service disappears. Cloud APIs (Gemini) are optional, secondary
instructor aids. This table lists every AI/ML component and where it runs.
It was written from the code, not from intent; limitations are stated.

"On-device (browser)" runs in the student's browser tab (WASM, CPU). "On-device
(server process)" runs in the API process or a child process on the same
machine as `npm run dev`. Camera and screen frames are analysed locally and are not
streamed anywhere. The one exception is evidence snapshots: when a local check
holds an unusual condition (see "Evidence snapshots" below), a single downscaled
still photo is saved to the local API database for the instructor, and the
student sees it in their report.

| Component                                                        | What it does                                                                                                                  | Where it runs                                                          | Model and approx size                                                                                   | Works offline?                                                                                |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| MediaPipe Face Landmarker                                        | Face presence, multiple faces, head pose / gaze direction                                                                     | On-device (browser, Web Worker, CPU)                                   | `face_landmarker.task` (float16), a few MB                                                              | Yes, after `npm run vision:prepare`                                                           |
| MediaPipe Object Detector (EfficientDet-Lite0)                   | Phone and similar object detection in the camera frame                                                                        | On-device (browser, Web Worker, CPU)                                   | `efficientdet_lite0.tflite` (int8), a few MB                                                            | Yes, after `npm run vision:prepare`                                                           |
| Optional custom earbud / smart-glasses detectors                 | Extra object classes                                                                                                          | On-device (browser)                                                    | `earbuds_custom.tflite`, `smart_glasses_custom.tflite`: not shipped, you must supply them               | Yes, if you add the files; otherwise skipped                                                  |
| Whisper.cpp `small.en` (ggml, 5-bit)                             | Speech-to-text of short audio clips, English-locked (`-l en`); non-speech output such as "[MUSIC]" or a lone "you" is dropped | On-device (server process: `whisper-cli` child process)                | `ggml-small.en-q5_1.bin`, about 190 MB (`WHISPER_MODEL` selects `large-v3-turbo`, `large-v3` or `base`) | Yes, after `npm run setup:whisper`                                                            |
| OWL-ViT zero-shot detector (opt-in `ENABLE_BACKEND_VISION=true`) | Text-prompted detection of cell phone, earbuds, headphones, headset, smart glasses, smart watch (and person) on a frame       | On-device (server process: local Python venv)                          | `google/owlvit-base-patch32`, about 600 MB, downloaded from Hugging Face on first use                   | Only after the first download has been cached; the first run needs the network                |
| Keystroke dynamics                                               | Dwell and flight times, typing speed, uniformity flag                                                                         | On-device (browser, plain statistics, no model)                        | None                                                                                                    | Yes                                                                                           |
| Voice activity (FFT energy)                                      | Detects speech in the microphone stream                                                                                       | On-device (browser, Web Audio, no model)                               | None                                                                                                    | Yes                                                                                           |
| Liveness colour flash (default)                                  | Opens the native webcam, shows three random full-screen colours and reads the mean RGB of the face region for each            | On-device capture; the HMAC-signed sequence is scored by the local API | None (signal processing)                                                                                | Yes                                                                                           |
| Liveness head turn (fallback)                                    | Measures head yaw with the app's MediaPipe face landmarker while the student turns left/right in a random order               | On-device (browser worker); the local API verifies the yaw samples     | MediaPipe `face_landmarker.task` (same as the camera panel)                                             | Yes, after `npm run vision:prepare`                                                           |
| Liveness spoken words (accessibility)                            | Student says 3 random words; at least 2 must be transcribed                                                                   | On-device recording; transcribed by local Whisper.cpp on the API       | Whisper small.en model (same as the audio panel)                                                        | Yes, after `npm run setup:whisper`                                                            |
| Virtual-camera rejection                                         | Refuses OBS and other virtual cameras during liveness and the exam gate                                                       | On-device (browser, camera label and device checks)                    | None                                                                                                    | Yes                                                                                           |
| Gemini exam generation (cloud, secondary)                        | Writes an exam from a topic on demand, and during `demo:seed`                                                                 | Cloud (Google Gemini API)                                              | Model set by `GEMINI_MODEL`                                                                             | No. Falls back to static questions                                                            |
| Gemini AI-written answer check (cloud, secondary)                | Instructor-only scoring of saved answers, with quoted phrases                                                                 | Cloud (Google Gemini API)                                              | Same Gemini model                                                                                       | No. Without keys the API returns a clear "needs GEMINI_API_KEYS" error; monitoring unaffected |
| Gemini similarity embeddings (cloud, secondary)                  | Embeds saved free-text answers and flags close pairs across students                                                          | Cloud (`gemini-embedding-001` by default)                              | `gemini-embedding-001`                                                                                  | No. Fewer than two answers needs no embeddings; otherwise a clear error                       |

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

### Eye gaze and the phone detector (browser, on-device)

Gaze is estimated locally from the same FaceLandmarker run that gives head pose: no new
model, no image leaves the device. Gaze = head yaw/pitch (face transform) + eye-in-head
direction, where the eye term blends (a) the iris centres (landmarks 468/473) relative to the
eye corners (33/133, 362/263) and lids (159/145, 386/374) with (b) the
`eyeLookIn/Out/Up/Down` blendshapes. The result is smoothed with a One-Euro filter and shown
on the "Gaze details" dial (compass bearing, head vs eyes, 5 s trail) next to statistics
(time on screen, look-aways of 1 s or more, per-direction dwell, blink rate, face present %,
multiple-face events, tracking quality, phone detections, vision frames/s).

**Plug-and-play: no calibration step.** Students never see anything about calibration; any
webcam works. The gaze estimate calibrates itself while the student works
(`implicitCalibration.ts`, DOM side in `interactionCalibration.ts`):

1. _Bootstrapping prior._ It starts from the camera-centre model (gaze 0,0 = looking into the
   lens). Viewing distance comes from the inter-pupillary distance in the image (63 mm adult
   average, iris landmarks 468/473, corrected for head yaw) or, without irises, the face-mesh
   width (about 140 mm), assuming a 65° horizontal webcam field of view. The screen size is
   `window.screen` CSS pixels x 0.25 mm (clamped to 300-700 mm wide, which slightly
   over-estimates a laptop screen on purpose) with the camera 10 mm above the top edge. A
   typical laptop at 55 cm gives about ±18° x ±12°. Until the calibration is confident, the
   on-screen zone is deliberately wide: 2x the sideways extent + 6°, and 1.5x the full screen
   height below the camera + 3° vertically (about ±42° x ±38°), so nobody is flagged early.
2. _Interaction pairs._ A click or tap (at the pointer position), focusing an answer field, or
   typing in a small field (at most every 3 s) is taken as "looking at that spot": the median
   raw gaze of the preceding 0.6 s is paired with the point in screen-normalised coordinates.
   Per axis, raw = offset + slope x target is refitted over the last 40 pairs with a robust
   fit (Theil-Sen start, Huber IRLS, residuals beyond 3 robust sigmas rejected), so clicks
   made while looking at the keyboard do not skew it. The slope (gain, including a mirrored
   sign) is only trusted when targets spread over at least a quarter of the screen half-size
   and there are 8+ pairs; otherwise the fit is offset-only. Only positions and timing are
   used: no key values or text.
3. _Self-centering._ While the student types, the running median of the residual against the
   current model feeds a slow drift correction (time constant 4 s while learning, 30 s after;
   at most ±12° sideways / ±15° vertically), which absorbs head creep and laptop-lid changes.
   A posture change (face 20% larger/smaller or moved by half a face width for 2.5 s while
   still facing the camera) clears the pairs and restarts the learning phase with the wide
   zone; a turned head (looking at notes) is not a posture change.
4. _Confidence._ 0-1 from the number of consistent pairs, their residual spread, the share of
   inliers and whether the gain was fitted (offset-only caps at 0.6). The on-screen zone
   shrinks from the wide learning zone toward the screen extent x 1.25 (plus two residual
   sigmas) as confidence grows. Look-away statistics and the `look_away` evidence trigger use
   that zone, and the direction log treats an unconfident estimate as "forward" unless it is
   clearly (10°+) beyond the wide zone. When the irises are unreliable (glare from glasses,
   low light: readings missing, jumping frame to frame or poor tracking quality), gaze falls
   back to head pose only with an extra ±12° x ±8° tolerance and confidence capped at 0.4.
5. _UI._ Calibration is silent. Students see no prompt, dots, buttons, status or confidence,
   and no code path asks them to look at points; the "Calibrate face direction" button is
   gone too. The status ("Auto-calibrating… (learns as you work)" / "Calibrated", with the
   confidence) is available to instructor views through `GazePanel`'s `showCalibration` prop,
   and in development builds with `VITE_GAZE_DEBUG=1`.

Limits of implicit calibration: it assumes people mostly look where they click and at the
screen while typing. Hunt-and-peck typists who watch the keyboard more than half the time
bias the vertical centre downward (bounded by the drift limit); a student who never clicks or
types in a small field stays in the wide learning zone. The geometry assumptions (field of
view, IPD, CSS pixel size) are averages; the fitted gain absorbs most of the error, but an
external monitor far from the webcam may need many interactions before the gain is trusted.
Someone who deliberately moves around to trigger posture resets keeps the zone wide; large
look-aways are still recorded, and a human reviews everything.

Limits: expect roughly +-5 to 10 degrees on a typical webcam. Glasses (glare, thick frames),
dim or back-lit rooms, a camera far from the screen, and extreme head angles all degrade it,
and the blink rate misses fast blinks at a few frames per second. The "tracking quality"
figure is a proxy (face size, iris landmarks, pose, eye openness) because FaceLandmarker
exposes no per-face confidence. Gaze is context for a human reviewer, never a verdict.

Phone detector: EfficientDet-Lite0 now returns up to 3 'cell phone' boxes at a 0.4 candidate
floor (run about once a second). A phone is only "Detected" when 3 of the last 5 detector
frames scored >= 0.5, or one frame scored >= 0.75; weaker evidence shows as "Possible phone".
Boxes overlapping the face are flagged but not discarded, because a phone held to the ear
overlaps the face. Logic: `phoneEvidence.ts`; gaze maths: `gazeEstimator.ts`; implicit calibration:
`implicitCalibration.ts`; statistics: `gazeStats.ts`; tracker and hook: `eyeGazeTracker.ts`.

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

## Camera hardware attestation (Mac app only)

In a plain browser the camera gate can only judge camera **labels** (plus a live-noise check),
so a virtual camera renamed to look like a webcam passes the label heuristics. In the Mac app,
the native helper's read-only `camera-list` action enumerates cameras with AVFoundation and
CoreMediaIO (no stream is opened, so no camera permission is needed) and classifies each one
from its transport type and providing plug-in: `builtin`, `usb`, `continuity` (iPhone),
`virtual` (transport `virt`, or a third-party Camera Extension / DAL plug-in such as OBS or Camo)
or `unknown`. The browser label is matched to that list by name, and the USB `vendor:product`
suffix Chromium adds (for example `(05ac:8514)`) must match the device's own ids. Virtual blocks
the gate with the usual instructions; unknown is allowed and logged as `camera_unverified` so
unusual hardware is never locked out; hardware is shown as "Verified hardware camera". A third-party
driver that claims a USB or built-in transport is reported as `unknown`, not trusted.

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
4. **Whisper `small.en` is a speed/accuracy compromise.** It is the largest
   model that keeps up with live 6 s clips on an Intel Mac CPU (see the
   benchmark below). Accuracy on noisy or accented audio is still limited.
   The transcript is a lead for review, not evidence. Only transcript text is
   stored (never audio), and it is deleted after the exam's retention setting
   (default `AUDIO_RETAIN_DAYS`, 30) or 7 days after the attempt is marked "fine".
5. Detection models make mistakes. Every signal is shown to the student and
   labelled as a lead for a human, never an automatic verdict.

### Whisper model choice

Transcription is pinned to English (`WHISPER_LANGUAGE=en`, `-l en`): automatic
language detection misread short or quiet clips as other languages. A short
prompt ("Exam room. English speech.", `WHISPER_PROMPT`) biases decoding,
`--suppress-nst` removes non-speech tokens and `--no-speech-thold 0.6` drops
segments Whisper rates as silent. Output that is only bracketed tags
("[MUSIC]", "(upbeat music)", "[BLANK_AUDIO]"), a known silence hallucination
("you", "Thank you."), an echo of the prompt, or one repeated token is treated
as non-speech: the API returns empty text and nothing is added to the timeline.

Benchmark on the development Intel Mac (Core i9-9880H, 8 cores, CPU only,
`-ng -t 4`, portable build with Apple Accelerate, 6 s clip from `jfk.wav`, the
machine was busy with other work so times are upper bounds). "Pair" is two
clips at once through the app's pipeline (`WHISPER_CONCURRENCY=2`); keeping
up live needs roughly 6 s or less.

| Model (`WHISPER_MODEL`)             | File size | One clip  | Pair      | Pair with `WHISPER_AUDIO_CTX=512` | 6 s transcript (truth: "And so my fellow Americans, ask not what your [country]")                   |
| ----------------------------------- | --------- | --------- | --------- | --------------------------------- | --------------------------------------------------------------------------------------------------- |
| `base` (base-q5_1)                  | 60 MB     | 1.4-2.3 s | 2.6 s     | not needed                        | "...ask not what you are" (wrong words; noisy clip: "...America asked not what you are calling me") |
| `small.en` (small.en-q5_1)          | 190 MB    | 3.0-4.5 s | 5.9-8.9 s | 3.1-4.5 s                         | "...ask not what your" (noisy: "...your cup is.")                                                   |
| medium.en-q5_0 (not offered)        | 539 MB    | 11-17 s   | n/a       | 10-12 s                           | "...ask not what your" (sometimes invents the rest: "...your country has to offer.")                |
| `large-v3-turbo` (q5_0)             | 574 MB    | 18-37 s   | 36-43 s   | 14-20 s                           | "...ask not what your country" (noisy: once "...your conscience")                                   |
| large-v3-turbo-q8_0 (not offered)   | 874 MB    | 40-47 s   | n/a       | n/a                               | same as q5_0                                                                                        |
| distil-large-v3 (q5_0, not offered) | 538 MB    | 17-41 s   | n/a       | 15 s (repeats phrases)            | "...ask not what your country"                                                                      |
| `large-v3` (q5_0)                   | 1.08 GB   | 39-50 s   | n/a       | n/a                               | "...ask not what your country"                                                                      |

On the full 11 s `jfk.wav` sample both `small.en` (5.4 s) and `large-v3-turbo`
(21.6 s) return the quote word for word. Six seconds of silence or room noise
came back as "you" or as the prompt echoed ("English speech."); both are
filtered out, so nothing reaches the timeline.

So `small.en` is the default for development and the packaged app: it is the
only model above `base` that transcribes a 6 s clip in well under 6 s and
keeps a pair of concurrent clips at about 6 s. On Apple Silicon or a fast
desktop CPU, `WHISPER_MODEL=large-v3-turbo` (or `large-v3`) gave the better
transcripts above but was not timed on Apple Silicon here; run
`npm run setup:whisper` with the same variable to download it, or
`WHISPER_MODEL=large-v3-turbo npm run package:mac` to bundle it (the dmg is
x86_64, so on Apple Silicon it runs under Rosetta; add `WHISPER_UNIVERSAL=1`
for a native arm64 `whisper-cli`). `WHISPER_AUDIO_CTX=512` cuts encoder time
two- to three-fold by encoding a 10 s window instead of 30 s, at some accuracy
risk (distil-large-v3 started repeating itself), so it is opt-in. The offered model files are official
`ggerganov/whisper.cpp` conversions pinned by SHA-256 in
`scripts/whisper-models.sh`. distil-large-v3 was measured by quantizing the
MIT-licensed `distil-whisper/distil-large-v3-ggml` file (fp16, 1.5 GB) locally;
no official quantized build exists, so it is not offered.

## Evidence snapshots

- **What:** when a local check holds for at least 2 seconds (more than one
  face, no face, a phone, a long look-away of 5 s or more, an overlay, or, in
  the desktop app, another app in front), the laptop takes one still frame from
  the already-open camera (at most 640 px wide, JPEG quality 0.6, 300 KB cap). In
  the desktop app, overlay and foreground-app triggers also save one still of
  the primary screen. The paired iPhone never sends photos. This is never
  continuous video.
- **Limits:** one snapshot per attempt, source and trigger every 30 seconds, and
  60 per attempt. The client and the API both enforce this.
- **Who sees it:** the instructor (Evidence gallery) and the owning student
  (transparency report). The student agrees to this in the consent list.
- **Retention:** stored in the API's SQLite database and deleted after the
  exam's retention setting (default `EVIDENCE_RETAIN_DAYS`, 30; 0 keeps them
  until the attempt is removed) or 7 days after the attempt is marked "fine".
  See "What leaves the device" below.
- **Honesty note:** a snapshot is a lead for a human, not proof. A screen
  snapshot may show whatever was on the screen at that moment.

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

## Input-behaviour signals (pointer and typing rhythm)

- **What is kept:** counts and timings aggregated into 20 s windows
  (`input_behaviour_windows`) plus a few named events. Never which keys were
  pressed, never typed text, never a stream of pointer coordinates. The only
  position-derived field is the nearest viewport edge when the pointer left.
- **Disclosure:** the consent list says "Typing rhythm and mouse movement
  patterns (not what you type)".
- **Events and thresholds** (constants in `apps/web/src/features/input/inputDetectors.ts`):

  | Event                           | Rule                                                                                                                                                                                                                                                                                     |
  | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `pointer_outside_long`          | pointer outside the window more than 5 s while the window still has focus                                                                                                                                                                                                                |
  | `synthetic_input`               | per 20 s window: 3 or more `isTrusted === false` events, or 3 or more teleports (over 400 px within one 34 ms frame), or 2 or more perfectly straight constant-velocity segments (straightness at least 0.9995, velocity variation under 5 %, 15 or more samples)                        |
  | `text_injected`                 | 30 or more characters inserted within 300 ms with fewer keydowns than characters (IME composition, autocorrect and paste/drop are ignored); also saves one webcam snapshot (`text_injected`)                                                                                             |
  | `uniform_typing`                | keydown interval coefficient of variation under 0.08 over 40 keys, or more than 150 wpm for 2 consecutive windows (40 or more characters each)                                                                                                                                           |
  | `burst_after_idle`              | over 60 s with no keys or pointer while the window kept focus, then 120 or more characters within 10 s                                                                                                                                                                                   |
  | `typing_drift`                  | mean key hold and interval both at least 4 standard errors and 30 % away from the baseline for 2 consecutive windows of 30 or more keys. The baseline is the typing from pre-exam setup if the setup screen calls `startSetupTypingCapture()`, otherwise the first 2 minutes of the exam |
  | `drop_blocked`, `copy_question` | a drop is blocked like paste; copying page text outside the answer box is logged                                                                                                                                                                                                         |

  Each event is reported at most once every 30 s. Context-menu counts, text
  selections, pointer path straightness and correction ratio are window
  aggregates only and never raise an event on their own. An injection with a
  still pointer (more than 10 s) gets its own log line.

- **False positives to expect:** screen readers, switch devices, voice control
  and dictation insert text without keydowns; password managers, text expanders
  and browser autofill do the same; remote-support or accessibility tools send
  untrusted events; trackpads, drawing tablets and touchscreens move
  differently from a mouse; a second monitor used for something permitted makes
  the pointer leave the window; fast typists and people who think for a minute
  then type a prepared outline can look like a burst; fatigue, a new keyboard
  or an injured hand shift typing rhythm. These are leads for a human reviewer,
  never verdicts, and the log wording says so.

## Findings (triage of the stored timeline)

- **What it is:** `GET /exam/attempts/:id/findings` (owner or instructor) reads the same stored
  rows as the integrity log and returns at most six plain-language findings plus one level:
  `review` (any high-confidence finding, or two medium ones), `glance` (any finding) or `none`.
  Findings are leads for a human, never verdicts; the wording always offers an innocent
  explanation. Each carries ISO windows, evidence-snapshot ids within ±10 s of a window,
  transcript lines inside the windows, and a `studentNote` slot. Results are cached 30 s per
  attempt, and the instructor attempt list carries `level`, `topReason` and `findingCount`.
- **Rules:** one weak signal never becomes a finding; confidence comes from corroboration. The
  student's own first 3 minutes are the baseline: the typing-burst floor is raised to twice their
  baseline rate, and a glance region they already used (and typed after) at least 3 times in the
  baseline at a similar rate (≥ 0.75× the attempt rate) is treated as a habit (keyboard, allowed
  notes), not a lead. Thresholds live in `FINDING_THRESHOLDS`
  (`apps/api/src/modules/integrity/findings.ts`):

  | Finding                  | Rule                                                                                                                                                                                                                                                                                            |
  | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `notes_or_second_screen` | 8 or more glances to one region (yaw and pitch within ±8°), 4 or more followed within 10 s by a typing burst (12 keystrokes or 40 characters in 10 s, an answer save growing by 20 words, or injected text); high when 8 or more are followed or any is followed by injected text               |
  | `second_person`          | 2 or more `multiple_faces` episodes of 2 s or more (or one of 10 s or more), and/or voice activity of 2 s or more with a transcript line of 3 or more words within 15 s while no `no_face` episode overlaps; high when both, medium for faces or 2 speech pairs, low for a single speech pair   |
  | `external_answer_entry`  | 2 or more injection episodes (`text_injected`, merged within 30 s), or one with a still pointer (`idle_pointer_injections`, or 0 pointer events in the window), or `burst_after_idle` with a still pointer over the 30 s before it; a single injection with a moving pointer is ignored         |
  | `phone_use`              | a downward gaze of 5 s or more within 60 s of `iphone_lost` / `phone_left_app`, or a phone sighting (`phone_detected`, server `vision_*phone*`) within 60 s of such a gaze or phone event, or 2 or more sightings (merged within 30 s); one sighting or one dropped connection alone is ignored |
  | `left_exam`              | 2 or more interruption episodes (focus loss, hidden page, blocked minimize or full-screen exit, recording stopped, emergency exit, another app in front; merged within 5 s); failed presence checks count only from the second one; medium at 3, high at 5 or an emergency exit                 |
  | `environment_risk`       | any virtual camera, capture device or capture display event (high with a second kind, 3 events, or a weak signal); `camera_unverified` and more than one display are weak and only count together                                                                                               |

- **False positives to expect:** touch-typists and hunt-and-peck typists look at the keyboard;
  a calculator or scratch paper sits below the camera; people read aloud or have family in the
  room; dictation and text expanders insert text at once; notifications steal focus; a locked
  phone drops its connection; docking stations present as capture hardware.

## Lighting and screen brightness

- **Lighting check (on-device):** small 64x64 luminance frames from the open camera (and the
  MediaPipe face box when available) are reduced to numbers: face brightness, face-versus-background
  contrast (backlight), clipped highlights, crushed shadows, noise and left/right asymmetry. Nothing
  is stored or uploaded except, if the face stays too dark or backlit for over 20 s in the exam, one
  informational `lighting_poor_<class>` timeline entry. Lighting never blocks an exam.
- **Boost light:** a white frame around the exam (and a brief full-white flash during setup) uses the
  screen as a fill light. Camera exposure/brightness constraints are tried when the camera exposes
  them; macOS Chrome exposes few, and failures are ignored.
- **Brightness (Mac app only):** the `app-control` helper reads and sets the built-in display level
  through the private DisplayServices framework (fallback: CoreDisplay, then IOKit). The exam sets
  100% and restores the original on exit; Strict re-applies it every 3 s if lowered (logged as
  `brightness_restored`, at most every 30 s), Demo sets it once. The original level is saved in
  `userData/display-brightness.json` and restored on the next launch after a crash. Private APIs may
  change between macOS versions, and external displays are unsupported (the student sees a tip).
  Browsers cannot change brightness and only show the tip.

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
