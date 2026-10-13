// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DISCUSSION_TRIGGER_DELAY_MS } from '@/lib/choreography';
import type { TriggerEvent } from '@/lib/playback/types';
import {
  MOMENT_ANNOUNCE_LEAD_MS,
  MOMENT_ANNOUNCE_MAX_HOLD_MS,
  momentCountdownHoldMs,
  useMomentAnnouncement,
} from '@/components/chat/use-moment-announcement';

const card: TriggerEvent = { id: 'm1', question: 'Why do they cancel?', agentId: 'mia' };

describe("useMomentAnnouncement: a card read out in its opener's voice", () => {
  let root: Root;
  let result: ReturnType<typeof useMomentAnnouncement>;
  let settle: (() => void) | undefined;
  const cancel = vi.fn();
  const announce = vi.fn((_text: string, _agentId: string | null, onSettled?: () => void) => {
    settle = onSettled;
    return cancel;
  });

  function Probe({
    trigger,
    holdMs,
    onResult,
  }: {
    readonly trigger: TriggerEvent | null;
    readonly holdMs: number;
    readonly onResult: (value: ReturnType<typeof useMomentAnnouncement>) => void;
  }) {
    onResult(useMomentAnnouncement({ trigger, announce, holdMs: () => holdMs }));
    return null;
  }
  function render(trigger: TriggerEvent | null, holdMs = 0) {
    act(() =>
      root.render(
        createElement(Probe, {
          trigger,
          holdMs,
          onResult: (value) => {
            result = value;
          },
        }),
      ),
    );
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    announce.mockClear();
    cancel.mockClear();
    settle = undefined;
    root = createRoot(document.createElement('div'));
  });
  afterEach(() => {
    act(() => root.unmount());
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("reads the topic in the opener's voice; the tile speaks and the countdown holds until it ends", () => {
    render(null);
    expect(result).toEqual({ holding: false, speakingAgentId: null });

    render(card);
    expect(announce).toHaveBeenCalledExactlyOnceWith(
      'Why do they cancel?',
      'mia',
      expect.any(Function),
    );
    expect(result).toEqual({ holding: true, speakingAgentId: 'mia' });

    act(() => vi.advanceTimersByTime(5000));
    expect(result.holding).toBe(true);
    act(() => settle?.());
    expect(result).toEqual({ holding: false, speakingAgentId: null });
  });

  it('holds for the rest of the usual pause after a short reading (merged, not stacked)', () => {
    const hold = momentCountdownHoldMs(MOMENT_ANNOUNCE_LEAD_MS);
    expect(hold).toBe(DISCUSSION_TRIGGER_DELAY_MS - MOMENT_ANNOUNCE_LEAD_MS);
    // An unshortened pause leaves nothing to hold
    expect(momentCountdownHoldMs(DISCUSSION_TRIGGER_DELAY_MS)).toBe(0);

    render(card, hold);
    act(() => settle?.());
    // The reading is over (the tile stops) but the pause is not
    expect(result).toEqual({ holding: true, speakingAgentId: null });
    act(() => vi.advanceTimersByTime(hold));
    expect(result.holding).toBe(false);
  });

  it('never holds longer than the cap, even if the voice never ends', () => {
    render(card);
    act(() => vi.advanceTimersByTime(MOMENT_ANNOUNCE_MAX_HOLD_MS));
    expect(result.holding).toBe(false);
  });

  it('stops the reading when the card goes, and reads a card offered again anew', () => {
    render(card);
    render(null);
    expect(cancel).toHaveBeenCalledOnce();
    expect(result.holding).toBe(false);

    // Offered again after a raised hand: the same card, read again
    render(card);
    expect(announce).toHaveBeenCalledTimes(2);
    expect(result.holding).toBe(true);
  });

  it('a reading that settles at once (muted) only leaves the hold of the pause', () => {
    announce.mockImplementationOnce((_text, _agentId, onSettled) => {
      onSettled?.();
      return cancel;
    });
    render(card, 0);
    act(() => vi.advanceTimersByTime(0));
    expect(result).toEqual({ holding: false, speakingAgentId: null });
  });
});
