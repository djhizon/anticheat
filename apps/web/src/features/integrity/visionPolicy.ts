// This policy must be on the worker response itself, not just the HTML document.
export const VISION_WORKER_CSP =
  "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; worker-src 'none'; object-src 'none'";

export function isVisionWorkerPath(url: string): boolean {
  const path = url.split('?')[0] ?? '';
  return (
    path.endsWith('/vision.worker.ts') ||
    /\/(?:vision-engine|vision\.worker)-[\w-]+\.js$/.test(path)
  );
}
