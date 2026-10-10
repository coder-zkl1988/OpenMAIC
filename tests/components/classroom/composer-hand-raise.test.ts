// @vitest-environment jsdom
/**
 * The composer's 举手 flow (HandRaiseFlow.dc.html): a bare hand goes up from
 * the 举手 slot, shows 已举手 · 讲完这句就请你发言 with 撤回 and the line's
 * progress, is called (轮到你发言了 · 课堂已暂停) and comes down with 放下. A
 * question typed meanwhile rides on the hand (the owner's attachQuestion).
 */
import { act, createElement, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
vi.mock('@/lib/hooks/use-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));

import {
  Composer,
  type ComposerHand,
  type ComposerHandle,
  type ComposerProps,
} from '@/components/classroom/interaction/composer';
import type { HandState } from '@/lib/playback';

const QUESTION = 'Why does the curve flatten?';

describe('Composer: the 举手 flow', () => {
  let container: HTMLDivElement;
  let root: Root;
  let props: ComposerProps;
  let hand: ComposerHand & { onRaise: ReturnType<typeof vi.fn>; onLower: ReturnType<typeof vi.fn> };
  const handle = createRef<ComposerHandle>();

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    hand = { state: null, onRaise: vi.fn(() => true), onLower: vi.fn(() => true) };
    props = {
      composerRef: handle,
      onMessageSend: vi.fn(() => 'queued' as const),
      onInputActivate: vi.fn(),
      onCancelQueuedQuestion: vi.fn(),
      hand,
    };
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  async function render(next: Partial<ComposerProps> = {}) {
    props = { ...props, ...next };
    await act(async () => root.render(createElement(Composer, props)));
  }

  /** The owner mirrors the engine's hand into the prop */
  function setHand(state: HandState | null, waitsFor?: 'sentence' | 'step') {
    hand = { ...hand, state, waitsFor };
    return render({ hand });
  }

  const textarea = () => container.querySelector('textarea') as HTMLTextAreaElement;
  const raiseButton = () =>
    container.querySelector('[data-testid="composer-raise-hand"]') as HTMLButtonElement | null;
  const lowerButton = () =>
    container.querySelector('[data-testid="composer-lower-hand"]') as HTMLButtonElement | null;
  const row = () => container.querySelector('[data-testid="composer-queued-question"]');
  const box = () => container.querySelector('[data-testid="composer-box"]')!;
  const liveRegion = () => container.querySelector('span[role="status"]')!;
  const withdraw = () =>
    [...(row()?.querySelectorAll('button') ?? [])].find(
      (b) => b.textContent === 'roundtable.cancelQueuedQuestion',
    )!;

  function typeAndSend(text: string) {
    act(() => textarea().focus());
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        textarea(),
        text,
      );
      textarea().dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() =>
      textarea().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })),
    );
  }

  it('raises a bare hand from the 举手 pill without focusing or activating the input', async () => {
    await render();
    const raise = raiseButton()!;
    expect(raise.getAttribute('aria-pressed')).toBeNull();
    expect(raise.className).toContain('bg-subtle');
    expect(raise.title).toBe('stage.composer.raiseHandHint');
    expect(raise.querySelector('svg')?.getAttribute('class')).toContain('text-warning');

    act(() => raise.click());
    expect(hand.onRaise).toHaveBeenCalledOnce();
    // Typing never pauses the lecture, and raising does not even open the input
    expect(props.onInputActivate).not.toHaveBeenCalled();
    expect(document.activeElement).not.toBe(textarea());
  });

  it('shows 放下 (pressed, amber) and the 已举手 row with 撤回 and the progress while raised', async () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] });
    await render({ getSpeechProgress: () => 0.64 });
    await setHand('raised');

    expect(raiseButton()).toBeNull();
    const lower = lowerButton()!;
    expect(lower.getAttribute('aria-pressed')).toBe('true');
    expect(lower.className).toContain('bg-amber-500');
    expect(lower.className).toContain('text-white');
    expect(lower.textContent).toBe('stage.composer.lowerHand');

    expect(row()?.getAttribute('data-kind')).toBe('hand');
    expect(row()?.textContent).toContain('stage.composer.handRaised');
    expect(textarea().placeholder).toBe('stage.composer.raisedPlaceholder');
    // Announced through the always-mounted status region
    expect(liveRegion().getAttribute('aria-live')).toBe('polite');
    expect(liveRegion().textContent).toBe('stage.composer.handRaised');

    act(() => vi.advanceTimersToNextFrame());
    const bar = container.querySelector('[data-testid="composer-queued-progress"]');
    expect(bar?.getAttribute('aria-hidden')).toBe('true');
    expect((bar?.firstElementChild as HTMLElement).style.width).toBe('64%');

    // 撤回 lowers the hand and says so
    act(() => withdraw().click());
    expect(hand.onLower).toHaveBeenCalledOnce();
    await setHand(null);
    expect(row()).toBeNull();
    expect(raiseButton()).not.toBeNull();
    expect(liveRegion().textContent).toBe('stage.composer.handLowered');
  });

  it('words the row by what the hand waits for', async () => {
    await setHand('raised', 'step');
    expect(row()?.textContent).toContain('stage.composer.handRaisedStep');
  });

  it('turns to the cue when the hand is called, and 放下 gives the floor back', async () => {
    await setHand('raised');
    await setHand('called');
    expect(row()).toBeNull();
    expect(container.querySelector('[data-testid="composer-cue"]')?.textContent).toContain(
      'stage.composer.cueStatus',
    );
    expect(box().getAttribute('data-state')).toBe('cue');
    expect(textarea().placeholder).toBe('stage.composer.cuePlaceholder');
    expect(liveRegion().textContent).toBe('stage.composer.cueStatus');

    act(() => lowerButton()!.click());
    expect(hand.onLower).toHaveBeenCalledOnce();
    expect(props.onCancelQueuedQuestion).not.toHaveBeenCalled();
  });

  it('upgrades the hand with a typed question: the owner queues it on the same boundary', async () => {
    await setHand('raised');
    typeAndSend(QUESTION);
    expect(props.onMessageSend).toHaveBeenCalledExactlyOnceWith(QUESTION);
    // The owner attached it: the hand is now a queued question
    hand = { ...hand, state: null };
    await render({ hand, queuedQuestion: { id: 1, text: QUESTION, status: 'queued' } });
    expect(row()?.getAttribute('data-kind')).toBe('question');
    expect(row()?.textContent).toContain(QUESTION);
    expect(row()?.textContent).toContain('roundtable.handRaisedQueued');
    // Still a raised hand: 放下 takes the question back
    act(() => lowerButton()!.click());
    expect(props.onCancelQueuedQuestion).toHaveBeenCalledOnce();
    expect(hand.onLower).not.toHaveBeenCalled();
  });

  it('is disabled during a Q&A or discussion (问答中可直接发言)', async () => {
    await render({ isLiveSession: true });
    const raise = raiseButton()!;
    expect(raise.disabled).toBe(true);
    expect(raise.title).toBe('stage.composer.raiseHandInLiveSession');
    act(() => raise.click());
    act(() => handle.current!.toggleHand());
    expect(hand.onRaise).not.toHaveBeenCalled();
    // A discussion keeps the default prompt; the learner's own Q&A invites a follow-up
    expect(textarea().placeholder).toBe('roundtable.inputPlaceholder');
    await render({ isLiveSession: true, isFollowUp: true });
    expect(textarea().placeholder).toBe('stage.composer.followUpPlaceholder');
  });

  it('focuses the textarea for a question when no hand can go up', async () => {
    hand.onRaise.mockReturnValue(false);
    await render();
    act(() => raiseButton()!.click());
    expect(hand.onRaise).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(textarea());
  });

  it('toggles from the shell (H): raise, lower, or take a waiting question back', async () => {
    await render();
    act(() => handle.current!.toggleHand());
    expect(hand.onRaise).toHaveBeenCalledOnce();

    await setHand('raised');
    act(() => handle.current!.toggleHand());
    expect(hand.onLower).toHaveBeenCalledOnce();

    await setHand(null);
    await render({ queuedQuestion: { id: 2, text: QUESTION, status: 'queued' } });
    act(() => handle.current!.toggleHand());
    expect(props.onCancelQueuedQuestion).toHaveBeenCalledOnce();
  });
});
