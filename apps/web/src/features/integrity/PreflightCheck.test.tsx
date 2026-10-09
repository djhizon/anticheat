// @vitest-environment jsdom
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PreflightCheck } from './PreflightCheck.js';
import { DevelopmentExemptions } from './DevelopmentExemptions.js';
import { DemoModeBanner } from './DemoModeBanner.js';
import type { DesktopAppTarget } from './desktopApps.js';

const target = (name = 'Notes', exempt = false): DesktopAppTarget => ({
  id: name,
  name,
  exempt,
  protected: exempt,
  reason: exempt ? 'Temporary exemption' : '',
  canForce: false,
});

describe('desktop preflight recovery', () => {
  let root: Root;
  let container: HTMLDivElement;
  const passed = vi.fn();
  const cancelled = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    Reflect.deleteProperty(window, 'electronExam');
    vi.useRealTimers();
  });
  async function render(
    listAppTargets: () => Promise<unknown>,
    getDisplayCount = () => Promise.resolve(1),
    extra: Record<string, unknown> = {},
  ) {
    Object.assign(window, {
      electronExam: {
        listAppTargets,
        getDisplayCount,
        ...extra,
        closeAppTarget: vi.fn(async () => ({ status: 'cancelled', message: 'Cancelled' })),
      },
    });
    await act(async () =>
      root.render(
        <StrictMode>
          <PreflightCheck onPassed={passed} onCancel={cancelled} />
        </StrictMode>,
      ),
    );
  }
  function click(label: string) {
    const button = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === label,
    );
    expect(button).toBeDefined();
    button!.click();
  }

  it('passes a valid native response without duplicate completion in StrictMode', async () => {
    await render(async () => [target('Exam', true)]);
    expect(passed).toHaveBeenCalledTimes(1);
  });
  it('shows native check rejection and lets the user sign out', async () => {
    await render(async () => {
      throw new Error('IPC failed');
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('failed');
    await act(async () => click('Sign out'));
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(passed).not.toHaveBeenCalled();
  });
  it('rejects malformed application lists instead of crashing or passing', async () => {
    await render(async () => null);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('failed');
    expect(passed).not.toHaveBeenCalled();
  });
  it('rejects an empty inventory rather than treating failed discovery as clear', async () => {
    await render(async () => []);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('failed');
    expect(passed).not.toHaveBeenCalled();
  });
  it('times out a stalled IPC and ignores a late success', async () => {
    let resolve!: (apps: string[]) => void;
    await render(
      () =>
        new Promise<string[]>((done) => {
          resolve = done;
        }),
    );
    await act(async () => vi.advanceTimersByTime(8000));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('timed out');
    await act(async () => resolve([]));
    expect(passed).not.toHaveBeenCalled();
  });
  it('can retry after a failed check', async () => {
    const apps = vi
      .fn()
      .mockRejectedValueOnce(new Error('IPC failed'))
      .mockResolvedValue([target('Exam', true)]);
    await render(apps);
    await act(async () => click('Re-check Environment'));
    expect(passed).toHaveBeenCalledTimes(1);
  });
  it('continues blocking extra displays and disallowed apps', async () => {
    await render(async () => [target()]);
    expect(container.textContent).toContain('Notes');
    expect(
      [...container.querySelectorAll('button')].some((button) =>
        button.textContent?.includes('Force Close'),
      ),
    ).toBe(false);
    expect(container.textContent).toContain('Save your work');
    expect(
      [...container.querySelectorAll('button')].some(
        (button) => button.textContent === 'Quit normally',
      ),
    ).toBe(true);
    expect(passed).not.toHaveBeenCalled();
    await act(async () => root.unmount());
    root = createRoot(container);
    await render(
      async () => [],
      () => Promise.resolve(2),
    );
    expect(container.textContent).toContain('Multiple Displays Detected');
    expect(passed).not.toHaveBeenCalled();
  });
  it('exempts Terminal and ChatGPT with no close buttons and keeps the reminder visible', async () => {
    await render(async () => [target('Terminal', true), target('ChatGPT', true)], undefined, {
      getRunMode: async () => 'demo',
    });
    expect(passed).toHaveBeenCalledTimes(1);
    await act(async () => root.render(<DevelopmentExemptions />));
    expect(container.textContent).toContain('Demo mode: Terminal and ChatGPT are exempt');
    expect(container.querySelector('button')).toBeNull();
  });
  it('shows the exemptions banner only in demo mode', async () => {
    await render(async () => [target('Exam', true)], undefined, {
      getRunMode: async () => 'strict',
    });
    await act(async () => root.render(<DevelopmentExemptions />));
    expect(container.textContent).toBe('');
  });
  it('shows the persistent demo banner only in demo mode', async () => {
    await render(async () => [target('Exam', true)], undefined, { getRunMode: async () => 'demo' });
    await act(async () => root.render(<DemoModeBanner />));
    expect(container.textContent).toContain('Demo mode — nothing is closed or blocked');
    await act(async () => root.unmount());
    root = createRoot(container);
    await render(async () => [target('Exam', true)], undefined, {
      getRunMode: async () => 'strict',
    });
    await act(async () => root.render(<DemoModeBanner />));
    expect(container.textContent).toBe('');
  });
  describe('demo mode', () => {
    const demo = { getRunMode: async () => 'demo' };
    it('lists findings with a continue button and no quit buttons', async () => {
      await render(
        async () => [target('Notes'), { ...target('Safari'), canForce: true }],
        () => Promise.resolve(2),
        {
          ...demo,
          getEnvironmentRisk: async () => ({
            virtualMachine: 'Hypervisor detected',
            captureDisplays: ['Cam Link'],
          }),
        },
      );
      expect(container.textContent).toContain('Notes');
      expect(container.textContent).toContain('Hypervisor detected');
      expect(container.textContent).toContain('Cam Link');
      expect(container.textContent).toContain('Multiple Displays Detected');
      const labels = [...container.querySelectorAll('button')].map((b) => b.textContent);
      expect(labels).toContain('Continue (demo mode)');
      expect(labels).not.toContain('Quit normally');
      expect(labels).not.toContain('Force Quit…');
      expect(passed).not.toHaveBeenCalled();
      await act(async () => click('Continue (demo mode)'));
      expect(passed).toHaveBeenCalledTimes(1);
    });
    it('still passes silently when there are no findings', async () => {
      await render(async () => [target('Exam', true)], undefined, demo);
      expect(passed).toHaveBeenCalledTimes(1);
    });
  });
  it('strict mode keeps blocking, with quit buttons and no continue button', async () => {
    await render(
      async () => [target('Notes')],
      () => Promise.resolve(2),
      { getRunMode: async () => 'strict' },
    );
    const labels = [...container.querySelectorAll('button')].map((b) => b.textContent);
    expect(labels).not.toContain('Continue (demo mode)');
    expect(container.textContent).toContain('Multiple Displays Detected');
    expect(passed).not.toHaveBeenCalled();
  });
  it('renders force quit only when the native controller grants eligibility', async () => {
    await render(async () => [{ ...target(), canForce: true }, target('Terminal', true)]);
    const buttons = [...container.querySelectorAll('button')].map((button) => button.textContent);
    expect(buttons.filter((label) => label === 'Quit normally')).toHaveLength(1);
    expect(buttons.filter((label) => label === 'Force Quit…')).toHaveLength(1);
    await act(async () => click('Force Quit…'));
    expect(
      (window as unknown as { electronExam: { closeAppTarget: unknown } }).electronExam
        .closeAppTarget,
    ).toHaveBeenCalledWith('Notes', 'force');
    expect(container.textContent).toContain('Cancelled');
  });
  it('blocks inside a virtual machine', async () => {
    await render(async () => [target('Exam', true)], undefined, {
      getEnvironmentRisk: async () => ({
        virtualMachine: 'Hypervisor detected',
        captureDisplays: [],
      }),
    });
    expect(container.textContent).toContain("This exam can't run inside a virtual machine.");
    expect(container.textContent).toContain('Hypervisor detected');
    expect(passed).not.toHaveBeenCalled();
  });
  it('blocks capture displays', async () => {
    await render(async () => [target('Exam', true)], undefined, {
      getEnvironmentRisk: async () => ({ virtualMachine: null, captureDisplays: ['Cam Link'] }),
    });
    expect(container.textContent).toContain('disconnect capture or mirroring');
    expect(passed).not.toHaveBeenCalled();
  });
  it('does not block when risk data is missing or throws', async () => {
    await render(async () => [target('Exam', true)]);
    expect(passed).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
    root = createRoot(container);
    await render(async () => [target('Exam', true)], undefined, {
      getEnvironmentRisk: async () => {
        throw new Error('x');
      },
    });
    expect(passed).toHaveBeenCalledTimes(2);
  });
});
