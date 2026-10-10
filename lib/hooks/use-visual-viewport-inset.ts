'use client';

import { useEffect, useState } from 'react';

/**
 * How much of the layout viewport's bottom the visual viewport no longer
 * shows: on a phone or tablet, the on-screen keyboard. Mobile Safari (and
 * Chrome with `resizes-visual`) keep the layout viewport — and so an
 * `h-app` page's bottom edge — under the keyboard; padding the page by this
 * inset lifts a bottom-docked composer back into view.
 *
 * Zero when there is no visualViewport, while pinch-zoomed (the shrunken
 * visual viewport is the zoom, not a keyboard), and when `enabled` is false.
 */
export function readVisualViewportInset(
  win: Pick<Window, 'innerHeight' | 'visualViewport'>,
): number {
  const viewport = win.visualViewport;
  if (!viewport) return 0;
  if (viewport.scale > 1.01) return 0;
  const inset = win.innerHeight - viewport.height - viewport.offsetTop;
  // Sub-pixel jitter and the URL bar's collapse are not a keyboard
  return inset > 1 ? Math.round(inset) : 0;
}

export function useVisualViewportInset(enabled: boolean): number {
  const [inset, setInset] = useState(0);

  useEffect(() => {
    const viewport = typeof window === 'undefined' ? null : window.visualViewport;
    // Disabled reads as 0 below; re-enabling measures again right away
    if (!enabled || !viewport) return;
    const update = () => {
      const next = readVisualViewportInset(window);
      setInset((current) => (current === next ? current : next));
    };
    update();
    viewport.addEventListener('resize', update);
    viewport.addEventListener('scroll', update);
    return () => {
      viewport.removeEventListener('resize', update);
      viewport.removeEventListener('scroll', update);
    };
  }, [enabled]);

  return enabled ? inset : 0;
}
