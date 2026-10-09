import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const candidates = ['../../../.env.local', '../.env.local'].map((relative) =>
  fileURLToPath(new URL(relative, import.meta.url)),
);

/**
 * Load local, gitignored credentials (repo-root `.env.local`, then
 * `apps/api/.env.local`). Variables already set in the shell win.
 */
export function loadLocalEnv(paths: readonly string[] = candidates): string[] {
  const loaded: string[] = [];
  for (const path of paths) {
    if (!existsSync(path)) continue;
    process.loadEnvFile(path);
    loaded.push(path);
  }
  return loaded;
}
