export function companionUrl(base: string, token: string, attemptId: string): string {
  const url = new URL(base);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    /^(localhost|127\..*|0\.0\.0\.0|\[::1\])$/i.test(url.hostname)
  ) {
    throw new Error(
      'Use the laptop’s phone-reachable LAN or HTTPS origin, not localhost/127.0.0.1.',
    );
  }
  url.pathname = '/companion';
  url.searchParams.set('token', token);
  url.searchParams.set('at', attemptId);
  return url.href;
}
