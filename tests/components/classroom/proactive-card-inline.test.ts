// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/hooks/use-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));

import { ProactiveCard } from '@/components/chat/proactive-card';
import { DISCUSSION_AUTO_SKIP_MS } from '@/lib/choreography';
import { ProactiveCardInViewContext } from '@/components/chat/use-proactive-countdown';
import type { DiscussionAction } from '@/lib/types/action';

const action: DiscussionAction = {
  type: 'discussion',
  id: 'trigger-1',
  topic: 'Why are leaves green?',
  agentId: 'agent-2',
};

describe('ProactiveCard inline variant (the 发起讨论 card in the stream)', () => {
  let container: HTMLDivElement;
  let root: Root;
  let onSkip: ReturnType<typeof vi.fn<() => void>>;
  let onListen: ReturnType<typeof vi.fn<() => void>>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    onSkip = vi.fn<() => void>();
    onListen = vi.fn<() => void>();
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function render(mode: 'playback' | 'paused') {
    act(() =>
      root.render(
        createElement(ProactiveCard, {
          variant: 'inline',
          action,
          mode,
          agentName: '显眼包',
          agentAvatar: '/avatars/agent.png',
          onSkip,
          onListen,
        }),
      ),
    );
  }

  const card = () => container.querySelector('[data-testid="proactive-card-inline"]');
  const buttonByText = (text: string) =>
    [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(text))!;

  it('renders in place (no portal): name, 讨论 chip, countdown, topic, join and skip only', () => {
    render('playback');
    expect(container.contains(card())).toBe(true);
    expect(card()?.getAttribute('role')).toBe('group');
    // One interpolated name: '{{name}} 发起讨论'
    expect(card()?.getAttribute('aria-label')).toBe('proactiveCard.offerLabel');
    expect(card()?.textContent).toContain('显眼包');
    expect(card()?.textContent).toContain('proactiveCard.discussion');
    expect(card()?.textContent).toContain(`${DISCUSSION_AUTO_SKIP_MS / 1000}s`);
    // The stream is a live log: the ticking seconds stay silent, and the time
    // limit is stated once instead
    const seconds = [...card()!.querySelectorAll('span')].find(
      (span) => span.textContent === `${DISCUSSION_AUTO_SKIP_MS / 1000}s`,
    );
    expect(seconds?.getAttribute('aria-hidden')).toBe('true');
    expect(card()?.querySelector('.sr-only')?.textContent).toBe('proactiveCard.autoSkipHint');
    expect(card()?.textContent).toContain('Why are leaves green?');
    // No pause toggle: the control bar's play / pause freezes the countdown
    expect(container.querySelectorAll('button')).toHaveLength(2);
    expect(card()?.textContent).not.toContain('proactiveCard.pause');

    act(() => buttonByText('proactiveCard.join').click());
    expect(onListen).toHaveBeenCalledOnce();
    act(() => buttonByText('proactiveCard.skip').click());
    expect(onSkip).toHaveBeenCalledOnce();
  });

  it("words the teacher's moment as their question to think along with", () => {
    act(() =>
      root.render(
        createElement(ProactiveCard, {
          variant: 'inline',
          action: { ...action, topic: 'Mia, what do you predict?', agentId: 'teacher-1' },
          mode: 'playback',
          agentName: 'Ms. Lin',
          openedByTeacher: true,
          onSkip,
          onListen,
        }),
      ),
    );
    expect(card()?.getAttribute('aria-label')).toBe('proactiveCard.teacherOfferLabel');
    expect(card()?.textContent).toContain('proactiveCard.question');
    expect(card()?.textContent).not.toContain('proactiveCard.discussion');
    expect(card()?.textContent).toContain('Mia, what do you predict?');
    act(() => buttonByText('proactiveCard.joinTeacher').click());
    expect(onListen).toHaveBeenCalledOnce();
  });

  it("puts the teacher's whole-class question to the learner: 我来答, 先听听大家 or 跳过, no countdown", () => {
    const onAnswer = vi.fn<() => void>();
    const onAutoSkip = vi.fn<() => void>();
    act(() =>
      root.render(
        createElement(ProactiveCard, {
          variant: 'inline',
          action: { ...action, topic: 'What do you predict?', agentId: 'teacher-1' },
          mode: 'playback',
          agentName: 'Ms. Lin',
          openedByTeacher: true,
          offer: 'ask-learner',
          autoSkip: false,
          onSkip,
          onAutoSkip,
          onListen,
          onAnswer,
        }),
      ),
    );
    expect(card()?.getAttribute('aria-label')).toBe('proactiveCard.teacherOfferLabel');
    expect(card()?.textContent).toContain('proactiveCard.question');
    // Waiting for the learner: no bar, no seconds, no time limit
    expect(container.querySelector('[data-testid="proactive-card-progress"]')).toBeNull();
    expect(card()?.textContent).not.toContain(`${DISCUSSION_AUTO_SKIP_MS / 1000}s`);
    expect(card()?.querySelector('.sr-only')).toBeNull();
    expect([...container.querySelectorAll('button')].map((b) => b.textContent)).toEqual([
      'proactiveCard.answerFirst',
      'proactiveCard.listenFirst',
      'proactiveCard.skip',
    ]);
    act(() => vi.advanceTimersByTime(DISCUSSION_AUTO_SKIP_MS * 3));
    expect(onAutoSkip).not.toHaveBeenCalled();
    expect(onSkip).not.toHaveBeenCalled();

    act(() => buttonByText('proactiveCard.answerFirst').click());
    expect(onAnswer).toHaveBeenCalledOnce();
    act(() => buttonByText('proactiveCard.listenFirst').click());
    expect(onListen).toHaveBeenCalledOnce();
    // The learner may always decline: the lecture goes on (a user skip, never an auto one)
    act(() => buttonByText('proactiveCard.skip').click());
    expect(onSkip).toHaveBeenCalledOnce();
    expect(onAutoSkip).not.toHaveBeenCalled();
  });

  it('keeps the countdown on a whole-class question when auto-skip stays on (unattended)', () => {
    const onAutoSkip = vi.fn<() => void>();
    act(() =>
      root.render(
        createElement(ProactiveCard, {
          variant: 'inline',
          action,
          mode: 'playback',
          offer: 'ask-learner',
          onSkip,
          onAutoSkip,
          onListen,
        }),
      ),
    );
    act(() => vi.advanceTimersByTime(DISCUSSION_AUTO_SKIP_MS + 500));
    expect(onAutoSkip).toHaveBeenCalledOnce();
  });

  it('offers a quiz review with no opener: 一起复盘 or 跳过, never skipping itself', () => {
    act(() =>
      root.render(
        createElement(ProactiveCard, {
          variant: 'inline',
          action: { type: 'discussion', id: 'quiz-review-1', topic: 'Q2 and Q4' },
          mode: 'playback',
          offer: 'quiz-review',
          autoSkip: false,
          onSkip,
          onListen,
        }),
      ),
    );
    expect(card()?.getAttribute('aria-label')).toBe('proactiveCard.reviewOfferLabel');
    expect(card()?.textContent).toContain('proactiveCard.review');
    expect(card()?.textContent).toContain('Q2 and Q4');
    expect(container.querySelector('[data-testid="proactive-card-progress"]')).toBeNull();
    act(() => vi.advanceTimersByTime(DISCUSSION_AUTO_SKIP_MS * 3));
    expect(onSkip).not.toHaveBeenCalled();
    act(() => buttonByText('proactiveCard.joinReview').click());
    expect(onListen).toHaveBeenCalledOnce();
    act(() => buttonByText('proactiveCard.skip').click());
    expect(onSkip).toHaveBeenCalledOnce();
  });

  it('auto-skips exactly once when the countdown runs out', () => {
    render('playback');
    act(() => vi.advanceTimersByTime(DISCUSSION_AUTO_SKIP_MS + 500));
    expect(onSkip).toHaveBeenCalledOnce();
    act(() => vi.advanceTimersByTime(DISCUSSION_AUTO_SKIP_MS));
    expect(onSkip).toHaveBeenCalledOnce();
  });

  it('freezes while playback is paused, then continues from where it stood', () => {
    render('playback');
    act(() => vi.advanceTimersByTime(DISCUSSION_AUTO_SKIP_MS / 2));
    const bar = container.querySelector('[data-testid="proactive-card-progress"]') as HTMLElement;
    const frozenWidth = bar.style.width;

    render('paused');
    act(() => vi.advanceTimersByTime(DISCUSSION_AUTO_SKIP_MS * 2));
    expect(onSkip).not.toHaveBeenCalled();
    expect(bar.style.width).toBe(frozenWidth);
    expect(bar.className).toContain('bg-line-strong');

    render('playback');
    act(() => vi.advanceTimersByTime(DISCUSSION_AUTO_SKIP_MS));
    expect(onSkip).toHaveBeenCalledOnce();
  });
});

describe('ProactiveCard countdown: it only runs while the card is seen and nothing holds it', () => {
  let container: HTMLDivElement;
  let root: Root;
  let onSkip: ReturnType<typeof vi.fn<() => void>>;
  let onAutoSkip: ReturnType<typeof vi.fn<() => void>>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    onSkip = vi.fn<() => void>();
    onAutoSkip = vi.fn<() => void>();
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function render(props: { countdownHeld?: boolean; inView?: boolean } = {}) {
    const card = createElement(ProactiveCard, {
      variant: 'inline',
      action,
      mode: 'playback',
      agentName: '显眼包',
      countdownHeld: props.countdownHeld,
      onSkip,
      onAutoSkip,
      onListen: vi.fn(),
    });
    act(() =>
      root.render(
        createElement(ProactiveCardInViewContext.Provider, { value: props.inView ?? true }, card),
      ),
    );
  }
  const bar = () =>
    container.querySelector('[data-testid="proactive-card-progress"]') as HTMLElement;

  it('runs out through onAutoSkip (an auto skip), never the click handler', () => {
    render();
    act(() => vi.advanceTimersByTime(DISCUSSION_AUTO_SKIP_MS + 500));
    expect(onAutoSkip).toHaveBeenCalledOnce();
    expect(onSkip).not.toHaveBeenCalled();
  });

  it('waits while its opener reads it out, then counts the full time', () => {
    render({ countdownHeld: true });
    act(() => vi.advanceTimersByTime(DISCUSSION_AUTO_SKIP_MS * 2));
    expect(onAutoSkip).not.toHaveBeenCalled();
    expect(bar().style.width).toBe('100%');
    expect(bar().className).toContain('bg-line-strong');

    render({ countdownHeld: false });
    act(() => vi.advanceTimersByTime(DISCUSSION_AUTO_SKIP_MS - 500));
    expect(onAutoSkip).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1000));
    expect(onAutoSkip).toHaveBeenCalledOnce();
  });

  it('freezes while its panel is out of view, and while the page is hidden', () => {
    render({ inView: false });
    act(() => vi.advanceTimersByTime(DISCUSSION_AUTO_SKIP_MS * 2));
    expect(onAutoSkip).not.toHaveBeenCalled();

    render({ inView: true });
    act(() => vi.advanceTimersByTime(DISCUSSION_AUTO_SKIP_MS / 2));
    const width = bar().style.width;

    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    act(() => vi.advanceTimersByTime(DISCUSSION_AUTO_SKIP_MS * 2));
    expect(onAutoSkip).not.toHaveBeenCalled();
    expect(bar().style.width).toBe(width);

    visibility.mockReturnValue('visible');
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    act(() => vi.advanceTimersByTime(DISCUSSION_AUTO_SKIP_MS));
    expect(onAutoSkip).toHaveBeenCalledOnce();
    visibility.mockRestore();
  });

  it('stops for good when keyboard focus lands on the card', () => {
    render();
    const skip = [...container.querySelectorAll('button')][1];
    vi.spyOn(skip, 'matches').mockImplementation((selector) => selector === ':focus-visible');
    act(() => skip.focus());
    act(() => skip.blur());
    act(() => vi.advanceTimersByTime(DISCUSSION_AUTO_SKIP_MS * 3));
    expect(onAutoSkip).not.toHaveBeenCalled();
  });

  it('stops for good once the learner navigates by keyboard (Tab), so they choose themselves', () => {
    render();
    act(() => vi.advanceTimersByTime(DISCUSSION_AUTO_SKIP_MS / 2));
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }));
    });
    act(() => vi.advanceTimersByTime(DISCUSSION_AUTO_SKIP_MS * 3));
    expect(onAutoSkip).not.toHaveBeenCalled();
    // A screen reader hears that the countdown stopped, not the time limit
    expect(container.querySelector('.sr-only')?.textContent).toBe('proactiveCard.countdownPaused');
  });

  it('holds while focus from a click is inside the card, and goes on when it leaves', () => {
    render();
    const join = [...container.querySelectorAll('button')][0];
    // A pointer's focus: not :focus-visible (jsdom matches it on any focus)
    vi.spyOn(join, 'matches').mockReturnValue(false);
    act(() => join.focus());
    act(() => vi.advanceTimersByTime(DISCUSSION_AUTO_SKIP_MS * 2));
    expect(onAutoSkip).not.toHaveBeenCalled();
    act(() => join.blur());
    act(() => vi.advanceTimersByTime(DISCUSSION_AUTO_SKIP_MS + 500));
    expect(onAutoSkip).toHaveBeenCalledOnce();
  });
});

describe('ProactiveCard portal variant (the 发起讨论 card over the fullscreen dock)', () => {
  let container: HTMLDivElement;
  let fullscreen: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    fullscreen = document.createElement('div');
    document.body.append(container, fullscreen);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    fullscreen.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('renders the same card inside the given container, with no pause toggle', () => {
    const anchor = document.createElement('div');
    container.appendChild(anchor);
    const onSkip = vi.fn<() => void>();
    act(() =>
      root.render(
        createElement(ProactiveCard, {
          action,
          mode: 'playback',
          agentName: '显眼包',
          anchorRef: { current: anchor },
          portalContainer: fullscreen,
          onSkip,
          onListen: vi.fn(),
        }),
      ),
    );
    // Positioned on the next frame, against the anchor
    act(() => vi.advanceTimersByTime(32));

    const card = fullscreen.querySelector('[data-testid="proactive-card-portal"]');
    expect(card).not.toBeNull();
    expect(container.querySelector('[data-testid="proactive-card-portal"]')).toBeNull();
    expect(card?.getAttribute('role')).toBe('group');
    expect(card?.textContent).toContain('Why are leaves green?');
    expect(card?.querySelectorAll('button')).toHaveLength(2);
    expect(card?.textContent).not.toContain('proactiveCard.pause');

    act(() => vi.advanceTimersByTime(DISCUSSION_AUTO_SKIP_MS + 500));
    expect(onSkip).toHaveBeenCalledOnce();
  });
});
