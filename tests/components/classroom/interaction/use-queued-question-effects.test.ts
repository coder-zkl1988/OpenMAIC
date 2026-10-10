// @vitest-environment jsdom
import { act, createElement, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/hooks/use-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));

import {
  SPEECH_PROGRESS_INTERVAL_MS,
  useQueuedQuestionEffects,
  type QueuedQuestionState,
  type UseQueuedQuestionEffectsOptions,
} from '@/components/classroom/interaction/use-queued-question-effects';

describe('useQueuedQuestionEffects', () => {
  let container: HTMLDivElement;
  let root: Root;
  let queued: ReturnType<typeof useQueuedQuestionEffects>;
  let options: UseQueuedQuestionEffectsOptions;

  function Probe({
    onResult,
    ...props
  }: UseQueuedQuestionEffectsOptions & {
    readonly onResult: (value: ReturnType<typeof useQueuedQuestionEffects>) => void;
  }) {
    onResult(useQueuedQuestionEffects(props));
    return null;
  }

  function render(next: Partial<UseQueuedQuestionEffectsOptions> = {}) {
    options = { ...options, ...next };
    act(() =>
      root.render(
        createElement(Probe, {
          ...options,
          onResult: (value) => {
            queued = value;
          },
        }),
      ),
    );
  }

  function question(status: QueuedQuestionState['status'], id = 1): QueuedQuestionState {
    return { id, text: 'Why?', status };
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] });
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    root = createRoot(container);
    options = {
      queuedQuestion: null,
      isSendCooldown: false,
      isSendCoolingDown: () => false,
      onDelivered: vi.fn(),
      onReturned: vi.fn(),
      focusTargetRef: createRef<HTMLElement>(),
    };
  });
  afterEach(() => {
    act(() => root.unmount());
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('runs each transition once and labels the live region', () => {
    render({ queuedQuestion: question('queued') });
    expect(queued).toMatchObject({
      isQueued: true,
      label: 'roundtable.handRaisedQueued',
      liveText: 'roundtable.handRaisedQueued',
    });

    render({ queuedQuestion: question('delivered') });
    expect(options.onDelivered).toHaveBeenCalledExactlyOnceWith('Why?');
    expect(queued.liveText).toBe('roundtable.handRaisedDelivered');
    // New callbacks on a re-render do not replay the transition
    render({ onDelivered: vi.fn(), onReturned: vi.fn() });
    expect(options.onDelivered).not.toHaveBeenCalled();

    // The learner's own 撤回 is announced as lowering the hand
    render({ queuedQuestion: question('queued', 2) });
    expect(queued.liveText).toBe('roundtable.handRaisedQueued');
    act(() => queued.announceHandLowered());
    expect(queued.liveText).toBe('roundtable.handRaisedQueued');
    render({ queuedQuestion: question('cancelled', 2) });
    expect(options.onReturned).toHaveBeenCalledExactlyOnceWith('Why?');
    expect(queued.liveText).toBe('stage.composer.handLowered');

    // A cancellation the learner did not ask for (scene switch, leaving
    // playback) is not announced as "hand lowered"
    render({ queuedQuestion: question('queued', 3) });
    render({ queuedQuestion: question('cancelled', 3) });
    expect(queued.liveText).toBe('');

    render({ queuedQuestion: question('restored', 4) });
    expect(queued.liveText).toBe('');
  });

  it('never falls back to a stale outcome once a later hand or cue clears', () => {
    render({ queuedQuestion: question('queued') });
    render({ queuedQuestion: question('delivered') });
    expect(queued.liveText).toBe('roundtable.handRaisedDelivered');

    // A bare hand later: up, then called and answered — not "delivered" again
    render({ handState: 'raised' });
    expect(queued.liveText).toBe('stage.composer.handRaised');
    render({ handState: 'called' });
    render({ handState: null });
    expect(queued.liveText).toBe('');

    // The director's cue comes and goes: still nothing stale
    render({ isCueUser: true });
    render({ isCueUser: false });
    expect(queued.liveText).toBe('');
  });

  it('announces a bare hand: raised (by what it waits for), called, then lowered', () => {
    render();
    expect(queued.liveText).toBe('');

    render({ handState: 'raised' });
    expect(queued).toMatchObject({
      isHandRaised: true,
      handLabel: 'stage.composer.handRaised',
      liveText: 'stage.composer.handRaised',
    });
    render({ handWaitsFor: 'step' });
    expect(queued.liveText).toBe('stage.composer.handRaisedStep');

    render({ handState: 'called' });
    expect(queued).toMatchObject({ isHandCalled: true, liveText: 'stage.composer.cueStatus' });

    render({ handState: null });
    expect(queued.liveText).toBe('');
    act(() => queued.announceHandLowered());
    expect(queued.liveText).toBe('stage.composer.handLowered');
    // The next hand replaces the announcement
    render({ handState: 'raised' });
    expect(queued.liveText).toBe('stage.composer.handRaisedStep');
    render({ handState: null });
    expect(queued.liveText).toBe('');
  });

  it("announces the director's cue like a called hand", () => {
    render({ isCueUser: true });
    expect(queued.liveText).toBe('stage.composer.cueStatus');
  });

  it('does not replay a state passed on mount', () => {
    render({ queuedQuestion: question('restored') });
    expect(options.onReturned).not.toHaveBeenCalled();
  });

  it('says "after this step" when no spoken line was playing', () => {
    render({ queuedQuestion: { ...question('queued'), waitsFor: 'step' } });
    expect(queued.label).toBe('roundtable.handRaisedQueuedStep');
  });

  it('polls the line progress about ten times a second while a hand or question waits', () => {
    let progress = 0.25;
    const getSpeechProgress = vi.fn(() => progress);
    render({ getSpeechProgress });
    expect(queued.speechProgress).toBeNull();

    render({ handState: 'raised' });
    expect(queued.isHandRaised).toBe(true);
    act(() => {
      vi.advanceTimersToNextFrame();
    });
    expect(queued.speechProgress).toBe(0.25);
    expect(getSpeechProgress).toHaveBeenCalledOnce();
    // Throttled: the next frames inside 100ms do not read the player again
    progress = 0.5;
    act(() => {
      vi.advanceTimersByTime(SPEECH_PROGRESS_INTERVAL_MS - 20);
    });
    expect(getSpeechProgress).toHaveBeenCalledOnce();
    expect(queued.speechProgress).toBe(0.25);
    act(() => {
      vi.advanceTimersByTime(40);
    });
    expect(getSpeechProgress).toHaveBeenCalledTimes(2);
    expect(queued.speechProgress).toBe(0.5);

    // Called: the line is over, polling stops
    render({ handState: 'called' });
    expect(queued).toMatchObject({ isHandCalled: true, speechProgress: null });
    const calls = getSpeechProgress.mock.calls.length;
    act(() => {
      vi.advanceTimersToNextFrame();
    });
    expect(getSpeechProgress).toHaveBeenCalledTimes(calls);

    // A new wait starts fresh: no reading from the previous line
    progress = 0.1;
    render({ handState: null, queuedQuestion: question('queued', 3) });
    expect(queued.speechProgress).toBeNull();
    act(() => {
      vi.advanceTimersToNextFrame();
    });
    expect(queued.speechProgress).toBe(0.1);
  });
});
