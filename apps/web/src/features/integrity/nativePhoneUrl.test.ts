import { expect, it } from 'vitest';
import { nativePhoneUrl } from './nativePhoneUrl.js';

it('creates a native pairing link, not a legacy browser heartbeat link', () => {
  const url = new URL(nativePhoneUrl('http://192.168.1.8:5173', 'synthetic'));
  expect(url.protocol).toBe('examcompanion:');
  expect(url.host).toBe('pair');
  expect(url.searchParams.get('origin')).toBe('http://192.168.1.8:5173');
  expect(url.searchParams.get('code')).toBe('synthetic');
});
it.each([
  'http://127.0.0.1:5173',
  'http://8.8.8.8',
  'https://user:pass@exam.test',
  'https://exam.test/path',
])('rejects unsafe or unreachable native origins: %s', (origin) => {
  expect(() => nativePhoneUrl(origin, 'synthetic')).toThrow();
});
