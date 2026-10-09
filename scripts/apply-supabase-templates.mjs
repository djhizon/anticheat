/* global console, process, fetch, URL */
// Push supabase/templates/*.html to the project's auth email templates via the
// Supabase Management API. Only touches the email template/subject fields.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const templates = {
  confirmation: ['confirm-signup.html', 'Confirm your anticheat email'],
  recovery: ['reset-password.html', 'Reset your anticheat password'],
  email_change: ['change-email.html', 'Confirm your new anticheat email'],
  reauthentication: ['reauthentication.html', 'Your anticheat verification code'],
  invite: ['invite.html', "You're invited to anticheat"],
  magic_link: ['magic-link.html', 'Your anticheat sign-in link'],
};

export function buildTemplatePatch(read) {
  const patch = {};
  for (const [kind, [file, subject]] of Object.entries(templates)) {
    patch[`mailer_subjects_${kind}`] = subject;
    patch[`mailer_templates_${kind}_content`] = read(file);
  }
  return patch;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = new URL('../supabase/templates/', import.meta.url);
  const patch = buildTemplatePatch((file) => readFileSync(new URL(file, dir), 'utf8'));
  const ref = process.env.SUPABASE_PROJECT_REF;
  if (process.argv.includes('--dry-run')) {
    console.log(`Would update ${Object.keys(patch).length} fields on project ${ref ?? '<unset>'}:`);
    for (const key of Object.keys(patch)) console.log(`  ${key}`);
  } else {
    const token = process.env.SUPABASE_ACCESS_TOKEN;
    if (!ref || !token) {
      console.error('Set SUPABASE_PROJECT_REF and SUPABASE_ACCESS_TOKEN (personal access token).');
      process.exit(1);
    }
    const response = await fetch(`https://api.supabase.com/v1/projects/${ref}/config/auth`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (!response.ok) {
      console.error(
        `Supabase rejected the update (${response.status}): ${(await response.text()).slice(0, 300)}`,
      );
      process.exit(1);
    }
    console.log(`Updated ${Object.keys(templates).length} email templates on ${ref}.`);
  }
}
