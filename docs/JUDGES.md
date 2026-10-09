# Judge install guide (macOS)

ExamGuard ships as an unsigned macOS disk image. Everything runs locally on your Mac; no
account with us and no internet connection is needed to try it.

## What you'll see

1. Opening the disk image shows a window titled **Install ExamGuard** with the app icon (a
   blue shield with a check mark) next to an **Applications** shortcut. Drag the icon onto it.
2. The first time you open the app, macOS shows a Gatekeeper warning because the app is not
   notarized. Follow the [First launch](#first-launch-gatekeeper-the-app-is-not-notarized) steps
   once; later launches open normally.
3. The app opens with a **Demo mode** banner, confirming that nothing will be closed, blocked, or
   quit while you explore. See [Demo mode](#demo-mode).

## Requirements

- macOS 13 (Ventura) or newer.
- Intel Mac for now. The Intel (x86_64) build also runs on Apple-silicon Macs through Rosetta 2.
  A native Apple-silicon build is planned but not available yet.
- Ports 3000 and 5173 on 127.0.0.1 must be free (close any development server first).

## Install

1. Download `ExamGuard-0.1.0.dmg` and open it.
2. Drag **ExamGuard** onto the **Applications** folder. Do this before the first launch;
   running it from the disk image or Downloads breaks the Gatekeeper steps below.
3. Eject the disk image, then open the app from Applications.

## First launch: Gatekeeper (the app is not notarized)

The app is ad-hoc signed but has no Apple Developer ID, so macOS blocks the first launch.

**macOS 13 and 14**

1. In Applications, right-click (or Control-click) **ExamGuard** and choose **Open**.
2. In the dialog, click **Open**. You only need to do this once.

**macOS 15 and newer** (the right-click shortcut no longer bypasses the check)

1. Open the app once and dismiss the "cannot be opened" dialog (click **Done**).
2. Open **System Settings > Privacy & Security**, scroll to the Security section, and click
   **Open Anyway** next to "ExamGuard".
3. Confirm with your password or Touch ID, then click **Open**.

**Fallback (any version):** remove the quarantine flag in Terminal, then open the app normally.

```sh
xattr -dr com.apple.quarantine "/Applications/ExamGuard.app"
```

## Permissions macOS will ask for

- **Camera**: identity and presence checks during an exam.
- **Microphone**: audio monitoring of the testing environment.
- **Screen Recording**: only if you choose to start screen recording; it is not requested otherwise.

- **Local Network / incoming connections**: only when you pair an iPhone. The app then opens a small
  listener on your Mac's Wi-Fi address (port 3443) that serves only the phone's check-in endpoints
  (everything else returns 404) and closes it when the exam ends or the app quits. macOS may show an
  "allow incoming network connections" prompt: choose **Allow**, and keep the iPhone on the same Wi-Fi.

Video and audio are processed locally on your machine. If you decline, the rest of the app still
opens, but the related checks cannot run.

Speech transcription runs fully on your machine: the app bundles a portable `whisper-cli` and the
quantized English Whisper small model (`ggml-small.en-q5_1`, English-locked, non-speech output filtered), and the web client sends 16 kHz mono WAV clips so no ffmpeg is needed. If the
bundled components are missing, the app still launches and shows transcription as unavailable.

## Demo mode

This judge build starts in **Demo mode**: nothing is closed, blocked, or quit, so you can look
around safely. Demo mode is specific to the judge build; regular builds of the app start in
**Strict mode** instead. You can change the mode from the app menu (**Mode**); switching in either
direction asks for confirmation, and an attempt taken in Demo mode is marked as such in its
transparency report.

While an exam attempt is in progress the window goes full screen and cannot be minimized or closed; leaving focus is recorded in the integrity timeline but never blocked in Demo mode. To leave full screen in Demo mode press **Esc** (or ⌘⇧Q); in Strict mode the only way out mid-exam is the **⌘⇧Q** emergency exit, which asks for confirmation and is recorded.

## Demo accounts

The judge build seeds these demo accounts on its first launch (a few seconds after the window
opens, sign-in works once seeding finishes). Regular builds start Strict and seed no demo or
instructor accounts at all.

| Role       | Email                          | Password                         |
| ---------- | ------------------------------ | -------------------------------- |
| Student    | `demo.student@example.test`    | `Demo exam password 2026!`       |
| Instructor | `demo.instructor@example.test` | `Demo instructor password 2026!` |
| Classmates | `classmate1..4@example.test`   | `Demo classmate password 2026!`  |

These are the defaults from `apps/api/src/demoSeed.ts`.

## Troubleshooting

- "Port 3000/5173 is already in use": quit whatever is using it and reopen the app.
- Server log: `~/Library/Application Support/@examguard/desktop/logs/api.log`.

## Automated tests of the desktop app

`npm run test:electron` (macOS only, not run in CI) rehearses the student flow and the Strict-mode
pre-exam check against two builds, each in a throwaway `--user-data-dir` so no real app data is
touched, with Chromium's fake camera and microphone:

- **dev build** (`apps/desktop/dist`, needs `npm run build:server` and
  `npm run build --workspace @examguard/desktop`): driven by Playwright's Electron driver.
- **packaged app** (`apps/desktop/release/mac/ExamGuard.app`, built by `npm run package:mac`; set
  `EAC_PACKAGED_APP` to point at another binary): the packaged build turns off the Node inspector
  fuse, so Playwright's Electron driver cannot attach. The test starts the binary with
  `--remote-debugging-port=0`, reads the `DevTools listening on ws://…` line from stderr and connects
  over CDP; it quits the app with SIGTERM and checks that the process exited and ports 3000/5173 are
  free again.

Security note: a DevTools endpoint would let any program on the Mac drive the exam window, so only
the **judge build** accepts `--remote-debugging-port` / `--remote-debugging-pipe`. Every other
packaged build refuses to start with those switches (an error dialog explains why; the unpackaged
dev build is unaffected). Chromium opens the endpoint before any app code runs, which is why the
switch is refused rather than stripped. See `refusesRemoteDebugging` in `apps/desktop/src/main.ts`
and its unit test.
