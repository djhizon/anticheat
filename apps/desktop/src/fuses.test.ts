import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

describe('packaging hardening', () => {
  it('flips the security fuses', () => {
    const { FUSES } = require('../scripts/adhoc-sign.cjs') as { FUSES: Record<string, boolean> };
    expect(FUSES).toEqual({
      runAsNode: false,
      enableCookieEncryption: true,
      enableNodeOptionsEnvironmentVariable: false,
      enableNodeCliInspectArguments: false,
      enableEmbeddedAsarIntegrityValidation: true,
      onlyLoadAppFromAsar: true,
    });
  });

  it('enables the hardened runtime with the entitlements V8 and the media devices need', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      build: { mac: { hardenedRuntime: boolean } };
    };
    expect(pkg.build.mac.hardenedRuntime).toBe(true);
    const plist = readFileSync(
      new URL('../assets/entitlements.mac.plist', import.meta.url),
      'utf8',
    );
    for (const key of [
      'com.apple.security.cs.allow-jit',
      'com.apple.security.cs.allow-unsigned-executable-memory',
      'com.apple.security.cs.disable-library-validation',
      'com.apple.security.device.camera',
      'com.apple.security.device.audio-input',
    ])
      expect(plist).toContain(key);
  });
});
