import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  hashPassword,
  nativeArgon2Implementation,
  verifyPassword,
  wasmArgon2Implementation,
} from './password.js';

// Reference vector: argon2id v=19 m=19456 t=2 p=1, password "password", salt "somesaltsomesalt",
// 32-byte tag, computed with OpenSSL (node:crypto) and checked against hash-wasm.
const VECTOR_SALT = Buffer.from('somesaltsomesalt', 'utf8');
const VECTOR_HEX = '2b5dc4054886ec957ef59c73b661c54dd6fb274590b278f657c6d96aac8fa6d1';
const PHC_PATTERN = /^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/u;

afterEach(() => {
  vi.doUnmock('node:crypto');
  vi.resetModules();
});

describe('password hashing implementations', () => {
  it('native and WASM match the known test vector', async () => {
    const native = await nativeArgon2Implementation('password', VECTOR_SALT);
    const wasm = await wasmArgon2Implementation('password', VECTOR_SALT);
    expect(native.toString('hex')).toBe(VECTOR_HEX);
    expect(wasm.toString('hex')).toBe(VECTOR_HEX);
  });

  it('native hash verifies with WASM and vice versa', async () => {
    const nativeHash = await hashPassword('Correct horse 1!', nativeArgon2Implementation);
    const wasmHash = await hashPassword('Correct horse 1!', wasmArgon2Implementation);
    expect(nativeHash).toMatch(PHC_PATTERN);
    expect(wasmHash).toMatch(PHC_PATTERN);
    expect(await verifyPassword('Correct horse 1!', nativeHash, wasmArgon2Implementation)).toBe(
      true,
    );
    expect(await verifyPassword('Correct horse 1!', wasmHash, nativeArgon2Implementation)).toBe(
      true,
    );
  });

  it('rejects wrong passwords on both paths', async () => {
    const hash = await hashPassword('Correct horse 1!', wasmArgon2Implementation);
    expect(await verifyPassword('wrong', hash, wasmArgon2Implementation)).toBe(false);
    expect(await verifyPassword('wrong', hash, nativeArgon2Implementation)).toBe(false);
  });

  it('default implementation falls back to WASM when native Argon2 is unsupported', async () => {
    const nativeHash = await hashPassword('Correct horse 1!', nativeArgon2Implementation);

    vi.resetModules();
    vi.doMock('node:crypto', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:crypto')>();
      const argon2 = (): never => {
        throw Object.assign(new Error('Argon2 algorithm not supported'), {
          code: 'ERR_CRYPTO_ARGON2_NOT_SUPPORTED',
        });
      };
      return { ...actual, argon2, default: { ...actual, argon2 } };
    });
    const mocked = await import('./password.js');

    await expect(mocked.nativeArgon2Implementation('password', VECTOR_SALT)).rejects.toMatchObject({
      code: 'ERR_CRYPTO_ARGON2_NOT_SUPPORTED',
    });
    expect(await mocked.verifyPassword('Correct horse 1!', nativeHash)).toBe(true);
    expect(await mocked.verifyPassword('nope', nativeHash)).toBe(false);
    const fallbackHash = await mocked.hashPassword('Correct horse 1!');
    expect(await verifyPassword('Correct horse 1!', fallbackHash, nativeArgon2Implementation)).toBe(
      true,
    );
  });
});
