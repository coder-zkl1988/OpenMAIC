// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/hooks/use-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));

import { ProactiveCard } from '@/components/chat/proactive-card';
import { DISCUSSION_AUTO_SKIP_MS } from '@/lib/choreography';
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
