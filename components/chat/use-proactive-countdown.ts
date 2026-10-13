'use client';

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { DISCUSSION_AUTO_SKIP_MS } from '@/lib/choreography';

const TICK_MS = 50;

/**
 * Whether the surface holding a proactive card is in view: the interaction
 * panel provides false while another tab is in front or the panel is
 * collapsed (the card stays mounted there, hidden). Outside a provider the
 * card counts as in view.
 */
export const ProactiveCardInViewContext = createContext(true);

function subscribeVisibility(onChange: () => void): () => void {
  document.addEventListener('visibilitychange', onChange);
  return () => document.removeEventListener('visibilitychange', onChange);
}

/** The page is shown (not a background tab or a minimised window) */
export function useDocumentVisible(): boolean {
  return useSyncExternalStore(
    subscribeVisibility,
    () => document.visibilityState !== 'hidden',
    () => true,
  );
}

/**
 * Whether a card's countdown may run: in playback (paused or autonomous
 * freezes it), with nothing holding it (its opener still reading it out, the
 * learner on it with the keyboard), and actually seen — its panel in view
 * and the page shown. A card nobody can see must not run out by itself.
 */
export function isProactiveCountdownRunning({
  mode,
  held,
  inView,
  documentVisible,
}: {
  mode: 'playback' | 'paused' | 'autonomous';
  held: boolean;
  inView: boolean;
  documentVisible: boolean;
}): boolean {
  return mode === 'playback' && !held && inView && documentVisible;
}

/**
 * Auto-skip countdown of a proactive discussion offer. It runs only while
 * isProactiveCountdownRunning (frozen where it stands otherwise) and calls
 * onSkip exactly once when it runs out.
 */
export function useProactiveCountdown({
  mode,
  onSkip,
  held = false,
}: {
  mode: 'playback' | 'paused' | 'autonomous';
  onSkip: () => void;
  /** Something holds the countdown (the reading of the card, the learner's keyboard) */
  held?: boolean;
}) {
  const inView = useContext(ProactiveCardInViewContext);
  const documentVisible = useDocumentVisible();
  const running = isProactiveCountdownRunning({ mode, held, inView, documentVisible });

  // Remaining share of the countdown, 100 → 0
  const [progress, setProgress] = useState(100);
  const skippedRef = useRef(false);

  useEffect(() => {
    if (!running) return;

    const step = (TICK_MS / DISCUSSION_AUTO_SKIP_MS) * 100;

    const timer = setInterval(() => {
      setProgress((prev) => {
        const next = prev - step;
        if (next <= 0) {
          clearInterval(timer);
          return 0;
        }
        return next;
      });
    }, TICK_MS);

    return () => clearInterval(timer);
  }, [running]);

  useEffect(() => {
    if (progress <= 0 && !skippedRef.current && running) {
      skippedRef.current = true;
      onSkip();
    }
  }, [progress, onSkip, running]);

  return {
    progress,
    remainingSeconds: Math.max(0, Math.ceil((progress / 100) * (DISCUSSION_AUTO_SKIP_MS / 1000))),
    // Frozen where it stands (the autonomous card simply has no countdown)
    isPaused: mode !== 'autonomous' && !running,
  };
}
