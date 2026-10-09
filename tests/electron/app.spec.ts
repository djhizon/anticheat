import { _electron as electron, chromium, expect, test, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// End-to-end rehearsal of the desktop app judges install. Every run uses a throwaway Electron
// userData directory (`--user-data-dir`), so real app data is never touched.
// Never clicks Quit / Force quit on real applications.
//
// Two launch drivers:
// - dev build: Playwright's `_electron.launch` (needs the Node inspector, which the packaged
//   build's fuses disable).
// - packaged app: the binary is started directly with `--remote-debugging-port=0`, the DevTools
//   endpoint is read from stderr and Playwright connects over CDP. There is no main-process
//   `evaluate`; everything is checked from the renderer. The judge build is the only packaged
//   build that accepts the switch (see `refusesRemoteDebugging` in apps/desktop/src/main.ts).

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const shotDir = join(root, 'test-results/electron');
const student = { email: 'demo.student@example.test', password: 'Demo exam password 2026!' };
const fakeMedia = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'];
const viewport = { width: 1280, height: 800 };

function packagedBinary(): string {
  return (
    process.env.EAC_PACKAGED_APP ??
    join(root, 'apps/desktop/release/mac/ExamGuard.app/Contents/MacOS/ExamGuard')
  );
}

interface Target {
  name: string;
  driver: 'electron' | 'cdp';
  skipReason: () => string | null;
}

const targets: Target[] = [
  {
    name: 'dev build',
    driver: 'electron',
    skipReason: () =>
      existsSync(join(root, 'apps/desktop/dist/main.js')) &&
      existsSync(join(root, 'apps/api/dist/api-server.mjs')) &&
      existsSync(join(root, 'apps/web/dist/index.html'))
        ? null
        : 'run npm run build:server and npm run build --workspace @examguard/desktop',
  },
  {
    name: 'packaged app',
    driver: 'cdp',
    skipReason: () =>
      existsSync(packagedBinary()) ? null : 'run npm run package:mac to build the packaged app',
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

interface Exit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

function exited(child: ChildProcess): Promise<Exit> {
  return new Promise((done) => {
    if (child.exitCode !== null || child.signalCode !== null)
      done({ code: child.exitCode, signal: child.signalCode });
    else child.once('exit', (code, signal) => done({ code, signal }));
  });
}

interface Launched {
  page: Page;
  process: ChildProcess;
  /** Asks the app to quit; resolves with how the process ended (SIGKILL only as a last resort). */
  quit: () => Promise<Exit & { forced: boolean }>;
  stderrTail: () => string;
}

/** Dev build: Playwright's Electron driver (main-process inspector available). */
async function launchElectron(args: string[], env: Record<string, string>): Promise<Launched> {
  const app = await electron.launch({
    args: [join(root, 'apps/desktop/dist/main.js'), ...args],
    env: { ...(process.env as Record<string, string>), ...env },
    timeout: 120_000,
  });
  const child = app.process();
  const page = await app.firstWindow();
  return {
    page,
    process: child,
    stderrTail: () => '',
    quit: async () => {
      const done = exited(child);
      await Promise.race([
        app.close().catch(() => undefined),
        new Promise((r) => setTimeout(r, 30_000)),
      ]);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      const exit = await Promise.race([
        done,
        new Promise<null>((r) => setTimeout(() => r(null), 20_000)),
      ]);
      if (exit) return { ...exit, forced: false };
      child.kill('SIGKILL');
      return { ...(await done), forced: true };
    },
  };
}

/**
 * Packaged app: spawn the binary with a random DevTools port, read "DevTools listening on ws://…"
 * from stderr and connect over CDP. Quit is a SIGTERM, which Electron turns into a normal
 * `before-quit` so the bundled server is stopped and the ports are released.
 */
async function launchOverCdp(args: string[], env: Record<string, string>): Promise<Launched> {
  const stderr: string[] = [];
  const child = spawn(packagedBinary(), ['--remote-debugging-port=0', ...args], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (chunk: Buffer) => stderr.push(`[stdout] ${chunk.toString()}`));
  const wsEndpoint = await new Promise<string>((done, fail) => {
    let buffer = '';
    const timer = setTimeout(() => fail(new Error('no DevTools endpoint within 60 s')), 60_000);
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderr.push(text);
      buffer += text;
      const match = buffer.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) {
        clearTimeout(timer);
        done(match[1]!);
      }
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      fail(new Error(`app exited before exposing DevTools (code ${code}, signal ${signal})`));
    });
  });
  const browser = await chromium.connectOverCDP(wsEndpoint, { timeout: 60_000 });
  const context = browser.contexts()[0];
  if (!context) throw new Error('no browser context over CDP');
  const deadline = Date.now() + 60_000;
  while (context.pages().length === 0 && Date.now() < deadline)
    await new Promise((r) => setTimeout(r, 200));
  const page = context.pages()[0];
  if (!page) throw new Error('no app window over CDP');
  return {
    page,
    process: child,
    stderrTail: () => stderr.join('').split('\n').slice(-20).join('\n'),
    quit: async () => {
      const done = exited(child);
      child.kill('SIGTERM');
      const exit = await Promise.race([
        done,
        new Promise<null>((r) => setTimeout(() => r(null), 20_000)),
      ]);
      await browser.close().catch(() => undefined);
      if (exit) return { ...exit, forced: false };
      child.kill('SIGKILL');
      return { ...(await done), forced: true };
    },
  };
}

interface Session {
  launched: Launched;
  page: Page;
  userData: string;
  consoleErrors: string[];
  pageErrors: string[];
}

async function launch(target: Target, mode?: 'strict'): Promise<Session> {
  await waitForPortsFree(20 * 60_000);
  const userData = mkdtempSync(join(tmpdir(), 'eac-electron-test-'));
  if (mode) writeFileSync(join(userData, 'settings.json'), JSON.stringify({ mode }) + '\n');
  const args = [`--user-data-dir=${userData}`, ...fakeMedia];
  const launched =
    target.driver === 'electron'
      ? // Unpackaged builds are not the judge build; this test-only flag makes it behave like one.
        await launchElectron(args, { EAC_TEST_JUDGE_BUILD: '1' })
      : await launchOverCdp(args, {});
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const { page } = launched;
  page.on('pageerror', (e) => pageErrors.push(`${e.name}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(`${m.text()} @ ${m.location().url}`);
  });
  page.on('dialog', (d) => void d.accept());
  // Same window size for both drivers (Emulation.setDeviceMetricsOverride under the hood), so
  // screenshots are comparable whatever the display.
  await page.setViewportSize(viewport);
  await installMicShim(page);
  await page.waitForURL('http://127.0.0.1:5173/**', { timeout: 120_000 }).catch(() => undefined);
  await page.reload();
  return { launched, page, userData, consoleErrors, pageErrors };
}

async function shutdown(s: Session): Promise<void> {
  const exit = await s.launched.quit();
  expect(exit.forced, 'app quit on request without SIGKILL').toBe(false);
  // Only ever signal the process this test started; check it really went away.
  expect(
    s.launched.process.exitCode !== null || s.launched.process.signalCode !== null,
    'app process exited',
  ).toBe(true);
  expect(await waitPortsReleased(), 'ports 3000/5173 free after quit (no orphan server)').toBe(
    true,
  );
}

/** Runs `body` against a fresh app session; the app is always quit and its data dir removed. */
async function withSession(
  target: Target,
  mode: 'strict' | undefined,
  body: (s: Session) => Promise<void>,
  onFailure?: (s: Session) => Promise<unknown>,
): Promise<void> {
  const s = await launch(target, mode);
  let failure: unknown = null;
  try {
    await body(s);
  } catch (error) {
    failure = error;
    await onFailure?.(s).catch(() => undefined);
    for (const name of ['logs/api.log', 'desktop-health.log']) {
      const file = join(s.userData, name);
      if (existsSync(file))
        console.log(
          `[${target.name}] ${name} tail:\n${readFileSync(file, 'utf8').split('\n').slice(-30).join('\n')}`,
        );
    }
    const tail = s.launched.stderrTail();
    if (tail) console.log(`[${target.name}] stderr tail:\n${tail}`);
  }
  try {
    await shutdown(s);
  } catch (error) {
    // A shutdown problem must not hide the failure that happened in the test body.
    if (failure === null) failure = error;
    else console.log(`[${target.name}] shutdown after failure: ${String(error)}`);
  } finally {
    rmSync(s.userData, { recursive: true, force: true });
  }
  if (failure !== null) throw failure;
}

async function signInWithRetry(page: Page): Promise<void> {
  // The demo accounts are seeded in the background on first launch; retry until sign-in works.
  // The pre-exam check runs right after sign-in, before the exam list, and may take a while.
  const signedIn = page
    .getByRole('heading', { name: 'Your assigned exams' })
    .or(page.getByRole('heading', { name: /Security Gate|Pre-exam check|Pre-flight/ }))
    .first();
  const email = page.getByLabel('Email address');
  const deadline = Date.now() + 120_000;
  for (;;) {
    await expect(email.or(signedIn).first()).toBeVisible({ timeout: 30_000 });
    if (await signedIn.isVisible()) return; // A reload with a live session skips the form.
    await email.fill(student.email);
    await page.getByLabel('Password', { exact: true }).fill(student.password);
    await page.locator('button.auth-submit').click();
    const outcome = await Promise.race([
      signedIn.waitFor({ timeout: 45_000 }).then(() => 'ok' as const),
      page
        .getByRole('alert')
        .waitFor({ timeout: 45_000 })
        .then(() => 'rejected' as const),
    ]).catch(() => 'timeout' as const);
    if (outcome === 'ok') return;
    if (Date.now() > deadline)
      throw new Error(`could not sign in as the demo student (${outcome})`);
    await page.waitForTimeout(3_000);
    await page.reload();
  }
}

mkdirSync(shotDir, { recursive: true });

for (const target of targets) {
  const slug = target.name.replace(/\s+/g, '-');

  test.describe(target.name, () => {
    // Serial per target: the tests share the fixed ports, but one build's failure must not
    // skip the other build's run.
    test.describe.configure({ mode: 'serial' });
    test.skip(target.skipReason() !== null, target.skipReason() ?? '');

    test('demo mode: full student exam flow', async () => {
      const shotName = (name: string) => join(shotDir, `${slug}-demo-${name}.png`);
      await withSession(
        target,
        undefined,
        async (s) => {
          const shot = (name: string) => s.page.screenshot({ path: shotName(name) });
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
            await expect(
              page.getByRole('heading', {
                name: /Pre-exam check — demo mode, nothing will be closed/,
              }),
            ).toBeVisible();
            await expect(
              page.getByText(
                'These findings are shown for information only. Nothing is closed or blocked.',
              ),
            ).toBeVisible();
            await expect(
              page.getByRole('button', { name: /Quit normally|Force Quit/ }),
            ).toHaveCount(0);
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
            dialog
              .locator('p')
              .filter({ hasText: /Check passed|Verified\. Thank you|Not verified/ }),
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

          // Evidence lightbox (if any snapshot was saved): a real modal. Focus lands on Close,
          // Escape closes it and focus returns to the thumbnail. Needs a build with the a11y fix.
          const gallery = page.locator('section.evidence-gallery').first();
          if (await gallery.count()) {
            await expect(gallery.getByText('Loading snapshots…')).toBeHidden({ timeout: 20_000 });
            const thumb = gallery.locator('button.evidence-thumb').first();
            if (await thumb.count()) {
              await thumb.click();
              const lightbox = gallery.getByRole('dialog');
              await expect(lightbox).toBeVisible();
              await expect(lightbox.getByRole('button', { name: 'Close' })).toBeFocused();
              await page.keyboard.press('Escape');
              await expect(lightbox).toBeHidden();
              await expect(thumb).toBeFocused();
            } else {
              test
                .info()
                .annotations.push({ type: 'evidence', description: 'no snapshots to enlarge' });
            }
          }
        },
        (s) => s.page.screenshot({ path: shotName('FAILURE') }),
      );
    });

    test('strict mode: pre-exam check blocks and lists apps (nothing is quit)', async () => {
      // Strict via settings.json; both builds still seed the demo accounts (judge flag).
      await withSession(target, 'strict', async (s) => {
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
      });
    });
  });
}
