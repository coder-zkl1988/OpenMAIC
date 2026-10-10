// @vitest-environment jsdom
/**
 * Opening the board keeps the slide mounted (it docks in the PiP), so a video
 * on it would keep playing, with sound, in a 192px thumbnail. Opening the board
 * pauses it and clears canvasStore.playingVideoElementId: a play_video action
 * the engine is waiting on is released instead of waiting out MAX_VIDEO_WAIT_MS.
 */
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
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
  StageColumn: ({
    boardOpen,
    renderScene,
  }: {
    boardOpen: boolean;
    renderScene: (state: { docked: boolean }) => ReactNode;
  }) => createElement('div', null, renderScene({ docked: boardOpen })),
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
