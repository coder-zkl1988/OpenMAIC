// @vitest-environment jsdom
import { act, createElement, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PPTElement, Whiteboard } from '@openmaic/dsl';

vi.mock('motion/react', async () => (await import('./motion-stub')).motionStub);
vi.mock('@/components/slide-renderer/Editor/ScreenElement', () => ({
  ScreenElement: () => null,
}));
vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

import {
  WhiteboardCanvas,
  type WhiteboardCanvasHandle,
  type WhiteboardViewState,
} from '@/components/whiteboard/whiteboard-canvas';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const ELEMENT = {
  id: 'e-1',
  type: 'text',
  content: '<p>x</p>',
  left: 0,
  top: 0,
  width: 100,
  height: 40,
  rotate: 0,
  defaultFontName: 'Arial',
  defaultColor: '#111111',
} as PPTElement;

function board(elements: PPTElement[]): Whiteboard {
  return { id: 'wb-1', viewportSize: 1000, viewportRatio: 0.5625, elements };
}

let root: Root | null = null;
const ref = createRef<WhiteboardCanvasHandle>();
const onViewChange = vi.fn<(view: WhiteboardViewState) => void>();
const lastView = () => onViewChange.mock.calls.at(-1)![0];

async function render(elements: PPTElement[]) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      createElement(WhiteboardCanvas, { ref, whiteboard: board(elements), onViewChange }),
    );
  });
}

async function zoomBy(factor: number) {
  await act(async () => ref.current!.zoomBy(factor));
}

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  onViewChange.mockReset();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('WhiteboardCanvas zoom handle', () => {
  it('starts at fit (100%) and steps with zoomBy', async () => {
    await render([ELEMENT]);
    expect(lastView()).toEqual({ zoom: 1, modified: false });

    await zoomBy(1.25);
    expect(lastView()).toEqual({ zoom: 1.25, modified: true });

    await zoomBy(0.8);
    expect(lastView()).toEqual({ zoom: 1, modified: false });
  });

  it('clamps zoomBy to 0.2–5', async () => {
    await render([ELEMENT]);

    await zoomBy(100);
    expect(lastView().zoom).toBe(5);
    await zoomBy(1.25);
    expect(lastView().zoom).toBe(5);

    await zoomBy(0.0001);
    expect(lastView().zoom).toBe(0.2);
  });

  it('fit resets zoom and pan back to the fitted sheet', async () => {
    await render([ELEMENT]);
    await zoomBy(2);
    expect(lastView().modified).toBe(true);

    await act(async () => ref.current!.fit());
    expect(lastView()).toEqual({ zoom: 1, modified: false });
  });

  it('ignores zoom on an empty board', async () => {
    await render([]);
    await zoomBy(2);
    expect(lastView()).toEqual({ zoom: 1, modified: false });
  });

  it('draws the ready state as unscaled chrome outside the sheet', async () => {
    await render([]);
    const ready = document.querySelector('[data-testid="whiteboard-ready"]')!;
    expect(ready.textContent).toContain('whiteboard.ready');
    expect(ready.textContent).toContain('whiteboard.readyHint');
    const sheet = document.querySelector<HTMLElement>('[style*="scale("]')!;
    expect(sheet.contains(ready)).toBe(false);
    expect(ready.closest('[style*="scale("]')).toBeNull();
  });
});
