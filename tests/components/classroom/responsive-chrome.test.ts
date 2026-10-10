// @vitest-environment jsdom

/**
 * Tablet landscape chrome (TabletLandscape.dc.html, P7a): the 64px numbered
 * scene rail, the 52px compact header with "n / m" and the 44px ⋯ menu that
 * holds language / theme / settings / the Pro switch row / export, the 56px
 * control bar of 44px targets, the 44px composer controls and the panel's
 * 52px tab row. Desktop stays the default for every component.
 */
import { act, createElement, useState } from 'react';
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
vi.mock('@/components/slide-renderer/SlideThumbnail', () => ({ SlideThumbnail: () => null }));
vi.mock('@/components/slide-renderer/components/ThumbnailInteractive', () => ({
  ThumbnailInteractive: () => null,
}));
vi.mock('@/lib/hooks/use-audio-recorder', () => ({
  useAudioRecorder: () => ({
    isRecording: false,
    isProcessing: false,
    startRecording: vi.fn(),
    stopRecording: vi.fn(),
    cancelRecording: vi.fn(),
  }),
}));
vi.mock('@/lib/hooks/use-asr-available', () => ({ useASRAvailable: () => true }));

import { ControlBar, type ControlBarProps } from '@/components/classroom/control-bar';
import { Composer } from '@/components/classroom/interaction/composer';
import { Header } from '@/components/header';
import { SceneSidebar } from '@/components/stage/scene-sidebar';
import { useStageStore } from '@/lib/store';
import { PENDING_SCENE_ID } from '@/lib/store/stage';
import type { Scene } from '@/lib/types/stage';

/** The opening tag of the first element whose attributes contain `marker`. */
function tagWith(html: string, marker: string): string {
  const tag = html.match(new RegExp(`<[a-z0-9]+[^>]*${marker}[^>]*>`))?.[0];
  if (!tag) throw new Error(`no element with ${marker}`);
  return tag;
}

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

describe('ControlBar density="touch"', () => {
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
    ...overrides,
  });

  it('is a 56px bar of 44px targets without the page counter', () => {
    act(() => root.render(createElement(ControlBar, props({ density: 'touch' }))));
    const bar = container.querySelector('[data-testid="control-bar"]')!;
    expect(bar.getAttribute('data-density')).toBe('touch');
    expect(bar.className).toContain('h-14');
    expect(bar.querySelector('[data-testid="page-counter"]')).toBeNull();

    const buttons = [...bar.querySelectorAll('button')];
    // prev, pause, next, speed, volume, auto-play, whiteboard, fullscreen
    expect(buttons).toHaveLength(8);
    for (const button of buttons) expect(button.className).toContain('size-11');
    expect(buttons.some((b) => b.className.includes('size-8'))).toBe(false);
  });

  it('turns the whiteboard toggle into a named icon button and keeps fullscreen in the centre', () => {
    act(() => root.render(createElement(ControlBar, props({ density: 'touch' }))));
    const whiteboard = container.querySelector('button[aria-pressed="false"][title]')!;
    expect(whiteboard.getAttribute('aria-label')).toBe('stage.whiteboardToggle');
    expect(whiteboard.textContent).toBe('');
    const fullscreen = container.querySelector('button[aria-label="stage.fullscreen"]')!;
    expect(fullscreen.parentElement?.className).toContain('justify-center');
  });

  it('keeps the page counter when the host has no header to carry it', () => {
    act(() =>
      root.render(createElement(ControlBar, props({ density: 'touch', showPageCounter: true }))),
    );
    expect(container.querySelector('[data-testid="page-counter"]')?.textContent).toBe(
      'stage.pageCounter(2/4)',
    );
  });

  it('keeps the 48px desktop bar by default', () => {
    act(() => root.render(createElement(ControlBar, props())));
    const bar = container.querySelector('[data-testid="control-bar"]')!;
    expect(bar.getAttribute('data-density')).toBe('default');
    expect(bar.className).toContain('h-12');
    expect(bar.querySelector('[data-testid="page-counter"]')).not.toBeNull();
    expect(
      container.querySelector('button[aria-label="stage.play"], button[aria-label="stage.pause"]')
        ?.className,
    ).toContain('size-8');
  });
});

describe('Composer density="touch"', () => {
  it('makes the 举手 pill, voice and send 44px', async () => {
    await act(async () =>
      root.render(
        createElement(Composer, {
          density: 'touch',
          hand: { state: null, onRaise: () => true, onLower: () => true },
        }),
      ),
    );
    expect(
      container.querySelector('[data-testid="classroom-composer"]')?.getAttribute('data-density'),
    ).toBe('touch');
    expect(container.querySelector('[data-testid="composer-raise-hand"]')?.className).toContain(
      'h-11',
    );
    expect(
      container.querySelector('button[aria-label="roundtable.voiceInput"]')?.className,
    ).toContain('size-11');
    expect(
      container.querySelector('button[aria-label="stage.composer.send"]')?.className,
    ).toContain('size-11');
    expect(container.querySelector('textarea')?.className).toContain('text-[15px]');
  });

  it('stays 32px by default', async () => {
    await act(async () =>
      root.render(
        createElement(Composer, {
          hand: { state: null, onRaise: () => true, onLower: () => true },
        }),
      ),
    );
    expect(container.querySelector('[data-testid="composer-raise-hand"]')?.className).toContain(
      'h-8',
    );
    expect(
      container.querySelector('button[aria-label="stage.composer.send"]')?.className,
    ).toContain('size-8');
  });
});

describe('Header layout="compact"', () => {
  const render = (props: Partial<Parameters<typeof Header>[0]> = {}) =>
    renderToStaticMarkup(
      createElement(Header, {
        currentSceneTitle: 'Light reactions',
        mode: 'playback',
        canEdit: true,
        onToggleEditMode: () => undefined,
        layout: 'compact',
        sceneIndex: 1,
        sceneCount: 4,
        ...props,
      }),
    );

  it('is 52px with a 44px back button, the title, "n / m" and one ⋯ trigger', () => {
    const html = render();
    expect(tagWith(html, 'h-\\[52px\\]')).toContain('px-2 flex items-center gap-1');
    expect(tagWith(html, 'aria-label="generation.backToHome"')).toContain('size-11');
    expect(html).toMatch(/<h1[^>]*>Light reactions<\/h1>/);
    expect(html).toMatch(/data-testid="page-counter"[^>]*><span aria-hidden="true">2 \/ 4<\/span>/);
    expect(html).toContain('stage.pageCounter(2/4)');

    const trigger = tagWith(html, 'data-testid="header-overflow-menu"');
    expect(trigger).toContain('aria-label="stage.headerMenu"');
    expect(trigger).toContain('size-11');
    // Everything else lives in the menu: no pill, no inline switch, no export button
    expect(html).not.toContain('role="switch"');
    expect(html).not.toContain('aria-label="settings.theme"');
    expect(html).not.toContain('aria-label="export.pptx"');
  });

  it('keeps the workbench Pro-switch-only cluster when global and course controls are hidden', () => {
    const html = render({ hideGlobalControls: true, hideCourseActions: true });
    expect(html).not.toContain('header-overflow-menu');
    expect(html.match(/role="switch"/g)).toHaveLength(1);
  });

  it('opens a ⋯ menu with language, theme, settings, the Pro switch row and export', () => {
    const onToggleEditMode = vi.fn();
    act(() =>
      root.render(
        createElement(Header, {
          currentSceneTitle: 'Light reactions',
          mode: 'playback',
          canEdit: true,
          onToggleEditMode,
          layout: 'compact',
          sceneIndex: 1,
          sceneCount: 4,
        }),
      ),
    );
    const trigger = container.querySelector(
      '[data-testid="header-overflow-menu"]',
    ) as HTMLButtonElement;
    act(() => {
      trigger.focus();
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });

    const menu = document.body.querySelector('[role="menu"]')!;
    expect(menu).not.toBeNull();
    const text = menu.textContent ?? '';
    expect(text).toContain('settings.language');
    expect(text).toContain('settings.theme');
    expect(text).toContain('settings.title');
    expect(text).toContain('stage.exportMenu');

    const switches = document.body.querySelectorAll('[role="switch"]');
    expect(switches).toHaveLength(1);
    const pro = switches[0] as HTMLElement;
    expect(pro.getAttribute('aria-checked')).toBe('false');
    expect(pro.getAttribute('aria-label')).toBe('stage.editCourse');
    expect(pro.className).toContain('min-h-11');
    act(() => pro.click());
    expect(onToggleEditMode).toHaveBeenCalledTimes(1);
  });

  it('keeps the desktop header by default', () => {
    const html = render({ layout: undefined });
    expect(tagWith(html, 'h-14')).toContain('pl-3 pr-5');
    expect(html).not.toContain('header-overflow-menu');
    expect(html).not.toContain('data-testid="page-counter"');
  });
});

describe('SceneSidebar variant="rail"', () => {
  const scene = (id: string, type: Scene['type'], order: number) =>
    ({
      id,
      stageId: 'stage-1',
      type,
      title: `Scene ${order + 1}`,
      order,
      content: { type },
    }) as unknown as Scene;

  afterEach(() => {
    useStageStore.setState({
      scenes: [],
      currentSceneId: null,
      generatingOutlines: [],
      failedOutlines: [],
    });
  });

  function renderRail(props: Partial<Parameters<typeof SceneSidebar>[0]> = {}) {
    const onCollapseChange = vi.fn();
    const onSceneSelect = vi.fn();
    act(() =>
      root.render(
        createElement(SceneSidebar, {
          variant: 'rail',
          collapsed: false,
          onCollapseChange,
          onSceneSelect,
          ...props,
        }),
      ),
    );
    return { onCollapseChange, onSceneSelect };
  }

  it('is a 64px rail of 44px numbered targets, tinted by scene type', () => {
    useStageStore.setState({
      scenes: [
        scene('s1', 'slide', 0),
        scene('s2', 'slide', 1),
        scene('s3', 'quiz', 2),
        scene('s4', 'interactive', 3),
      ],
      currentSceneId: 's2',
    });
    const { onSceneSelect } = renderRail();

    const rail = container.querySelector('[data-testid="scene-rail"]') as HTMLElement;
    expect(rail.tagName).toBe('NAV');
    expect(rail.getAttribute('aria-label')).toBe('stage.sceneRail');
    expect(rail.style.width).toBe('64px');
    // No thumbnails, no titled rows
    expect(container.querySelector('[data-testid="scene-item"]')).toBeNull();

    const items = [...container.querySelectorAll('[data-testid="scene-rail-item"]')];
    expect(items.map((i) => i.textContent)).toEqual(['1', '2', '3', '4']);
    for (const item of items) expect(item.className).toContain('size-11');
    expect(items[1].getAttribute('aria-current')).toBe('page');
    expect(items[1].getAttribute('aria-label')).toBe('stage.sceneRailItem(2/Scene 2)');
    expect(items[1].className).toContain('bg-primary-1');
    // The artboard's current number is #722ed1, the accent-text role
    expect(items[1].className).toContain('text-accent-text');
    expect(items[2].className).toContain('bg-warning-soft text-warning');
    expect(items[3].className).toContain('bg-success-soft text-success');

    act(() => (items[2] as HTMLButtonElement).click());
    expect(onSceneSelect).toHaveBeenCalledWith('s3');
  });

  it('expands to the full sidebar from its 展开场景栏 button and hides when collapsed', () => {
    const { onCollapseChange } = renderRail();
    const expand = container.querySelector(
      'button[aria-label="stage.expandSceneSidebar"]',
    ) as HTMLButtonElement;
    expect(expand.className).toContain('size-11');
    act(() => expand.click());
    expect(onCollapseChange).toHaveBeenCalledWith(false);

    renderRail({ collapsed: true });
    const rail = container.querySelector('[data-testid="scene-rail"]') as HTMLElement;
    expect(rail.style.width).toBe('0px');
    expect(container.querySelector('button')).toBeNull();
  });

  it('hands focus to the counterpart toggle when the rail and the sidebar swap', () => {
    function Host() {
      const [open, setOpen] = useState(false);
      return createElement(SceneSidebar, {
        variant: open ? 'sidebar' : 'rail',
        density: 'touch',
        collapsed: false,
        onCollapseChange: (collapsed: boolean) => setOpen(!collapsed),
      });
    }
    act(() => root.render(createElement(Host)));

    const expand = () =>
      container.querySelector(
        'button[aria-label="stage.expandSceneSidebar"]',
      ) as HTMLButtonElement | null;
    const collapse = () =>
      container.querySelector(
        'button[aria-label="stage.collapseSceneSidebar"]',
      ) as HTMLButtonElement | null;

    act(() => {
      expand()!.focus();
      expand()!.click();
    });
    expect(container.querySelector('[data-testid="scene-rail"]')).toBeNull();
    // The sidebar opened from the rail keeps the 44px touch target
    expect(collapse()!.className).toContain('size-11');
    expect(document.activeElement).toBe(collapse());

    act(() => collapse()!.click());
    expect(container.querySelector('[data-testid="scene-rail"]')).not.toBeNull();
    expect(document.activeElement).toBe(expand());
  });

  it('keeps the desktop sidebar collapse button at 28px', () => {
    act(() =>
      root.render(
        createElement(SceneSidebar, { collapsed: false, onCollapseChange: () => undefined }),
      ),
    );
    const collapse = container.querySelector(
      'button[aria-label="stage.collapseSceneSidebar"]',
    ) as HTMLButtonElement;
    expect(collapse.className).toContain('size-7');
    expect(collapse.className).not.toContain('size-11');
  });

  it('shows the generating page and the course-complete page as compact icons', () => {
    useStageStore.setState({
      scenes: [scene('s1', 'slide', 0)],
      currentSceneId: 's1',
      generatingOutlines: [{ id: 'o2', title: 'Dark reactions' }] as never,
      failedOutlines: [],
    });
    const { onSceneSelect } = renderRail();
    const pending = container.querySelector(
      '[data-testid="scene-rail-pending"]',
    ) as HTMLButtonElement;
    expect(pending.className).toContain('size-11');
    expect(pending.getAttribute('aria-label')).toContain('stage.sceneRailItem(2/Dark reactions)');
    expect(pending.querySelector('svg')).not.toBeNull();
    act(() => pending.click());
    expect(onSceneSelect).toHaveBeenCalledWith(PENDING_SCENE_ID);

    useStageStore.setState({ generatingOutlines: [] });
    renderRail({ isCourseComplete: true });
    expect(container.querySelector('[data-testid="scene-rail-pending"]')).toBeNull();
    const complete = container.querySelector('[data-testid="scene-rail-complete"]')!;
    expect(complete.getAttribute('aria-label')).toBe('stage.courseComplete');
    expect(complete.className).toContain('bg-warning-soft');
  });
});
