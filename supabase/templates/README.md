# Supabase auth email templates

Branded templates for this app's **own** Supabase project. Every link lands on
`/account/confirm` in the web app, which verifies the `token_hash` server-side, so
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

## Required Supabase settings

The app uses Supabase Auth only when `SUPABASE_URL` and `SUPABASE_ANON_KEY` are set
(see `.env.example`); otherwise it keeps its offline local accounts.

In the Supabase dashboard (Authentication):

- **URL Configuration → Site URL**: the public web origin, for example
  `https://exam.example.org` (local development: `http://localhost:5173`). The templates build
  links from `{{ .SiteURL }}`, so this must be the origin that serves the web app.
- **URL Configuration → Redirect URLs**: add `<Site URL>/account/confirm` (and
  `http://localhost:5173/account/confirm` for development). The server also passes this as
  `redirect_to`.
- **Sign In / Providers → Email**: enable the Email provider and keep **Confirm email** ON.
  Minimum password length should be at least what you want to enforce (the app itself only checks
  that a password is 1 to 1024 characters).
- **Emails → Templates**: apply the templates in this folder (see the command above).
- Set `SITE_URL` in the API environment to the same origin when it differs from the first
  `ALLOWED_ORIGINS` entry.

Built-in SMTP is for trying things out: Supabase sends only a few emails per hour per project
and only to addresses of your project team. Configure custom SMTP (Authentication → SMTP
Settings) before real students sign up.

The `SUPABASE_SERVICE_ROLE_KEY` secret key is used only by `npm run seed` equivalents (the demo
seed) to create pre-confirmed demo accounts without sending email. Never expose it to the browser.
