import { expect, it } from 'vitest';
import { lanOrigins } from './lan-config.mjs';
it('allows explicit private LAN origins, excluding public and loopback addresses', () => {
  const item = (address: string, internal = false) => ({ address, internal, family: 'IPv4' });
  expect(
    lanOrigins({
      en0: [item('192.168.1.8'), item('192.168.1.8')],
      other: [item('127.0.0.1', true), item('8.8.8.8'), item('172.16.0.2')],
    }),
  ).toEqual(['http://192.168.1.8:5173', 'http://172.16.0.2:5173']);
});
