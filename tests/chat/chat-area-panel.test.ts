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
  ConversationStream: ({ trailing }: { trailing?: ReactNode }) =>
    createElement('div', { 'data-testid': 'stream' }, trailing),
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
});
