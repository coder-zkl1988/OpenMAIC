// @vitest-environment jsdom
import { act, createElement, createRef, useContext, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/hooks/use-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/store', () => ({
  useStageStore: (selector: (state: { scenes: unknown[] }) => unknown) => selector({ scenes: [] }),
}));
vi.mock('@/lib/chat/lecture-notes', () => ({
  buildLectureNotes: () => [],
  buildLectureNoteMoments: () => new Map(),
}));
vi.mock('@/components/chat/lecture-notes-view', () => ({
  LectureNotesView: () => createElement('div', { 'data-testid': 'notes' }),
}));
const chat = vi.hoisted(() => ({
  /** What useChatSessions returns (the panel tests need only the sessions) */
  state: {} as Record<string, unknown>,
  /** The stream's last props */
  streamProps: {} as Record<string, unknown>,
}));
vi.mock('@/components/chat/conversation-stream', () => ({
  ConversationStream: (props: { trailing?: ReactNode; density?: string }) => {
    chat.streamProps = props;
    return createElement(
      'div',
      { 'data-testid': 'stream', 'data-density': props.density },
      props.trailing,
    );
  },
}));
vi.mock('@/components/chat/use-chat-sessions', () => ({
  MANUAL_STOP_END_OPTIONS: { source: 'manual_stop' },
  isAsideSession: (session: { config?: { aside?: boolean } }) => session.config?.aside === true,
  useChatSessions: () => chat.state,
}));

import { ChatArea, type ChatAreaRef } from '@/components/chat/chat-area';
import { ProactiveCardInViewContext } from '@/components/chat/use-proactive-countdown';

describe('ChatArea panel: the 互动 tab behind 笔记 and a collapsed panel', () => {
  let container: HTMLDivElement;
  let root: Root;
  const ref = createRef<ChatAreaRef>();

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    chat.state = { sessions: [], activeSessionType: null, isStreaming: false };
    chat.streamProps = {};
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

  it('keeps a pending 发起讨论 card mounted on 笔记 (its countdown frozen) and flags 互动', () => {
    const trailing = createElement('div', { 'data-testid': 'offer' });
    render({ streamTrailing: trailing });
    const card = offer();
    expect(card).not.toBeNull();

    act(() => ref.current!.switchToTab('notes'));
    // Same node, only hidden: no remount, so the countdown keeps where it stood
    expect(offer()).toBe(card);
    expect(interactionPanel().getAttribute('data-state')).toBe('inactive');
    expect(interactionPanel().className).toContain('data-[state=inactive]:hidden');
    // The amber dot on 互动 tells the learner something waits there
    const interactionTab = container.querySelector('[role="tab"]')!;
    expect(interactionTab.querySelector('.animate-ping')).not.toBeNull();

    render({ streamTrailing: undefined });
    expect(interactionTab.querySelector('.animate-ping')).toBeNull();
  });

  it("tells the stream's card when it can be seen: 互动 in front and the panel open", () => {
    const seen: boolean[] = [];
    function Card() {
      seen.push(useContext(ProactiveCardInViewContext));
      return createElement('div', { 'data-testid': 'offer' });
    }
    render({ streamTrailing: createElement(Card) });
    expect(seen.at(-1)).toBe(true);
    act(() => ref.current!.switchToTab('notes'));
    expect(seen.at(-1)).toBe(false);
    act(() => ref.current!.switchToTab('interaction'));
    expect(seen.at(-1)).toBe(true);
    render({ streamTrailing: createElement(Card), collapsed: true });
    expect(seen.at(-1)).toBe(false);
  });

  it("shows the waiting moment's opener on 互动 instead of the bare dot while 笔记 is in front", () => {
    const pendingOffer = { name: 'Mia', avatar: '/avatars/mia.png', label: 'Mia offers' };
    const trailing = createElement('div', { 'data-testid': 'offer' });
    render({ streamTrailing: trailing, pendingOffer });
    const hint = () => container.querySelector('[data-testid="interaction-offer-hint"]');
    // 互动 in front: the card itself is in view
    expect(hint()).toBeNull();

    act(() => ref.current!.switchToTab('notes'));
    const interactionTab = container.querySelector('[role="tab"]')!;
    expect(interactionTab.contains(hint())).toBe(true);
    expect(hint()!.querySelector('img')?.getAttribute('src')).toBe('/avatars/mia.png');
    expect(hint()!.querySelector('.sr-only')?.textContent).toBe('Mia offers');
    // One hint, not the dot as well
    expect(interactionTab.querySelectorAll('.animate-ping')).toHaveLength(1);

    render({ streamTrailing: undefined, pendingOffer: null });
    expect(hint()).toBeNull();
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

  describe("the teaching assistant's aside", () => {
    const qa = { id: 'qa-1', type: 'qa', status: 'active', config: { agentIds: ['default-1'] } };
    const aside = {
      id: 'aside-1',
      type: 'qa',
      status: 'active',
      config: { agentIds: ['default-2'], aside: true },
    };
    let endSession: ReturnType<typeof vi.fn>;
    let endAsideSession: ReturnType<typeof vi.fn>;
    let sendAsideMessage: ReturnType<typeof vi.fn>;

    function withSessions(sessions: unknown[], extra: Record<string, unknown> = {}) {
      endSession = vi.fn().mockResolvedValue(undefined);
      endAsideSession = vi.fn().mockResolvedValue(undefined);
      sendAsideMessage = vi.fn().mockResolvedValue(undefined);
      chat.state = {
        sessions,
        activeSessionType: 'lecture',
        isStreaming: false,
        asideSessionId: 'aside-1',
        isAsideStreaming: true,
        endSession,
        endAsideSession,
        sendAsideMessage,
        ...extra,
      };
    }

    it('keeps the stop pill on the Q&A and ends an aside on its own, without engine cleanup', async () => {
      const onStopSession = vi.fn();
      withSessions([aside, qa]);
      render({ onStopSession });

      await act(async () => {
        await ref.current!.stopActiveSession();
      });
      expect(endSession).toHaveBeenCalledExactlyOnceWith('qa-1', { source: 'manual_stop' });
      expect(onStopSession).toHaveBeenCalledExactlyOnceWith({
        sessionId: 'qa-1',
        source: 'manual_stop',
      });

      // The stream's end control on the aside: only the aside ends
      await act(async () => {
        await (chat.streamProps.onEndSession as (id: string) => Promise<void>)('aside-1');
      });
      expect(endAsideSession).toHaveBeenCalledOnce();
      expect(onStopSession).toHaveBeenCalledOnce();
    });

    it('has nothing to stop with only an aside open', async () => {
      const onStopSession = vi.fn();
      withSessions([aside]);
      render({ onStopSession });
      await act(async () => {
        await ref.current!.stopActiveSession();
      });
      expect(endSession).not.toHaveBeenCalled();
      expect(endAsideSession).not.toHaveBeenCalled();
      expect(onStopSession).not.toHaveBeenCalled();
    });

    it('reports its state, streams it on its own flag and exposes its send / end', () => {
      const onAsideStateChange = vi.fn();
      withSessions([aside]);
      render({ onAsideStateChange });
      expect(onAsideStateChange).toHaveBeenLastCalledWith({
        sessionId: 'aside-1',
        isStreaming: true,
      });
      expect(chat.streamProps).toMatchObject({ asideSessionId: 'aside-1', isAsideStreaming: true });
      expect(ref.current!.sendAsideMessage).toBe(sendAsideMessage);
      expect(ref.current!.endAsideSession).toBe(endAsideSession);

      // Re-rendering with a new (inline) callback does not re-report
      const next = vi.fn();
      render({ onAsideStateChange: next });
      expect(next).not.toHaveBeenCalled();
      withSessions([aside], { asideSessionId: null, isAsideStreaming: false });
      render({ onAsideStateChange: next });
      expect(next).toHaveBeenCalledExactlyOnceWith({ sessionId: null, isStreaming: false });
    });
  });
});
