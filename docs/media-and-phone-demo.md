# Webcam, local transcription, and same-Wi-Fi phone demo

The phone instructions below describe the **legacy browser companion**. The
laptop now offers a native iPhone presence requirement; use the
[iPhone presence guide](iphone-presence.md) for current pairing and timeout behavior.

## Scope and current behavior

These fixes target the existing desktop demo and its Vite/API servers. They do
not change kiosk controls, terminate applications, reset exams, configure a VPN,
install certificates, or change firewall settings. Hardware validation is manual.

- **Camera:** choose a labelled non-virtual camera, prefer the built-in/FaceTime
  camera, and request its exact device ID. Reject known OBS/virtual labels and
  unexpected returned device IDs; show the selected label or a useful error.
  Installed OBS alone is not a camera violation. Device labels are a heuristic,
  not attestation that a feed is raw or unmodified.
- **Transcription:** record a complete five-second clip, convert it locally with
  FFmpeg, then run whisper.cpp. Each clip has its own container header; slices
  of one continuous WebM recording were not reliably independently decodable.
  Recording pauses during inference to avoid an unbounded upload queue. The
  voice activity counter is independent of speech recognition.
- **Phone:** the QR uses an explicitly entered laptop origin, not localhost.
  The companion calls `/exam/phone-heartbeat` and shows connected only after
  acknowledgement. Requests time out, and pending requests are cancelled on
  unmount. Enrollment requires student authentication, CSRF, and attempt
  ownership; heartbeat possession of the QR token is its authorization.

## Start on trusted Wi-Fi

1. Stop an existing development server with Ctrl+C in its terminal. Do not run
   two copies against ports 3000/5173.
2. From this checkout's root, run:

   ```sh
   EXAM_LAN=1 npm run dev
   ```

3. Leave that terminal open. Copy the Wi-Fi address printed after
   `Phone QR origin (choose the Wi-Fi address)`, for example
   `http://192.168.1.10:5173`. If several private addresses are listed, use the
   Wi-Fi interface's address, not a VPN or unrelated adapter.
4. Open/reload the desktop app, open an exam, then enter that address in
   **Connect companion phone → Laptop origin** and scan the new QR.
5. The phone should show **Connected — heartbeat acknowledged**. The laptop's
   enrollment modal closes when it sees the heartbeat.

LAN mode exposes the development website and its proxied API to reachable
network peers. Use only trusted Wi-Fi and synthetic demo accounts/data. It adds
exact private IPv4 origins to the API allowlist, not a wildcard. Ordinary
`npm run dev` remains loopback-only. Stop the server after the demonstration.
No Tailscale, public tunnel, router port forwarding, or administrator privileges
are needed for this mode. Wi-Fi client isolation or a host firewall can still
prevent phone access; those settings are not modified by the app.

The Electron shell still loads `http://127.0.0.1:5173/`; local servers must stay
running. These renderer/API changes do not require rebuilding the Electron
package. Restart the API process to load backend changes.

### Phone limitations

- HTTP on a private Wi-Fi address supports enrollment and heartbeats, **not
  microphone access**. The proximity microphone requires a trusted HTTPS origin
  plus the phone user's explicit enable action. HTTPS setup is separate work;
  do not bypass certificate warnings.
- The companion does **not** record camera video. A heartbeat is not proof that
  the phone is restricted, that it is the student's only phone, or that its
  camera/microphone is active.
- Treat the QR URL as a private bearer credential. HTTP does not encrypt it.
  Do not publish screenshots containing the QR or its token.
- The existing integrity plugin still gates phone routes on configured
  `GEMINI_API_KEYS`, even though heartbeat itself does not call Gemini. If the
  API reports that phone features are disabled, use the existing private local
  configuration; do not paste API keys into documentation or screenshots.

## Manual hardware acceptance

1. **Camera:** leave OBS installed/running, enable camera checks, and confirm
   the selected label is FaceTime/built-in and the preview is the physical
   webcam, not the OBS scene. Denying access or making the physical camera
   unavailable should produce an error rather than silently switching to OBS.
2. **Speech:** enable audio and speak a short synthetic sentence while the
   status says recording. After five seconds it should say transcribing, then
   append text or show an explicit failure. The default is the smaller multilingual
   base model on CPU; this is clip transcription, not continuous real-time
   transcription. Stop/start audio to retry after correcting an error.
3. **Phone:** confirm connected on the same Wi-Fi, then disconnect the phone
   from Wi-Fi and verify it eventually reports connection lost. Reconnect and
   verify acknowledgements resume. HTTP mode should explain why the microphone
   is unavailable instead of repeatedly requesting permission.

For an unreachable phone page, first try the printed laptop origin directly in
the phone browser. Confirm both server processes are still running, the address
is the current Wi-Fi IPv4 address, and the network is not a guest/client-isolated
network. A successful laptop localhost page alone does not prove LAN access.

## Local transcription dependencies and data handling

Defaults are `ffmpeg` on PATH and, under `apps/api`, the existing
`vendor/whisper.cpp/build/bin/whisper-cli` and
`vendor/whisper.cpp/models/ggml-base.bin`. Overrides are `FFMPEG_BIN`,
`WHISPER_BIN`, and `WHISPER_MODEL_PATH`. GPU use is opt-in with `WHISPER_USE_GPU=1`.
Install the base model with the vendored `models/download-ggml-model.sh base` script.
The default model's upstream SHA-1 is `465707469ff3a37a2b9b8d8f89f2f99de7299dac`.

The API checks audio attempt ownership, admits one transcription at a time,
limits input to 1 MiB, and bounds FFmpeg/Whisper execution to 15/30 seconds.
Inference failures return HTTP 503 instead of a successful empty transcript.
The client displays failure and stops submitting clips until restarted.

Temporary raw audio is removed in a `finally` cleanup after each request,
including normal inference failures. This is not a secure-erasure guarantee;
an abrupt process/OS crash can interrupt cleanup. Existing transcript text can
still be stored as an integrity event in SQLite. This patch does not implement
immediate deletion of transcript history or change other recording features.

## Automated validation

Focused tests cover camera preference/rejection, complete recording containers,
upload backpressure, inference error reporting and cleanup, QR origin
validation, configured LAN origins, acknowledged/rejected heartbeats, and
student/CSRF/ownership boundaries. Camera, microphone, subprocess inference,
and phone fetches are mocked in these tests. They do not prove hardware
operation, model accuracy, or real phone reachability.

```sh
npx vitest run --config vitest.config.ts apps/web/src/features/integrity apps/web/src/features/companion apps/web/src/features/exam/api.test.ts apps/api/src/modules/exam apps/api/src/modules/integrity/whisper.test.ts scripts/lan-config.test.ts
npx tsc -p apps/api/tsconfig.json --pretty false
npm run build --workspace @exam-anti-cheat/web
```

The full web typecheck still has existing failures in `SimilarityDashboard`,
the `keystroke_violation` type, MediaPipe worker declarations, and `watermark`.
The web build also warns about MediaPipe WASM/runtime imports. Neither issue is
claimed fixed by this media/network patch.
