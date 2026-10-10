// @vitest-environment jsdom
import { act, createElement, createRef, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  overlayProps: {} as Record<string, Record<string, unknown>>,
  proactiveProps: undefined as Record<string, unknown> | undefined,
}));

vi.mock('@/lib/hooks/use-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/hooks/use-asr-available', () => ({ useASRAvailable: () => true }));
// The speech bubbles: each side's props
vi.mock('@/components/roundtable/presentation-speech-overlay', () => ({
  PresentationSpeechOverlay: (props: Record<string, unknown>) => {
    mocks.overlayProps[props.side as string] = props;
    return null;
  },
}));
vi.mock('@/components/chat/proactive-card', () => ({
  ProactiveCard: (props: Record<string, unknown>) => {
    mocks.proactiveProps = props;
    return null;
  },
}));

import {
  PresentationDock,
  type PresentationDockHandle,
  type PresentationDockProps,
} from '@/components/classroom/presentation-dock';
import type { ComposerHandle } from '@/components/classroom/interaction/composer';
import type { PlaybackView } from '@/lib/playback';
import type { Participant } from '@/lib/types/roundtable';

const participants: Participant[] = [
  { id: 'teacher-1', name: 'Ms. Li', role: 'teacher', avatar: '/t.png', isOnline: true },
  { id: 'agent-2', name: '显眼包', role: 'student', avatar: '/a.png', isOnline: true },
  { id: 'user', name: 'You', role: 'user', avatar: '/u.png', isOnline: true },
];

const lectureView: PlaybackView = {
  phase: 'lecturePlaying',
  sourceText: 'Light reactions happen in the thylakoid.',
  bubbleRole: 'teacher',
  activeRole: 'teacher',
  buttonState: 'bars',
  isInLiveFlow: false,
  isTopicActive: false,
};

describe('PresentationDock (fullscreen: overlay, dock, composer card, discussion card)', () => {
  let container: HTMLDivElement;
  let root: Root;
  let props: PresentationDockProps;
  const dockRef = createRef<PresentationDockHandle>();
  let composer: { [K in keyof ComposerHandle]: ReturnType<typeof vi.fn> };
  let stage: HTMLDivElement;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    mocks.overlayProps = {};
    mocks.proactiveProps = undefined;
    container = document.createElement('div');
    document.body.appendChild(container);
    stage = document.createElement('div');
    document.body.appendChild(stage);
    root = createRoot(container);
    composer = {
      focus: vi.fn(() => container.querySelector('textarea')?.focus()),
      openTextInput: vi.fn(),
      toggleVoice: vi.fn(),
      dismiss: vi.fn(),
      toggleHand: vi.fn(),
    };
    props = {
      dockRef,
      participants,
      playbackView: lectureView,
      engineMode: 'playing',
      controlBar: createElement('div', { 'data-testid': 'bar' }),
      controlsVisible: true,
      // Stands in for the ComposerSlot the shell passes
      composerSlot: createElement('textarea', { 'aria-label': 'composer' }) as ReactNode,
      composerRef: { current: composer as unknown as ComposerHandle },
      isComposing: false,
      onInteractionChange: vi.fn(),
      onDiscussionStart: vi.fn(),
      onDiscussionSkip: vi.fn(),
      portalContainerRef: { current: stage },
    };
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    stage.remove();
    vi.unstubAllGlobals();
  });

  async function render(next: Partial<PresentationDockProps> = {}) {
    props = { ...props, ...next };
    await act(async () => root.render(createElement(PresentationDock, props)));
  }

  const card = () =>
    container.querySelector('[data-testid="presentation-composer-card"]') as HTMLElement;
  const isCardShown = () => card().dataset.visible === 'true';
  const button = (label: string) =>
    container.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement;
  const lastReported = () =>
    (props.onInteractionChange as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0];

  it('keeps the composer card mounted but hidden until it is opened', async () => {
    await render();
    expect(card().querySelector('textarea')).not.toBeNull();
    expect(isCardShown()).toBe(false);
    expect(lastReported()).toBe(false);
    expect(container.querySelector('[data-testid="bar"]')).not.toBeNull();
  });

  it('reports interaction while the card is open, and closes it on Escape (close) or a click outside', async () => {
    await render();

    act(() => dockRef.current!.openText());
    expect(isCardShown()).toBe(true);
    // Focused only once the card shows: a hidden textarea takes no focus
    expect(composer.focus).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(card().querySelector('textarea'));
    expect(lastReported()).toBe(true);

    act(() => dockRef.current!.close());
    expect(isCardShown()).toBe(false);
    expect(composer.dismiss).toHaveBeenCalledOnce();
    expect(lastReported()).toBe(false);

    // The text toggle opens it; the backdrop closes it
    act(() => button('roundtable.textInput').click());
    expect(button('roundtable.textInput').getAttribute('aria-pressed')).toBe('true');
    expect(lastReported()).toBe(true);
    act(() =>
      (
        container.querySelector('[data-testid="presentation-dock-backdrop"]') as HTMLElement
      ).click(),
    );
    expect(isCardShown()).toBe(false);
    expect(lastReported()).toBe(false);
  });

  it('reports the composer composing, but not a card shown only for a raised hand or the cue', async () => {
    await render({ isComposing: true });
    expect(isCardShown()).toBe(true);
    expect(lastReported()).toBe(true);

    await render({ isComposing: false, hasRaisedHand: true });
    expect(isCardShown()).toBe(true);
    expect(lastReported()).toBe(false);

    await render({ hasRaisedHand: false, isCueUser: true });
    expect(isCardShown()).toBe(true);
    expect(lastReported()).toBe(false);
  });

  it('stops reporting interaction when it unmounts mid-composition', async () => {
    await render();
    act(() => dockRef.current!.openText());
    expect(lastReported()).toBe(true);
    act(() => root.unmount());
    expect(lastReported()).toBe(false);
    root = createRoot(container);
  });

  it('opens the card for voice (V) and for a continued session, then asks the composer', async () => {
    await render();
    act(() => dockRef.current!.toggleVoice());
    expect(isCardShown()).toBe(true);
    expect(composer.toggleVoice).toHaveBeenCalledOnce();

    // Already shown: the action runs at once
    act(() => button('roundtable.voiceInput').click());
    expect(composer.toggleVoice).toHaveBeenCalledTimes(2);

    act(() => dockRef.current!.close());
    act(() => dockRef.current!.continueText());
    expect(isCardShown()).toBe(true);
    expect(composer.openTextInput).toHaveBeenCalledOnce();
    expect(composer.focus).not.toHaveBeenCalled();
  });

  it('closes the card after a send without dismissing the composer', async () => {
    await render();
    act(() => dockRef.current!.openText());
    act(() => dockRef.current!.closeAfterSend());
    expect(isCardShown()).toBe(false);
    expect(composer.dismiss).not.toHaveBeenCalled();
    expect(document.activeElement).not.toBe(card().querySelector('textarea'));
    expect(lastReported()).toBe(false);
  });

  it('feeds both speech bubbles from the caption model, with the learner line once asked', async () => {
    await render();
    const left = mocks.overlayProps.left;
    expect((left.playbackView as PlaybackView).sourceText).toBe(lectureView.sourceText);
    expect((left.playbackView as PlaybackView).bubbleRole).toBe('teacher');
    expect(left.buttonState).toBe('bars');
    expect(left.isPaused).toBe(false);

    act(() => dockRef.current!.showUserMessage('Why the thylakoid?'));
    const right = mocks.overlayProps.right;
    expect((right.playbackView as PlaybackView).bubbleRole).toBe('user');
    expect((right.playbackView as PlaybackView).sourceText).toBe('Why the thylakoid?');
    expect(right.userAvatar).toBe('/u.png');
  });

  it('portals the discussion card into the fullscreen element, anchored on the dock', async () => {
    const request = {
      type: 'discussion' as const,
      id: 'trigger-1',
      topic: 'Why are leaves green?',
      agentId: 'agent-2',
    };
    await render({ engineMode: 'paused', controlsVisible: false, discussionRequest: request });

    expect(mocks.proactiveProps).toBeDefined();
    expect(mocks.proactiveProps?.variant).toBeUndefined();
    expect(mocks.proactiveProps?.portalContainer).toBe(stage);
    expect(mocks.proactiveProps?.mode).toBe('paused');
    expect(mocks.proactiveProps?.agentName).toBe('显眼包');
    // The dock stays up for the offer even with the controls hidden
    const dockRow = container.querySelector('[data-testid="presentation-dock-row"]');
    expect(dockRow).not.toBeNull();
    expect((mocks.proactiveProps?.anchorRef as { current: Element | null }).current).toBe(dockRow);
    // The offering agent sits beside the learner in the dock
    expect(dockRow?.querySelector('[title="显眼包"]')).not.toBeNull();

    act(() => (mocks.proactiveProps?.onListen as () => void)());
    expect(props.onDiscussionStart).toHaveBeenCalledExactlyOnceWith(request);
    act(() => (mocks.proactiveProps?.onSkip as () => void)());
    expect(props.onDiscussionSkip).toHaveBeenCalledOnce();
  });

  it('hides the dock with the controls when nothing waits on the learner', async () => {
    await render({ controlsVisible: false });
    expect(container.querySelector('[data-testid="presentation-dock-row"]')).toBeNull();
    await render({ controlsVisible: false, isCueUser: true });
    expect(container.querySelector('[data-testid="presentation-dock-row"]')).not.toBeNull();
  });
});
