# Security

ExamGuard is an advanced exam integrity enforcement platform.

## Design

- The server owns authorization, exam assignment, timing, answers, grading, and appeals.
- Browser and desktop signals are continuously monitored, logged, and enforced.
- Camera, microphone, screen recording, and native process permissions are **required** to take an exam.
- All monitoring data is persisted server-side for instructor review.
- Automated violation thresholds trigger session termination.

## Reporting a suspected vulnerability

Do not include real student data, credentials, recordings, or private exam
content in an issue. Report the affected component, reproduction steps using
synthetic data, expected behavior, and observed behavior.

## Known limitations

See the **Virtual Machine Blindspot** section in `architecture_and_context.md` for a
detailed analysis of hardware-level evasion and how the Companion Phone Setup
mitigates it as an external root of trust.
