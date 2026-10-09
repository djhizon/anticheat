import { mergeConfig } from 'vite';

import webConfig from '../../apps/web/vite.config.js';

// The product config pins port 5173 and proxies to :3000, which may be a developer's own demo.
// This wrapper moves the E2E stack to other ports without touching product code.
const apiPort = process.env.E2E_API_PORT ?? '3100';
const webPort = Number(process.env.E2E_WEB_PORT ?? '5273');

export default mergeConfig(webConfig, {
  server: {
    port: webPort,
    proxy: {
      '/auth': `http://127.0.0.1:${apiPort}`,
      '/exam': `http://127.0.0.1:${apiPort}`,
    },
  },
});
