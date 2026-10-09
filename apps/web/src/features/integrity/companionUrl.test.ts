import { describe, expect, it } from 'vitest';
import { companionUrl } from './companionUrl.js';
describe('phone-reachable enrollment URLs', () => {
  it.each([
    'http://127.0.0.1:5173',
    'http://localhost:5173',
    'http://[::1]:5173',
    'http://0.0.0.0:5173',
    'https://user:secret@example.com',
    'https://example.com/path',
  ])('rejects unsuitable origin %s', (origin) => {
    expect(() => companionUrl(origin, 'test-token', 'attempt')).toThrow();
  });
  it('uses the entered LAN address and encodes parameters', () => {
    const url = new URL(companionUrl('http://192.168.1.10:5173', 'token+&', 'a/b'));
    expect(url.host).toBe('192.168.1.10:5173');
    expect(url.pathname).toBe('/companion');
    expect(url.searchParams.get('token')).toBe('token+&');
    expect(url.searchParams.get('at')).toBe('a/b');
  });
});
