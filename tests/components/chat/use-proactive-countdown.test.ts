// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DISCUSSION_AUTO_SKIP_MS } from '@/lib/choreography';
import {
  isProactiveCountdownRunning,
  useProactiveCountdown,
} from '@/components/chat/use-proactive-countdown';

type Mode = 'playback' | 'paused' | 'autonomous';

describe('useProactiveCountdown', () => {
  let container: HTMLDivElement;
  let root: Root;
  let countdown: ReturnType<typeof useProactiveCountdown>;
  const onSkip = vi.fn();

  function Probe({
    mode,
    onResult,
  }: {
    readonly mode: Mode;
    readonly onResult: (value: ReturnType<typeof useProactiveCountdown>) => void;
  }) {
    onResult(useProactiveCountdown({ mode, onSkip }));
    return null;
  }

  function render(mode: Mode) {
    act(() =>
      root.render(
        createElement(Probe, {
          mode,
          onResult: (value) => {
            countdown = value;
          },
        }),
      ),
    );
  }

  function advance(ms: number) {
    act(() => {
      vi.advanceTimersByTime(ms);
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    onSkip.mockReset();
    container = document.createElement('div');
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('counts down in playback and skips exactly once', () => {
    render('playback');
    expect(countdown).toMatchObject({
      progress: 100,
      remainingSeconds: DISCUSSION_AUTO_SKIP_MS / 1000,
      isPaused: false,
    });

    advance(DISCUSSION_AUTO_SKIP_MS / 2);
    expect(countdown.progress).toBeCloseTo(50, 0);
    expect(countdown.remainingSeconds).toBe(Math.ceil(DISCUSSION_AUTO_SKIP_MS / 2000));
    expect(onSkip).not.toHaveBeenCalled();

    advance(DISCUSSION_AUTO_SKIP_MS);
    expect(countdown.progress).toBe(0);
    expect(countdown.remainingSeconds).toBe(0);
    expect(onSkip).toHaveBeenCalledOnce();

    // Re-renders and more time never skip again
    render('playback');
    advance(DISCUSSION_AUTO_SKIP_MS);
    expect(onSkip).toHaveBeenCalledOnce();
  });

  it('freezes while paused and resumes where it stopped', () => {
    render('playback');
    advance(DISCUSSION_AUTO_SKIP_MS / 2);
    const frozenAt = countdown.progress;

    render('paused');
    expect(countdown.isPaused).toBe(true);
    advance(DISCUSSION_AUTO_SKIP_MS * 2);
    expect(countdown.progress).toBe(frozenAt);
    expect(onSkip).not.toHaveBeenCalled();

    render('playback');
    advance(DISCUSSION_AUTO_SKIP_MS / 2 + 100);
    expect(onSkip).toHaveBeenCalledOnce();
  });

  it('does not run outside playback', () => {
    render('autonomous');
    advance(DISCUSSION_AUTO_SKIP_MS * 2);
    expect(countdown.progress).toBe(100);
    expect(countdown.isPaused).toBe(false);
    expect(onSkip).not.toHaveBeenCalled();
  });
});

describe('isProactiveCountdownRunning', () => {
  const seen = { mode: 'playback', held: false, inView: true, documentVisible: true } as const;

  it('runs only in playback, unheld, with the card in view and the page shown', () => {
    expect(isProactiveCountdownRunning(seen)).toBe(true);
    expect(isProactiveCountdownRunning({ ...seen, mode: 'paused' })).toBe(false);
    expect(isProactiveCountdownRunning({ ...seen, mode: 'autonomous' })).toBe(false);
    // The opener still reads it out, or the learner is on it by keyboard
    expect(isProactiveCountdownRunning({ ...seen, held: true })).toBe(false);
    // Another tab in front, the panel collapsed
    expect(isProactiveCountdownRunning({ ...seen, inView: false })).toBe(false);
    // A background browser tab
    expect(isProactiveCountdownRunning({ ...seen, documentVisible: false })).toBe(false);
  });
});
