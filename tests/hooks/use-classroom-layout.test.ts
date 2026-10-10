// @vitest-environment jsdom

/**
 * The classroom's responsive thresholds (owner decision): desktop from 1200px
 * of classroom-root width (the 1280px e2e viewport minus the scrollbar gutter
 * and Electron's default 1440 stay desktop), tablet landscape 900–1199
 * (Electron's minimum 1024 lands here), stacked below 900 or in portrait.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, createElement, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLASSROOM_DESKTOP_MIN_WIDTH,
  CLASSROOM_TABLET_MIN_WIDTH,
  isTouchClassroomLayout,
  resolveClassroomLayout,
  useClassroomLayout,
  useClassroomLayoutObserver,
  type ClassroomLayout,
} from '@/lib/hooks/use-classroom-layout';

describe('resolveClassroomLayout', () => {
  it('keeps desktop at and above 1200px', () => {
    expect(resolveClassroomLayout(1200, 800)).toBe('desktop');
    // e2e: 1280×720 minus a ~15px scrollbar gutter
    expect(resolveClassroomLayout(1265, 720)).toBe('desktop');
    // Electron's default window
    expect(resolveClassroomLayout(1440, 868)).toBe('desktop');
    // A tall desktop window is still desktop
    expect(resolveClassroomLayout(1300, 1600)).toBe('desktop');
  });

  it('is tablet landscape from 900 to 1199px', () => {
    expect(resolveClassroomLayout(1199, 800)).toBe('tablet');
    // TabletLandscape.dc.html
    expect(resolveClassroomLayout(1180, 820)).toBe('tablet');
    // Electron's minimum window width
    expect(resolveClassroomLayout(1024, 668)).toBe('tablet');
    expect(resolveClassroomLayout(900, 600)).toBe('tablet');
    expect(resolveClassroomLayout(1000)).toBe('tablet');
  });

  it('stacks below 900px and in portrait below desktop width', () => {
    expect(resolveClassroomLayout(899, 600)).toBe('stacked');
    // TabletPortrait.dc.html and ClassroomPhone.dc.html
    expect(resolveClassroomLayout(820, 1180)).toBe('stacked');
    expect(resolveClassroomLayout(390, 844)).toBe('stacked');
    expect(resolveClassroomLayout(1000, 1100)).toBe('stacked');
  });

  it('falls back to desktop before layout (zero or unknown width)', () => {
    expect(resolveClassroomLayout(0, 0)).toBe('desktop');
    expect(resolveClassroomLayout(Number.NaN)).toBe('desktop');
  });

  it('uses touch targets everywhere below desktop', () => {
    expect(isTouchClassroomLayout('desktop')).toBe(false);
    expect(isTouchClassroomLayout('tablet')).toBe(true);
    expect(isTouchClassroomLayout('stacked')).toBe(true);
  });

  it('matches the CSS container sizes in app/globals.css', () => {
    const css = readFileSync(join(process.cwd(), 'app/globals.css'), 'utf8');
    expect(css).toContain(`--container-desktop: ${CLASSROOM_DESKTOP_MIN_WIDTH / 16}rem;`);
    expect(css).toContain(`--container-tablet: ${CLASSROOM_TABLET_MIN_WIDTH / 16}rem;`);
  });

  it('puts the classroom container on the ClassroomSurface root', () => {
    const surface = readFileSync(
      join(process.cwd(), 'components/classroom/ClassroomSurface.tsx'),
      'utf8',
    );
    expect(surface).toContain("'@container/classroom'");
    expect(surface).toContain('<ClassroomLayoutContext.Provider value={layout}>');
  });
});

describe('useClassroomLayoutObserver', () => {
  let container: HTMLDivElement;
  let root: Root;
  let size = { width: 0, height: 0 };
  let resizeCallback: ResizeObserverCallback | null = null;
  const disconnect = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ResizeObserverCallback) {
          resizeCallback = callback;
        }
        observe() {}
        unobserve() {}
        disconnect = disconnect;
      },
    );
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      () => ({ ...size, x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0 }) as DOMRect,
    );
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    resizeCallback = null;
    disconnect.mockClear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function Probe({ onLayout }: { onLayout: (layout: ClassroomLayout) => void }) {
    const ref = useRef<HTMLDivElement>(null);
    onLayout(useClassroomLayoutObserver(ref));
    // eslint-disable-next-line react-hooks/refs -- attaching the ref, as JSX would
    return createElement('div', { ref });
  }

  function resize(width: number, height: number) {
    size = { width, height };
    act(() =>
      resizeCallback?.(
        [{ contentRect: { width, height } } as ResizeObserverEntry],
        {} as ResizeObserver,
      ),
    );
  }

  it('measures before paint, then follows the root width', () => {
    size = { width: 1180, height: 820 };
    const seen: ClassroomLayout[] = [];
    act(() => root.render(createElement(Probe, { onLayout: (l) => seen.push(l) })));
    expect(seen.at(-1)).toBe('tablet');

    resize(1280, 720);
    expect(seen.at(-1)).toBe('desktop');
    resize(820, 1180);
    expect(seen.at(-1)).toBe('stacked');

    act(() => root.unmount());
    root = createRoot(container);
    expect(disconnect).toHaveBeenCalled();
  });

  it('defaults to desktop without a provider', () => {
    const seen: ClassroomLayout[] = [];
    function Reader({ onLayout }: { onLayout: (layout: ClassroomLayout) => void }) {
      onLayout(useClassroomLayout());
      return null;
    }
    act(() => root.render(createElement(Reader, { onLayout: (l) => seen.push(l) })));
    expect(seen.at(-1)).toBe('desktop');
  });
});
