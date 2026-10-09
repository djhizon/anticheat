import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// End-to-end rehearsal of the desktop app judges install. Every run uses a throwaway Electron
// userData directory (`--user-data-dir`), so real app data is never touched.
// Never clicks Quit / Force quit on real applications.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const shotDir = join(root, 'test-results/electron');
const student = { email: 'demo.student@example.test', password: 'Demo exam password 2026!' };
const fakeMedia = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'];

function packagedBinary(): string {
  return (
    process.env.EAC_PACKAGED_APP ??
    join(root, 'apps/desktop/release/mac/ExamGuard.app/Contents/MacOS/ExamGuard')
  );
}

interface Target {
  name: string;
  launch: (userData: string) => {
    executablePath?: string;
    args: string[];
    env: Record<string, string>;
  };
  skipReason: () => string | null;
}

const targets: Target[] = [
  {
    name: 'dev build',
    skipReason: () =>
      existsSync(join(root, 'apps/desktop/dist/main.js')) &&
      existsSync(join(root, 'apps/api/dist/api-server.mjs')) &&
      existsSync(join(root, 'apps/web/dist/index.html'))
        ? null
        : 'run npm run build:server and npm run build --workspace @examguard/desktop',
    launch: (userData) => ({
      args: [join(root, 'apps/desktop/dist/main.js'), `--user-data-dir=${userData}`, ...fakeMedia],
      // Unpackaged builds are not the judge build; this test-only flag makes it behave like one.
      env: { EAC_TEST_JUDGE_BUILD: '1' },
    }),
  },
  {
    name: 'packaged app',
    skipReason: () =>
      existsSync(packagedBinary()) ? null : 'run npm run package:mac to build the packaged app',
    launch: (userData) => ({
      executablePath: packagedBinary(),
      args: [`--user-data-dir=${userData}`, ...fakeMedia],
      env: {},
    }),
  },
];

function portOpen(port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = createConnection({ port, host: '127.0.0.1' });
    socket.once('connect', () => {
      socket.destroy();
      done(true);
    });
    socket.once('error', () => done(false));
  });
}

async function portsFree(): Promise<boolean> {
  return !(await portOpen(3000)) && !(await portOpen(5173));
}

/** Other people/agents may be using the fixed ports; wait (never kill anything we did not start). */
async function waitForPortsFree(maxMs: number): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (!(await portsFree())) {
    if (Date.now() > deadline) throw new Error('ports 3000/5173 stayed busy');
    await new Promise((r) => setTimeout(r, 30_000));
  }
}

async function waitPortsReleased(): Promise<boolean> {
  for (let i = 0; i < 40; i++) {
    if (await portsFree()) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

// Benign console noise (same rationale as tests/e2e/demo-flow.spec.ts).
const benignConsole: readonly RegExp[] = [
  /status of 401.*\/auth\/me/,
  /^INFO: Created TensorFlow Lite XNNPACK delegate/,
  /Failed to load resource.*(\.task|\.tflite|\.wasm|\.bin)/i,
  /(model|wasm|whisper|mediapipe).*(load|fetch|unavailable|not found)/i,
  /\/exam\/attempts\/[^/]+\/audio/,
  /Failed to load resource.*(409|422|503|501)/i,
  /status of 403.*\/liveness-challenge$/,
];

async function installMicShim(page: Page): Promise<void> {
  // The app only accepts a "built-in" labelled mic; present Chromium's synthetic one as such.
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
}

interface Session {
  app: ElectronApplication;
  page: Page;
  userData: string;
  consoleErrors: string[];
  pageErrors: string[];
}

async function launch(target: Target, mode?: 'strict'): Promise<Session> {
  await waitForPortsFree(20 * 60_000);
  const userData = mkdtempSync(join(tmpdir(), 'eac-electron-test-'));
  if (mode) writeFileSync(join(userData, 'settings.json'), JSON.stringify({ mode }) + '\n');
  const spec = target.launch(userData);
  const app = await electron.launch({
    executablePath: spec.executablePath,
    args: spec.args,
    env: { ...(process.env as Record<string, string>), ...spec.env },
    timeout: 120_000,
  });
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const page = await app.firstWindow();
  page.on('pageerror', (e) => pageErrors.push(`${e.name}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(`${m.text()} @ ${m.location().url}`);
  });
  page.on('dialog', (d) => void d.accept());
  await installMicShim(page);
  await page.waitForURL('http://127.0.0.1:5173/**', { timeout: 120_000 }).catch(() => undefined);
  await page.reload();
  return { app, page, userData, consoleErrors, pageErrors };
}

async function shutdown(s: Session): Promise<void> {
  const child = s.app.process();
  await Promise.race([
    s.app.close().catch(() => undefined),
    new Promise((r) => setTimeout(r, 30_000)),
  ]);
  // Only ever signal the process this test started.
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  expect(await waitPortsReleased(), 'ports 3000/5173 free after quit (no orphan server)').toBe(
    true,
  );
}

async function signInWithRetry(page: Page): Promise<void> {
  // The demo accounts are seeded in the background on first launch; retry until sign-in works.
  const deadline = Date.now() + 120_000;
  for (;;) {
    await page.getByLabel('Email address').fill(student.email);
    await page.getByLabel('Password', { exact: true }).fill(student.password);
    await page.locator('button.auth-submit').click();
    // The pre-exam check runs right after sign-in, before the exam list.
    const ok = await page
      .getByRole('heading', { name: 'Your assigned exams' })
      .or(page.getByRole('heading', { name: /Security Gate|Pre-exam check|Pre-flight/ }))
      .first()
      .waitFor({ timeout: 8_000 })
      .then(
        () => true,
        () => false,
      );
    if (ok) return;
    if (Date.now() > deadline) throw new Error('could not sign in as the demo student');
    await page.waitForTimeout(3_000);
    await page.reload();
  }
}

test.describe.configure({ mode: 'serial' });
mkdirSync(shotDir, { recursive: true });

for (const target of targets) {
  const slug = target.name.replace(/\s+/g, '-');

  test.describe(target.name, () => {
    test.skip(target.skipReason() !== null, target.skipReason() ?? '');

    test('demo mode: full student exam flow', async () => {
      const s = await launch(target);
      const shot = (name: string) =>
        s.page.screenshot({ path: join(shotDir, `${slug}-demo-${name}.png`) });
      try {
        const { page } = s;
        await expect(page.getByRole('note', { name: 'Demo mode' })).toBeVisible({
          timeout: 120_000,
        });
        await shot('1-signin');

        await signInWithRetry(page);
        // Pre-exam check: in demo mode findings are listed and never block; no quit buttons.
        // When nothing is found it passes by itself and goes straight to the exam list.
        const cont = page.getByRole('button', { name: 'Continue (demo mode)' });
        const list = page.getByRole('heading', { name: 'Your assigned exams' });
        await expect(cont.or(list)).toBeVisible({ timeout: 60_000 });
        if (await cont.isVisible()) {
          await expect(page.getByText(/Demo mode: these findings are shown/)).toBeVisible();
          await expect(page.getByRole('button', { name: /Quit normally|Force Quit/ })).toHaveCount(
            0,
          );
          await shot('2-preflight-findings');
          await cont.click();
        } else {
          test
            .info()
            .annotations.push({ type: 'preflight', description: 'passed without findings' });
        }
        await expect(list).toBeVisible();
        await page
          .getByRole('button', { name: /^(Start|Open) exam$/ })
          .first()
          .click();
        const consent = page.getByRole('heading', { name: 'Before you begin' });
        await expect(consent).toBeVisible();
        const grant = page.getByRole('button', { name: /Grant Camera & Microphone Access/ });
        await page.getByRole('checkbox').check();
        await grant.click();
        await shot('3-consent');
        await page.getByRole('button', { name: 'I Agree — Start Exam' }).click();

        await expect(page.locator('.exam-shell')).toBeVisible();
        const camera = page.getByRole('region', { name: 'Camera checks' });
        const audio = page.getByRole('region', { name: 'Audio checks' });
        await expect(camera.getByRole('button', { name: 'Stop camera checks' })).toBeVisible();
        await expect(audio.getByRole('button', { name: 'Stop audio' })).toBeVisible();
        await expect(camera.getByText('Camera active')).toBeVisible({ timeout: 60_000 });
        await expect(audio.getByText(/^Microphone active:/)).toBeVisible({ timeout: 60_000 });
        await shot('4-sensors');

        const answerArea = page.locator('.answer-area');
        const saved = page.waitForResponse(
          (r) => r.request().method() === 'PUT' && /\/answers$/.test(new URL(r.url()).pathname),
        );
        const radio = answerArea.locator('input[type="radio"]').first();
        const numeric = answerArea.locator('input[type="number"]');
        const text = answerArea.locator('textarea, input[type="text"]').first();
        if (await radio.count()) await radio.check();
        else if (await numeric.count()) await numeric.pressSequentially('32', { delay: 20 });
        else await text.pressSequentially('Typed by the electron test.', { delay: 20 });
        expect((await saved).ok()).toBe(true);
        await expect(page.locator('.topbar-chip--save')).toContainText('Saved');

        const banner = page.locator('.brightness-banner');
        if (await banner.isVisible()) {
          // PRODUCT BUG (reported): in demo mode the bottom "Demo mode: Terminal and ChatGPT are
          // exempt" strip covers this banner, so a real click is intercepted. Dispatch directly.
          await shot('4b-brightness-banner-covered');
          await banner.locator('.brightness-close').dispatchEvent('click');
        }
        await page.getByRole('button', { name: /Verify I.m here/ }).click();
        const dialog = page.getByRole('dialog');
        await expect(dialog.getByRole('heading', { name: 'Quick presence check' })).toBeVisible();
        await dialog.getByRole('button', { name: 'Start', exact: true }).click();
        await expect(
          dialog.locator('p').filter({ hasText: /Check passed|Verified\. Thank you|Not verified/ }),
        ).toBeVisible({ timeout: 60_000 });
        await shot('5-liveness');
        await dialog.getByRole('button', { name: 'Close', exact: true }).click();
        await expect(dialog).toBeHidden();

        await page.getByRole('button', { name: 'Submit Exam' }).click();
        await expect(page.getByText('✅ Submitted')).toBeVisible();
        const report = page.getByRole('region', { name: 'What monitoring recorded' });
        await expect(report).toBeVisible();
        await expect(report.getByText('Loading report…')).toBeHidden();
        await expect(report.getByRole('alert')).toHaveCount(0);
        await shot('6-report');

        expect(s.pageErrors, 'uncaught page errors').toEqual([]);
        expect(
          s.consoleErrors.filter((e) => !benignConsole.some((p) => p.test(e))),
          'unexpected console errors',
        ).toEqual([]);
        expect(existsSync(join(s.userData, 'logs', 'api.log')), 'api.log in throwaway dir').toBe(
          true,
        );
      } catch (error) {
        await s.page
          .screenshot({ path: join(shotDir, `${slug}-demo-FAILURE.png`) })
          .catch(() => undefined);
        const log = join(s.userData, 'logs', 'api.log');
        if (existsSync(log))
          console.log(readFileSync(log, 'utf8').split('\n').slice(-30).join('\n'));
        throw error;
      } finally {
        await shutdown(s);
        rmSync(s.userData, { recursive: true, force: true });
      }
    });

    test('strict mode: pre-exam check blocks and lists apps (nothing is quit)', async () => {
      // Strict via settings.json; both builds still seed the demo accounts (judge flag).
      const s = await launch(target, 'strict');
      try {
        const { page } = s;
        await expect(page.getByRole('note', { name: 'Demo mode' })).toHaveCount(0);
        await signInWithRetry(page);
        await expect(page.getByRole('heading', { name: /Security Gate/ })).toBeVisible({
          timeout: 60_000,
        });
        await expect(page.getByRole('button', { name: 'Continue (demo mode)' })).toHaveCount(0);
        await expect(page.getByText(/Save your work, then request a normal quit/)).toBeVisible();
        const items = page.locator('li').filter({ has: page.locator('strong') });
        const names = (await items.locator('strong').allTextContents()).map((n) => n.trim());
        const quittable = (
          await items
            .filter({ has: page.getByRole('button', { name: 'Quit normally' }) })
            .locator('strong')
            .allTextContents()
        ).map((n) => n.trim());
        await page.screenshot({ path: join(shotDir, `${slug}-strict-gate.png`) });
        writeFileSync(
          join(shotDir, `${slug}-strict-apps.json`),
          JSON.stringify({ all: names, withQuitButton: quittable }, null, 2),
        );
        console.log(`[${target.name}] strict list: ${names.join(' | ')}`);
        console.log(`[${target.name}] with Quit button: ${quittable.join(' | ')}`);
        expect(names.length).toBeGreaterThan(0);
        // NEVER click Quit / Force Quit here: these are the tester's real applications.
      } finally {
        await shutdown(s);
        rmSync(s.userData, { recursive: true, force: true });
      }
    });
  });
}
