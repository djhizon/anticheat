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

## Supported devices

- iPhone XR and every newer iPhone (A12 Bionic or later). iPhone only; iPad is
  not a target (`TARGETED_DEVICE_FAMILY = 1`), portrait, full screen.
- iOS 16.0 or later. The XR tops out at iOS 18 and never receives iOS 26, so the
  deployment target is 16.0 and no API newer than iOS 16 is used unguarded
  (`onChange` uses an `#available(iOS 17)` branch with an iOS 16 fallback).
- Desk camera: capture is limited to 640x480 at 5 fps; Vision runs on a
  background queue on about 2 frames per second (heavier checks every 2 seconds).

## Install options

- **Xcode to your own iPhone, free Apple ID:** works with a personal team. The
  signed app expires after 7 days and must be re-installed from Xcode; limited
  to a few apps per Apple ID. Enable Developer Mode on the phone.
- **TestFlight:** requires a paid Apple Developer Program account (USD 99/year)
  to upload builds; testers then install without a Mac.

## Local Network permission

On first connection iOS shows: "Exam Companion would like to find and connect to
devices on your local network" with the app's explanation (connect to your exam
laptop on Wi-Fi to send foreground-only presence checks). Students must tap
**Allow**. If they tap Don't Allow, pairing fails silently; fix it in
Settings > Privacy & Security > Local Network (or Settings > Exam Companion).
The app does not use Bonjour, so no `NSBonjourServices` key is declared. The
camera prompt appears only if the optional desk camera is switched on.

ATS: the plist sets only `NSAllowsLocalNetworking`, which exempts LAN IPs and
`.local` hosts from the HTTPS requirement, so a laptop at `http://192.168.x.x`
can be reached. Internet hosts stay HTTPS-only, and Release builds also refuse
`http://` pairing links in code (only Debug allows the HTTP demo flow); Release
pairing therefore needs an HTTPS laptop origin.

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
5. Keep the app on screen. It disables automatic idle sleep only while active
   with a pairing or credential (paired or reconnecting); it restores the
   normal idle timer when inactive/stopped.

Reliability behavior: only a definite server rejection (401/403/404/410) clears
the pending QR or credential and asks for a new scan. Timeouts, offline errors,
and 5xx during the pairing probe/claim show "Reconnecting…" and retry up to 5
tries (1 s, 2 s, 4 s, 4 s backoff) while keeping the QR; if all fail, the QR is
kept and the user can tap Connect again. Heartbeats run on a fixed 2 s schedule
(sleep = 2 s minus the cycle's elapsed time). Credentials are stored in the
database, so an API restart does not invalidate them and claim codes are
single-use (re-claim is impossible); a single 401/403 on the heartbeat loop
therefore gets exactly one fresh challenge attempt, and a second consecutive
rejection unpairs.

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

How it works: AVFoundation captures the rear wide camera at 640x480 and about 5 fps;
about 2 frames per second are analysed on a background queue with Apple Vision (no
third-party models, no downloads):

| Flag (sent)                                          | Vision request                                                                                | Rule                                                                                                                                   |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `extraPerson`                                        | `VNDetectHumanRectanglesRequest` + `VNDetectFaceRectanglesRequest`                            | max(people, faces) >= 2 held for 1.5 s                                                                                                 |
| `extraHands`, `handCount`, `leftHands`, `rightHands` | `VNDetectHumanHandPoseRequest` (max 4 hands, chirality)                                       | more than 2 hands held for 1 s                                                                                                         |
| `textVisible`                                        | `VNRecognizeTextRequest` (fast) on the lower desk region                                      | 2+ lines of 4+ characters, or 20+ characters, on two checks 2 s apart. Only the amount of text is used; the text is never kept or sent |
| `objectHints`                                        | `VNDetectRectanglesRequest` (bright rectangles in the desk area) and `VNClassifyImageRequest` | names only from `cellphone`, `paper`, `book`, `bright_rectangle`; classifier confidence >= 0.3; held 2 s                               |
| `cameraObstructed`                                   | mean luminance + variance of a 32x32 grid                                                     | very dark or almost featureless for 2 s                                                                                                |
| `people`, `handsVisible`, `framingOk`                | as before                                                                                     | `people` is the max over the last 3 s                                                                                                  |

The text/object checks (heavier) run about every 2 s, the others at about 2 fps.
Your own monitor's text is outside the desk region and ignored, but a keyboard with
printed keys, a book you are allowed to have, or a poster can still trigger leads.

Evidence still: when `extraPerson` (trigger `extra_person`), `cameraObstructed`
(`left_frame`) or a `cellphone` hint (`phone_detected`) first fires, the phone sends
ONE JPEG (max 640 px wide, quality about 0.6, normally under 150 KB) to
`POST /exam/attempts/:attemptId/evidence` with
`{source: 'desk_camera', trigger, capturedAt, imageJpegBase64, credential}`. At most one
per trigger per 30 s and 20 per pairing. A missing route (404) or any failure is logged
on the phone and dropped. There is no video. `extraHands` and `textVisible` have no
server trigger yet, so they are flags only (no still). Frames are otherwise never
stored or transmitted. Flags and counts are sent at most every 5 s (or 2.5 s after a flag changes).

API: `POST /exam/phone-presence/desk-camera` with
`{credential, people, handsVisible, framingOk}` plus the optional fields `extraPerson,
extraHands, handCount, leftHands, rightHands, textVisible, objectHints, cameraObstructed`
(old phones omit them; an old phone's `people >= 2` still counts as an extra person; invalid
values get 400, `objectHints` must come from the allowlist). The `claim` response also returns
`attemptId` so the phone can address evidence stills. It uses the same credential and
attempt/expiry checks as the heartbeat but does not extend the presence lease.
`people` must be an integer 0..20; reports closer than 2 s apart get 409. State
is memory-only; no report for 15 s means "off". Notable changes are stored as
`app_events` rows (`flag:desk_camera_extra_person`, `_left_frame`, `_extra_hands`,
`_text_visible`, `_obstructed`, `_object_<hint>`), at most one of each
per 30 s, and show in the transparency report as "Flagged behaviour: ...".
`GET /exam/attempts/:id/phone-presence` additionally returns
`deskCamera: {on, framingOk, people, handsVisible, extraPerson, extraHands, handCount, leftHands, rightHands, textVisible, objectHints, cameraObstructed}`. These are leads for a human
reviewer, not verdicts; lighting and camera angle cause false alarms.

Desk-camera flags are cooperative signals: they are authenticated only by the
pairing credential, so whoever holds that credential can send, forge or withhold
them. Treat them as hints, never proof. Desk state and flag cooldowns are
dropped when the attempt ends or after 10 minutes without a report, so server
memory stays bounded.

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
npm run typecheck --workspace @examguard/api
npm run build --workspace @examguard/web
cd apps/ios
swift test
xcodegen generate --spec project.yml
xcodebuild -project ExamCompanion.xcodeproj -scheme ExamCompanion -configuration Debug -sdk iphoneos -destination 'generic/platform=iOS' -derivedDataPath /tmp/exam-companion-build CODE_SIGNING_ALLOWED=NO build
```

Swift package tests exercise pure policy/parsing on the Mac, not a simulator.
The unsigned build cannot be installed as-is. Existing unrelated web typecheck
errors and MediaPipe build warnings remain outside this pack.

Optional Simulator UI smoke test (developer check only, not acceptance; it
covers the unpaired state, an invalid link, an unreachable host and the "camera
unavailable" message, never presence timing or the camera):

```sh
cd apps/ios
xcodegen generate --spec project.yml
xcodebuild test -project ExamCompanion.xcodeproj -scheme ExamCompanion -destination 'platform=iOS Simulator,name=iPhone SE (3rd generation)' CODE_SIGNING_ALLOWED=NO
```

Set `TEST_RUNNER_SCREENSHOT_DIR=<dir>` to save screenshots. The paired
desk-camera test is skipped unless `TEST_RUNNER_MOCK_ORIGIN` is set to a mock
laptop origin on a private IPv4 address (the app rejects loopback origins).

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

## Real iPhone lab test

One command runs an isolated lab (API on :3600, web on :5773, throwaway database,
cloud keys off) on your Wi-Fi address and watches the result live:

```sh
npm run phone:lab
```

It seeds the demo data, signs in as the demo student, starts the exam attempt,
prints a pairing QR plus the private link, and then prints the instructor's view
of that attempt every 2 seconds. Evidence JPEGs are saved under
`lab-output/<timestamp>/` (git-ignored). Press `r` for a new QR (it expires after
2 minutes) and Ctrl+C to stop everything. Use trusted Wi-Fi only.

1. Scan the QR with the iPhone XR Camera app, confirm the address, tap
   **Connect to laptop**, and allow Local Network access.
2. In the app, switch on **Desk camera** and allow Camera access.
3. Follow the placement guide: stand the phone to the side so the rear camera sees
   the keyboard (inside the dashed box) and the screen.
4. Optionally open the printed `http://localhost:5773/` URL on the Mac and sign in
   as the student to see the laptop side. Using **Require iPhone** there replaces
   the terminal's pairing.
5. Run the checklist below. Desk-camera notes are rate limited (one of each kind
   per 30 s), so wait about 30 s between actions.

| Action                                         | Expect in the terminal                                                                                                       |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Pair and sit still, hands on keyboard          | `attempt_started`, then a `phone` line `iphone_paired`. No flags.                                                            |
| A second person or face steps into the view    | `phone  desk_extra_person` (notice). An `extra_person` snapshot line if evidence is enabled on this build.                   |
| Extra hands at the keyboard                    | No timeline line by itself (hands are a yes/no value, not a flag). The browser's Require iPhone panel shows the desk status. |
| Paper with text held in view                   | No dedicated check; expect nothing. Note what you see.                                                                       |
| Cover the phone lens (after a person was seen) | `phone  desk_left_frame` (notice), plus a `left_frame` snapshot if evidence is enabled.                                      |
| Hold the phone up to the laptop webcam         | `camera  phone_in_view` from the laptop camera check, only if the Mac browser exam page is open with its camera on.          |
| Take the iPhone app off screen for over 8 s    | The laptop pauses answering; no timeline line is guaranteed. Return to resume.                                               |

These are leads for a human reviewer, not verdicts. Lighting and angle cause
false alarms, and any row that stays silent is a result worth writing down.

### Hands-off check

`npm run phone:lab -- --auto` plays the iPhone's part itself (claim, heartbeat,
desk-camera reports for one person, two people and nobody, and an evidence
snapshot when the build has that endpoint), then checks the instructor timeline,
prints PASS, FAIL or SKIP per check, and exits non-zero on any FAIL. It needs no
phone and is a quick way to confirm the lab works before testing the real XR.

## How to test the desk camera on a real iPhone (XR checklist)

Setup: pair as above, switch on **Desk camera**, prop the phone to the side of your
desk with the keyboard in the dashed box. The line under the preview ("Hands: ...
Extra person: ... Lens blocked: ...") shows the flags live. Wait 2-3 seconds after each
change; flags are debounced. On the laptop the exam report shows the events.

1. **Baseline**: sit alone, both hands on the keyboard. Expect People 1, Hands 2, all
   flags "no", framing OK, no events.
2. **Extra person** (`extraPerson`): have a second person stand or sit beside you, with a face
   visible, for 2+ seconds. Expect "Extra person: yes", a `flag:desk_camera_extra_person`
   event and one still in the report. A photo of a face on a screen can also trigger it.
3. **Extra hands** (`extraHands`): you plus a helper put three hands in view for 1+ second.
   Expect "Extra hands: yes" and a `flag:desk_camera_extra_hands` event (no still).
4. **Text on desk** (`textVisible`): lay a printed page or open notebook with readable
   lines on the desk, in the lower half of the frame, for 4+ seconds. Expect "Text on desk: yes"
   (no still). Text high in the frame (your monitor) is ignored.
5. **Phone / paper / book** (`objectHints`): place a second phone, a white sheet or a book on the
   desk for 4+ seconds. Expect "Objects: ..." (`cellphone`, `paper`, `book`, or
   `bright_rectangle` for a lit screen or white sheet). A cellphone hint also sends a
   `phone_detected` still. Classifier labels are guesses; treat them as leads.
6. **Covered lens** (`cameraObstructed`): cover the back camera with your hand, or switch off the
   room lights, for 2+ seconds. Expect "Lens blocked: yes", an obstructed event and a
   `left_frame` still.
7. **Throttle**: repeating the same trigger within 30 s must not send a second still.
8. Switch the toggle off; the preview stops and the laptop shows the camera as off within 15 s.

Simulator (no camera): the Debug build has test hooks `-UITestMockLaptop YES` (the app answers
its own requests in-process) and `-UITestFixtureFrames <one_person|two_people|extra_hands|paper_text|bright_paper|dark|empty_desk>`.
Frames are drawn in code and go through the real Vision, flag, aggregation and JPEG
code. Vision cannot detect people/hands in drawings, so the `one_person`, `two_people` and
`extra_hands` fixtures inject those counts in place of Vision's detections; the text and dark
fixtures are detected for real.

```sh
cd apps/ios && xcodegen generate --spec project.yml
xcodebuild test -project ExamCompanion.xcodeproj -scheme ExamCompanion -destination 'id=<simulator id>' CODE_SIGNING_ALLOWED=NO
```
