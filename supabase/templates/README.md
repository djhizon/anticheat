# Supabase auth email templates

Branded templates for this app's **own** Supabase project. Every link lands on
`/auth/confirm` in the web app, which verifies the `token_hash` server-side, so
links work even when opened on a different device than the one that asked.

| File                    | Dashboard template (Authentication → Emails) | Subject                          |
| ----------------------- | -------------------------------------------- | -------------------------------- |
| `confirm-signup.html`   | Confirm signup                               | Confirm your anticheat email     |
| `reset-password.html`   | Reset password                               | Reset your anticheat password    |
| `change-email.html`     | Change email address                         | Confirm your new anticheat email |
| `reauthentication.html` | Reauthentication                             | Your anticheat verification code |
| `invite.html`           | Invite user                                  | You're invited to anticheat      |
| `magic-link.html`       | Magic link                                   | Your anticheat sign-in link      |

Apply them all at once (needs a Supabase personal access token with access to
the project; keep it in your shell, not in the repo):

```bash
SUPABASE_ACCESS_TOKEN=sbp_... SUPABASE_PROJECT_REF=<ref> npm run supabase:templates
```

Add `-- --dry-run` to see what would change without sending anything.
