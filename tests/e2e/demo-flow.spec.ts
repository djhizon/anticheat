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
];
const benignRequests: readonly RegExp[] = [
  /\/auth\/me -> 401/,
  // In-flight requests cancelled on purpose (unmounted panels, stopped workers, navigation).
  /net::ERR_ABORTED/,
  /\.(task|tflite|wasm|bin)(\?|$)/i,
  /\/exam\/attempts\/[^/]+\/audio/,
  /\/exam\/instructor\/versions\/[^/]+\/questions\/[^/]+\/(ai-check|similarity) -> 503/,
  /\/exam\/attempts\/[^/]+\/(liveness-verify|vision-check)/,
];

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

  await test.step('student signs in and starts the exam with consent', async () => {
    currentStep = 'student signs in and starts the exam with consent';
    await signIn(page, student);
    await expect(page.getByRole('heading', { name: 'Your assigned exams' })).toBeVisible();
    await page
      .getByRole('button', { name: /^(Start|Open) exam$/ })
      .first()
      .click();

    await expect(page.getByRole('heading', { name: 'Before you begin' })).toBeVisible();
    const grant = page.getByRole('button', { name: /Grant Camera & Microphone Access/ });
    await expect(grant).toBeDisabled();
    await page.getByRole('checkbox').check();
    await grant.click();
    await shot('1-consent');
    await page.getByRole('button', { name: 'I Agree — Start Exam' }).click();
  });

  await test.step('exam opens and camera/audio checks start by themselves', async () => {
    currentStep = 'exam opens and camera/audio checks start by themselves';
    await expect(page.locator('.exam-shell')).toBeVisible();
    const camera = page.getByRole('region', { name: 'Camera checks' });
    const audio = page.getByRole('region', { name: 'Audio checks' });
    // Running state: the toggle flips to "Stop ..." once the checks have auto-started.
    await expect(camera.getByRole('button', { name: 'Stop camera checks' })).toBeVisible();
    await expect(audio.getByRole('button', { name: 'Stop audio' })).toBeVisible();
    await expect(camera.getByText('Camera active')).toBeVisible({ timeout: 60_000 });
    await expect(audio.getByText(/^Microphone active:/)).toBeVisible({ timeout: 60_000 });
    await shot('2-exam-sensors-running');
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

  await test.step('liveness check reaches a clear result and can be closed', async () => {
    currentStep = 'liveness check reaches a clear result and can be closed';
    // Known UX issue (reported, not fixed here): the brightness banner is fixed over the top bar
    // and covers the "Verify I'm here" button until dismissed. Dismiss it like a student would.
    const banner = page.locator('.brightness-banner');
    if (await banner.isVisible()) {
      await shot('3a-brightness-banner-covers-topbar');
      await banner.locator('.brightness-close').click();
    }
    await page.getByRole('button', { name: /Verify I.m here/ }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Quick presence check' })).toBeVisible();
    const start = dialog.getByRole('button', { name: 'Start', exact: true });
    await expect(start).toBeVisible();
    await start.click();
    // The synthetic camera cannot reflect the colour sequence, so a pass is not expected; the
    // requirement is a clear final state (either result), never an indefinite spinner.
    await expect(
      dialog.locator('p').filter({ hasText: /Check passed|Verified\. Thank you|Not verified/ }),
    ).toBeVisible({ timeout: 60_000 });
    await shot('3-liveness-result');
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator('.exam-shell')).toBeVisible();
  });

  await test.step('submit shows "What monitoring recorded"', async () => {
    currentStep = 'submit shows "What monitoring recorded"';
    await page.getByRole('button', { name: 'Submit Exam' }).click();
    await expect(page.getByText('✅ Submitted')).toBeVisible();
    const report = page.getByRole('region', { name: 'What monitoring recorded' });
    await expect(report).toBeVisible();
    await expect(report.getByText('Loading report…')).toBeHidden();
    await expect(report.getByRole('alert')).toHaveCount(0);
    // "What was heard" only renders when the local Whisper build produced text; empty is valid.
    const heard = await report.getByRole('heading', { name: 'What was heard' }).count();
    testInfo.annotations.push({ type: 'what-was-heard-sections', description: String(heard) });
    await shot('4-transparency-report');
  });

  await test.step('instructor sees Integrity review with disabled Gemini checks and a clear hint', async () => {
    currentStep = 'instructor sees Integrity review with disabled Gemini checks and a clear hint';
    await page.getByRole('button', { name: '← Back' }).click();
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
    await signIn(page, instructor);
    await expect(page.getByRole('heading', { name: 'Integrity review' })).toBeVisible();
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
