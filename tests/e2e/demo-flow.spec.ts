import { expect, test, type Page } from '@playwright/test';

// Automated rehearsal of docs/DEMO.md (student beats, then the instructor's secondary checks).
// Runs against an isolated API + web server (see demo.playwright.config.ts) with a synthetic
// camera and microphone, and with Gemini/Supabase/Microsoft all switched off.

const student = { email: 'demo.student@example.test', password: 'Demo exam password 2026!' };
const instructor = {
  email: 'demo.instructor@example.test',
  password: 'Demo instructor password 2026!',
};

// Console errors / failed requests that are expected in this environment. Keep this list explicit.
const benignConsole: readonly RegExp[] = [
  // The anonymous session probe before sign-in (and after sign-out) is a normal 401.
  /status of 401.*\/auth\/me/,
  // TensorFlow Lite logs an informational line through console.error.
  /^INFO: Created TensorFlow Lite XNNPACK delegate/,
  // On-device models are not downloaded in CI and fall back to a "model unavailable" state.
  /Failed to load resource.*(\.task|\.tflite|\.wasm|\.bin)/i,
  /(model|wasm|whisper|mediapipe).*(load|fetch|unavailable|not found)/i,
  // Whisper is not built in the test environment, so clip transcription is unavailable.
  /\/exam\/attempts\/[^/]+\/audio/,
  // The "needs GEMINI_API_KEYS" instructor checks intentionally return an error response.
  /Failed to load resource.*(409|422|503|501)/i,
  // Same instructor checks: with no keys the API currently answers 500 (reported as a finding).
  /status of 500.*\/exam\/instructor\/.*\/(ai-check|similarity)$/,
  /Failed to load resource.*404.*\/findings/,
];
const benignRequests: readonly RegExp[] = [
  /\/auth\/me -> 401/,
  // In-flight requests cancelled on purpose (unmounted panels, stopped workers, navigation).
  /net::ERR_ABORTED/,
  /\.(task|tflite|wasm|bin)(\?|$)/i,
  /\/exam\/attempts\/[^/]+\/audio/,
  /\/exam\/instructor\/versions\/[^/]+\/questions\/[^/]+\/(ai-check|similarity) -> 503/,
  /\/exam\/attempts\/[^/]+\/(liveness-verify|vision-check)/,
  // Cloud (OneDrive) recording is not configured here: segments are saved locally instead.
  /\/exam\/attempts\/[^/]+\/recording -> 503/,
  // The findings engine may have nothing for an attempt yet; the screens say so.
  /\/exam\/attempts\/[^/]+\/findings -> 404/,
];

/**
 * Plays the iPhone's part over HTTP, like apps/ios PresenceController and
 * scripts/phone-lab-auto.mjs: claim the pairing code, then a fresh challenge + heartbeat every
 * 2 s (presence only: no desk camera). JSON, no cookies, no Origin, through the web proxy.
 */
async function startPhoneSimulation(code: string): Promise<{ stop(): void }> {
  const origin = `http://127.0.0.1:${process.env.E2E_WEB_PORT ?? '5273'}`;
  const post = async (path: string, body: unknown) => {
    const response = await fetch(origin + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, data: (await response.json().catch(() => null)) as never };
  };
  const claim = await post('/exam/phone-presence/claim', { code });
  const credential = (claim.data as { credential?: string } | null)?.credential ?? '';
  expect(claim.status, 'phone claim').toBe(200);
  let stopped = false;
  const beat = async () => {
    if (stopped) return;
    const challenge = await post('/exam/phone-presence/challenge', { credential }).catch(
      () => null,
    );
    const data = challenge?.data as { challenge?: string; sequence?: number } | null;
    if (stopped || !data?.challenge) return;
    await post('/exam/phone-presence/heartbeat', {
      credential,
      challenge: data.challenge,
      sequence: data.sequence,
      active: true,
    }).catch(() => null);
  };
  await beat();
  const timer = setInterval(() => void beat(), 2000);
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

function isBenign(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

async function signIn(page: Page, account: { email: string; password: string }): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Email address').fill(account.email);
  await page.getByLabel('Password', { exact: true }).fill(account.password);
  await page.locator('button.auth-submit').click();
}

test('demo flow: student exam with on-device checks, then instructor review', async ({
  page,
}, testInfo) => {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];
  let currentStep = 'setup';
  page.on('pageerror', (error) => pageErrors.push(`${error.name}: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error')
      consoleErrors.push(`${message.text()} @ ${message.location().url}`);
  });
  page.on('requestfailed', (request) =>
    failedRequests.push(`${request.method()} ${request.url()} ${request.failure()?.errorText}`),
  );
  page.on('response', (response) => {
    if (response.status() < 400) return;
    const entry = `[${currentStep}] ${response.request().method()} ${response.url()} -> ${response.status()}`;
    failedRequests.push(entry);
    void response.text().then(
      (body) => failedRequests.push(`    body: ${body.slice(0, 200)}`),
      () => undefined,
    );
  });
  page.on('dialog', (dialog) => void dialog.accept());
  let phone: { stop(): void } | undefined;
  page.on('close', () => phone?.stop());

  // The app deliberately only accepts a microphone labelled like a laptop's built-in one and
  // refuses "Fake ..." devices. Test-only shim: present Chromium's synthetic mic under such a
  // label (the real label check, deviceId match and stream all still run unchanged).
  await page.addInitScript(() => {
    const fakeLabel = 'Fake Audio Input 1';
    const builtIn = 'MacBook Pro Microphone';
    const media = navigator.mediaDevices;
    const original = media.enumerateDevices.bind(media);
    media.enumerateDevices = async () =>
      (await original()).map((device) =>
        device.label === fakeLabel
          ? ({
              deviceId: device.deviceId,
              groupId: device.groupId,
              kind: device.kind,
              label: builtIn,
              toJSON: () => ({}),
            } as MediaDeviceInfo)
          : device,
      );
    const descriptor = Object.getOwnPropertyDescriptor(MediaStreamTrack.prototype, 'label');
    if (descriptor?.get) {
      const getLabel = descriptor.get;
      Object.defineProperty(MediaStreamTrack.prototype, 'label', {
        ...descriptor,
        get() {
          const label = getLabel.call(this) as string;
          return label === fakeLabel ? builtIn : label;
        },
      });
    }
  });

  const shot = (name: string) =>
    page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true });

  await test.step('student signs in and completes the pre-exam setup', async () => {
    currentStep = 'student signs in and completes the pre-exam setup';
    // The synthetic camera cannot reflect the random colour sequence, so a real pass is not
    // possible in CI. Only the server verdict is stubbed; the challenge request, the camera
    // capture and the inline UI all run for real.
    await page.route('**/liveness-verify', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ passed: true, layer: 3, detail: 'Passed (e2e stub verdict)' }),
      }),
    );
    await signIn(page, student);
    await expect(page.getByRole('heading', { name: 'Your assigned exams' })).toBeVisible();
    await page
      .getByRole('button', { name: /^(Start|Open) exam$/ })
      .first()
      .click();

    const next = page.getByRole('button', { name: 'Next', exact: true });
    const heading = page.locator('#setup-heading');

    await expect(heading).toHaveText('Consent');
    await expect(page.getByText(/cannot pause or stop them yourself/).first()).toBeVisible();
    await expect(next).toBeDisabled();
    await page.getByRole('checkbox').check();
    await shot('1-consent');
    await next.click();

    // The test browser context pre-grants camera/microphone, so they may already show as allowed.
    await expect(heading).toHaveText('Permissions');
    await page.getByRole('button', { name: 'Allow camera & microphone' }).click();
    await expect(page.getByText('Camera: Allowed ✓')).toBeVisible();
    await expect(page.getByText('Microphone: Allowed ✓')).toBeVisible();
    await next.click();

    await expect(heading).toHaveText('Camera');
    await expect(page.getByText(/Camera check passed/)).toBeVisible({ timeout: 30_000 });
    // The synthetic camera shows no face; the E2E build swaps only the face counter for a stub
    // (tests/e2e/fakeFaceSource.ts), the window logic and the gating run unchanged.
    await expect(page.getByText('Face detected ✓')).toBeVisible({ timeout: 30_000 });
    await shot('2-camera-check');
    await next.click();

    // The real lighting check: the synthetic camera may pass by itself or need the warning button.
    await expect(heading).toHaveText('Lighting');
    const lightingWarning = page.getByRole('button', { name: /Continue with a lighting warning/ });
    await expect(next.or(lightingWarning)).toBeEnabled({ timeout: 45_000 });
    if (await lightingWarning.isVisible()) await lightingWarning.click();
    await expect(next).toBeEnabled();
    await next.click();

    await expect(heading).toHaveText('Microphone');
    await expect(page.getByText('We can hear you ✓')).toBeVisible({ timeout: 30_000 });
    await next.click();

    // Mandatory whole-screen recording; Chromium's fake capture picks the entire screen.
    await expect(heading).toHaveText('Screen recording');
    await expect(next).toBeDisabled();
    await page.getByRole('button', { name: 'Start screen recording' }).click();
    await expect(page.getByText('Screen recording is on ✓')).toBeVisible({ timeout: 30_000 });
    await expect(next).toBeEnabled();
    await next.click();

    // The iPhone is always required. The browser build asks for this computer's Wi-Fi address
    // (the desktop app opens its LAN listener itself); the phone is simulated over HTTP.
    await expect(heading).toHaveText('iPhone');
    await expect(next).toBeDisabled();
    await expect(page.getByRole('button', { name: /Skip/ })).toHaveCount(0);
    await expect(page.getByText(/desk camera/i)).toHaveCount(0);
    await page.getByLabel("This computer's Wi-Fi address").fill('http://192.168.1.10:5273');
    await page.getByRole('button', { name: 'Show QR code' }).click();
    await expect(
      page.getByText('Open Exam Companion on your iPhone and scan this code.'),
    ).toBeVisible();
    await page.getByText('Show the link instead').click();
    const link = await page.getByLabel('Private pairing link').inputValue();
    phone = await startPhoneSimulation(new URL(link).searchParams.get('code') ?? '');
    await expect(page.getByText(/Paired ✓/)).toBeVisible({ timeout: 15_000 });
    await shot('3-iphone-paired');
    // Moves on by itself once paired.

    await expect(heading).toHaveText('Identity');
    await expect(next).toBeDisabled();
    const presence = page.getByRole('group', { name: /presence check/i });
    await presence.getByRole('button', { name: 'Start', exact: true }).click();
    await expect(page.getByText('Verified ✓')).toBeVisible({ timeout: 60_000 });
    await shot('3-identity');
    await next.click();

    await expect(heading).toHaveText('Ready');
    await shot('4-ready');
    await page.getByRole('button', { name: 'Start exam', exact: true }).click();
  });

  await test.step('exam opens with checks already running and no setup controls', async () => {
    currentStep = 'exam opens with checks already running and no setup controls';
    await expect(page.locator('.exam-shell')).toBeVisible();
    const camera = page.getByRole('region', { name: 'Camera checks' });
    const audio = page.getByRole('region', { name: 'Audio checks' });
    await expect(camera.getByText('Camera active')).toBeVisible({ timeout: 60_000 });
    await expect(audio.getByText(/^Microphone active:/)).toBeVisible({ timeout: 60_000 });
    const chips = page.getByRole('group', { name: 'Monitoring status' });
    await expect(chips).toContainText('Camera ✓');
    await expect(chips).toContainText('Mic ✓');
    await expect(chips).toContainText('iPhone Connected');
    await expect(page.locator('.phone-lost-banner')).toHaveCount(0);
    await expect(chips).toContainText('Verified ✓');
    // Recording started in setup carried over: answering is not paused.
    await expect(page.getByRole('alertdialog', { name: 'Screen recording stopped' })).toHaveCount(
      0,
    );
    for (const name of [
      /Verify I.m here/,
      /iPhone$/,
      /^(Start|Stop)/,
      /Pair/,
      /Resume monitoring/,
      /Resume screen recording/,
    ])
      await expect(page.getByRole('button', { name })).toHaveCount(0);
    await shot('5-exam-sensors-running');
  });

  await test.step('answering a question autosaves', async () => {
    currentStep = 'answering a question autosaves';
    const answerArea = page.locator('.answer-area');
    const saved = page.waitForResponse(
      (response) =>
        response.request().method() === 'PUT' &&
        /\/answers$/.test(new URL(response.url()).pathname),
    );
    const radio = answerArea.locator('input[type="radio"]').first();
    const numeric = answerArea.locator('input[type="number"]');
    const text = answerArea.locator('textarea, input[type="text"]').first();
    // The question order is not fixed, so answer whatever control the first question uses.
    if (await radio.count()) await radio.check();
    else if (await numeric.count()) await numeric.pressSequentially('32', { delay: 20 });
    else await text.pressSequentially('Typed by the demo rehearsal.', { delay: 20 });
    expect((await saved).ok()).toBe(true);
    await expect(page.locator('.topbar-chip--save')).toContainText('Saved');
  });

  await test.step('refreshing mid-exam skips setup and re-acquires the sensors', async () => {
    currentStep = 'refreshing mid-exam skips setup and re-acquires the sensors';
    await page.reload();
    await expect(page.locator('.exam-shell')).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('#setup-heading')).toHaveCount(0);
    // A refresh ends the screen recording: answering pauses until the one button restarts it.
    const recordingPaused = page.getByRole('alertdialog', { name: 'Screen recording stopped' });
    await expect(recordingPaused).toBeVisible({ timeout: 30_000 });
    await recordingPaused.getByRole('button', { name: 'Resume screen recording' }).click();
    await expect(recordingPaused).toHaveCount(0, { timeout: 30_000 });
    // The browser remembers the grant, so monitoring resumes by itself; if a gesture were
    // needed, "Resume monitoring" is the only button allowed.
    const resume = page.getByRole('button', { name: 'Resume monitoring' });
    if (await resume.isVisible()) await resume.click();
    await expect(
      page.getByRole('region', { name: 'Camera checks' }).getByText('Camera active'),
    ).toBeVisible({ timeout: 60_000 });
    await expect(
      page.getByRole('region', { name: 'Audio checks' }).getByText(/^Microphone active:/),
    ).toBeVisible({ timeout: 60_000 });
  });

  await test.step('submit shows "What monitoring recorded"', async () => {
    currentStep = 'submit shows "What monitoring recorded"';
    await page.getByRole('button', { name: 'Submit Exam' }).click();
    await expect(page.getByText('✅ Submitted')).toBeVisible();
    phone?.stop();
    await expect(page.locator('.exam-topbar')).not.toContainText('Not saved');
    const report = page.getByRole('region', { name: 'What monitoring recorded' });
    await expect(report).toBeVisible();
    await expect(report.getByText('Loading report…')).toBeHidden();
    await expect(report.getByRole('alert')).toHaveCount(0);
    // The same findings the instructor triages, in plain language (or "not available yet").
    const findings = report.getByRole('region', { name: 'What your teacher may look at' });
    await expect(findings).toBeVisible();
    await expect(findings.getByText('Loading…')).toBeHidden();
    // "What was heard" only renders when the local Whisper build produced text; empty is valid.
    const heard = await report.getByRole('heading', { name: 'What was heard' }).count();
    testInfo.annotations.push({ type: 'what-was-heard-sections', description: String(heard) });
    await shot('4-transparency-report');
  });

  await test.step('instructor triage: counts, sorted list, one card cleared with "Fine"', async () => {
    currentStep = 'instructor triage: counts, sorted list, one card cleared with "Fine"';
    await page.getByRole('button', { name: '← Back' }).click();
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
    await signIn(page, instructor);
    await expect(page.getByRole('heading', { name: 'Integrity review' })).toBeVisible();
    const triage = page.getByRole('region', { name: 'Who needs a look' });
    await expect(triage).toBeVisible();
    await expect(triage.locator('.triage-counts')).toHaveText(
      /^\d+ no review · \d+ glance · \d+ review$/,
    );
    const rows = triage.locator('.triage-row');
    // The demo student plus the classmates and the synthetic triage students.
    expect(await rows.count()).toBeGreaterThanOrEqual(5);
    const selected = triage.locator('.triage-row--selected');
    await expect(selected).toHaveCount(1);
    await expect(selected).toContainText('Undecided');
    const card = triage.locator('.evidence-card');
    await expect(card).toBeVisible();
    await expect(card.getByText('Loading findings…')).toBeHidden();
    await shot('5-instructor-triage');
    // Clearing one card: "Fine" records the decision and moves on to the next attempt.
    const cleared = (await selected.locator('.triage-student').textContent()) ?? '';
    const started = Date.now();
    await triage.getByRole('button', { name: /^Fine/ }).click();
    await expect(triage.locator('.triage-row', { hasText: cleared })).toContainText('✓ Fine');
    expect(Date.now() - started).toBeLessThan(60_000);
    await expect(triage.locator('.triage-row--selected')).not.toContainText(cleared);
  });

  await test.step('instructor Details show the dashboards with disabled Gemini checks and a clear hint', async () => {
    currentStep =
      'instructor Details show the dashboards with disabled Gemini checks and a clear hint';
    await page.getByRole('button', { name: /^Details: full logs/ }).click();
    await expect(page.getByRole('region', { name: /Attempt integrity log/ })).toBeVisible();
    const similarity = page.getByRole('region', { name: /Cross-student similarity/ });
    const ai = page.getByRole('region', { name: /AI-written answer check/ });
    await expect(similarity).toBeVisible();
    await expect(ai).toBeVisible();

    // Without GEMINI_API_KEYS the server says so up front and the buttons are disabled.
    await expect(ai.getByRole('button', { name: 'Run AI check' })).toBeDisabled();
    await expect(ai).toContainText('Needs GEMINI_API_KEYS on the server');
    await expect(similarity.getByRole('button', { name: 'Run similarity check' })).toBeDisabled();
    await expect(similarity).toContainText('Needs GEMINI_API_KEYS on the server');
    await shot('5-instructor-no-keys');
  });

  const unexpectedConsole = consoleErrors.filter((entry) => !isBenign(entry, benignConsole));
  const unexpectedRequests = failedRequests.filter(
    (entry) => !entry.startsWith('    body:') && !isBenign(entry, benignRequests),
  );
  await testInfo.attach('console-errors', { body: consoleErrors.join('\n') || '(none)' });
  await testInfo.attach('failed-requests', { body: failedRequests.join('\n') || '(none)' });
  expect(pageErrors, 'uncaught page errors').toEqual([]);
  expect(unexpectedConsole, 'unexpected console errors').toEqual([]);
  expect(unexpectedRequests, 'unexpected failed requests').toEqual([]);
});
