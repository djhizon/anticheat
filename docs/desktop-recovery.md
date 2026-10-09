# Desktop blank-window recovery

The original reported post-login white window has not yet been reproduced in
the native macOS app. Browser login succeeds; that alone does not validate the
Electron preflight bridge or renderer process.

## Recovery behavior

- The old display-name-to-PID `kill-app` handler remains disabled. Its replacement
  uses a compiled macOS helper and instance identities (PID, bundle ID, bundle
  path, executable path, kernel start timestamp), not shell kill commands.
- Both normal quit and Force Quit require a native confirmation; Cancel is the
  default. Force Quit requires a prior normal quit request for that instance,
  a three-second grace period, a re-check, and a separate confirmation. That
  eligibility expires after 60 seconds and is consumed by a force request.
- A requested quit is not proof of exit. Re-check observes current apps. Force
  Quit may lose unsaved work and does not promise cleanup of detached helpers.
- Identity and protection are rechecked after confirmation and again in the
  native helper before acting. Uncertain discovery fails closed. These checks
  reduce process-reuse races; they are not a claim of atomic OS guarantees.
- The helper protects the exam bundle, known system/terminal identifiers, and
  the ancestors/descendants of the exam and local service processes on ports
  3000/5173. Both services must be running and discoverable. Descendants of a
  shared ancestor such as launchd are not all swept into the protected set.
- Native preflight requests time out after eight seconds. Rejected or invalid
  responses show an error, retry, and sign-out instead of silently stalling.
- Late replies cannot pass a timed-out or unmounted check.
- Renderer exits, unresponsive windows, and main-page load failures open a
  native reload/close dialog. Failed reloads offer recovery again.
- Cache clearing is best-effort and precedes the initial page load.
- A failed native recovery dialog closes the unusable window; it does not
  delete exam data.
- `desktop-health.log` in Electron's user-data directory records only lifecycle
  categories and error codes. It is local, is not uploaded, and is truncated
  when it exceeds 64 KiB. It contains no answer text or credentials.

The desktop app still requires the API and Vite servers (`npm run dev`). Its
page URL is `http://127.0.0.1:5173/`. The ordinary close, quit, reload, and
developer-tools menu commands remain available for troubleshooting.

## Verification

```sh
npx vitest run --config vitest.config.ts apps/desktop/src/main.test.ts apps/web/src/features/integrity/PreflightCheck.test.tsx apps/web/src/App.test.tsx apps/web/src/features/exam/StudentExamPage.render.test.tsx apps/web/src/features/exam/api.test.ts
npm run build --workspace @exam-anti-cheat/desktop
npm run build --workspace @exam-anti-cheat/web
```

The focused tests cover the component and mocked native lifecycle, including
denial of legacy force-close IPC without process commands. Browser
login was checked through the UI. Automated browser end-to-end tests are in
`tests/e2e/desktop-login.spec.ts`; launching Chromium from the background shell
was blocked by macOS Mach-port permissions, so these are not recorded as passed.

Rebuild the macOS directory package from `apps/desktop` with:

```sh
npm run build
./native-bin/app-control --self-test
npx electron-builder --mac --dir --config.electronVersion=44.4.1
```

Final acceptance still requires launching the rebuilt app from the desktop
session, signing in, and verifying either the preflight gate or workspace is
visible and responsive. Do not treat this recovery hardening as proof that the
original native white-screen cause has been eliminated.

## Temporary development exemptions and removal reminder

`native/AppControl.swift` contains `temporaryExemptions`: `com.apple.Terminal`,
`com.openai.chat`, and `com.openai.codex` (the identifier observed in the local
ChatGPT installation). Exempt targets have no close controls. A persistent
`DevelopmentExemptions` banner remains visible on the desktop login, preflight,
workspace, and exam screens. Browser-only pages do not claim native exemptions.

Before a real presentation/exam, remove the temporary policy exemptions and
update the banner together, rebuild, and retest. Do not remove runtime/server
safety protections. If removing Terminal's policy exemption blocks the demo,
first make the app manage its own servers; do not terminate the hosting terminal.

## Manual acceptance (user-operated)

No real applications were terminated in automated tests. The native helper's
self-test uses only fixture process graphs and policy identifiers. UI interaction
and live termination are intentionally left to the user:

1. Start `npm run dev` from the repository root and leave its terminal open.
   Launch the rebuilt desktop executable from another terminal.
2. Sign in. Confirm the exemption reminder is visible. Terminal/ChatGPT must
   not block entry and must never have quit buttons. If other apps block entry,
   the preflight list also labels exempt/protected entries.
3. Use only a disposable test app/window with no important unsaved work.
   Select Quit normally, cancel the native confirmation, and verify it stays
   open. Repeat and approve normal quit; re-check to verify it exited.
4. To test escalation, use disposable unsaved content in a test app, approve
   normal quit but cancel that app's save/quit prompt. After three seconds,
   re-check. Force Quit must require another native warning and default to
   Cancel. Test cancellation first; approve only if losing that test content
   is acceptable. Verify the exam and both local servers stay alive.
5. Report the exact message if discovery, quitting, or re-checking fails. Do
   not close Terminal to get around a dependency warning.
