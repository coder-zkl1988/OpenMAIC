// @vitest-environment jsdom

/**
 * Classroom chrome restyle (Classroom.dc.html): the 56px header, the 32px
 * settings pill with 26px controls, the 32×18 Pro switch and the 180px scene
 * sidebar. The header and the Pro CommandBar share one height and right
 * padding so the HeaderControls cluster does not jump on the Stage cross-fade.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key, locale: 'en-US', setLocale: () => undefined }),
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

import { Header } from '@/components/header';
import { HeaderControls } from '@/components/stage/header-controls';
import { SceneSidebar } from '@/components/stage/scene-sidebar';
import { useStageStore } from '@/lib/store';
import type { Scene } from '@/lib/types/stage';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const source = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

/** The opening tag of the first element whose attributes contain `marker`. */
function tagWith(html: string, marker: string): string {
  const tag = html.match(new RegExp(`<[a-z0-9]+[^>]*${marker}[^>]*>`))?.[0];
  if (!tag) throw new Error(`no element with ${marker}`);
  return tag;
}

describe('classroom header', () => {
  const renderHeader = (props: Partial<Parameters<typeof Header>[0]> = {}) =>
    renderToStaticMarkup(
      createElement(Header, {
        currentSceneTitle: 'Photosynthesis basics',
        mode: 'playback',
        canEdit: true,
        onToggleEditMode: () => undefined,
        ...props,
      }),
    );

  it('is 56px with a 36px back button and a 16px semibold title, no eyebrow', () => {
    const html = renderHeader();

    expect(tagWith(html, 'h-14')).toContain('pl-3 pr-5');
    expect(tagWith(html, 'aria-label="generation.backToHome"')).toContain('size-9');
    expect(tagWith(html, 'aria-label="generation.backToHome"')).toContain(
      'rounded-[10px] text-icon',
    );
    expect(html).toMatch(
      /<h1[^>]*text-base leading-6 font-semibold[^>]*>Photosynthesis basics<\/h1>/,
    );
    expect(html).not.toContain('stage.currentScene');
  });

  it('keeps the workbench pane variants: custom back control, no back, Pro switch only', () => {
    const custom = renderHeader({
      backControl: createElement('button', { 'data-testid': 'workbench-return' }),
    });
    expect(custom).toContain('data-testid="workbench-return"');
    expect(custom).not.toContain('aria-label="generation.backToHome"');

    const bare = renderHeader({
      hideBackControl: true,
      hideGlobalControls: true,
      hideCourseActions: true,
    });
    expect(renderHeader()).toContain('aria-label="generation.backToHome"');
    expect(bare).not.toContain('aria-label="generation.backToHome"');
    expect(bare.match(/role="switch"/g)).toHaveLength(1);
    expect(bare).toContain('edit.proMode');
    expect(bare).not.toContain('settings.theme');
  });
});

describe('HeaderControls', () => {
  const html = renderToStaticMarkup(
    createElement(HeaderControls, {
      mode: 'playback',
      canEdit: true,
      onToggleEditMode: () => undefined,
    }),
  );

  it('renders the 32px settings pill with 26px language, theme and settings buttons', () => {
    expect(tagWith(html, 'gap-0.5 h-8 px-1')).toContain('border-line bg-white/70');
    // The language button keeps the locale short label as its accessible name (e2e: 'EN').
    expect(html).toMatch(/<button[^>]*h-\[26px\] px-2\.5 text-fg-secondary[^>]*>EN<\/button>/);
    expect(tagWith(html, 'aria-label="settings.theme"')).toContain('size-[26px]');
    expect(tagWith(html, 'aria-label="settings.title"')).toContain('size-[26px]');
  });

  it('renders the Pro label pill and exactly one 32×18 switch', () => {
    expect(html.match(/role="switch"/g)).toHaveLength(1);
    const label = tagWith(html, 'h-8 pl-3 pr-2.5');
    expect(label).toContain('border-line');
    expect(html).toMatch(/text-xs font-semibold[^"]*text-fg-secondary[^>]*>edit\.proMode</);
    expect(html).not.toContain('uppercase');
    expect(tagWith(html, 'role="switch"')).toContain('h-[18px] w-8');
    expect(tagWith(html, 'role="switch"')).toContain('data-[state=unchecked]:bg-line-strong');
  });

  it('renders the export trigger as a 32px round icon button', () => {
    expect(tagWith(html, 'aria-label="export.pptx"')).toContain('size-8');
    expect(tagWith(html, 'aria-label="export.pptx"')).toContain('text-icon');
  });

  it('has no compact variant left', () => {
    expect(source('components/stage/header-controls.tsx')).not.toContain('compact');
  });
});

describe('header / CommandBar cross-fade contract', () => {
  it('gives the Pro CommandBar the playback header height and right padding', () => {
    const commandBar = source('components/edit/EditShell/CommandBar.tsx');
    expect(commandBar).toMatch(/<header className="[^"]*\bh-14\b[^"]*\bpx-5\b/);
    expect(commandBar).not.toContain('h-20');

    const header = source('components/header.tsx');
    expect(header).toMatch(/<header className="[^"]*\bh-14\b[^"]*\bpr-5\b/);
  });

  it('sizes the playback scene viewer against the 56px header', () => {
    const root = source('components/edit/PlaybackChromeRoot.tsx');
    expect(root).toContain('const headerHeight = isPresenting || hideHeader ? 0 : 56;');
  });

  it('scopes the classroom surface root with data-ui="v2"', () => {
    expect(source('components/classroom/ClassroomSurface.tsx')).toContain('data-ui="v2"');
  });
});

describe('SceneSidebar', () => {
  const quiz = (id: string, title: string, order: number) =>
    ({
      id,
      stageId: 'stage-1',
      type: 'quiz',
      title,
      order,
      content: { type: 'quiz', questions: [] },
    }) as unknown as Scene;

  afterEach(() => {
    useStageStore.setState({ scenes: [], currentSceneId: null });
    document.body.replaceChildren();
  });

  /** Client render: the server snapshot of the stage store is its initial (empty) state. */
  function renderSidebar(): string {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    act(() =>
      root.render(
        createElement(SceneSidebar, { collapsed: false, onCollapseChange: () => undefined }),
      ),
    );
    const html = container.innerHTML;
    act(() => root.unmount());
    return html;
  }

  it('defaults to 180px and marks the active scene with the primary-1 / primary-3 row', () => {
    useStageStore.setState({
      scenes: [quiz('s1', 'Basics', 0), quiz('s2', 'Light reactions', 1)],
      currentSceneId: 's2',
    });
    const html = renderSidebar();

    expect(html).toContain('width: 180px');
    expect(tagWith(html, 'data-testid="scene-list"')).toContain('px-2 pb-2 pt-1 space-y-1.5');

    const items = html.match(/<div data-testid="scene-item"[^>]*>/g) ?? [];
    expect(items).toHaveLength(2);
    expect(items[0]).not.toContain('bg-primary-1');
    expect(items[1]).toContain('bg-primary-1 ring-1 ring-primary-3');
    expect(items[1]).toContain('rounded-[10px]');

    expect(html).toMatch(/bg-primary-6[^>]*>2<\/span>/);
    expect(html).toMatch(/bg-subtle text-icon[^>]*>1<\/span>/);
    expect(html).toMatch(/data-testid="scene-title"[^>]*text-primary-7[^>]*>Light reactions</);
  });

  it('gives the icon-only collapse button an accessible name', () => {
    const html = renderSidebar();
    expect(tagWith(html, 'aria-label="stage.collapseSceneSidebar"')).toContain('size-7');
  });
});
