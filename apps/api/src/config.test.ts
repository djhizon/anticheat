import { describe, expect, it } from 'vitest';

import { DEFAULT_ALLOWED_ORIGINS, loadConfig } from './config.js';

describe('API configuration', () => {
  it('keeps development runnable with localhost HTTP defaults', () => {
    const config = loadConfig({ NODE_ENV: 'development', COOKIE_SECURE: 'false' });

    expect(config.allowedOrigins).toEqual(DEFAULT_ALLOWED_ORIGINS);
    expect(config.secureCookies).toBe(false);
  });

  it('requires explicit HTTPS origins in production', () => {
    expect(() => loadConfig({ NODE_ENV: 'production', COOKIE_SECURE: 'true' })).toThrow(
      'ALLOWED_ORIGINS must be explicitly configured with HTTPS origins in production.',
    );
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        ALLOWED_ORIGINS: 'http://localhost:5173',
        COOKIE_SECURE: 'true',
      }),
    ).toThrow('Invalid allowed origin: http://localhost:5173');
  });

  it('accepts explicit HTTPS origins with secure production cookies', () => {
    const config = loadConfig({
      NODE_ENV: 'production',
      ALLOWED_ORIGINS: 'https://exam.example.test,https://admin.example.test',
      COOKIE_SECURE: 'true',
    });

    expect(config.allowedOrigins).toEqual([
      'https://exam.example.test',
      'https://admin.example.test',
    ]);
    expect(config.secureCookies).toBe(true);
  });
});
