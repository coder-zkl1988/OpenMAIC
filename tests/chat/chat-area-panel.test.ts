// @vitest-environment jsdom
import { act, createElement, createRef, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/hooks/use-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/store', () => ({
  useStageStore: (selector: (state: { scenes: unknown[] }) => unknown) => selector({ scenes: [] }),
}));
vi.mock('@/lib/chat/lecture-notes', () => ({ buildLectureNotes: () => [] }));
vi.mock('@/components/chat/lecture-notes-view', () => ({
  LectureNotesView: () => createElement('div', { 'data-testid': 'notes' }),
}));
vi.mock('@/components/chat/conversation-stream', () => ({
  ConversationStream: ({ trailing, density }: { trailing?: ReactNode; density?: string }) =>
    createElement('div', { 'data-testid': 'stream', 'data-density': density }, trailing),
}));
vi.mock('@/components/chat/use-chat-sessions', () => ({
  MANUAL_STOP_END_OPTIONS: { source: 'manual_stop' },
  useChatSessions: () => ({
    sessions: [],
    activeSessionType: null,
    isStreaming: false,
  }),
}));

import { ChatArea, type ChatAreaRef } from '@/components/chat/chat-area';

describe('ChatArea panel: the 互动 tab behind 笔记 and a collapsed panel', () => {
  let container: HTMLDivElement;
  let root: Root;
  const ref = createRef<ChatAreaRef>();

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  function render(props: Record<string, unknown>) {
    act(() => root.render(createElement(ChatArea, { ref, ...props })));
  }

  const offer = () => container.querySelector('[data-testid="offer"]');
  const interactionPanel = () => container.querySelector('[data-testid="stream"]')!.parentElement!;

  it('keeps a pending 发起讨论 card mounted on 笔记 (its countdown keeps running) and flags 互动', () => {
    const trailing = createElement('div', { 'data-testid': 'offer' });
    render({ streamTrailing: trailing });
    const card = offer();
    expect(card).not.toBeNull();

    act(() => ref.current!.switchToTab('notes'));
    // Same node, only hidden: no remount, so no restarted countdown
    expect(offer()).toBe(card);
    expect(interactionPanel().getAttribute('data-state')).toBe('inactive');
    expect(interactionPanel().className).toContain('data-[state=inactive]:hidden');
    // The amber dot on 互动 tells the learner something waits there
    const interactionTab = container.querySelector('[role="tab"]')!;
    expect(interactionTab.querySelector('.animate-ping')).not.toBeNull();

    render({ streamTrailing: undefined });
    expect(interactionTab.querySelector('.animate-ping')).toBeNull();
  });

  it('reports the composer going out of sight once per hide (笔记, then collapsing)', () => {
    const onFooterHidden = vi.fn();
    const footer = createElement('div', { 'data-testid': 'composer' });
    render({ footer, onFooterHidden });
    expect(onFooterHidden).not.toHaveBeenCalled();

    act(() => ref.current!.switchToTab('notes'));
    expect(onFooterHidden).toHaveBeenCalledOnce();
    // Still hidden on a later render: not reported again
    render({ footer, onFooterHidden, collapsed: true });
    expect(onFooterHidden).toHaveBeenCalledOnce();

    act(() => ref.current!.switchToTab('interaction'));
    render({ footer, onFooterHidden, collapsed: false });
    expect(onFooterHidden).toHaveBeenCalledOnce();
    render({ footer, onFooterHidden, collapsed: true });
    expect(onFooterHidden).toHaveBeenCalledTimes(2);
  });

  it('touch density: a 52px tab row of 44px targets, a 44px collapse button, no drag handle', () => {
    const resizeHandle = () => container.querySelector('.cursor-col-resize');
    render({ width: 320, onCollapseChange: vi.fn(), density: 'touch' });
    const aside = container.querySelector('aside')!;
    expect(aside.style.width).toBe('320px');
    expect(resizeHandle()).toBeNull();
    expect(container.querySelector('[role="tablist"]')!.className).toContain('h-11');
    expect(container.querySelector('[role="tablist"]')!.parentElement!.className).toContain(
      'h-[52px]',
    );
    expect(container.querySelector('[role="tab"]')!.className).toContain('text-sm');
    expect(container.querySelector('button[aria-label="chat.collapsePanel"]')!.className).toContain(
      'size-11',
    );

    // Desktop keeps the drag-resize and the 28px collapse button
    render({ width: 360, onCollapseChange: vi.fn() });
    expect(resizeHandle()).not.toBeNull();
    expect(container.querySelector('button[aria-label="chat.collapsePanel"]')!.className).toContain(
      'size-7',
    );
  });

  describe('stacked layouts (TabletPortrait / ClassroomPhone.dc.html)', () => {
    const scenes = createElement('div', { 'data-testid': 'scene-grid' });
    const tabs = () => [...container.querySelectorAll('[role="tab"]')] as HTMLElement[];
    const section = () => container.querySelector('[data-testid="interaction-section"]')!;

    it('is a full-width section with a 3-column 互动 / 笔记 / 场景 segmented control', () => {
      render({ layout: 'stacked', scenes, onlineCount: 5, onCollapseChange: vi.fn(), width: 320 });
      expect(section().tagName).toBe('ASIDE');
      expect(section().getAttribute('aria-label')).toBe('chat.panelLabel');
      expect(section().getAttribute('data-layout')).toBe('stacked');
      // No fixed width, no drag-resize, no collapse button: it fills the column
      expect((section() as HTMLElement).style.width).toBe('');
      expect(section().className).toContain('flex-1');
      expect(container.querySelector('.cursor-col-resize')).toBeNull();
      expect(container.querySelector('button[aria-label="chat.collapsePanel"]')).toBeNull();

      const list = container.querySelector('[role="tablist"]')!;
      expect(list.className).toContain('grid-cols-3');
      expect(tabs().map((tab) => tab.textContent)).toEqual([
        'chat.tabs.chatstage.participants.online',
        'chat.tabs.lecture',
        'chat.tabs.scenes',
      ]);
      // TabletPortrait: 40px segments
      for (const tab of tabs()) expect(tab.className).toContain('h-10');
      expect(tabs()[0].getAttribute('data-state')).toBe('active');
    });

    it('phone: 36px segments and the bare online count (a screen reader hears the label)', () => {
      render({ layout: 'phone', scenes, onlineCount: 5 });
      for (const tab of tabs()) expect(tab.className).toContain('h-9');
      // The stream takes the phone's tighter spacing
      expect(container.querySelector('[data-testid="stream"]')?.getAttribute('data-density')).toBe(
        'phone',
      );
      const count = tabs()[0].querySelector('[aria-hidden="true"]:not(.rounded-full)')!;
      expect(count.textContent).toBe('5');
      expect(tabs()[0].querySelector('.sr-only')!.textContent).toBe('stage.participants.online');
    });

    it('switchToTab reaches 场景 and back to 互动; the composer hides on 场景', () => {
      const onFooterHidden = vi.fn();
      const footer = createElement('div', { 'data-testid': 'composer' });
      render({ layout: 'stacked', scenes, footer, onFooterHidden });
      expect(container.querySelector('[data-testid="scene-grid"]')).toBeNull();

      act(() => ref.current!.switchToTab('scenes'));
      expect(container.querySelector('[data-testid="scene-grid"]')).not.toBeNull();
      expect(tabs()[2].getAttribute('data-state')).toBe('active');
      expect(onFooterHidden).toHaveBeenCalledOnce();
      expect(
        container.querySelector('[data-testid="composer"]')!.parentElement!.className,
      ).toContain('hidden');

      // The shell's question-sent / cue / offer calls still land on 互动
      act(() => ref.current!.switchToTab('chat'));
      expect(tabs()[0].getAttribute('data-state')).toBe('active');
      expect(
        container.querySelector('[data-testid="composer"]')!.parentElement!.className,
      ).not.toContain('hidden');
    });

    it('falls back to 互动 when 场景 is left behind by the switch to the side panel', () => {
      render({ layout: 'stacked', scenes });
      act(() => ref.current!.switchToTab('scenes'));
      render({ layout: 'panel', width: 320, density: 'touch' });
      expect(tabs()).toHaveLength(2);
      expect(tabs()[0].getAttribute('data-state')).toBe('active');
      expect(interactionPanel().getAttribute('data-state')).toBe('active');
    });

    it('keeps the stream mounted across the switch between the panel and the section', () => {
      const trailing = createElement('div', { 'data-testid': 'offer' });
      render({ layout: 'panel', streamTrailing: trailing });
      const card = offer();
      render({ layout: 'stacked', scenes, streamTrailing: trailing });
      expect(offer()).toBe(card);
    });

    it('hides while presenting (collapsed)', () => {
      render({ layout: 'phone', scenes, collapsed: true });
      expect(section().className).toContain('hidden');
    });
  });
});
