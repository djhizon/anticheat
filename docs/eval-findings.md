# Findings engine: measured on synthetic sessions

**Synthetic data only.** Nothing here was measured on real students. The numbers show how
`buildFindings` (`apps/api/src/modules/integrity/findings.ts`) behaves on 22 generated attempts
and are meant to expose blind spots and false flags, not to claim accuracy.

Run `npm run eval:findings` to replay the sessions and refresh the block between the markers
below (the text outside the markers is written by hand). `npm run eval:findings -- --regenerate`
rewrites the fixtures from the generator first; the unit test
`apps/api/src/modules/integrity/eval-findings.test.ts` fails if the committed fixtures drift
from the generator.

## How the sessions are made

- `apps/api/src/modules/integrity/eval-generator.ts` builds each attempt from a short scenario
  (typist profile, glances, flags, voices, pastes, idle spans) into the same raw rows the API
  stores: keystrokes one by one, 20 s input-behaviour windows aggregated from them with a
  pointer model, gaze rows with yaw/pitch, named app-event flags, voice and transcript rows,
  answer revisions and evidence metadata. The client's `burst_after_idle` event is reproduced
  by a small simulated detector (2 min silence, then 40+ keys in 15 s), so it appears wherever
  the typing warrants it in honest and staged sessions alike.
- Every scenario has its own seeded stream (mulberry32 keyed by the scenario id, seed
  `20260915`) and is noisy on purpose: timestamps jitter, the gaze tracker misses 10-40 % of
  glances and sometimes logs only the tail of one, faces and transcript lines are dropped at
  random, and every session carries background noise (stray short look-aways, face-loss blips,
  app heartbeats).
- Cohorts: 9 honest sessions (thinking glances upward, calculator, slow typist, fast typist,
  one focus loss, glasses/lighting, a brief TV in the next room, a posture shift, a keyboard
  looker), 9 staged cheats (notes beside the screen, phone in hand, phone + down-gaze + iPhone
  lost, second person talking, pasted answers, burst after a long idle with a still pointer,
  second screen, leaving the exam window repeatedly, virtual camera), and 2 hard borderline
  cases each way (sparse notes use, a phone kept under the desk; a calculator user with one
  spurious phone detection and a Wi-Fi drop, a student who reads the questions aloud).
- The fixtures in `apps/api/src/modules/integrity/eval-sessions/` are committed so the run is
  reproducible without the generator and the rows can be inspected.
- The thresholds in `FINDING_THRESHOLDS` were **not** adjusted against this set. One generator
  bug was fixed after the first run (idle spans did not silence typing laid down earlier, so
  the burst-after-idle cheat contained no idle at all); nothing else changed between runs.

## Results

<!-- eval-findings:start -->

Synthetic data only: 22 generated sessions (seed 20260915), not real students. Main set: 9 of 9 staged cheats detected, 3 of 9 honest sessions flagged. Hard borderline cases are counted separately.

### Per finding type

| Finding                  | Staged cheats detected | Honest sessions flagged | Hard cheats | Hard honest |
| ------------------------ | ---------------------- | ----------------------- | ----------- | ----------- |
| `notes_or_second_screen` | 2 / 2                  | 2 / 9                   | 0 / 1       | 0 / 2       |
| `second_person`          | 1 / 1                  | 1 / 9                   | -           | 1 / 2       |
| `external_answer_entry`  | 2 / 2                  | 0 / 9                   | -           | 0 / 2       |
| `phone_use`              | 2 / 2                  | 0 / 9                   | 0 / 1       | 0 / 2       |
| `left_exam`              | 1 / 1                  | 0 / 9                   | -           | 0 / 2       |
| `environment_risk`       | 1 / 1                  | 0 / 9                   | -           | 0 / 2       |

### Review level by cohort

| Cohort      | Sessions | none | glance | review |
| ----------- | -------- | ---- | ------ | ------ |
| honest      | 9        | 6    | 1      | 2      |
| cheat       | 9        | 0    | 2      | 7      |
| hard_honest | 2        | 1    | 1      | 0      |
| hard_cheat  | 2        | 2    | 0      | 0      |

### Hard borderline cases

| Session                                 | Cohort      | Level  | Findings                 | Outcome    |
| --------------------------------------- | ----------- | ------ | ------------------------ | ---------- |
| `hard-cheat-phone-under-desk`           | hard_cheat  | none   | none                     | MISSED     |
| `hard-cheat-sparse-notes`               | hard_cheat  | none   | none                     | MISSED     |
| `hard-honest-calculator-spurious-phone` | hard_honest | none   | none                     | clean      |
| `hard-honest-reads-aloud`               | hard_honest | glance | `second_person` (medium) | FALSE FLAG |

### All sessions

| Session                             | Cohort | Level  | Findings                        | Outcome    |
| ----------------------------------- | ------ | ------ | ------------------------------- | ---------- |
| `cheat-burst-after-long-idle`       | cheat  | glance | `external_answer_entry` (low)   | detected   |
| `cheat-leaving-exam-window`         | cheat  | review | `left_exam` (high)              | detected   |
| `cheat-notes-beside-screen`         | cheat  | review | `notes_or_second_screen` (high) | detected   |
| `cheat-pasted-answers`              | cheat  | review | `external_answer_entry` (high)  | detected   |
| `cheat-phone-down-gaze-iphone-lost` | cheat  | review | `phone_use` (high)              | detected   |
| `cheat-phone-in-hand`               | cheat  | glance | `phone_use` (medium)            | detected   |
| `cheat-second-person-talking`       | cheat  | review | `second_person` (high)          | detected   |
| `cheat-second-screen`               | cheat  | review | `notes_or_second_screen` (high) | detected   |
| `cheat-virtual-camera`              | cheat  | review | `environment_risk` (high)       | detected   |
| `honest-background-tv`              | honest | glance | `second_person` (medium)        | FALSE FLAG |
| `honest-calculator`                 | honest | none   | none                            | clean      |
| `honest-fast-typist`                | honest | none   | none                            | clean      |
| `honest-glasses-lighting`           | honest | none   | none                            | clean      |
| `honest-keyboard-looker`            | honest | review | `notes_or_second_screen` (high) | FALSE FLAG |
| `honest-one-focus-loss`             | honest | none   | none                            | clean      |
| `honest-posture-shift`              | honest | none   | none                            | clean      |
| `honest-slow-typist`                | honest | none   | none                            | clean      |
| `honest-thinking-up`                | honest | review | `notes_or_second_screen` (high) | FALSE FLAG |

<!-- eval-findings:end -->

## What the numbers say

- All nine staged cheats in the main set produce their expected finding, seven of them at
  `review`. The two at `glance` are honest weaknesses: `cheat-phone-in-hand` stays `medium`
  because nothing corroborates the camera except the look down (the paired iPhone stays put),
  and `cheat-burst-after-long-idle` only reaches `low` because one of the two bursts loses its
  "still pointer" status (see recommendation 3).
- Three of nine honest sessions are flagged, two of them at `review` with `high` confidence:
  the student who looks up while thinking and the one who looks at the keyboard. Both are
  `notes_or_second_screen` and both come from the same cause (recommendation 1 and 2). The
  third, the TV in the next room, is a `medium` `second_person` from a single 45 s stretch
  (recommendation 4).
- Both hard cheats are missed, as expected from the two-signal rule: a phone that never enters
  the frame with only 2.5-4.5 s looks down (below `phone.minDownGazeMs`), and notes used for
  only a few questions (fewer than `notes.minGlances` logged). These are the engine's declared
  blind spots; the iPhone presence requirement and evidence snapshots exist to cover them, and
  lowering these thresholds would hit the honest calculator and thinking sessions first.
- The hard honest calculator session is clean, but only by timing: one spurious phone detection
  within 60 s of any 5 s look down would have produced a `medium` `phone_use` on its own
  (recommendation 5). The student reading aloud is flagged `medium` `second_person`; the
  engine cannot tell their voice from a helper's, and the finding's wording already says so.

## Recommendations (not applied)

1. **Typing-burst floor.** `TypingProfile` derives the burst floor from the mean baseline rate
   (`baseKeys x 10 s / 180 s x 2`). For a steady 2.2 keys/s typist who types about 40 % of the
   time the floor lands at 12-18 keys per 10 s, below their actual typing speed, so every normal
   sentence typed after a glance counts as a "burst". Derive the floor from the baseline's
   busiest 10 s windows instead (for example 1.5x the 90th percentile of keystrokes per 10 s),
   so a burst means faster than the student types, not faster than they think-and-type.
2. **Habit rule.** `notes.habitBaselineGlances: 3` requires three followed glances inside the
   first 3 minutes. A once-a-minute habit gives three chances, and one missed detection or one
   glance without typing is enough to turn a habit into a `high` finding (the keyboard looker
   had its baseline glances but not three _followed_ ones). Count all glances to the region in
   the baseline (not only followed ones) for the habit test, or lower the minimum to 2 with the
   rate ratio doing the work.
3. **Still-pointer lookback.** `answerEntry.idleLookbackMs` is measured back from the
   `burst_after_idle` flag, which the client sends about 10 s into the burst, so the lookback
   overlaps the window in which typing resumed; any pointer event there (a click into the
   answer box) disqualifies the burst. End the lookback at the burst's first keystroke, or allow
   `stillPointerEvents` of 1-2 in the resuming window only.
4. **Speech pairs.** `secondPerson.mediumSpeechPairs: 2` is reached by one 45 s stretch of TV
   audio. Merge speech pairs closer than `windowMergeMs` into one episode before counting, as
   the other findings do, so one burst of background speech is `low` and repeated conversation
   over minutes stays `medium`.
5. **Single phone detection plus a look down.** `phoneFinding` returns `medium` for one camera
   detection within 60 s of a 5 s look down. Looking down for 5 s is common (calculator, desk,
   keyboard) and the detector fires on calculators; require `phone.minDetections` even when a
   look down corroborates, and keep the single-detection path for the iPhone-lost correlation
   only.

## Limits of this evaluation

- The generator encodes my assumptions about how students and cheats behave (pointer activity
  while typing, how often trackers miss, how fast copied text is typed). A real pilot with
  consented recordings should replace this set before any threshold is changed.
- One sample per scenario with one seed; small changes to the seed move borderline sessions
  across thresholds. The numbers are a smoke test of the rules, not a detection rate.
- Honest sessions were designed from the list of behaviours in the work package, not sampled
  from real exams, so the false-flag rate is not an estimate of what instructors would see.
