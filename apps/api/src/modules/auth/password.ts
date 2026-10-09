import { randomBytes, timingSafeEqual } from 'node:crypto';
import * as crypto from 'node:crypto';

import { DomainError } from '@examguard/contracts';
import { argon2id as wasmArgon2id } from 'hash-wasm';

export const ARGON2_MEMORY_KIB = 19_456;
export const ARGON2_PASSES = 2;
export const ARGON2_PARALLELISM = 1;
export const ARGON2_TAG_LENGTH = 32;
export const ARGON2_SALT_LENGTH = 16;

type Argon2Parameters = {
  readonly message: Buffer;
  readonly nonce: Buffer;
  readonly memory: number;
  readonly passes: number;
  readonly parallelism: number;
  readonly tagLength: number;
};

type Argon2Callback = (error: Error | null | undefined, derivedKey?: Buffer) => void;

type NativeCrypto = {
  readonly argon2?: (
    algorithm: 'argon2id',
    parameters: Argon2Parameters,
    callback: Argon2Callback,
  ) => void;
};

const nativeArgon2 = (crypto as unknown as NativeCrypto).argon2;

function assertPasswordLength(password: string): void {
  if (password.length === 0 || password.length > 1024) {
    throw new DomainError('validation_failed', 'Password length is outside the supported range.');
  }
}

export type Argon2Implementation = (password: string, salt: Buffer) => Promise<Buffer>;

/** Native node:crypto Argon2id. Rejects with ERR_CRYPTO_ARGON2_NOT_SUPPORTED on BoringSSL builds (Electron). */
export const nativeArgon2Implementation: Argon2Implementation = (password, salt) =>
  new Promise((resolve, reject) => {
    if (nativeArgon2 === undefined) {
      reject(
        Object.assign(new Error('Node crypto.argon2 is unavailable.'), {
          code: 'ERR_CRYPTO_ARGON2_NOT_SUPPORTED',
        }),
      );
      return;
    }

    // Electron's Node throws synchronously; the Promise executor turns that into a rejection.
    nativeArgon2(
      'argon2id',
      {
        message: Buffer.from(password, 'utf8'),
        nonce: salt,
        memory: ARGON2_MEMORY_KIB,
        passes: ARGON2_PASSES,
        parallelism: ARGON2_PARALLELISM,
        tagLength: ARGON2_TAG_LENGTH,
      },
      (error, derivedKey) => {
        if (error !== undefined && error !== null) {
          reject(error);
          return;
        }

        if (derivedKey === undefined) {
          reject(new Error('Node crypto.argon2 returned no derived key.'));
          return;
        }

        resolve(derivedKey);
      },
    );
  });

/** Pure-WASM Argon2id (hash-wasm); identical parameters and output to the native path. */
export const wasmArgon2Implementation: Argon2Implementation = async (password, salt) => {
  const digest = await wasmArgon2id({
    password,
    salt,
    parallelism: ARGON2_PARALLELISM,
    iterations: ARGON2_PASSES,
    memorySize: ARGON2_MEMORY_KIB,
    hashLength: ARGON2_TAG_LENGTH,
    outputType: 'binary',
  });
  return Buffer.from(digest);
};

function isUnsupportedError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'ERR_CRYPTO_ARGON2_NOT_SUPPORTED'
  );
}

let nativeUnsupported = false;

/** Native first; falls back to WASM (and remembers) when native Argon2 is unsupported. */
export const defaultArgon2Implementation: Argon2Implementation = async (password, salt) => {
  if (!nativeUnsupported) {
    try {
      return await nativeArgon2Implementation(password, salt);
    } catch (error) {
      if (!isUnsupportedError(error)) {
        throw error;
      }
      nativeUnsupported = true;
    }
  }

  return wasmArgon2Implementation(password, salt);
};

function encodePhcBase64(value: Buffer): string {
  return value.toString('base64').replace(/=+$/u, '');
}

function decodePhcBase64(value: string): Buffer | null {
  if (value.length % 4 === 1 || !/^[A-Za-z0-9+/]+$/u.test(value)) {
    return null;
  }

  const padding = '='.repeat((4 - (value.length % 4)) % 4);
  const decoded = Buffer.from(`${value}${padding}`, 'base64');

  return encodePhcBase64(decoded) === value ? decoded : null;
}

interface ParsedPasswordHash {
  readonly salt: Buffer;
  readonly digest: Buffer;
}

function parsePasswordHash(encoded: string): ParsedPasswordHash | null {
  const match = /^\$argon2id\$v=(\d+)\$m=(\d+),t=(\d+),p=(\d+)\$([^$]+)\$([^$]+)$/u.exec(encoded);

  if (match === null) {
    return null;
  }

  const [, version, memory, passes, parallelism, encodedSalt, encodedDigest] = match;
  if (
    version !== '19' ||
    memory !== String(ARGON2_MEMORY_KIB) ||
    passes !== String(ARGON2_PASSES) ||
    parallelism !== String(ARGON2_PARALLELISM) ||
    encodedSalt === undefined ||
    encodedDigest === undefined
  ) {
    return null;
  }

  const salt = decodePhcBase64(encodedSalt);
  const digest = decodePhcBase64(encodedDigest);
  if (salt === null || digest === null) {
    return null;
  }

  if (salt.length !== ARGON2_SALT_LENGTH || digest.length !== ARGON2_TAG_LENGTH) {
    return null;
  }

  return { salt, digest };
}

export async function hashPassword(
  password: string,
  derive: Argon2Implementation = defaultArgon2Implementation,
): Promise<string> {
  assertPasswordLength(password);

  const salt = randomBytes(ARGON2_SALT_LENGTH);
  const digest = await derive(password, salt);

  return [
    '$argon2id$v=19',
    `m=${ARGON2_MEMORY_KIB},t=${ARGON2_PASSES},p=${ARGON2_PARALLELISM}`,
    encodePhcBase64(salt),
    encodePhcBase64(digest),
  ].join('$');
}

export async function verifyPassword(
  password: string,
  encodedHash: string,
  derive: Argon2Implementation = defaultArgon2Implementation,
): Promise<boolean> {
  assertPasswordLength(password);

  const parsed = parsePasswordHash(encodedHash);
  if (parsed === null) {
    return false;
  }

  const digest = await derive(password, parsed.salt);
  return digest.length === parsed.digest.length && timingSafeEqual(digest, parsed.digest);
}
