import { companionUrl } from './companionUrl.js';

export function nativePhoneUrl(origin: string, code: string): string {
  const validated = new URL(companionUrl(origin.trim(), code, 'native'));
  if (
    validated.protocol === 'http:' &&
    !/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(validated.hostname)
  ) {
    throw new Error('HTTP demo pairing requires a private Wi-Fi IPv4 address.');
  }
  const link = new URL('examcompanion://pair');
  link.searchParams.set('origin', validated.origin);
  link.searchParams.set('code', code);
  return link.href;
}
