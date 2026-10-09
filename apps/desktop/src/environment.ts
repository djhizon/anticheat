export interface VirtualMachineResult {
  virtual: boolean;
  reason: string | null;
}

const VM_MODEL = /VMware|Parallels|VirtualBox|VirtualMac|QEMU/i;
const VM_PRODUCT = /VMware|VirtualBox|KVM|QEMU|Virtual Machine|Parallels|Bochs|Xen|HVM/i;
const CAPTURE_LABEL =
  /elgato|avermedia|cam link|capture|blackmagic|magewell|hdmi to usb|dummy|headless/i;

function attempt(run: (cmd: string) => string, cmd: string): string | null {
  try {
    return String(run(cmd)).trim();
  } catch {
    return null;
  }
}

export function detectVirtualMachine(
  run: (cmd: string) => string,
  platform: string = process.platform,
): VirtualMachineResult {
  if (platform === 'darwin') {
    if (attempt(run, 'sysctl -n kern.hv_vmm_present') === '1')
      return { virtual: true, reason: 'Hypervisor detected' };
    const model = attempt(run, 'sysctl -n hw.model');
    if (model && VM_MODEL.test(model))
      return { virtual: true, reason: `Virtual hardware model detected (${model})` };
  } else if (platform === 'linux') {
    const virt = attempt(run, 'systemd-detect-virt');
    if (virt && virt !== 'none') return { virtual: true, reason: `Hypervisor detected (${virt})` };
    const product = attempt(run, 'cat /sys/class/dmi/id/product_name');
    if (product && VM_PRODUCT.test(product))
      return { virtual: true, reason: `Virtual hardware model detected (${product})` };
  }
  return { virtual: false, reason: null };
}

export function classifyDisplays(
  displays: Array<{
    label?: string;
    size: { width: number; height: number };
    internal?: boolean;
  }>,
): { count: number; captureLike: string[] } {
  const captureLike = displays
    .map((d) => (typeof d.label === 'string' ? d.label : ''))
    .filter((label) => label !== '' && CAPTURE_LABEL.test(label));
  return { count: displays.length, captureLike };
}
