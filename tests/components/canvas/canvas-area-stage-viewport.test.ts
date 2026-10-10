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
vi.mock('@/components/whiteboard', () => ({ Whiteboard: () => null }));
vi.mock('@/components/stage/scene-renderer', () => ({ SceneRenderer: () => null }));
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
