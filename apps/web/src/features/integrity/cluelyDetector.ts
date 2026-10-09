/**
 * Detects invisible iframe overlays (clickjacking) or extension-injected overlays
 * commonly used by cheating tools like Cluely.
 */
export function createOverlayDetector(onViolation: () => void): () => void {
  // 1. Detect if we are embedded in a suspicious iframe (should be top level)
  try {
    if (window.top !== window.self) {
      // We are inside an iframe. Is it same-origin?
      if (document.referrer && new URL(document.referrer).origin !== window.location.origin) {
        onViolation();
      }
    }
  } catch (e) {
    // Cross-origin iframe blocked access to window.top
    onViolation();
  }

  // 2. Continually check for injected invisible overlays on the document
  const interval = setInterval(() => {
    const iframes = document.querySelectorAll('iframe');
    for (let i = 0; i < iframes.length; i++) {
      const iframe = iframes[i];
      if (!iframe) continue;

      const style = window.getComputedStyle(iframe);
      // Cheating extensions often inject transparent full-screen iframes
      const isTransparent =
        style.opacity === '0' || style.visibility === 'hidden' || style.display === 'none';
      const coversScreen =
        iframe.clientWidth > window.innerWidth * 0.8 &&
        iframe.clientHeight > window.innerHeight * 0.8;

      if (isTransparent && coversScreen && style.pointerEvents !== 'none') {
        onViolation();
        break;
      }
    }
  }, 2000);

  return () => clearInterval(interval);
}
