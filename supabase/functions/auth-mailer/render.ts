import { templates } from './templates.ts';

/** The subset of the Send Email hook payload this mailer uses. */
export interface HookPayload {
  readonly user: { readonly email: string; readonly new_email?: string };
  readonly email_data: {
    readonly token: string;
    readonly token_hash: string;
    readonly redirect_to: string;
    readonly email_action_type: string;
    readonly token_new?: string;
    readonly token_hash_new?: string;
  };
}

export interface OutgoingEmail {
  readonly to: string;
  readonly subject: string;
  readonly html: string;
}

const kinds: Record<string, { template: keyof typeof templates; subject: string }> = {
  signup: { template: 'confirm-signup', subject: 'Confirm your anticheat email' },
  recovery: { template: 'reset-password', subject: 'Reset your anticheat password' },
  invite: { template: 'invite', subject: "You're invited to anticheat" },
  magiclink: { template: 'magic-link', subject: 'Your anticheat sign-in link' },
  email_change: { template: 'change-email', subject: 'Confirm your new anticheat email' },
  reauthentication: { template: 'reauthentication', subject: 'Your anticheat verification code' },
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** The web app's origin: APP_URL if set, else the origin of the requested redirect. */
export function appOrigin(redirectTo: string, appUrl?: string): string {
  const candidate = appUrl?.trim() || redirectTo;
  return new URL(candidate).origin;
}

function fill(
  template: string,
  values: { site: string; tokenHash: string; token: string; email: string; newEmail: string },
): string {
  return template
    .replaceAll('{{ .SiteURL }}', values.site)
    .replaceAll('{{ .TokenHash }}', encodeURIComponent(values.tokenHash))
    .replaceAll('{{ .Token }}', escapeHtml(values.token))
    .replaceAll('{{ .NewEmail }}', escapeHtml(values.newEmail))
    .replaceAll('{{ .Email }}', escapeHtml(values.email));
}

/**
 * Turn one hook call into the emails to send. A secure email change sends two
 * messages: one to the current address (token_hash) and one to the new
 * address (token_hash_new), and both must be confirmed.
 */
export function renderEmails(payload: HookPayload, appUrl?: string): OutgoingEmail[] {
  const { user, email_data: data } = payload;
  const kind = kinds[data.email_action_type];
  if (!kind) throw new Error(`Unsupported email action: ${data.email_action_type}`);
  const site = appOrigin(data.redirect_to, appUrl);
  const newEmail = user.new_email ?? '';
  const build = (to: string, tokenHash: string, token: string): OutgoingEmail => ({
    to,
    subject: kind.subject,
    html: fill(templates[kind.template], { site, tokenHash, token, email: user.email, newEmail }),
  });

  if (data.email_action_type === 'email_change') {
    const emails: OutgoingEmail[] = [];
    if (data.token_hash) emails.push(build(user.email, data.token_hash, data.token));
    if (data.token_hash_new && newEmail)
      emails.push(build(newEmail, data.token_hash_new, data.token_new ?? ''));
    return emails;
  }
  return [build(user.email, data.token_hash, data.token)];
}
