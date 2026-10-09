/* global console, process */
// Replays the synthetic evaluation sessions through the findings engine and writes the
// per-finding-type table to docs/eval-findings.md. Run with `npm run eval:findings`
// (vite-node, like the other API scripts); `--regenerate` rewrites the fixtures first.
import { fileURLToPath, URL } from 'node:url';

import { evalFindingsMain } from '../apps/api/src/modules/integrity/eval-report.ts';

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: npm run eval:findings [-- --regenerate]');
  process.exit(0);
}

try {
  await evalFindingsMain({
    root: fileURLToPath(new URL('../', import.meta.url)),
    regenerate: args.includes('--regenerate'),
    log: (line) => console.log(line),
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : 'The findings evaluation failed.');
  process.exitCode = 1;
}
