# iPhone presence companion

## Goal and scope

The iPhone app **Exam Companion** proves only one thing: the student's phone is
on the desk with the app open. It pings the laptop every two seconds while its
iOS scene is active. The laptop pauses new answer changes when the pings stop.
This is **cooperative presence**, not device attestation, phone lockdown,
identity verification, or proof of cheating. The phone collects and sends no
camera, microphone, screen, other-app, location, or input data. (An earlier
optional iPhone desk camera was removed; the camera is used only to scan the
pairing QR code.)

Hardware target: iPhone XR on iOS 18.3 and every newer iPhone. Minimum
deployment target is iOS 16. iPhone only, portrait, full screen.

## Student setup: two steps

1. **Install Exam Companion** on the iPhone (see Install options below).
2. **Scan the QR code** shown in the exam's iPhone step on the laptop.

That's all. Opening the app while unpaired goes straight to the QR scanner; the
code is claimed as soon as it is read. Scanning with the system Camera app or
tapping the `examcompanion://pair?...` link also works. The app shows
"Connecting to laptop…" and gives up after 5 seconds with **Try again** and
**Scan again** buttons, so a wrong network never leaves it spinning.

Once paired, a calm full-screen view says **Paired with your laptop** and asks the
student to keep the app open and put the phone face-down on the desk. It shows a
live status:

| Status                        | Meaning                                                                       |
| ----------------------------- | ----------------------------------------------------------------------------- |
| Connected to your laptop      | The last heartbeat was acknowledged.                                          |
| Reconnecting…                 | A heartbeat failed (Wi-Fi blip); it retries every 2 s automatically.          |
| Your laptop isn't responding… | No acknowledgement for 8 s (the laptop has paused answering); still retrying. |
| Paused: open this app again…  | The app is not active (Home, lock, app switcher).                             |

The screen stays awake (`isIdleTimerDisabled`) only while the app is active and
paired or connecting. If the laptop ends the pairing (new QR, exam finished), the
app returns to the scanner and says so. **Unpair** (with a confirmation) does the
same on purpose.

If the camera is unavailable (Simulator) or camera access is denied, the scanner
is replaced by "Camera unavailable — paste link" (or a Settings shortcut) and a
field for the pairing link.

## Behavior contract

- The laptop turns the requirement on per attempt when it shows the pairing QR.
  Closing setup, reloading, or replacing a pairing does not disable it.
- Active app: a fresh challenge/heartbeat cycle about every two seconds, with no
  overlapping requests or queued retry backlog.
- Home, lock, app switcher, Control Center, calls, or another inactive state:
  cancel the foreground task and URLSession requests. No background execution
  mode, audio keepalive, background URLSession, or background task is used.
- Laptop: the answering lease expires eight seconds after challenge issuance.
  A delayed heartbeat cannot earn a fresh eight seconds.
- Returning to the app renews presence and resumes answering. The exam deadline
  keeps running; this feature never extends it.
- **Report only, never blocking:** when the app went to the **background** while
  paired (phone picked up and used, Home pressed, another app opened), the first
  acknowledged heartbeat after returning carries `leftApp: true`. The server logs
  `phone_left_app` (at most once per 30 s). Brief interruptions that only make
  the app inactive (Control Center, a notification banner) are not reported.
- Force-quit discards the in-memory credential; scan a fresh QR to pair again.
- A paused laptop keeps the in-memory answer draft but does not upload it just
  because presence returns. Submission/deadline ends the phone credential's
  authority.

## Integrity timeline

The server writes these transitions to the attempt's integrity log (phone lane):

| Event                | When                                                                     | Severity |
| -------------------- | ------------------------------------------------------------------------ | -------- |
| `iphone_paired`      | The QR code was claimed.                                                 | info     |
| `iphone_lost`        | The lease ran out (logged once per outage, stamped at the lease expiry). | notice   |
| `iphone_reconnected` | The first accepted heartbeat after a loss.                               | info     |
| `phone_left_app`     | A heartbeat carried `leftApp: true`.                                     | notice   |

A loss is noticed when the laptop polls presence or, at the latest, by the next
heartbeat. Lease state is memory-only, so an API restart does not produce a
`lost` entry. These are leads for a human reviewer: a dead battery, a locked
phone or a Wi-Fi drop look the same as walking away.

## Supported devices and install options

- iPhone XR and newer (A12 Bionic or later), iOS 16.0+. The XR tops out at
  iOS 18. No API newer than iOS 16 is used unguarded (`onChange` has an
  `#available(iOS 17)` branch). The QR scanner uses a 640x480 session with a
  QR-only `AVCaptureMetadataOutput`.
- **Xcode to your own iPhone, free Apple ID:** works with a personal team. The
  signed app expires after 7 days and must be re-installed from Xcode. Enable
  Developer Mode on the phone.
- **TestFlight:** needs a paid Apple Developer Program account to upload
  builds; testers then install without a Mac.

## Permissions

- **Camera:** "Used only to scan the pairing QR code from your laptop". Asked
  the first time the scanner opens. Frames are never stored or sent.
- **Local Network:** on first connection iOS asks to "find and connect to
  devices on your local network". Students must tap **Allow**. If the alert
  pauses pairing, the app resumes connecting when it becomes active again; a
  credential-free probe runs before the single-use code is claimed. If they tap
  Don't Allow, fix it in Settings > Privacy & Security > Local Network. No
  Bonjour, so no `NSBonjourServices` key.

ATS: the plist sets only `NSAllowsLocalNetworking`, which exempts LAN IPs and
`.local` hosts from the HTTPS requirement. Internet hosts stay HTTPS-only, and
Release builds also refuse `http://` pairing links in code (only Debug allows
HTTP, and only to private IPv4 addresses). Release pairing therefore needs an
HTTPS laptop origin. Even on trusted Wi-Fi, HTTP exposes pairing credentials to
anyone able to intercept traffic; use synthetic accounts/data only. Native
pairing redirects are rejected so a credential is never forwarded elsewhere.

## Build and install on the real phone

```sh
cd apps/ios
xcodegen generate --spec project.yml
```

Open `apps/ios/ExamCompanion.xcodeproj` in Xcode, connect the iPhone by USB,
choose your own development team under **Signing & Capabilities**, select the
phone and press Run. The generated project/plist and signing choices are
ignored by Git; `project.yml` and the Swift sources are the reproducible inputs.

## Pairing on your Wi-Fi (developer setup)

1. Run `EXAM_LAN=1 npm run dev` from the repository root and leave it open.
   Native presence does not need Gemini keys.
2. Open an active exam on the laptop and go to its iPhone step, which shows the
   pairing QR for the printed Wi-Fi origin (such as `http://192.168.1.8:5173`).
3. Open Exam Companion and point it at the QR (or scan with the Camera app).

The iPhone still needs a reachable laptop address. This app does not solve Wi-Fi
client isolation or host firewall rules.

Reliability: only a definite server rejection (401/403/404/410) discards the
pending QR or credential. Timeouts, offline errors and 5xx during the claim are
retried every second inside the 5 s connect budget. Heartbeats run on a fixed
2 s schedule. Credentials are stored in the database (an API restart does not
invalidate them) and claim codes are single-use, so a single 401/403 in the
heartbeat loop gets exactly one fresh challenge; a second consecutive rejection
returns to the scanner.

## Protocol and safety boundaries

`PhonePresenceService` is independent of the Gemini integrity service. The
`phone_presence` row persists the per-attempt requirement and hashed
credentials. It contains no heartbeat history or device identifiers.

| Endpoint                                 | Authorization and behavior                                                                                                                                        |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /exam/attempts/:id/phone-presence` | Student session, CSRF, ownership, active attempt. Replace pairing with a single-use QR code expiring in at most two minutes.                                      |
| `GET /exam/attempts/:id/phone-presence`  | Student session and ownership. Returns `{required, active, remainingMs, heartbeatIntervalMs, timeoutMs}`, never credentials.                                      |
| `POST /exam/phone-presence/claim`        | Consume the QR code once; return a separate attempt-scoped credential to the phone.                                                                               |
| `POST /exam/phone-presence/challenge`    | Credential only; issue one outstanding four-second challenge and the next sequence.                                                                               |
| `POST /exam/phone-presence/heartbeat`    | Credential, unused/unexpired challenge, increasing sequence, `active: true`, optional boolean `leftApp`. Extends the lease to challenge issuance + eight seconds. |
| `POST /exam/phone-presence/desk-camera`  | **Retired: always 410 Gone.** Older app builds ignore the failure.                                                                                                |

The phone cannot upload evidence photos: `POST /exam/attempts/:id/evidence`
accepts only the laptop's `webcam` and `screen` sources with a student session.
Snapshots stored by older desk-camera builds (`desk_camera`) stay readable.

Leases and outstanding challenges are memory-only: restarting the API loses
current presence but not the requirement; the phone recovers with a new
challenge. Replacing pairing invalidates the old credential and lease. Expired
or completed attempts reject phone operations.

The service checks presence **inside** the answer-write transaction, so direct
answer API calls cannot bypass the UI pause. A credential holder can still write
a client that emulates foreground pings; the protocol does not establish that
only our binary is running or that the student cannot use another phone.

## Validation

```sh
npx vitest run --config vitest.config.ts apps/api/src/modules/exam apps/api/src/modules/integrity scripts/phone-lab-lib.test.ts
cd apps/ios
swift test
xcodegen generate --spec project.yml
xcodebuild test -project ExamCompanion.xcodeproj -scheme ExamCompanion -destination 'id=<simulator id>'
xcodebuild -project ExamCompanion.xcodeproj -scheme ExamCompanion -configuration Debug -sdk iphoneos -destination 'generic/platform=iOS' -derivedDataPath /tmp/exam-companion-build CODE_SIGNING_ALLOWED=NO build
```

`swift test` runs the pure policy tests on the Mac. The Simulator UI tests use
the DEBUG-only in-app mock laptop (`-UITestMockLaptop YES`, no network) and cover:
launch unpaired opens the scanner ("Camera unavailable — paste link" in the
Simulator), an invalid link, the 5 s connect timeout with retry, pairing through
an `examcompanion://` deep link, a laptop outage (`-UITestMockOutage YES`) showing
"Your laptop isn't responding" then reconnecting, background/foreground sending
`leftApp`, and unpairing. Set `SCREENSHOT_DIR` (as `TEST_RUNNER_SCREENSHOT_DIR`)
to save screenshots. An unsigned generic build checks arm64 compilation only.

Manual check on a real iPhone with synthetic data:

1. Open the app: the scanner appears. Scan the laptop QR: "Paired with your
   laptop" appears and answering is enabled.
2. Go Home for over 8 s: the laptop pauses; the timeline shows `iphone_lost`.
   Return: answering resumes; `iphone_reconnected` and `phone_left_app` appear.
3. Lock the phone and unlock it: the same pause and recovery.
4. Turn Wi-Fi off for 10 s: "Your laptop isn't responding"; back on, it
   reconnects by itself.
5. Show a new QR on the laptop: the old pairing ends and the app asks for a scan.

## Real iPhone lab test

```sh
npm run phone:lab
```

Starts an isolated lab (API on :3600, web on :5773, throwaway database, cloud
keys off) on your Wi-Fi address, signs in as the demo student, starts the exam,
prints a pairing QR, and streams the instructor's timeline every 2 seconds
(laptop evidence JPEGs are saved under `lab-output/<timestamp>/`). Press `r` for
a new QR and Ctrl+C to stop. Scan the QR with Exam Companion and walk through the
manual check above; each transition prints a `phone` line.

`npm run phone:lab -- --auto` plays the phone itself: claim, three heartbeats,
a check that the retired desk-camera route answers 410, a simulated loss (no
heartbeats for 9.5 s), then a reconnect that reports `leftApp`. It verifies the
timeline shows `iphone_paired`, `iphone_lost`, `iphone_reconnected` and
`phone_left_app`, prints PASS/FAIL per check and exits non-zero on any failure.
