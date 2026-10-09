import { randomBytes, timingSafeEqual } from 'node:crypto';
import * as crypto from 'node:crypto';

import { DomainError } from '@exam-anti-cheat/contracts';

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

function deriveArgon2id(password: string, salt: Buffer): Promise<Buffer> {
  if (nativeArgon2 === undefined) {
    return Promise.reject(new Error('Node crypto.argon2 is required for password hashing.'));
  }

  return new Promise((resolve, reject) => {
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
}

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

export async function hashPassword(password: string): Promise<string> {
  assertPasswordLength(password);

  const salt = randomBytes(ARGON2_SALT_LENGTH);
  const digest = await deriveArgon2id(password, salt);

  return [
    '$argon2id$v=19',
    `m=${ARGON2_MEMORY_KIB},t=${ARGON2_PASSES},p=${ARGON2_PARALLELISM}`,
    encodePhcBase64(salt),
    encodePhcBase64(digest),
  ].join('$');
}

export async function verifyPassword(password: string, encodedHash: string): Promise<boolean> {
  assertPasswordLength(password);

  const parsed = parsePasswordHash(encodedHash);
  if (parsed === null) {
    return false;
  }

  const digest = await deriveArgon2id(password, parsed.salt);
  return digest.length === parsed.digest.length && timingSafeEqual(digest, parsed.digest);
}
