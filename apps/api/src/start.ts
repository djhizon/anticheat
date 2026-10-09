import { createApiServer } from './server.js';

const application = createApiServer();
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
      console.error('exam-anti-cheat API shutdown failed.');
      process.exitCode = 1;
    },
  );
};

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

void application.start().then(
  (address) => {
    console.log(`exam-anti-cheat API listening on http://${address.address}:${address.port}`);
  },
  (err) => {
    console.error('exam-anti-cheat API startup failed.', err);
    process.exitCode = 1;
    void application.stop().catch(() => {
      console.error('exam-anti-cheat API cleanup after startup failure failed.');
    });
  },
);
