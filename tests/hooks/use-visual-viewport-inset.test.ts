// @vitest-environment jsdom

/**
 * The stacked classroom pads its root by the part of the layout viewport the
 * visual viewport no longer shows (the on-screen keyboard), so the composer
 * at the foot of the interaction section stays reachable while typing.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  readVisualViewportInset,
  useVisualViewportInset,
} from '@/lib/hooks/use-visual-viewport-inset';

type ViewportStub = {
  height: number;
  offsetTop: number;
  scale: number;
  listeners: Map<string, Set<() => void>>;
  addEventListener: (type: string, listener: () => void) => void;
  removeEventListener: (type: string, listener: () => void) => void;
};

function stubViewport(height: number, offsetTop = 0, scale = 1): ViewportStub {
  const listeners = new Map<string, Set<() => void>>();
  return {
    height,
    offsetTop,
    scale,
    listeners,
    addEventListener: (type, listener) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    },
    removeEventListener: (type, listener) => listeners.get(type)?.delete(listener),
  };
}

describe('readVisualViewportInset', () => {
  const win = (innerHeight: number, viewport: Partial<VisualViewport> | null) =>
    ({ innerHeight, visualViewport: viewport }) as Pick<Window, 'innerHeight' | 'visualViewport'>;

  it('is the keyboard: the layout viewport the visual viewport no longer covers', () => {
    expect(readVisualViewportInset(win(844, { height: 508, offsetTop: 0, scale: 1 }))).toBe(336);
    // Panned up to show the focused field: the pan is not part of the inset
    expect(readVisualViewportInset(win(844, { height: 508, offsetTop: 40, scale: 1 }))).toBe(296);
  });

  it('is zero without a keyboard, without visualViewport and while pinch-zoomed', () => {
    expect(readVisualViewportInset(win(844, { height: 844, offsetTop: 0, scale: 1 }))).toBe(0);
    expect(readVisualViewportInset(win(844, { height: 843.5, offsetTop: 0, scale: 1 }))).toBe(0);
    expect(readVisualViewportInset(win(844, null))).toBe(0);
    expect(readVisualViewportInset(win(844, { height: 400, offsetTop: 100, scale: 2 }))).toBe(0);
  });
});

describe('useVisualViewportInset', () => {
  let container: HTMLDivElement;
  let root: Root;
  let viewport: ViewportStub;
  const seen: number[] = [];

  function Probe({ enabled }: { enabled: boolean }) {
    seen.push(useVisualViewportInset(enabled));
    return null;
  }

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    viewport = stubViewport(844);
    vi.stubGlobal('visualViewport', viewport);
    vi.stubGlobal('innerHeight', 844);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    seen.length = 0;
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  const fire = (type: 'resize' | 'scroll') =>
    act(() => viewport.listeners.get(type)?.forEach((listener) => listener()));

  it('follows the keyboard opening and closing', () => {
    act(() => root.render(createElement(Probe, { enabled: true })));
    expect(seen.at(-1)).toBe(0);

    viewport.height = 508;
    fire('resize');
    expect(seen.at(-1)).toBe(336);

    viewport.offsetTop = 36;
    fire('scroll');
    expect(seen.at(-1)).toBe(300);

    viewport.height = 844;
    viewport.offsetTop = 0;
    fire('resize');
    expect(seen.at(-1)).toBe(0);
  });

  it('reads 0 and stops listening when disabled', () => {
    viewport.height = 508;
    act(() => root.render(createElement(Probe, { enabled: true })));
    expect(seen.at(-1)).toBe(336);

    act(() => root.render(createElement(Probe, { enabled: false })));
    expect(seen.at(-1)).toBe(0);
    expect(viewport.listeners.get('resize')?.size ?? 0).toBe(0);
    expect(viewport.listeners.get('scroll')?.size ?? 0).toBe(0);
  });
});
