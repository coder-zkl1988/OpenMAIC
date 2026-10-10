import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

/**
 * The stage viewport: slides contain-fit a 16:9 box, while the course-complete
 * page takes the whole slot. That page picks its compact / full layout from the
 * height it gets (FULL_MIN / FULL_SAFE), so a width-driven 16:9 box would pin
 * it to compact whenever the side panels are open.
 */
vi.mock('@/lib/hooks/use-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/workbench/panel-context', () => ({ useInWorkbenchPanel: () => false }));
vi.mock('@/lib/contexts/scene-context', () => ({
  SceneProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('@/components/whiteboard', () => ({
  Whiteboard: ({ isOpen }: { isOpen: boolean }) =>
    isOpen ? createElement('section', { 'data-board': '' }) : null,
}));
vi.mock('@/components/stage/scene-renderer', () => ({
  SceneRenderer: ({ scene }: { scene: { type: string } }) =>
    createElement('div', { 'data-scene': scene.type }),
}));
vi.mock('@/components/canvas/slide-element-pick-overlay', () => ({
  SlideElementPickOverlay: () => null,
}));
vi.mock('@/components/scene-renderers/classroom-complete', () => ({
  ClassroomCompletePageConnected: () =>
    createElement('section', { 'aria-label': 'Course complete' }),
}));
vi.mock('@/components/edit/ContainBox', () => ({
  ContainBox: ({ children }: { children: ReactNode }) =>
    createElement('div', { 'data-contain-box': '' }, children),
}));

import { CanvasArea } from '@/components/canvas/canvas-area';
import type { Scene } from '@/lib/types/stage';

function render(props: Partial<Parameters<typeof CanvasArea>[0]> = {}) {
  return renderToStaticMarkup(
    createElement(CanvasArea, {
      currentScene: null,
      mode: 'playback',
      engineState: 'idle',
      whiteboardOpen: false,
      onPlayPause: vi.fn(),
      onWhiteboardClose: vi.fn(),
      ...props,
    }),
  );
}

describe('CanvasArea stage viewport', () => {
  it('gives the course-complete page the whole slot instead of a 16:9 box', () => {
    const html = render({ isPendingScene: true, isCourseComplete: true });
    expect(html).toContain('aria-label="Course complete"');
    expect(html).not.toContain('data-contain-box');
    expect(html).toMatch(/<div class="h-full w-full bg-card[^"]*rounded-\[10px\]/);
  });

  it('contain-fits a slide (and the generating placeholder) in a 16:9 box', () => {
    const slide = { id: 's1', type: 'slide', title: 'S', order: 0 } as unknown as Scene;
    expect(render({ currentScene: slide })).toContain('data-contain-box');
    expect(render({ isPendingScene: true, isCourseComplete: false })).toContain('data-contain-box');
  });
});

/**
 * Board mode (ClassroomWhiteboard.dc.html): the board takes the slide's slot
 * and the slide docks in the PiP. The slide stays mounted (no lost state); an
 * interactive scene hands its pooled iframe back so it cannot paint over the
 * board, and the PiP shows a card for it instead.
 */
describe('CanvasArea board mode', () => {
  const slide = { id: 's1', type: 'slide', title: 'Buoyancy', order: 1 } as unknown as Scene;
  const interactive = {
    id: 'i1',
    type: 'interactive',
    title: 'Lab',
    order: 2,
  } as unknown as Scene;

  it('keeps the slide mounted, inert under the PiP, beside the board', () => {
    const html = render({ currentScene: slide, whiteboardOpen: true, pageNumber: 2 });
    expect(html).toContain('data-scene="slide"');
    expect(html).toContain('data-board=""');
    expect(html).toMatch(
      /data-testid="stage-scene"[^>]*>\s*<div[^>]*inert=""[^>]*aria-hidden="true"/,
    );
    expect(html).toContain('data-testid="whiteboard-pip"');
    expect(html).toContain('aria-label="stage.pip.returnLabel"');
    // The board is no longer drawn inside the slide's viewport
    const viewport = html.slice(html.indexOf('data-contain-box'));
    expect(viewport.slice(0, viewport.indexOf('data-scene'))).not.toContain('data-board=""');
  });

  it('shows no PiP and no board in slide mode', () => {
    const html = render({ currentScene: slide });
    expect(html).toContain('data-scene="slide"');
    expect(html).not.toContain('data-board=""');
    expect(html).not.toContain('whiteboard-pip');
  });

  it('releases an interactive scene while docked and shows its card in the PiP', () => {
    const html = render({ currentScene: interactive, whiteboardOpen: true });
    expect(html).not.toContain('data-scene="interactive"');
    expect(html).toContain('data-testid="whiteboard-pip"');
    expect(html).toContain('Lab');
    expect(render({ currentScene: interactive })).toContain('data-scene="interactive"');
  });
});
