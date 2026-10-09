/* global console, process */
import { createServer as httpServer } from 'node:http';
import { readdir } from 'node:fs/promises';
import { fileURLToPath, URL } from 'node:url';
import { createServer, preview } from 'vite';
import { VISION_WORKER_CSP } from '../apps/web/src/features/integrity/visionPolicy.ts';

// A loopback-only, no-camera harness. It uses the actual app worker and actual
// Vite policy in dev/preview, never a second implementation of model loading.
const webRoot = fileURLToPath(new URL('../apps/web/', import.meta.url));
const built = process.argv.includes('--preview');
let workerImport =
  "const workerUrl = '/src/features/integrity/vision.worker.ts?worker_file&type=module';";
if (built) {
  const files = await readdir(new URL('../apps/web/dist/assets/', import.meta.url));
  const entry = files.find((name) => /^vision-engine-[\w-]+\.js$/.test(name));
  if (!entry) throw new Error('Build the web app first');
  workerImport = `const workerUrl = ${JSON.stringify(`/assets/${entry}`)};`;
}
let probes = 0;
const receiver = httpServer((request, response) => {
  if (request.url === '/probe') probes += 1;
  response.end('test receiver');
});
await new Promise((resolve, reject) => {
  receiver.once('error', reject);
  receiver.listen(5189, '127.0.0.1', resolve);
});
const html =
  '<!doctype html><title>Local vision verification</title><h1>Local vision verification</h1><p>No camera or microphone access. The real models perform blank-frame inference.</p><button id="start">Check models and worker policy</button><button id="probe">Check outbound blocking</button><button id="stop">Release models</button><pre id="output"></pre><script type="module" src="/__vision_check.js"></script>';
const client = `${workerImport}
const output = document.querySelector('#output');
const log = text => { output.textContent += text + '\\n'; };
let worker;
document.querySelector('#start').onclick = async () => {
  worker?.terminate();
  const response = await fetch(workerUrl, {method:'HEAD',cache:'no-store'});
  if (response.headers.get('content-security-policy') !== ${JSON.stringify(VISION_WORKER_CSP)}) { log('FAIL: worker policy missing'); return; }
  log('PASS: actual worker response policy');
  worker = new Worker(workerUrl,{type:'module'});
  worker.onerror = () => log('FAIL: worker error');
  worker.onmessage = e => log(e.data.type === 'ready' ? 'PASS: both real models initialized and blank-frame inference completed' : JSON.stringify(e.data));
  worker.postMessage({type:'init'});
};
document.querySelector('#probe').onclick = () => {
  const probe = new Worker('/__probe/vision.worker-test.js',{type:'module'});
  probe.onmessage = async event => { const count = await (await fetch('/__vision_count')).json(); log(event.data.blocked && count.probes === 0 ? 'PASS: cross-origin request blocked; receiver count = 0' : 'FAIL: outbound request escaped'); probe.terminate(); };
};
document.querySelector('#stop').onclick = () => {worker?.terminate();worker = undefined;log('Models released');};
window.addEventListener('pagehide', () => worker?.terminate());`;
function routes(request, response, next) {
  const path = request.url?.split('?')[0];
  if (path === '/__vision_check') {
    response.setHeader('Content-Type', 'text/html');
    response.end(html);
  } else if (path === '/__vision_check.js') {
    response.setHeader('Content-Type', 'text/javascript');
    response.end(client);
  } else if (path === '/__vision_count') {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ probes }));
  } else if (path === '/__probe/vision.worker-test.js') {
    response.setHeader('Content-Type', 'text/javascript');
    response.end(
      "try { await fetch('http://127.0.0.1:5189/probe', {mode:'no-cors'}); self.postMessage({blocked:false}); } catch { self.postMessage({blocked:true}); }",
    );
  } else next();
}
const config = {
  root: webRoot,
  configFile: `${webRoot}/vite.config.ts`,
  plugins: [
    {
      name: 'vision-smoke-routes',
      configureServer(server) {
        server.middlewares.use(routes);
      },
      configurePreviewServer(server) {
        server.middlewares.use(routes);
      },
    },
  ],
  server: { host: '127.0.0.1', port: 5188, strictPort: true },
  preview: { host: '127.0.0.1', port: 5188, strictPort: true },
};
const server = built ? await preview(config) : await createServer(config);
if (!built) await server.listen();
console.log(
  `Vision ${built ? 'preview' : 'development'} check: http://127.0.0.1:5188/__vision_check`,
);
process.once('SIGINT', () => {
  receiver.close();
  if (built) server.httpServer.close();
  else void server.close();
});
