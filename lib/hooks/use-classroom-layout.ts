'use client';

import { createContext, useContext, useLayoutEffect, useState, type RefObject } from 'react';

/**
 * The classroom's responsive layouts, chosen by the WIDTH OF THE CLASSROOM
 * ROOT rather than the viewport: the same surface renders full-page and
 * inside the workbench's resizable pane, and only the root's width describes
 * both.
 *
 * - `desktop` (≥ 1200px): 180px scene sidebar, 360px panel, 56px header with
 *   the full control cluster, 48px control bar. Covers the e2e viewport (1280
 *   minus the scrollbar gutter) and Electron's default 1440.
 * - `tablet` (900–1199px, TabletLandscape.dc.html): 64px numbered scene rail,
 *   52px header with "n / m" and a ⋯ menu, 320px panel, 44px touch targets.
 *   Electron's minimum window width (1024) lands here.
 * - `stacked` (< 900px, or portrait below desktop width,
 *   TabletPortrait.dc.html): the slide, caption and control bar on top and the
 *   interaction section below with 互动 / 笔记 / 场景 tabs (no scene rail, no
 *   side panel).
 * - `phone` (stacked below 600px, ClassroomPhone.dc.html): the same stack with
 *   36px tabs, a five-column avatar grid, the speed / volume / auto-play
 *   controls folded into a ⋯ sheet, and a full-width whiteboard with a
 *   返回课件 chip instead of the 192×108 slide PiP.
 *
 * The CSS side of the same thresholds is the `@container/classroom` root plus
 * the `--container-*` sizes in app/globals.css; this hook is for the branches
 * CSS cannot express (which component renders, and the portrait rule).
 */
export type ClassroomLayout = 'desktop' | 'tablet' | 'stacked' | 'phone';

/** 75rem: keep in sync with `--container-desktop` in app/globals.css */
export const CLASSROOM_DESKTOP_MIN_WIDTH = 1200;
/** 56.25rem: keep in sync with `--container-tablet` in app/globals.css */
export const CLASSROOM_TABLET_MIN_WIDTH = 900;
/** 37.5rem: keep in sync with `--container-phone` in app/globals.css */
export const CLASSROOM_PHONE_MAX_WIDTH = 600;

export function resolveClassroomLayout(width: number, height?: number): ClassroomLayout {
  // Not laid out yet (or no layout engine, e.g. jsdom): keep the desktop chrome
  if (!(width > 0)) return 'desktop';
  if (width >= CLASSROOM_DESKTOP_MIN_WIDTH) return 'desktop';
  if (width < CLASSROOM_PHONE_MAX_WIDTH) return 'phone';
  if (width < CLASSROOM_TABLET_MIN_WIDTH) return 'stacked';
  if (height !== undefined && height > width) return 'stacked';
  return 'tablet';
}

/** Every layout below desktop uses the 44px touch targets */
export function isTouchClassroomLayout(layout: ClassroomLayout): boolean {
  return layout !== 'desktop';
}

/** Tablet portrait and phone put the interaction section under the stage */
export function isStackedClassroomLayout(layout: ClassroomLayout): boolean {
  return layout === 'stacked' || layout === 'phone';
}

/** Provided by ClassroomSurface; without a provider the classroom is desktop. */
export const ClassroomLayoutContext = createContext<ClassroomLayout>('desktop');

export function useClassroomLayout(): ClassroomLayout {
  return useContext(ClassroomLayoutContext);
}

/**
 * Tracks the layout of the element behind `ref` (the classroom root). The
 * first measurement runs before paint, so a tablet-width root never flashes
 * the desktop chrome.
 */
export function useClassroomLayoutObserver(ref: RefObject<HTMLElement | null>): ClassroomLayout {
  const [layout, setLayout] = useState<ClassroomLayout>('desktop');

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = (width: number, height: number) => {
      const next = resolveClassroomLayout(width, height);
      setLayout((current) => (current === next ? current : next));
    };
    const rect = element.getBoundingClientRect();
    update(rect.width, rect.height);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const box = entries[entries.length - 1]?.contentRect;
      if (box) update(box.width, box.height);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);

  return layout;
}
