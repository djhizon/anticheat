/* global console, process */

import { spawn } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import { lanOrigins } from './lan-config.mjs';

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const apiEnv = { ...process.env };
if (process.env.EXAM_LAN === '1') {
  if (process.env.NODE_ENV === 'production') throw new Error('LAN development mode is not for production.');
  const origins = lanOrigins(networkInterfaces());
  if (!origins.length) throw new Error('No private IPv4 LAN address found. Connect to Wi-Fi first.');
  apiEnv.ALLOWED_ORIGINS = [process.env.ALLOWED_ORIGINS ?? 'http://localhost:5173,http://127.0.0.1:5173', ...origins].join(',');
  console.log('Phone QR origin (choose the Wi-Fi address):', origins.join(', '));
}
const children = [
  spawn(npmCommand, ['run', 'dev:api'], { env: apiEnv, stdio: 'inherit' }),
  spawn(npmCommand, process.env.EXAM_LAN === '1'
    ? ['run', 'dev', '--workspace', '@exam-anti-cheat/web', '--', '--host', '0.0.0.0']
    : ['run', 'dev:web'], { env: process.env, stdio: 'inherit' }),
];
if (process.env.EXAM_LAN === '1') console.warn('LAN development mode: use only on trusted Wi-Fi. Phone microphone access still requires HTTPS.');
let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill(signal);
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

for (const child of children) {
  child.once('error', (error) => {
    console.error('Development process failed to start.', error);
    shutdown('SIGTERM');
    process.exitCode = 1;
  });
  child.once('exit', (code, signal) => {
    if (!shuttingDown && (code ?? 0) !== 0) {
      console.error(`Development process stopped with ${signal ?? `exit code ${code}`}.`);
      shutdown('SIGTERM');
      process.exitCode = code ?? 1;
    }
  });
}
