import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createAppController, type NativeApp } from './appControl.js';

const sample = (): NativeApp => ({ identity: { pid: 123, bundleId: 'test.notes',
  bundlePath: '/Applications/Test.app', executablePath: '/Applications/Test.app/Contents/MacOS/Test', launchDate: 100 },
  name: 'Test Notes', protected: false, exempt: false, reason: '' });

describe('native app-close authority (simulated applications only)', () => {
  let apps: NativeApp[];
  let time: number;
  let call: ReturnType<typeof vi.fn>;
  let confirm: ReturnType<typeof vi.fn>;
  let controller: ReturnType<typeof createAppController>;
  beforeEach(() => {
    apps = [sample()]; time = 10000;
    call = vi.fn(async (mode: string) => mode === 'list' ? { apps } : { status: 'requested' });
    confirm = vi.fn(async () => true);
    controller = createAppController({ call, confirm, now: () => time });
  });
  const firstId = async () => (await controller.list())[0]!.id;
  const actions = () => call.mock.calls.filter(args => args[0] !== 'list');

  it('requires a normal quit, elapsed grace, then separate force confirmation', async () => {
    const id = await firstId();
    expect((await controller.close(id, 'force')).status).toBe('refused');
    expect(confirm).not.toHaveBeenCalled();
    expect((await controller.close(id, 'quit')).status).toBe('requested');
    expect((await controller.close(id, 'force')).status).toBe('refused');
    time += 3000;
    expect((await controller.list())[0]?.canForce).toBe(true);
    expect((await controller.close(id, 'force')).status).toBe('requested');
    expect(confirm.mock.calls.map(args => args[1])).toEqual(['quit', 'force']);
    expect(actions().map(args => args[0])).toEqual(['quit', 'force']);
    expect((await controller.close(id, 'force')).status).toBe('refused');
  });
  it.each(['protected', 'exempt'] as const)('never offers or executes close for %s targets', async flag => {
    apps[0]![flag] = true;
    const id = await firstId();
    expect((await controller.close(id, 'quit')).status).toBe('refused');
    expect((await controller.close(id, 'force')).status).toBe('refused');
    expect(actions()).toEqual([]);
    expect(confirm).not.toHaveBeenCalled();
  });
  it('rejects replaced processes with reused PIDs', async () => {
    const id = await firstId();
    apps = [{ ...sample(), identity: { ...sample().identity, launchDate: 101 } }];
    expect((await controller.close(id, 'quit')).status).toBe('refused');
    expect(actions()).toEqual([]);
  });
  it('rechecks identity and protection after a confirmation dialog', async () => {
    const id = await firstId();
    confirm.mockImplementation(async () => { apps = [{ ...sample(), protected: true }]; return true; });
    expect((await controller.close(id, 'quit')).status).toBe('refused');
    expect(actions()).toEqual([]);
  });
  it('does not act after cancellation', async () => {
    const id = await firstId();
    confirm.mockResolvedValue(false);
    expect((await controller.close(id, 'quit')).status).toBe('cancelled');
    expect(actions()).toEqual([]);
  });
  it('invalidates pending actions when the document changes', async () => {
    const id = await firstId();
    confirm.mockImplementation(async () => { controller.reset(); return true; });
    expect((await controller.close(id, 'quit')).status).toBe('refused');
    expect(actions()).toEqual([]);
  });
  it('does not convert failed inventory to an empty passing list', async () => {
    call.mockResolvedValue({ error: 'unavailable' });
    await expect(controller.list()).rejects.toThrow('discovery failed');
    call.mockResolvedValue({ apps: [] });
    await expect(controller.list()).rejects.toThrow('unavailable');
    call.mockResolvedValue({ apps: [{ ...sample(), identity: { pid: 123 } }] });
    await expect(controller.list()).rejects.toThrow('Incomplete');
  });
  it('refuses unknown IDs, invalid modes and expired escalation', async () => {
    expect((await controller.close('fake', 'quit')).status).toBe('refused');
    const id = await firstId();
    expect((await controller.close(id, 'kill')).status).toBe('refused');
    await controller.close(id, 'quit');
    time += 60001;
    expect((await controller.close(id, 'force')).status).toBe('refused');
    expect(actions()).toHaveLength(1);
  });
  it('serializes confirmations and handles helper errors without automatic retries', async () => {
    const id = await firstId();
    let answer!: (value: boolean) => void;
    confirm.mockImplementation(() => new Promise<boolean>(resolve => { answer = resolve; }));
    const pending = controller.close(id, 'quit');
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledOnce());
    expect((await controller.close(id, 'quit')).status).toBe('refused');
    call.mockRejectedValue(new Error('native unavailable'));
    answer(true);
    expect((await pending).status).toBe('error');
    expect(actions()).toEqual([]);
  });
});
