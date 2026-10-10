// @vitest-environment jsdom
/**
 * Opening the board keeps the slide mounted (it docks in the PiP), so a video
 * on it would keep playing, with sound, in a 192px thumbnail. Opening the board
 * pauses it and clears canvasStore.playingVideoElementId: a play_video action
 * the engine is waiting on is released instead of waiting out MAX_VIDEO_WAIT_MS.
 */
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/hooks/use-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/workbench/panel-context', () => ({ useInWorkbenchPanel: () => false }));
vi.mock('@/lib/contexts/scene-context', () => ({
  SceneProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('@/components/whiteboard', () => ({
  Whiteboard: ({ isOpen }: { isOpen: boolean }) =>
    isOpen ? createElement('section', { 'data-board': '' }) : null,
}));
// The slide's video element, as the slide renderer draws it
vi.mock('@/components/stage/scene-renderer', () => ({
  SceneRenderer: () => createElement('video', { 'data-testid': 'slide-video' }),
}));
vi.mock('@/components/canvas/slide-element-pick-overlay', () => ({
  SlideElementPickOverlay: () => null,
}));
vi.mock('@/components/scene-renderers/classroom-complete', () => ({
  ClassroomCompletePageConnected: () => null,
}));
vi.mock('@/components/edit/ContainBox', () => ({
  ContainBox: ({ children }: { children: ReactNode }) => createElement('div', null, children),
}));
// The real column is covered by stage-column.test.ts; here the scene is docked
// exactly while the board is open
vi.mock('@/components/classroom/stage-column', () => ({
  CAPTION_HEIGHT: 92,
  STAGE_GAP: 12,
  CHIP_BOARD_EXTRA_HEIGHT: 56,
  StageColumn: ({
    boardOpen,
    renderScene,
    pipMode,
  }: {
    boardOpen: boolean;
    renderScene: (state: { docked: boolean }) => ReactNode;
    pipMode?: string;
  }) =>
    createElement(
      'div',
      { 'data-testid': 'stage-column', 'data-pip-mode': pipMode },
      renderScene({ docked: boardOpen }),
    ),
}));

import { CanvasArea } from '@/components/canvas/canvas-area';
import { useCanvasStore } from '@/lib/store/canvas';
import type { Scene } from '@/lib/types/stage';

const slide = { id: 's1', type: 'slide', title: 'Buoyancy', order: 0 } as unknown as Scene;

describe('CanvasArea: opening the board with a video playing', () => {
  let container: HTMLDivElement;
  let root: Root;
  let pause: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useCanvasStore.getState().pauseVideo();
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    pause.mockRestore();
    useCanvasStore.getState().pauseVideo();
    vi.unstubAllGlobals();
  });

  function render(whiteboardOpen: boolean) {
    act(() =>
      root.render(
        createElement(CanvasArea, {
          currentScene: slide,
          mode: 'playback',
          engineState: 'playing',
          whiteboardOpen,
          onPlayPause: vi.fn(),
          onWhiteboardClose: vi.fn(),
        }),
      ),
    );
  }

  it('pauses the docked slide video and releases the engine wait', () => {
    render(false);
    act(() => useCanvasStore.getState().playVideo('v1'));
    expect(useCanvasStore.getState().playingVideoElementId).toBe('v1');
    expect(pause).not.toHaveBeenCalled();

    render(true);
    expect(useCanvasStore.getState().playingVideoElementId).toBe('');
    const video = container.querySelector('[data-testid="slide-video"]');
    expect(video).not.toBeNull();
    expect(pause.mock.contexts).toContain(video);
  });

  it('leaves playback alone while the slide has the slot', () => {
    render(false);
    act(() => useCanvasStore.getState().playVideo('v1'));
    render(false);
    expect(useCanvasStore.getState().playingVideoElementId).toBe('v1');
    expect(pause).not.toHaveBeenCalled();
  });
});

describe('CanvasArea in the stacked layouts', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function render(props: Record<string, unknown>) {
    act(() =>
      root.render(
        createElement(CanvasArea, {
          currentScene: slide,
          mode: 'playback',
          engineState: 'playing',
          whiteboardOpen: false,
          onPlayPause: vi.fn(),
          onWhiteboardClose: vi.fn(),
          caption: createElement('div', { 'data-testid': 'caption' }),
          ...props,
        }),
      ),
    );
  }
  const frame = () =>
    container.querySelector<HTMLElement>('[data-testid="stage-column"]')!.parentElement!;

  it('fills its host outside the stacked layouts', () => {
    render({});
    expect(frame().className).toContain('h-full');
    expect(frame().style.height).toBe('');
    expect(
      container.querySelector('[data-testid="stage-column"]')!.getAttribute('data-pip-mode'),
    ).toBe('dock');
  });

  // jsdom's CSSOM drops min() / cqw / dvh, so the stacked sizes are read from
  // the server markup
  const markup = (props: Record<string, unknown>) =>
    renderToStaticMarkup(
      createElement(CanvasArea, {
        currentScene: slide,
        mode: 'playback',
        engineState: 'playing',
        whiteboardOpen: false,
        onPlayPause: vi.fn(),
        onWhiteboardClose: vi.fn(),
        caption: createElement('div', { 'data-testid': 'caption' }),
        ...props,
      }),
    );
  const frameTag = (html: string) => html.match(/^<div[^>]*>/)![0];

  it('tablet portrait: a full-width 16:9 slide plus the caption, 16px insets', () => {
    const tag = frameTag(markup({ stacked: 'stacked' }));
    expect(tag).not.toContain('h-full');
    expect(tag).toContain('px-4');
    // 12px under the caption row + the 92px caption + its 12px gap, capped
    expect(tag).toContain('height:min(calc((100cqw - 32px) * 9 / 16 + 116px), 60dvh)');
  });

  it('phone: 12px insets, the PiP becomes the chip, and the open board adds its chrome', () => {
    const html = markup({ stacked: 'phone' });
    expect(frameTag(html)).toContain('px-3');
    expect(frameTag(html)).toContain('calc((100cqw - 24px) * 9 / 16 + 112px)');
    expect(html).toContain('data-pip-mode="chip"');

    expect(frameTag(markup({ stacked: 'phone', whiteboardOpen: true }))).toContain(
      'calc((100cqw - 24px) * 9 / 16 + 168px)',
    );
  });

  it('without a caption the stage is just the slide and its inset', () => {
    expect(frameTag(markup({ stacked: 'stacked', caption: null }))).toContain(
      'calc((100cqw - 32px) * 9 / 16 + 12px)',
    );
  });
});
