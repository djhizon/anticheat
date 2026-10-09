import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { isVisionWorkerPath, VISION_WORKER_CSP } from './src/features/integrity/visionPolicy.js';

const documentPolicy =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://127.0.0.1:* ws://localhost:*; img-src 'self' data:; media-src 'self' blob:; worker-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'";

function localVisionPolicy(): Plugin {
  const headers = (
    request: { url?: string },
    response: { setHeader(name: string, value: string): void },
    next: () => void,
  ) => {
    response.setHeader(
      'Content-Security-Policy',
      isVisionWorkerPath(request.url ?? '') ? VISION_WORKER_CSP : documentPolicy,
    );
    next();
  };
  return {
    name: 'local-vision-policy',
    configureServer(server) {
      server.middlewares.use(headers);
    },
    configurePreviewServer(server) {
      server.middlewares.use(headers);
    },
  };
}

// Set by `npm run share` so the ngrok domain can reach the dev server.
const shareHost = process.env.SHARE_HOST?.trim() || undefined;

export default defineConfig({
  plugins: [react(), localVisionPolicy()],
  worker: {
    format: 'es',
    rollupOptions: { output: { entryFileNames: 'assets/vision-engine-[hash].js' } },
  },
  optimizeDeps: {
    // Pre-bundle MediaPipe on first start so it doesn't stall the page on load
    include: ['@mediapipe/tasks-vision'],
    exclude: ['@mediapipe/tasks-vision/vision_wasm_module_internal.js'],
  },
  server: {
    port: 5173,
    strictPort: true,
    ...(shareHost ? { allowedHosts: [shareHost], hmr: false } : {}),
    warmup: {
      // Pre-transform these files so the first page visit is instant
      clientFiles: [
        './src/features/exam/StudentExamPage.tsx',
        './src/features/exam/api.ts',
        './src/features/auth/AuthProvider.tsx',
      ],
    },
    proxy: {
      '/auth': 'http://127.0.0.1:3000',
      '/exam': 'http://127.0.0.1:3000',
    },
  },
});
