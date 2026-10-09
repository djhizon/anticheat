import { describe, expect, it } from 'vitest';

import { DEFAULT_ALLOWED_ORIGINS, loadConfig } from './config.js';

describe('API configuration', () => {
  it('keeps development runnable with localhost HTTP defaults', () => {
    const config = loadConfig({ NODE_ENV: 'development', COOKIE_SECURE: 'false' });

    expect(config.allowedOrigins).toEqual(DEFAULT_ALLOWED_ORIGINS);
    expect(config.secureCookies).toBe(false);
  });

  it('reads RECORDING_UPLOAD as the default for exams without their own setting', () => {
    const base = { NODE_ENV: 'test', ALLOWED_ORIGINS: 'http://localhost:5173' };
    expect(loadConfig(base).recordingUploadDefault).toBe(true);
    expect(loadConfig({ ...base, RECORDING_UPLOAD: 'on' }).recordingUploadDefault).toBe(true);
    expect(loadConfig({ ...base, RECORDING_UPLOAD: 'off' }).recordingUploadDefault).toBe(false);
    expect(loadConfig({ ...base, RECORDING_UPLOAD: 'OFF' }).recordingUploadDefault).toBe(false);
    expect(() => loadConfig({ ...base, RECORDING_UPLOAD: 'maybe' })).toThrow(/RECORDING_UPLOAD/u);
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

  describe('identity provider', () => {
    const base = { NODE_ENV: 'development', COOKIE_SECURE: 'false' } as const;

    it('defaults to the local provider', () => {
      const config = loadConfig(base);
      expect(config.authProvider).toBe('local');
      expect(config.supabaseUrl).toBeUndefined();
      expect(config.siteUrl).toBe('http://localhost:5173');
    });

    it('enables supabase when URL and anon key are set', () => {
      const config = loadConfig({
        ...base,
        SUPABASE_URL: 'https://abc.supabase.co/',
        SUPABASE_ANON_KEY: 'sb_publishable_x',
        SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_y',
        SITE_URL: 'https://exam.example.test',
      });
      expect(config.authProvider).toBe('supabase');
      expect(config.supabaseUrl).toBe('https://abc.supabase.co');
      expect(config).not.toHaveProperty('supabaseServiceRoleKey');
      expect(config.siteUrl).toBe('https://exam.example.test');
    });

    it('treats placeholder values containing "<" as unset', () => {
      const config = loadConfig({
        ...base,
        SUPABASE_URL: 'https://<project-ref>.supabase.co',
        SUPABASE_ANON_KEY: '<publishable-key>',
        SUPABASE_SERVICE_ROLE_KEY: '<secret>',
      });
      expect(config.authProvider).toBe('local');
    });

    it('rejects partial or malformed supabase configuration', () => {
      expect(() => loadConfig({ ...base, SUPABASE_URL: 'https://abc.supabase.co' })).toThrow(
        'must be configured together',
      );
      expect(() =>
        loadConfig({ ...base, SUPABASE_URL: 'not a url', SUPABASE_ANON_KEY: 'k' }),
      ).toThrow('SUPABASE_URL must be a valid URL.');
      expect(() =>
        loadConfig({
          NODE_ENV: 'production',
          COOKIE_SECURE: 'true',
          ALLOWED_ORIGINS: 'https://exam.example.test',
          SUPABASE_URL: 'http://abc.supabase.co',
          SUPABASE_ANON_KEY: 'k',
        }),
      ).toThrow('https');
    });
  });
});
