/* global console, process */

import { seedDemo } from './demoSeed.js';
import { loadLocalEnv } from './env.js';

loadLocalEnv();

void seedDemo().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'The demo seed failed.');
  process.exitCode = 1;
});
