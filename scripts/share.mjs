/* global console, process */
// Share the local app over HTTPS through an ngrok static domain, so judges can
// open a link. The AI still runs on this machine; ngrok is only a tunnel.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

if (existsSync('.env.local')) process.loadEnvFile('.env.local');
const host = process.env.SHARE_HOST?.trim();
if (!host) {
  console.error('Set SHARE_HOST to your ngrok static domain (e.g. in .env.local).');
  process.exit(1);
}
if (spawnSync('ngrok', ['version']).status !== 0) {
  console.error('ngrok is not installed. Run: brew install ngrok');
  process.exit(1);
}

const origin = `https://${host}`;
const env = {
  ...process.env,
  SHARE_HOST: host,
  ALLOWED_ORIGINS: ['http://localhost:5173', 'http://127.0.0.1:5173', origin].join(','),
  // Email links (confirm sign-up, reset password) must open the public address.
  SITE_URL: origin,
};
const children = [
  spawn(process.execPath, ['scripts/dev.mjs'], { env, stdio: 'inherit' }),
  spawn('ngrok', ['http', `--url=${host}`, '5173', '--log=stdout', '--log-level=warn'], {
    env,
    stdio: 'inherit',
  }),
];
console.log(`\nSharing ${origin}  (Ctrl+C to stop)\n`);

let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGINT');
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const child of children) child.on('exit', stop);
