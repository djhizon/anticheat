# Responsive local demo

Camera and audio checks start automatically for an active exam after the consent gate
(camera first, audio about 1 s later so permission prompts and model loading do not
collide; both panels are lazy-loaded and still have Stop/Start buttons, and a failed
auto-start is not retried). The liveness check and screen recording stay user-initiated.
This is a demonstration mode, not a guarantee of continuous monitoring.

- **Camera:** face and available object processing, at most 1 inference/second.
  Earbud and smart-glasses custom model files are absent in this checkout; wired
  earphone/headphone detection is not implemented. Unavailable models show no fabricated
  clear readings. Direction describes calibrated head pose, not eye gaze.
- **Audio:** one built-in laptop microphone stream shared by activity monitoring
  and clip transcription. No default, external, phone, or virtual mic fallback.
  Hidden/unrecognized device labels produce permission/setup guidance; labels
  are not hardware attestation. Screen recording, when separately enabled,
  also uses the verified built-in mic.
- **Whisper:** multilingual base, CPU by default, one request at a time. Five-second
  clips pause while processing; no accumulating upload queue. FFmpeg timeout 15s,
  inference timeout 30s. A bundled synthetic/public sample passed locally in ~2.1s
  including conversion; live hardware performance remains to be checked.
- **Screen recordings:** 720p maximum, 5 fps maximum, local WebM segments every
  minute and on Stop. No recording-upload or speed-test calls. Downloads/save
  dialogs are browser/Electron managed; a request is not verified disk persistence.
  Stop before closing the app and verify playable files in Downloads. These local
  recordings persist until you delete them; existing server recordings are not deleted.
- **Phone:** origin validation explains disabled QR controls. Enrollment requests
  abort after 8 seconds. Expired QR codes are hidden and replaceable. The phone
  answer/save gate and server deadline remain unchanged. Navigation is accessible
  during phone setup; per-question timers retain their existing behavior.

## User-run checks

1. Restart the API/Vite servers; reopen the rebuilt desktop app. Camera checks start
   after consent, audio about a second later; recording remains manually started.
2. Wait for camera checks, calibrate facing forward, then turn left/right/up/down.
   Verify direction against your physical movement; camera-relative signs may differ
   from a mirrored preview. OBS must not replace the selected physical camera.
3. Confirm audio started on its own, confirm the built-in label, and speak a synthetic test sentence during
   capture. Check transcript or actionable error, then Stop. Test permission denial.
4. Enter the printed private Wi-Fi origin, consent, create QR and scan with the
   installed iPhone app. Complete both iPhone toggles for HTTP, then Connect.
5. Start local recording, wait briefly, Stop and open the downloaded WebM. Verify
   no `/recording` or `/speedtest` request was made. Check a full minute's segment too.

## Xcode diagnostics

Unsigned physical-iOS build passed. Current generated project targets both iPhone
and iPad while its plist declares portrait only, producing an orientation warning.
The checked-in generator template is iPhone-only. User signing/project settings
were preserved rather than regenerated. Sandbox checks also reported inaccessible
simulator services and cached provisioning-profile diagnostics; these are not proof
that the successfully sideloaded app's signing is broken. No AppIntents metadata is
expected because the app has no AppShortcuts.

## Automated verification for this repair

Recording follow-up: Electron now provides an explicit, cancel-first screen chooser
for click-initiated requests from the trusted main frame. Concurrent requests and
navigation during selection are denied. No system audio is granted. The desktop
must be rebuilt; refreshing Vite cannot update its main process. The separate
`apps/desktop/out-recording-fix/mac/ExamGuard.app` development package is
unsigned. The integrity/desktop targeted suite passed 63 tests, then the added
concurrency test passed with all 9 desktop tests. Desktop and web builds passed;
screen capture and downloaded-file playback still require user validation.

86 tests passed with:

```sh
npx vitest run --config vitest.config.ts apps/web/src/features/integrity apps/web/src/features/exam/api.test.ts apps/web/src/features/exam/StudentExamPage.render.test.tsx apps/api/src/modules/exam/exam.test.ts apps/api/src/modules/integrity/whisper.test.ts apps/api/src/modules/integrity/integrityService.test.ts
npm run typecheck --workspace @examguard/api
npm run build --workspace @examguard/web
git diff --check
```

API typecheck, web build and diff check passed. The full web typecheck still reports
pre-existing errors in the similarity dashboard contract, keystroke violation type,
MediaPipe internal-module declarations and watermark indexing. The production build
retains MediaPipe WASM/externalized-module warnings. No browser/hardware acceptance
was performed on the user's behalf; the manual checks above remain necessary.
