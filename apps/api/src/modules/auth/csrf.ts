import type { CsrfToken } from './session.js';
import {
  asAuthOpaqueId,
  CSRF_TOKEN_BYTES,
  hashToken,
  tokenMatchesHash,
  type TokenGenerator,
} from './session.js';

export function issueCsrfToken(tokenGenerator: TokenGenerator): CsrfToken {
  return asAuthOpaqueId<'CsrfToken'>(tokenGenerator.generate(CSRF_TOKEN_BYTES));
}

export function hashCsrfToken(token: string): string {
  return hashToken(token);
}

export function verifySessionCsrfToken(token: string | undefined, expectedHash: string): boolean {
  return tokenMatchesHash(token, expectedHash);
}

export function verifyDoubleSubmitToken(
  headerToken: string | undefined,
  cookieToken: string | undefined,
): boolean {
  if (cookieToken === undefined) {
    return false;
  }

  return tokenMatchesHash(headerToken, hashCsrfToken(cookieToken));
}

export function getCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) {
    return undefined;
  }

  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0 || part.slice(0, separator).trim() !== name) {
      continue;
    }

    const encodedValue = part.slice(separator + 1).trim();
    try {
      return decodeURIComponent(encodedValue);
    } catch {
      return undefined;
    }
  }

  return undefined;
}

export function isAllowedOrigin(
  origin: string | undefined,
  allowedOrigins: readonly string[],
): boolean {
  if (origin === undefined || origin === '' || origin === 'null') {
    return false;
  }

  try {
    const parsed = new URL(origin);
    return parsed.origin === origin && allowedOrigins.includes(parsed.origin);
  } catch {
    return false;
  }
}
