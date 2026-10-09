// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { CameraAttestation } from './cameraAttestation.js';
import { CameraGatePanel } from './CameraGatePanel.js';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function render(attestation?: CameraAttestation): string {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <CameraGatePanel
        state={{
          phase: 'ok',
          label: 'FaceTime HD Camera (Built-in) (05ac:8514)',
          deviceId: 'mac',
          ...(attestation ? { attestation } : {}),
        }}
        cameras={{ native: [], virtual: [] }}
        stream={null}
        onCheck={() => {}}
      />,
    ),
  );
  return host.textContent ?? '';
}

describe('CameraGatePanel attestation note', () => {
  it('shows the verified hardware camera in the Mac app', () => {
    const text = render({
      verdict: 'hardware',
      kind: 'builtin',
      reasons: [],
      matchedDevice: { name: 'FaceTime HD Camera (Built-in)', kind: 'builtin' },
    });
    expect(text).toContain('Verified hardware camera: FaceTime HD Camera (Built-in) (built-in)');
  });

  it('notes an unverified camera without blocking', () => {
    const text = render({ verdict: 'unknown', kind: 'unknown', reasons: [], matchedDevice: null });
    expect(text).toContain('Camera check passed');
    expect(text).toContain('could not confirm');
  });

  it('shows nothing extra in a plain browser', () => {
    const text = render();
    expect(text).toContain('Camera check passed');
    expect(text).not.toMatch(/Verified hardware|could not confirm/);
  });
});
