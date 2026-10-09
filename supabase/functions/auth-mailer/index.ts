// Supabase "Send Email" auth hook: renders this app's templates and sends them
// through Microsoft Graph. Deploy with verify_jwt disabled; requests are
// authenticated by the hook's Standard Webhooks signature instead.
import { Webhook } from 'https://esm.sh/standardwebhooks@1.0.0';

import { renderEmails, type HookPayload, type OutgoingEmail } from './render.ts';

declare const Deno: {
  env: { get(name: string): string | undefined };
  serve(handler: (request: Request) => Promise<Response>): void;
};

const env = (name: string): string => {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing secret ${name}`);
  return value;
};

let cachedToken: { value: string; expires: number } | null = null;

async function graphToken(): Promise<string> {
  if (cachedToken && cachedToken.expires > Date.now() + 60_000) return cachedToken.value;
  const response = await fetch(
    `https://login.microsoftonline.com/${env('MS_TENANT_ID')}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env('MS_CLIENT_ID'),
        client_secret: env('MS_CLIENT_SECRET'),
        scope: 'https://graph.microsoft.com/.default',
        grant_type: 'client_credentials',
      }),
    },
  );
  const body = (await response.json()) as { access_token?: string; expires_in?: number };
  if (!body.access_token) throw new Error(`Graph token request failed (${response.status})`);
  cachedToken = {
    value: body.access_token,
    expires: Date.now() + (body.expires_in ?? 3600) * 1000,
  };
  return body.access_token;
}

async function send(email: OutgoingEmail): Promise<void> {
  const sender = env('MAIL_SENDER');
  const response = await fetch(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(sender)}/sendMail`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await graphToken()}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          subject: email.subject,
          body: { contentType: 'HTML', content: email.html },
          toRecipients: [{ emailAddress: { address: email.to } }],
        },
        saveToSentItems: false,
      }),
    },
  );
  if (!response.ok) throw new Error(`Graph sendMail failed (${response.status})`);
}

Deno.serve(async (request) => {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  try {
    const raw = await request.text();
    const secret = env('SEND_EMAIL_HOOK_SECRET').replace('v1,whsec_', '');
    const payload = new Webhook(secret).verify(
      raw,
      Object.fromEntries(request.headers),
    ) as HookPayload;
    for (const email of renderEmails(payload, Deno.env.get('APP_URL'))) await send(email);
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Email could not be sent';
    console.error('auth-mailer:', message);
    return new Response(JSON.stringify({ error: { http_code: 500, message } }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  }
});
