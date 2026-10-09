import { resolve } from 'node:path';

import { loadLocalEnv } from './env.js';
import { createApiServer } from './server.js';

loadLocalEnv();
const webRoot = process.env.SERVE_WEB_DIST?.trim();
const application = createApiServer(undefined, webRoot ? { webRoot: resolve(webRoot) } : {});
let shuttingDown = false;

const shutdown = (): void => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  void application.stop().then(
    () => {
      process.exitCode = 0;
    },
    () => {
      console.error('ExamGuard API shutdown failed.');
      process.exitCode = 1;
    },
  );
};

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

void application.start(undefined, process.env.HOST?.trim() || undefined).then(
  (address) => {
    console.log(`ExamGuard API listening on http://${address.address}:${address.port}`);
  },
  (err) => {
    console.error('ExamGuard API startup failed.', err);
    process.exitCode = 1;
    void application.stop().catch(() => {
      console.error('ExamGuard API cleanup after startup failure failed.');
    });
  },
);
