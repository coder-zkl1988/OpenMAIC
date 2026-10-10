// @vitest-environment jsdom

/**
 * The stacked classroom (P7b): tablet portrait (TabletPortrait.dc.html) and
 * phone (ClassroomPhone.dc.html). The 场景 tab's two-column scene grid keeps
 * the sidebar's scene-item / scene-title hooks; the phone condenses the
 * control bar (speed / volume / auto-play in a ⋯ sheet), uses a five-column
 * grid of 36px avatars and a tighter header with a vertical ⋮ trigger.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}(${Object.values(options).join('/')})` : key,
    locale: 'en-US',
    setLocale: () => undefined,
  }),
}));
vi.mock('@/lib/hooks/use-theme', () => ({
  useTheme: () => ({ theme: 'light', setTheme: () => undefined, resolvedTheme: 'light' }),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => undefined }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/lib/export/use-export-pptx', () => ({
  useExportPPTX: () => ({
    exporting: false,
    exportPPTX: () => undefined,
    exportResourcePack: () => undefined,
  }),
}));
vi.mock('@/lib/export/use-export-classroom', () => ({
  useExportClassroom: () => ({ exporting: false, exportClassroomZip: () => undefined }),
}));
vi.mock('@/lib/export/use-export-html', () => ({
  classroomHasPlaybackMedia: () => false,
  useExportHtml: () => ({ exporting: false, exportStandaloneHtml: () => undefined }),
}));
vi.mock('@/lib/export/use-export-script', () => ({
  isScriptExportReady: () => true,
  useExportScript: () => ({
    exporting: false,
    exportScriptDocx: () => undefined,
    exportScriptMd: () => undefined,
  }),
}));
vi.mock('@/lib/config/feature-flags', () => ({ isVideoExportEnabled: () => false }));
vi.mock('@/components/settings', () => ({ SettingsDialog: () => null }));
vi.mock('@/components/stage/video-export-dialog', () => ({ VideoExportDialog: () => null }));
// The thumbnail reports the size the grid asked for
vi.mock('@/components/slide-renderer/SlideThumbnail', async () => {
  const { createElement: h } = await import('react');
  return {
    SlideThumbnail: ({ size }: { size: number }) =>
      h('span', { 'data-testid': 'thumb', 'data-size': String(size) }),
  };
});
vi.mock('@/components/slide-renderer/components/ThumbnailInteractive', () => ({
  ThumbnailInteractive: () => null,
}));
vi.mock('@/lib/orchestration/registry/store', () => ({
  useAgentRegistry: { getState: () => ({ getAgent: () => undefined }) },
}));

import { ControlBar, type ControlBarProps } from '@/components/classroom/control-bar';
import { Participants } from '@/components/classroom/interaction/participants';
import { Header } from '@/components/header';
import { SceneSidebar } from '@/components/stage/scene-sidebar';
import { useStageStore } from '@/lib/store';
import { PENDING_SCENE_ID } from '@/lib/store/stage';
import type { Participant } from '@/lib/types/roundtable';
import type { Scene } from '@/lib/types/stage';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe('SceneSidebar variant="grid" (the 场景 tab)', () => {
  const scene = (id: string, type: Scene['type'], order: number) =>
    ({
      id,
      stageId: 'stage-1',
      type,
      title: `Scene ${order + 1}`,
      order,
      content:
        type === 'slide'
          ? { type, canvas: { id: `c-${id}`, elements: [], viewportSize: 1000 } }
          : { type },
    }) as unknown as Scene;

  afterEach(() => {
    useStageStore.setState({
      scenes: [],
      currentSceneId: null,
      generatingOutlines: [],
      failedOutlines: [],
    });
  });

  function renderGrid(props: Partial<Parameters<typeof SceneSidebar>[0]> = {}) {
    const onSceneSelect = vi.fn();
    act(() =>
      root.render(
        createElement(SceneSidebar, {
          variant: 'grid',
          collapsed: false,
          onCollapseChange: () => undefined,
          onSceneSelect,
          ...props,
        }),
      ),
    );
    return { onSceneSelect };
  }

  it('lays the titled scene items out in two columns, keeping the e2e hooks', async () => {
    useStageStore.setState({
      scenes: [scene('s1', 'slide', 0), scene('s2', 'quiz', 1), scene('s3', 'slide', 2)],
      currentSceneId: 's2',
    });
    renderGrid();
    // The lazy thumbnails flip on in a microtask without IntersectionObserver
    await act(async () => undefined);

    const list = container.querySelector('[data-testid="scene-list"]') as HTMLElement;
    expect(list.getAttribute('data-variant')).toBe('grid');
    expect(list.getAttribute('aria-label')).toBe('stage.sceneRail');
    expect(list.className).toContain('grid-cols-2');
    expect(list.className).toContain('gap-3');
    // No sidebar chrome: no logo row, no collapse button, no drag handle, no rail
    expect(container.querySelector('button[aria-label="stage.collapseSceneSidebar"]')).toBeNull();
    expect(container.querySelector('.cursor-col-resize')).toBeNull();
    expect(container.querySelector('[data-testid="scene-rail"]')).toBeNull();

    const items = [...container.querySelectorAll('[data-testid="scene-item"]')];
    expect(items).toHaveLength(3);
    expect(items.map((i) => i.querySelector('[data-testid="scene-title"]')?.textContent)).toEqual([
      'Scene 1',
      'Scene 2',
      'Scene 3',
    ]);
    expect(items[1].getAttribute('aria-current')).toBe('page');
    expect(items[0].getAttribute('aria-current')).toBeNull();
    // Unmeasured (jsdom has no layout): the fallback thumbnail width
    const thumbs = [...container.querySelectorAll('[data-testid="thumb"]')];
    expect(thumbs.map((t) => t.getAttribute('data-size'))).toEqual(['160', '160']);
  });

  it('sizes the thumbnails from the measured grid width', async () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(390);
    useStageStore.setState({ scenes: [scene('s1', 'slide', 0)], currentSceneId: 's1' });
    renderGrid();
    await act(async () => undefined);
    // (390 − 2×16 inset − 12 gap) / 2 − 12 item padding
    expect(container.querySelector('[data-testid="thumb"]')?.getAttribute('data-size')).toBe('161');
    vi.restoreAllMocks();
  });

  it('items are focusable buttons: click, Enter and Space select the scene', () => {
    useStageStore.setState({
      scenes: [scene('s1', 'slide', 0), scene('s2', 'slide', 1)],
      currentSceneId: 's1',
    });
    const { onSceneSelect } = renderGrid();
    const items = [...container.querySelectorAll('[data-testid="scene-item"]')] as HTMLElement[];
    expect(items[1].getAttribute('role')).toBe('button');
    expect(items[1].tabIndex).toBe(0);

    act(() => items[1].click());
    expect(onSceneSelect).toHaveBeenLastCalledWith('s2');
    act(() => {
      items[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(onSceneSelect).toHaveBeenLastCalledWith('s1');
    act(() => {
      items[1].dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    });
    expect(onSceneSelect).toHaveBeenLastCalledWith('s2');
    expect(onSceneSelect).toHaveBeenCalledTimes(3);
  });

  it('keeps the desktop sidebar rows as they were (no button role)', () => {
    useStageStore.setState({ scenes: [scene('s1', 'slide', 0)], currentSceneId: 's1' });
    act(() =>
      root.render(
        createElement(SceneSidebar, { collapsed: false, onCollapseChange: () => undefined }),
      ),
    );
    const item = container.querySelector('[data-testid="scene-item"]')!;
    expect(item.getAttribute('role')).toBeNull();
    expect(item.hasAttribute('tabindex')).toBe(false);
    expect(container.querySelector('[data-testid="scene-list"]')!.className).not.toContain(
      'grid-cols-2',
    );
  });

  it('shows the generating page (selectable) and the course-complete page in the grid', () => {
    useStageStore.setState({
      scenes: [scene('s1', 'slide', 0)],
      currentSceneId: 's1',
      generatingOutlines: [{ id: 'o2', title: 'Dark reactions' }] as never,
      failedOutlines: [],
    });
    const { onSceneSelect } = renderGrid();
    const pending = [...container.querySelectorAll('[role="button"]')].find((el) =>
      el.textContent?.includes('Dark reactions'),
    ) as HTMLElement;
    expect(pending).toBeDefined();
    act(() => {
      pending.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(onSceneSelect).toHaveBeenCalledWith(PENDING_SCENE_ID);

    useStageStore.setState({ generatingOutlines: [] });
    renderGrid({ isCourseComplete: true });
    expect(container.textContent).toContain('stage.courseComplete');
    const complete = container.querySelector('[role="button"][aria-label="stage.courseComplete"]');
    expect(complete).not.toBeNull();
  });

  it('names the grid and its tiles like the rail; thumbnails stay out of the tab order', async () => {
    useStageStore.setState({
      scenes: [scene('s1', 'slide', 0), scene('s2', 'interactive', 1)],
      currentSceneId: 's1',
      generatingOutlines: [{ id: 'o3', title: 'Dark reactions' }] as never,
      failedOutlines: [],
    });
    renderGrid();
    await act(async () => undefined);

    // A named navigation region (an aria-label on a role-less div is ignored)
    const list = container.querySelector('[data-testid="scene-list"]')!;
    expect(list.getAttribute('role')).toBe('navigation');
    // Tiles take the rail's name, not the thumbnail's slide text
    const items = [...container.querySelectorAll('[data-testid="scene-item"]')];
    expect(items.map((i) => i.getAttribute('aria-label'))).toEqual([
      'stage.sceneRailItem(1/Scene 1)',
      'stage.sceneRailItem(2/Scene 2)',
    ]);
    const pending = container.querySelector('[role="button"][aria-label*="Dark reactions"]');
    expect(pending?.getAttribute('aria-label')).toBe(
      'stage.sceneRailItem(3/Dark reactions) · stage.generating',
    );
    // The thumbnail is decoration of the tile: hidden and inert (no iframe tab stop)
    for (const item of items) {
      const thumbnail = item.querySelector('.aspect-video')!;
      expect(thumbnail.getAttribute('aria-hidden')).toBe('true');
      expect(thumbnail.hasAttribute('inert')).toBe(true);
    }
  });

  it('gives a failed page in the grid a 44px, named retry button', () => {
    useStageStore.setState({
      scenes: [scene('s1', 'slide', 0)],
      currentSceneId: 's1',
      generatingOutlines: [{ id: 'o2', title: 'Dark reactions' }] as never,
      failedOutlines: [{ id: 'o2', title: 'Dark reactions' }] as never,
    });
    const onRetryOutline = vi.fn(async () => undefined);
    renderGrid({ onRetryOutline });
    const retry = container.querySelector(
      'button[aria-label="generation.retryScene"]',
    ) as HTMLButtonElement;
    expect(retry).not.toBeNull();
    expect(retry.className).toContain('size-11');
    expect(retry.className).not.toContain('-ml-1');
    act(() => retry.click());
    expect(onRetryOutline).toHaveBeenCalledWith('o2');
  });
});

describe('ControlBar condensed (phone)', () => {
  const props = (overrides: Partial<ControlBarProps> = {}): ControlBarProps => ({
    currentSceneIndex: 1,
    scenesCount: 4,
    engineState: 'playing',
    onPrev: vi.fn(),
    onNext: vi.fn(),
    onPlayPause: vi.fn(),
    whiteboardOpen: false,
    onToggleWhiteboard: vi.fn(),
    onTogglePresentation: vi.fn(),
    onToggleMute: vi.fn(),
    ttsEnabled: true,
    onToggleAutoPlay: vi.fn(),
    onCycleSpeed: vi.fn(),
    density: 'touch',
    condensed: true,
    ...overrides,
  });

  it('is a 52px bar: transport, whiteboard, ⋯ and fullscreen, every target 44px', () => {
    act(() => root.render(createElement(ControlBar, props())));
    const bar = container.querySelector('[data-testid="control-bar"]')!;
    expect(bar.className).toContain('h-13');
    const labels = [...bar.querySelectorAll('button')].map(
      (b) => b.getAttribute('aria-label') ?? b.textContent,
    );
    expect(labels).toEqual([
      'stage.previousScene',
      'stage.pause',
      'stage.nextScene',
      'stage.whiteboardToggle',
      'stage.playbackMenu',
      'stage.fullscreen',
    ]);
    for (const button of bar.querySelectorAll('button')) {
      expect(button.className).toContain('size-11');
    }
    // The phone's dividers sit 4px from their neighbours (the tablet's 8px)
    const dividers = [...bar.querySelectorAll('div.w-px')];
    expect(dividers.length).toBeGreaterThan(0);
    for (const divider of dividers) expect(divider.className).toContain('mx-1 ');
    // Speed, volume and auto-play are only in the sheet
    expect(bar.querySelector('button[aria-label="stage.playbackSpeed"]')).toBeNull();
    expect(bar.querySelector('button[aria-label="stage.mute"]')).toBeNull();
    expect(bar.querySelector('button[aria-label="roundtable.autoPlay"]')).toBeNull();
  });

  it('opens a ⋯ sheet with speed, volume and auto-play rows', async () => {
    const onCycleSpeed = vi.fn();
    const onToggleAutoPlay = vi.fn();
    const onToggleMute = vi.fn();
    const onVolumeChange = vi.fn();
    act(() =>
      root.render(
        createElement(
          ControlBar,
          props({
            onCycleSpeed,
            onToggleAutoPlay,
            onToggleMute,
            onVolumeChange,
            playbackSpeed: 1.5,
            autoPlayLecture: true,
          }),
        ),
      ),
    );
    const more = container.querySelector('[data-testid="control-bar-more"]') as HTMLElement;
    expect(more.getAttribute('aria-expanded')).toBe('false');
    // Off its defaults (1.5x): the trigger hints at it
    expect(more.className).toContain('text-accent-text');
    await act(async () => more.click());
    expect(more.getAttribute('aria-expanded')).toBe('true');

    const sheet = document.querySelector('[data-testid="control-bar-sheet"]') as HTMLElement;
    expect(sheet).not.toBeNull();
    const speed = sheet.querySelector('button[aria-label="stage.playbackSpeed 1.5x"]')!;
    expect(speed.className).toContain('h-11');
    act(() => (speed as HTMLButtonElement).click());
    expect(onCycleSpeed).toHaveBeenCalledOnce();

    const mute = sheet.querySelector('button[aria-label="stage.mute"]') as HTMLButtonElement;
    expect(mute.className).toContain('size-11');
    act(() => mute.click());
    expect(onToggleMute).toHaveBeenCalledOnce();
    expect(sheet.querySelector('input[type="range"][aria-label="stage.volume"]')).not.toBeNull();

    const autoPlay = [...sheet.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('roundtable.autoPlay'),
    )!;
    expect(autoPlay.getAttribute('aria-pressed')).toBe('true');
    act(() => autoPlay.click());
    expect(onToggleAutoPlay).toHaveBeenCalledOnce();
  });

  it('portals the sheet into the fullscreen element while presenting', async () => {
    const stage = document.createElement('div');
    document.body.appendChild(stage);
    act(() => root.render(createElement(ControlBar, props({ portalContainer: stage }))));
    await act(async () =>
      (container.querySelector('[data-testid="control-bar-more"]') as HTMLElement).click(),
    );
    expect(stage.querySelector('[data-testid="control-bar-sheet"]')).not.toBeNull();
  });

  it('during a Q&A the disabled prev / next step aside for a shrinkable stop pill', () => {
    act(() =>
      root.render(
        createElement(ControlBar, props({ showStop: true, stopKind: 'qa', onStop: vi.fn() })),
      ),
    );
    const bar = container.querySelector('[data-testid="control-bar"]')!;
    expect(bar.querySelector('button[aria-label="stage.previousScene"]')).toBeNull();
    expect(bar.querySelector('button[aria-label="stage.nextScene"]')).toBeNull();
    const stop = [...bar.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('roundtable.stopQA'),
    )!;
    expect(stop.className).toContain('min-w-0');
    expect(stop.getAttribute('title')).toBe('roundtable.stopQA');
    expect(stop.querySelector('.truncate')).not.toBeNull();
  });

  it('keeps every control inline when not condensed (tablet)', () => {
    act(() => root.render(createElement(ControlBar, props({ condensed: false }))));
    const bar = container.querySelector('[data-testid="control-bar"]')!;
    expect(bar.className).toContain('h-14');
    expect(bar.querySelector('[data-testid="control-bar-more"]')).toBeNull();
    expect(bar.querySelector('button[aria-label="stage.playbackSpeed"]')).not.toBeNull();
  });
});

describe('Participants in the stacked layouts', () => {
  const person = (id: string, role: Participant['role']): Participant => ({
    id,
    name: id,
    role,
    avatar: `/avatars/${id}.png`,
    isOnline: true,
  });
  const roster = [
    person('teacher', 'teacher'),
    person('assistant', 'student'),
    person('student-1', 'student'),
    person('student-2', 'student'),
    person('user-1', 'user'),
  ];
  const render = (layout: 'panel' | 'stacked' | 'phone') =>
    act(() =>
      root.render(
        createElement(Participants, {
          participants: roster,
          playbackView: { phase: 'lecturePlaying', activeRole: 'teacher' } as never,
          layout,
        }),
      ),
    );

  it('tablet portrait: no count line (the 互动 tab has it), 60px tiles of 44px avatars', () => {
    render('stacked');
    const block = container.querySelector('[data-testid="participants"]')!;
    expect(block.getAttribute('data-layout')).toBe('stacked');
    expect(block.textContent).not.toContain('stage.participants.online');
    expect(block.querySelector('ul')!.className).toContain('flex gap-5');
    const tiles = [...block.querySelectorAll('li')];
    expect(tiles).toHaveLength(5);
    for (const tile of tiles) expect(tile.className).toContain('w-[60px]');
    const avatar = block.querySelector('[data-testid="participant-tile"] > span')!;
    expect(avatar.className).toContain('size-11');
    expect(avatar.className).not.toContain('@max-desktop/classroom:size-10');
    // The status line stays
    expect(block.textContent).toContain('stage.participants.speaking');
  });

  it('phone: a five-column grid of 36px avatars with names; the status is read, not shown', () => {
    render('phone');
    const block = container.querySelector('[data-testid="participants"]')!;
    expect(block.querySelector('ul')!.className).toContain('grid-cols-5');
    const avatar = block.querySelector('[data-testid="participant-tile"] > span')!;
    expect(avatar.className).toContain('size-9');
    const speaking = block.querySelector('[data-status="speaking"]')!;
    expect(speaking.querySelector('.sr-only')!.textContent).toBe('stage.participants.speaking');
    expect(speaking.querySelector('.text-accent-text')).toBeNull();
  });

  it('keeps the panel block with its count line by default', () => {
    render('panel');
    const block = container.querySelector('[data-testid="participants"]')!;
    expect(block.textContent).toContain('stage.participants.online(5)');
    expect(block.querySelector('[data-testid="participant-tile"] > span')!.className).toContain(
      '@max-desktop/classroom:size-10',
    );
  });
});

describe('Header layout="phone"', () => {
  it('tightens the insets, uses a 15px title and a vertical ⋮ trigger', () => {
    const html = renderToStaticMarkup(
      createElement(Header, {
        currentSceneTitle: 'Light reactions',
        mode: 'playback',
        canEdit: true,
        onToggleEditMode: () => undefined,
        layout: 'phone',
        sceneIndex: 1,
        sceneCount: 4,
      }),
    );
    const header = html.match(/<header[^>]*>/)![0];
    expect(header).toContain('h-[52px]');
    expect(header).toContain('px-1');
    expect(html).toMatch(/<h1[^>]*text-\[15px\][^>]*>Light reactions<\/h1>/);
    expect(html).toContain('stage.pageCounter(2/4)');
    const trigger = html.match(/<button[^>]*data-testid="header-overflow-menu"[^>]*>/)![0];
    expect(trigger).toContain('size-11');
    expect(html).toContain('lucide-ellipsis-vertical');
    expect(html).not.toContain('lucide-ellipsis"');
  });
});
