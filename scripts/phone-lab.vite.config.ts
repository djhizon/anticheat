import { mergeConfig } from 'vite';

import webConfig from '../apps/web/vite.config.js';

// Used only by `npm run phone:lab`. The product config pins port 5173 and proxies to :3000
// (a developer's own demo may be running there), so this wrapper moves the lab to its own ports
// and listens on the LAN so the iPhone can reach the app through the same origin.
const apiPort = process.env.LAB_API_PORT ?? '3600';
const webPort = Number(process.env.LAB_WEB_PORT ?? '5773');

export default mergeConfig(webConfig, {
  server: {
    host: '0.0.0.0',
    port: webPort,
    proxy: {
      '/auth': `http://127.0.0.1:${apiPort}`,
      '/exam': `http://127.0.0.1:${apiPort}`,
    },
  },
});
