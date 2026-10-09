import { fileURLToPath } from 'node:url';

import { mergeConfig } from 'vite';

import webConfig from '../../apps/web/vite.config.js';

// The product config pins port 5173 and proxies to :3000, which may be a developer's own demo.
// This wrapper moves the E2E stack to other ports without touching product code.
const apiPort = process.env.E2E_API_PORT ?? '3100';
const webPort = Number(process.env.E2E_WEB_PORT ?? '5273');

export default mergeConfig(webConfig, {
  // The synthetic camera has no face, so the pre-exam face counter is replaced by a stub that
  // reports one face. Only this module is swapped; nothing else differs from the product build.
  resolve: {
    alias: [
      {
        find: /^\.\/setupFaceSource\.js$/u,
        replacement: fileURLToPath(new URL('./fakeFaceSource.ts', import.meta.url)),
      },
    ],
  },
  server: {
    port: webPort,
    proxy: {
      '/auth': `http://127.0.0.1:${apiPort}`,
      '/exam': `http://127.0.0.1:${apiPort}`,
    },
  },
});
