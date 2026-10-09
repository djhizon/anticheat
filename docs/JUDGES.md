# Judge install guide (macOS)

Exam Anti-Cheat ships as an unsigned macOS disk image. Everything runs locally on your Mac; no
account with us and no internet connection is needed to try it.

## Requirements

- macOS 13 (Ventura) or newer.
- Intel Mac for now. The Intel (x86_64) build also runs on Apple-silicon Macs through Rosetta 2.
  A native Apple-silicon build is planned but not available yet.
- Ports 3000 and 5173 on 127.0.0.1 must be free (close any development server first).

## Install

1. Download `Exam Anti-Cheat-0.1.0.dmg` and open it.
2. Drag **Exam Anti-Cheat** onto the **Applications** folder. Do this before the first launch;
   running it from the disk image or Downloads breaks the Gatekeeper steps below.
3. Eject the disk image, then open the app from Applications.

## First launch: Gatekeeper (the app is not notarized)

The app is ad-hoc signed but has no Apple Developer ID, so macOS blocks the first launch.

**macOS 13 and 14**

1. In Applications, right-click (or Control-click) **Exam Anti-Cheat** and choose **Open**.
2. In the dialog, click **Open**. You only need to do this once.

**macOS 15 and newer** (the right-click shortcut no longer bypasses the check)

1. Open the app once and dismiss the "cannot be opened" dialog (click **Done**).
2. Open **System Settings > Privacy & Security**, scroll to the Security section, and click
   **Open Anyway** next to "Exam Anti-Cheat".
3. Confirm with your password or Touch ID, then click **Open**.

**Fallback (any version):** remove the quarantine flag in Terminal, then open the app normally.

```sh
xattr -dr com.apple.quarantine "/Applications/Exam Anti-Cheat.app"
```

## Permissions macOS will ask for

- **Camera**: identity and presence checks during an exam.
- **Microphone**: audio monitoring of the testing environment.
- **Screen Recording**: only if you choose to start screen recording; it is not requested otherwise.

Video and audio are processed locally on your machine. If you decline, the rest of the app still
opens, but the related checks cannot run.

Speech transcription needs the optional whisper/ffmpeg components, which are not bundled in this
build. The app launches normally and shows transcription as unavailable.

## Demo mode

The app starts in **Demo mode**: nothing is closed, blocked, or quit, so you can look around
safely. The mode can be changed from the app menu.

## Demo accounts

| Role       | Email                          | Password                         |
| ---------- | ------------------------------ | -------------------------------- |
| Student    | `demo.student@example.test`    | `Demo exam password 2026!`       |
| Instructor | `demo.instructor@example.test` | `Demo instructor password 2026!` |
| Classmates | `classmate1..4@example.test`   | `Demo classmate password 2026!`  |

These are the defaults from `apps/api/src/demoSeed.ts`; the app seeds them on its first launch.

## Troubleshooting

- "Port 3000/5173 is already in use": quit whatever is using it and reopen the app.
- Server log: `~/Library/Application Support/@exam-anti-cheat/desktop/logs/api.log`.
