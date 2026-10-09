import { describe, expect, it } from 'vitest';
import { classifyDisplays, detectVirtualMachine } from './environment';

const runner = (map: Record<string, string>) => (cmd: string) => {
  if (cmd in map) return map[cmd];
  throw new Error('fail');
};

describe('detectVirtualMachine', () => {
  it('detects the macOS hypervisor flag', () => {
    const r = detectVirtualMachine(runner({ 'sysctl -n kern.hv_vmm_present': '1\n' }), 'darwin');
    expect(r).toEqual({ virtual: true, reason: 'Hypervisor detected' });
  });
  it('detects a virtual macOS model', () => {
    const r = detectVirtualMachine(
      runner({ 'sysctl -n kern.hv_vmm_present': '0', 'sysctl -n hw.model': 'VMware7,1' }),
      'darwin',
    );
    expect(r.virtual).toBe(true);
  });
  it('passes real hardware', () => {
    const r = detectVirtualMachine(
      runner({ 'sysctl -n kern.hv_vmm_present': '0', 'sysctl -n hw.model': 'Mac14,2' }),
      'darwin',
    );
    expect(r).toEqual({ virtual: false, reason: null });
  });
  it('uses systemd-detect-virt on Linux', () => {
    expect(detectVirtualMachine(runner({ 'systemd-detect-virt': 'kvm' }), 'linux').virtual).toBe(
      true,
    );
    expect(detectVirtualMachine(runner({ 'systemd-detect-virt': 'none' }), 'linux').virtual).toBe(
      false,
    );
  });
  it('treats command failure as not virtual and skips Windows', () => {
    expect(detectVirtualMachine(runner({}), 'darwin').virtual).toBe(false);
    expect(detectVirtualMachine(runner({}), 'linux').virtual).toBe(false);
    expect(detectVirtualMachine(runner({ x: '1' }), 'win32')).toEqual({
      virtual: false,
      reason: null,
    });
  });
});

describe('classifyDisplays', () => {
  it('flags capture-like labels only', () => {
    const size = { width: 1920, height: 1080 };
    const r = classifyDisplays([
      { label: 'Built-in Retina Display', size, internal: true },
      { label: 'Elgato Cam Link 4K', size },
      { size },
    ]);
    expect(r).toEqual({ count: 3, captureLike: ['Elgato Cam Link 4K'] });
  });
});
