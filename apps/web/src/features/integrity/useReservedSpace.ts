import { useLayoutEffect, useRef } from 'react';

/**
 * Publishes the element's rendered height as a CSS variable on <html> so the page can reserve
 * room for a fixed notice instead of being covered by it. The variable is removed on unmount.
 */
export function useReservedSpace<T extends HTMLElement>(variable: string, active: boolean) {
  const ref = useRef<T>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!active || !el) return undefined;
    const root = document.documentElement;
    const publish = (): void => root.style.setProperty(variable, `${el.offsetHeight}px`);
    publish();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(publish) : null;
    observer?.observe(el);
    window.addEventListener('resize', publish);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', publish);
      root.style.removeProperty(variable);
    };
  }, [variable, active]);
  return ref;
}
