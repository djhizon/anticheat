# Demo kit: 60-second video, 5-minute live demo, 3-minute Q&A

AppBuildersPH 2026, theme **Local AI**. Demo Day gives each team **5 minutes of live demo, then
3 minutes of Q&A**. The submission also needs a **public video of about 1 minute** that a general
audience can follow. This file has all three, plus the pre-stage checklist. Every claim below is
true of `main` today; if you change the product, change the script.

Two ways to run it, both pre-seeded with the same accounts:

- **Mac app** (`ExamGuard.dmg`, judge build, starts in Demo mode): camera hardware check, D-FINE
  wearables, enforced brightness, "View screen recording" and kiosk lockdown are all here. Use it
  for the video and the live demo.
- **Browser** (`npm run demo` opens http://127.0.0.1:5173): the same flow in Chrome, without the
  Mac-only pieces. Use it as the fallback. No Node? `docker compose up --build` (see
  [DOCKER.md](DOCKER.md)).

| Role                            | Email                                                                                            | Password                         |
| ------------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------- |
| Student                         | `demo.student@example.test`                                                                      | `Demo exam password 2026!`       |
| Instructor                      | `demo.instructor@example.test`                                                                   | `Demo instructor password 2026!` |
| Triage demo (already submitted) | `triage.review`, `triage.phone`, `triage.glance`, `triage.clean` (all `@example.test`, no login) | n/a                              |

The four `triage.*` students are synthetic, already-submitted attempts the seed inserts so the
teacher screen has something to triage: two at **review** (`triage.review`: eight glances to one
spot each followed by a jump in the answer, a second voice and a phone sighting; `triage.phone`:
two phone sightings, a long look down while the iPhone dropped off, a second person twice), one
at **glance** (`triage.glance`: two focus losses) and one clean (`triage.clean`).

## Before you go on stage (10 minutes earlier)

- **Fresh data.** Browser: `npm run demo -- --reset` (the old database is backed up, not deleted,
  and the demo student's exam is "Not started" again). Mac app: quit it, move
  `~/Library/Application Support/@examguard/desktop` aside, reopen; the judge build re-seeds the
  demo and `triage.*` accounts a few seconds after the window opens (sign-in works once seeding
  finishes).
- **iPhone.** Install Exam Companion with the phone plugged in and Developer Mode on:
  `npm run ios:device` (builds, installs, launches). Mac and iPhone on the **same Wi-Fi**; on
  first pairing iOS asks for **Local Network** access, tap **Allow**, and macOS may ask to allow
  incoming connections, also **Allow** (the Mac opens a phone-only listener on port 3443 while
  pairing is on). Keep the phone unlocked with the app open until it says "Paired with your
  laptop".
- **Internet-off plan.** The iPhone pings the Mac over the local network, so the Mac and phone
  must stay on one Wi-Fi while the internet goes away. Plan A: a router with its internet (WAN)
  cable unplugged. Plan B: a hotspot with cellular data off, if that phone allows a hotspot
  without data; rehearse this, some phones refuse. Plan C (live demo only): turn the Mac's Wi-Fi
  off for 20 s; the phone shows "Reconnecting…", the laptop logs `iphone_lost` and shows a
  non-blocking banner, answering continues, and the phone reconnects when Wi-Fi returns. Say
  which plan you are showing. [LOCAL_AI.md](LOCAL_AI.md) is explicit that a run with the network
  physically disconnected was not verified at the desk, so **rehearse it the day before**.
- **Warm the machine.** Run setup once so camera, microphone, screen-recording and (Mac app)
  brightness permissions are already granted, Whisper has transcribed one clip and the D-FINE
  model has loaded (about 2 s). Close other apps, Do Not Disturb on, one display only (the
  pre-exam check lists extra displays).
- **Windows.** Window 1: the student, signed in, on the assignment list. Window 2 (browser
  incognito, or the Mac app after the student submits): the instructor on **Who needs a look**.
- **Props.** A phone to hold up to the webcam, a sheet of "notes" beside the screen, a sentence
  copied to the clipboard for the paste beat.
- **Presence spot checks** fire between questions after 2–5 answered items and 4–10 minutes; in a
  5-minute slot you may not see one, so show the one in setup and say the mid-exam ones look the
  same. When running from source you can shorten them for a rehearsal with
  `VITE_PRESENCE_ITEMS=1-1 VITE_PRESENCE_GAP_MINUTES=0.5-1` (build-time variables, not for the
  packaged app). The edge pulse stays at or below 2 colour changes per second (1 under reduced
  motion), a low-opacity band under the WCAG 2.3.1 three-flash limit.
- **Mode.** The judge build starts in **Demo mode** (nothing is quit or blocked; **Esc** leaves
  full screen). Do not switch to Strict on stage unless asked; it needs a confirmation and the only
  way out mid-exam is ⌘⇧Q.

## (a) The 60-second video

One continuous story, shot on the Mac app with a real iPhone. No jargon on screen; the captions
name the techniques for those who care. Target length 58–62 s.

### Shot list

| Time    | Shot                                                                                                                                                                                                                                                                                              | On screen                                                            |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 0–6 s   | **Hook.** Split screen: a student at a kitchen table; a webcam feed being "uploaded" to a cloud icon, then a red X over the cloud.                                                                                                                                                                | Caption: "Online exams: trust everyone, or stream everyone?"         |
| 6–18 s  | **Setup montage** (fast cuts, 2 s each): consent list ticked → camera step "one face in view, Verified hardware camera" → lighting tip → mic meter → "Start screen recording" → QR on the Mac, iPhone scans it, radar rings pulse → the colour-reflection presence check passes → **Start exam**. | Caption: "Every check is agreed to before the clock starts"          |
| 18–24 s | **HERO, part 1: internet off.** Hands pull the router's internet cable (or a Wi-Fi icon shows "no internet"). Cut to the exam: timer running, chips Camera ✓, Mic ✓, iPhone Connected. The iPhone on the desk is still pulsing.                                                                   | Caption: "Internet off. Everything still runs on this Mac"           |
| 24–34 s | **HERO, part 2: a phone and a glance.** The student lifts a phone into view: the camera panel's row flips to "Phone: Detected" and after 2 s an evidence photo is saved (show the thumbnail). Then they glance at notes beside the screen twice; nothing interrupts them.                         | Caption: "A phone, a glance: noticed, photographed, never a verdict" |
| 34–38 s | **Privacy card.** Full-frame caption over a blurred exam.                                                                                                                                                                                                                                         | Caption: "Nothing from the camera or microphone leaves the machine"  |
| 38–50 s | **Teacher triage.** Instructor window, **Who needs a look**: "… no review · 1 glance · 2 review". The top card opens: plain-language reasons, 2–3 photos, a transcript line, the student's note. Press **F**: "✓ Fine", the next card opens.                                                      | Caption: "Teachers see only the attempts that need a look"           |
| 50–56 s | **Student report.** Student window after submit: "What your teacher may look at" lists the same findings; the student types a note under one; "View screen recording" opens the Movies › ExamGuard Recordings folder.                                                                             | Caption: "Students see exactly what the teacher sees"                |
| 56–60 s | **Close.** Logo, repo URL.                                                                                                                                                                                                                                                                        | Caption: "Private by design, works offline. ExamGuard."              |

### Voice-over (about 145 words, plain language)

> Online exams have two bad options: trust everyone, or stream every student's webcam to a
> company in the cloud. ExamGuard does neither.
>
> Before the exam starts, the student agrees to each check, the camera confirms one real face,
> and their iPhone pairs with a QR code. The phone only pings the laptop, so it stays on the desk.
>
> Now watch: the internet is off. Every check still runs, on this laptop. A phone appears, and a
> photo is saved. A glance at notes is noticed, without interrupting anyone. Nothing from the
> camera or microphone ever leaves the machine.
>
> Afterwards, the teacher doesn't watch hours of video. They see only the attempts that need a
> look, with the photos and the student's own explanation, and clear one in seconds. The student
> sees the exact same findings.
>
> Private by design, works offline. ExamGuard.

### Caption strip: show it, or just list it

Sixty seconds cannot show everything. Show what moves; list the rest in one caption so nobody
thinks it was left out.

| Show on screen (it moves, it is obvious)                    | List in a caption only (true, but dull on video)                                                                                                                 |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Consent tick, "one face" camera step, QR pairing with radar | Camera must be real hardware; OBS and other virtual cameras are refused                                                                                          |
| Internet cable out, chips still green, iPhone still pulsing | Speech-to-text by Whisper on the Mac; only the text is kept, never audio                                                                                         |
| Phone lifted → "Phone: Detected" → evidence photo           | Earbuds, headphones and glasses detection (D-FINE, on-device, Mac app)                                                                                           |
| Glance at notes, no interruption                            | Eye-gaze direction that calibrates itself and is never shown to the student                                                                                      |
| Teacher presses F, card clears, next opens                  | Typing and pointer patterns (never the text typed), lighting check, enforced screen brightness, mandatory screen recording                                       |
| Student note under a finding, "View screen recording"       | Retention per exam (30 days by default), media auto-deleted 7 days after "Fine", recordings can be kept on the Mac only, Gemini only for optional teacher checks |

Suggested single caption for the "list" column at 34–38 s, under the privacy line: "Also on-device:
speech-to-text, gaze, earbuds and glasses, typing patterns, lighting. Photos auto-delete 7 days
after a teacher marks an attempt Fine."

## (b) The 5-minute live demo (runs 4:45)

Mac app, Demo mode, iPhone paired. Two windows as in the checklist. Practise with a timer.

| Time      | Beat                                | Do                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Say                                                                                                                                                                                                                                                                                                                                                               |
| --------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0:00–0:15 | **Hook**                            | Student window on the sign-in page or assignment list.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | "Online exams either trust students blindly or stream their webcam to a cloud proctor. ExamGuard runs the AI on the student's own Mac, and the teacher only sees the attempts that need a look."                                                                                                                                                                  |
| 0:15–1:15 | **Setup, step by step**             | Click **Start exam**. Tick the consent list. **Allow camera & microphone**. Camera step: one face in view, "Verified hardware camera" (Mac app). Lighting: show the tip, move on. Microphone: speak, the meter moves. **Start screen recording**: whole screen (windows and tabs are refused). iPhone: scan the QR with Exam Companion, show the radar rings on the phone, put it face-down; the step advances by itself. Identity: the screen flashes three colours, passes. **Start exam**.                                                                                                                                                      | "Eight steps, all before the clock starts, all agreed to. Only a real camera is accepted; OBS is refused. Screen recording and the iPhone are required. The last step reads a random colour sequence off my face, so a video loop can't pass."                                                                                                                    |
| 1:15–1:35 | **Lockdown + answering**            | The window is full screen. Point at the read-only chips (Camera ✓, Mic ✓, iPhone Connected). Type a sentence into a free-text answer; it autosaves.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | "No start, stop or verify buttons during the exam; every check runs by itself until submit. In Strict mode this is a kiosk you can't leave; this is the judge build, so Esc still works."                                                                                                                                                                         |
| 1:35–1:55 | **The cheat: a pasted answer**      | Press ⌘V in the answer box. The toast "Paste is not allowed — please type your answer" appears; nothing is inserted.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | "Paste is blocked and logged. Text that lands all at once by other routes, dictation, a text expander, a script, is noticed too, and becomes a finding only when it happens twice, or once while the pointer was still. One slip is never a case."                                                                                                                |
| 1:55–2:25 | **Internet off, phone, notes**      | Pull the router's internet cable (Plan A) or toggle Wi-Fi (Plan C, say what happens). Hold a phone up to the webcam: the panel row flips to "Phone: Detected"; after 2 s an evidence photo is saved. Put it down. Glance at the notes sheet beside the screen twice. Say one sentence; the live transcript prints it.                                                                                                                                                                                                                                                                                                                              | "The internet is gone and nothing changed: face, gaze, phone, earbuds and glasses detection, speech-to-text, all on this Mac. Nothing from the camera or microphone ever leaves it. One photo is kept when something unusual holds for two seconds."                                                                                                              |
| 2:25–2:45 | **Submit + student report**         | Click **Submit Exam**. Scroll to **What your teacher may look at** and **What monitoring recorded**; open **Full integrity log** and point at `paste_blocked` and the phone photo. Click **View screen recording**: Finder opens Movies › ExamGuard Recordings.                                                                                                                                                                                                                                                                                                                                                                                    | "The student sees the same findings the teacher will see and can add a note under each. The recording is on their Mac; it's uploaded only if the school turns upload on."                                                                                                                                                                                         |
| 2:45–4:30 | **Teacher clears 3 cards in 2 min** | Instructor window, **Who needs a look**: counts "… no review · 1 glance · 2 review", list sorted review first. Card 1 (`triage.review`): read the plain reasons, two photos, the transcript line "what did you put for number four"; click **Play clip** on one window; press **U** (Follow up), type "Ask about the second voice" first if you like. Card 2 (`triage.phone`) opens by itself: phone photos next to the iPhone-lost moment; press **F**. Card 3 (`triage.glance`): two focus losses; press **F**. Press **J**/**K** to show moving between attempts, then **Details** on one card for the full log and the optional Gemini checks. | "Three decisions in two minutes, each from the evidence on the card: reasons in plain words, the photos, the transcript line, and the student's own note. Fine or Follow up, F or U. Seven days after Fine, the photos and transcript auto-delete. Everything under Details, similarity and the AI-written check, is optional and the only place Gemini is used." |
| 4:30–4:45 | **Close**                           | Back to the student report.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | "Private by design, works offline, no per-student cloud cost, and the teacher's time goes only where it's needed. That's why the AI runs locally."                                                                                                                                                                                                                |

**Cut first if running long:** Play clip and Details in the triage beat, then the spoken sentence
in 1:55. **Never cut:** consent and the one-face camera step, internet off with the phone held up,
the teacher clearing a card.

### Fallbacks, in the order they are likely to be needed

| If this fails                                 | Do this                                                                                                                                                                                                                                                                               |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| iPhone will not pair                          | Check both are on the same Wi-Fi and the Local Network permission was allowed; tap retry on the phone. If it still fails, the step cannot be skipped, so switch to the **browser** copy (`npm run demo`) where the same QR appears and pair there; say the Mac app has the same step. |
| Camera step stays red                         | Another app has the camera, or it is a virtual device. Quit the other app, pick the built-in camera, **Check again**. The student can only choose native cameras.                                                                                                                     |
| Internet-off plan misbehaves                  | Plan C: toggle the Mac's Wi-Fi off, show that answering continues and the phone-lost banner is non-blocking, turn it back on and show the iPhone reconnect.                                                                                                                           |
| Transcript stays empty                        | Say it and move on: "Whisper runs on the Mac; it keeps the text, never the audio." Browser copy: `npm run setup:whisper`.                                                                                                                                                             |
| Phone not detected in time                    | Hold it closer, screen facing the camera, steady for 3 s; detection needs 3 of 5 frames. If not, show the `triage.phone` card later and say the photo there is what you would have seen.                                                                                              |
| Student submit or report misbehaves           | Skip to the instructor window; the three `triage.*` cards are seeded and do not depend on the live attempt.                                                                                                                                                                           |
| Mac app will not open or seed                 | `npm run demo` in Chrome (browser copy, same accounts, same triage screen); say which Mac-only pieces are missing (hardware camera check, D-FINE wearables, brightness, Finder button).                                                                                               |
| Gemini checks under Details show "needs keys" | Expected without keys; monitoring and triage are unaffected. Say so.                                                                                                                                                                                                                  |

## (c) 3-minute Q&A cheat sheet

Short answers first, then the detail if they ask. Never claim more than `main` does.

- **What exactly runs locally?** Everything that touches the student: MediaPipe face and gaze
  (self-calibrating, hidden from the student), phone detection, D-FINE earbuds/headphones/glasses
  (Mac app), Whisper `small.en` speech-to-text, typing and pointer patterns, lighting and
  brightness, the colour-reflection presence checks, evidence photos, the findings engine, the
  teacher's triage screen and the SQLite database. The only cloud call is Gemini, for optional
  teacher checks after the exam (similarity, AI-written answer) and only with an API key. Full
  table: [LOCAL_AI.md](LOCAL_AI.md).
- **False positives?** Measured on 22 synthetic sessions, not real students
  ([eval-findings.md](eval-findings.md)): the findings engine caught 9 of 9 staged cheats and
  wrongly flagged 3 of 9 honest sessions (a student who looks up to think, one who looks at the
  keyboard, a TV in the next room). It missed both hard cases, a phone kept under the desk and
  notes used for only a few questions. That is why every finding is a lead with photos for a
  human, and why the student sees it and can reply. Thresholds were not tuned to that set; five
  fixes are written up, not applied.
- **Privacy and retention?** Camera frames and audio never leave the device; only derived
  events, one still photo when something unusual holds for 2 s, and transcript text are stored.
  Each exam has one retention setting (30 days by default); 7 days after a teacher marks an
  attempt Fine, its photos, transcripts and recording metadata are deleted (findings and counts
  stay). Screen recordings stay on the Mac unless the school turns upload to OneDrive on, and an
  exam can be set to keep them local only. Gemini only ever receives saved answer text, never
  media. Table: [SUBMISSION.md](SUBMISSION.md#what-leaves-the-device).
- **Can students bypass it?** Some ways, yes, and we say so: notes out of frame, a hidden
  earpiece, a second device we never see. What is blocked: virtual cameras (OBS, Camo and the
  like, by hardware attestation in the Mac app), virtual machines and capture displays in Strict
  mode, paste, leaving the kiosk window. What is noticed: a phone in view, extra faces, a second
  voice, text that appears all at once, the iPhone leaving the desk. It is not tamper-proof; it
  makes cheating visible enough that a teacher spends two minutes, not two hours.
- **Why does the iPhone only ping?** Because a second camera is a second privacy problem. The
  companion sends a heartbeat every 2 s over the local network and nothing else: no camera, no
  microphone, no screen. If the heartbeat stops or the app goes to the background, the timeline
  says so and the laptop shows a banner; it never blocks answering. The point is that the phone is
  face-down on the desk, not in a hand.
- **Apple Silicon or Intel?** The `.dmg` is an Intel (x86_64) build, macOS 13 or newer; it runs
  on Apple silicon through Rosetta 2. The numbers quoted (D-FINE about 1.2 s per view, Whisper
  `small.en` keeping up with live 6 s clips) were measured on an Intel i9; Whisper's GPU path is
  only used on Apple silicon. A native arm64 build is a packaging change, not a product change.
- **What does it cost?** No per-student cloud fee: the models are open (MediaPipe, Whisper under
  MIT, D-FINE under Apache-2.0) and run on the Mac the student already has. Gemini is optional
  and metered, used only when a teacher runs the two extra checks. Supabase and OneDrive are
  optional too.
- **Can it detect earbuds or smart glasses?** In the Mac app, yes, with D-FINE (Objects365
  classes `earphone`, `Head Phone`, `Glasses`, `Watch`); it cannot tell a smart variant from an
  ordinary one, and small items at webcam resolution are missed, so they are leads. Browsers run
  a lighter D-FINE-S copy.
- **Was this built during the hackathon?** It started from our own earlier prototype, imported
  unchanged as the first commit and disclosed in [EXISTING_CODE.md](EXISTING_CODE.md); every
  hackathon change is its own commit and listed in [CHANGELOG.md](../CHANGELOG.md).

## If something fails outside the demo

- Camera panel shows a model error: run `npm run vision:prepare`.
- Transcript stays empty in the browser copy: `npm run setup:whisper`.
- Camera or microphone blocked: allow access, then retry.
- Desktop shell won't start (`Electron failed to install correctly`): `npm run setup:desktop`.
- Mac app server log: `~/Library/Application Support/@examguard/desktop/logs/api.log`.
- Port 3000/5173 in use: quit whatever holds it and reopen.
- No confirmation or reset email: that needs Supabase configured; demo accounts are
  pre-confirmed and need no email. See
  [supabase/templates/README.md](../supabase/templates/README.md).
