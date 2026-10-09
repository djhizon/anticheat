# Foreground-only iPhone companion

## Goal and scope

Keep the companion active on the exam phone. The app pings only while its iOS
scene is active and interactive. The laptop pauses new answer changes when
presence expires. This pack is **cooperative presence**, not device attestation,
phone lockdown, identity verification, or proof of cheating. No phone audio,
video, other-app contents, location, or input activity is collected.

The initial hardware target is iPhone XR / iOS 18.3.2. Minimum deployment target
is iOS 16. Xcode's generic **iphoneos** build checks compilation for physical
devices; it is not evidence of execution on the XR. Do not use simulators for
manual acceptance of this workflow.

## Behavior contract

- Opt in per attempt using **Require iPhone**. Creating a pairing immediately
  enables a persistent requirement; closing setup, reloading, or replacing a
  pairing does not disable it. Existing non-enrolled attempts are unaffected.
- Active app: send a fresh challenge/heartbeat cycle approximately every two
  seconds, with no overlapping requests or queued retry backlog.
- Home, lock, app switcher, Control Center, calls, or another inactive state:
  cancel the foreground task and URLSession requests. No background execution
  mode, audio keepalive, background URLSession, or background task is used.
- Laptop: expire the answering lease eight seconds after challenge issuance.
  Server receipt time cannot give an old, delayed heartbeat a fresh eight
  seconds. Network delay and laptop polling can affect when the warning is
  visible. A previously accepted request cannot be retracted on exit.
- Returning to the app renews presence and resumes answering. The original
  exam deadline continues; this feature does not extend it.
- Force-quit or **Stop and forget pairing** discards the in-memory credential.
  Use **Replace iPhone pairing** and scan a new QR to reconnect.
- A paused laptop retains the in-memory answer draft, but does not automatically
  upload it just because presence returns. Use **Save retained draft** or keep
  editing to save the current snapshot. Reloading can lose unsaved drafts.
- **Submit last saved answers only** remains available while paused, with an
  explicit warning that unsaved drafts are excluded. No new answer changes are
  accepted without presence. Submission/deadline ends the phone credential's
  authority. Successful answer idempotency replays remain available.

## Build and install on the real phone

From the repository root:

```sh
cd apps/ios
xcodegen generate --spec project.yml
```

Open `apps/ios/ExamCompanion.xcodeproj` in Xcode. Connect the XR by USB, unlock it,
and approve **Trust This Computer** on the phone if prompted. In the app target's
**Signing & Capabilities**, choose your own development team. Select the XR as
the run destination. Enable Developer Mode on the iPhone if Xcode requests it,
then press Run. Do not select a simulator or share account credentials/passcodes.
Signing/provisioning and device approvals cannot be replaced by an unsigned build.

The generated project/plist and personal signing choices are ignored by Git;
`project.yml` and Swift sources are the reproducible inputs. No distribution,
App Store upload, paid purchase, or provisioning change is automated here.

## Pairing on your Wi-Fi

1. Stop any old development server and run `EXAM_LAN=1 npm run dev` from the
   repository root. Leave that terminal open. Native presence does not require
   Gemini keys. The API applies additive migration `0005_phone_presence` on
   startup; it does not reset existing exams.
2. Open an active exam on the laptop. Select **Require iPhone**, paste the
   printed Wi-Fi origin (such as `http://192.168.1.8:5173`), read the notice, and
   enable the requirement.
3. Scan the QR using the iPhone's built-in Camera app. It opens the installed
   companion through `examcompanion://pair`. Alternatively, use the manual
   pairing link; keep it private. A browser-only companion cannot satisfy the
   native requirement through the legacy heartbeat endpoint.
4. Confirm the laptop address in the iPhone app. Accept the foreground-check
   notice and, for HTTP Debug demos, the unencrypted trusted-Wi-Fi warning.
   Tap **Connect to laptop** and allow **Local Network** access when requested.
   If that permission alert pauses the app, tap Connect again after allowing it.
   A credential-free probe runs before consuming the single-use QR code.
5. Keep the app on screen. It disables automatic idle sleep only while paired
   and active; it restores the normal idle timer when inactive/stopped.

Only Debug builds accept plain HTTP, and only for private IPv4 addresses.
Release pairing requires HTTPS; TLS validation is never disabled. Even on
trusted Wi-Fi, HTTP exposes pairing credentials to anyone able to intercept
traffic. Use synthetic accounts/data only. HTTPS is separate setup, not a claim
made by this demo. App Transport Security declares local networking intent;
no arbitrary-load or invalid-certificate bypass is included.

The iPhone still needs a reachable laptop address. This app does not solve Wi-Fi
client isolation or host firewall rules and does not install Tailscale or VPNs.

## Optional desk camera (on-device Vision)

After pairing, the iPhone app offers a **Desk camera (optional)** toggle. It is
off by default, per session, and is forgotten on **Stop and forget pairing**.

Setup:

1. Build and install with Xcode on a **physical iPhone**. The simulator has no
   camera, so the toggle only reports "Rear camera is unavailable" there.
2. Pair as above, then switch on **Desk camera** and allow Camera access.
3. Stand the phone upright to the side of the desk so the rear camera sees the
   keyboard (inside the dashed guide box) and the screen. A live preview is
   shown on the phone only.
4. Turn it off in the app at any time. Heartbeat/presence behaviour is
   unchanged whether it is on or off. It stops whenever the app is inactive.

How it works: AVFoundation captures the rear wide camera at about 5 fps; one
frame every ~2 s is analysed on the phone with Apple Vision.
`VNDetectHumanRectanglesRequest` counts people and `VNDetectHumanHandPoseRequest`
checks whether hand landmarks fall in the lower-middle "keyboard" region. Framing
is "OK" when a person fills a reasonable part of the view. No second-phone check
exists: Vision has no built-in phone detector (`VNRecognizeAnimalsRequest` only
finds cats and dogs), so it is skipped. Frames are never stored or transmitted.
Only `{people, handsVisible, framingOk}` is sent, at most every 5 s.

API: `POST /exam/phone-presence/desk-camera` with
`{credential, people, handsVisible, framingOk}`. It uses the same credential and
attempt/expiry checks as the heartbeat but does not extend the presence lease.
`people` must be an integer 0..20; reports closer than 2 s apart get 409. State
is memory-only; no report for 15 s means "off". Notable changes are stored as
`app_events` rows (`flag:desk_camera_extra_person` when 2+ people appear,
`flag:desk_camera_left_frame` when the person disappears), at most one of each
per 30 s, and show in the transparency report as "Flagged behaviour: ...".
`GET /exam/attempts/:id/phone-presence` additionally returns
`deskCamera: {on, framingOk, people, handsVisible}`. These are leads for a human
reviewer, not verdicts; lighting and camera angle cause false alarms.

## Protocol and safety boundaries

`PhonePresenceService` is independent of the legacy Gemini integrity service.
The `phone_presence` row persists the per-attempt requirement and hashed
credentials. It contains no heartbeat history or device identifiers.

| Endpoint                                 | Authorization and behavior                                                                                                          |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `POST /exam/attempts/:id/phone-presence` | Student session, CSRF, ownership, active attempt. Replace pairing with a single-use QR code expiring in at most two minutes.        |
| `GET /exam/attempts/:id/phone-presence`  | Student session and ownership. Returns required/active/remaining lease, never credentials.                                          |
| `POST /exam/phone-presence/claim`        | Consume QR code once; return a separate attempt-scoped credential to the phone.                                                     |
| `POST /exam/phone-presence/challenge`    | Credential only; issue one outstanding four-second challenge and next sequence.                                                     |
| `POST /exam/phone-presence/desk-camera`  | Same credential rules as heartbeat. Flags only, optional, rate limited; never extends the lease.                                    |
| `POST /exam/phone-presence/heartbeat`    | Credential, unused/unexpired challenge, increasing sequence, active claim. Extend lease only to challenge issuance + eight seconds. |

Leases and outstanding challenges are memory-only: restarting the API loses
current presence but not the requirement. The phone obtains a new challenge
while foreground to recover. Replacing pairing invalidates the old credential
and lease. Expired/completed attempts reject phone operations. Logout alone does
not revoke a still-active attempt's pairing; the student must still authenticate
again to answer. Stop/forget, timeout, replacement, submission, and deadline
semantics are distinct; do not describe this as logout revocation.

The service checks presence **inside** the answer-write transaction after
idempotency lookup, so direct answer API calls cannot bypass the UI pause. A
credential holder can still write a client that emulates foreground claims.
The protocol does not establish that only our binary is running or that the
student cannot use another phone. Native HTTPS pairing redirects are rejected
to avoid forwarding credentials to a different origin.

## Validation and manual acceptance

Automated checks:

```sh
npx vitest run --config vitest.config.ts apps/api/src/modules/exam/exam.test.ts apps/api/src/db/migrate.test.ts apps/web/src/features/integrity/nativePhoneUrl.test.ts apps/web/src/features/integrity/usePhonePresence.test.tsx apps/web/src/features/exam/api.test.ts apps/web/src/features/exam/StudentExamPage.render.test.tsx
npm run typecheck --workspace @exam-anti-cheat/api
npm run build --workspace @exam-anti-cheat/web
cd apps/ios
swift test
xcodegen generate --spec project.yml
xcodebuild -project ExamCompanion.xcodeproj -scheme ExamCompanion -configuration Debug -sdk iphoneos -destination 'generic/platform=iOS' -derivedDataPath /tmp/exam-companion-build CODE_SIGNING_ALLOWED=NO build
```

Swift package tests exercise pure policy/parsing on the Mac, not a simulator.
The unsigned build cannot be installed as-is. Existing unrelated web typecheck
errors and MediaPipe build warnings remain outside this pack.

On the XR, check each case with synthetic data:

1. Pair, keep the app open, and verify laptop answering is enabled.
2. Go Home. After the lease expires, verify controls are disabled and typing
   cannot save. Do not expect an instantaneous warning.
3. Return to the app. Verify fresh acknowledgement resumes answering and the
   retained draft is not silently uploaded until you save/edit it.
4. Lock the phone; unlock and return. Verify the same timeout/recovery.
5. Force-quit. Verify timeout; relaunch and verify re-pairing is required.
6. Disable Wi-Fi. Verify connection-loss status and laptop pause; reconnect to
   recover. Keep cellular behavior/network routing in mind when testing.
7. Reload the laptop while disconnected. The requirement must remain enabled.
8. Replace pairing. Verify the old credential/app session no longer renews it.
9. Submit the last saved answers while paused. Verify no unsaved draft was
   included and subsequent phone renewal is rejected.

Use ordinary phone gestures yourself. Browser/phone clicking is intentionally
left to the user; no hardware test result should be inferred from unit tests.
