import { describe, expect, it } from 'vitest';

import { appOrigin, renderEmails, type HookPayload } from './render.ts';

const payload = (type: string, extra: Partial<HookPayload['email_data']> = {}): HookPayload => ({
  user: { email: 'student@example.test', new_email: 'new@example.test' },
  email_data: {
    token: '123456',
    token_hash: 'hash/abc',
    redirect_to: 'https://exam.example/account/confirm',
    email_action_type: type,
    ...extra,
  },
});

describe('auth-mailer rendering', () => {
  it('builds a reset link to /account/confirm on the app origin with an encoded token hash', () => {
    const [email] = renderEmails(payload('recovery'));
    expect(email?.to).toBe('student@example.test');
    expect(email?.subject).toBe('Reset your ExamGuard password');
    expect(email?.html).toContain(
      'https://exam.example/account/confirm?token_hash=hash%2Fabc&amp;type=recovery',
    );
    expect(email?.html).not.toContain('{{');
  });

  it('prefers APP_URL over the redirect origin', () => {
    expect(appOrigin('http://evil.example/x', 'https://app.example')).toBe('https://app.example');
    const [email] = renderEmails(payload('signup'), 'https://app.example');
    expect(email?.html).toContain('https://app.example/account/confirm?token_hash=');
    expect(email?.html).toContain('type=email');
  });

  it('sends both halves of a secure email change', () => {
    const emails = renderEmails(
      payload('email_change', { token_hash_new: 'newhash', token_new: '654321' }),
    );
    expect(emails.map((e) => e.to)).toEqual(['student@example.test', 'new@example.test']);
    expect(emails[1]?.html).toContain('token_hash=newhash');
  });

  it('puts the one-time code in reauthentication emails and escapes values', () => {
    const [email] = renderEmails({
      ...payload('reauthentication'),
      user: { email: '<x>@example.test' },
    });
    expect(email?.html).toContain('123456');
    expect(email?.html).toContain('&#60;x&#62;@example.test');
  });

  it('never re-substitutes placeholders that appear inside inserted values', () => {
    const [email] = renderEmails({
      ...payload('reauthentication', { token: '{{ .Email }}' }),
      user: { email: 'a@example.test', new_email: '{{ .Token }}' },
    });
    expect(email?.html).toContain('{{ .Email }}');
    expect(email?.html).toContain('a@example.test');

    const [recovery] = renderEmails({
      ...payload('recovery', { token_hash: '{{ .Email }}' }),
      user: { email: 'victim@example.test' },
    });
    expect(recovery?.html).toContain('token_hash=%7B%7B%20.Email%20%7D%7D');
    expect(recovery?.html).not.toContain('token_hash=victim');
  });

  it('leaves unknown placeholders untouched', () => {
    const [email] = renderEmails(payload('recovery'));
    expect(email?.html).not.toMatch(/\{\{ \.(SiteURL|TokenHash|Token|NewEmail|Email) \}\}/u);
  });

  it('rejects unknown email actions', () => {
    expect(() => renderEmails(payload('carrier_pigeon'))).toThrow('Unsupported');
  });
});
