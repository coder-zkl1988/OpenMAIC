'use client';

import { useEffect, useRef, useState } from 'react';
import { DISCUSSION_AUTO_SKIP_MS } from '@/lib/choreography';

const TICK_MS = 50;

/**
 * Auto-skip countdown of a proactive discussion offer. It runs only in
 * playback (paused or autonomous freezes it where it is) and calls onSkip
 * exactly once when it runs out.
 */
export function useProactiveCountdown({
  mode,
  onSkip,
}: {
  mode: 'playback' | 'paused' | 'autonomous';
  onSkip: () => void;
}) {
  // Remaining share of the countdown, 100 → 0
  const [progress, setProgress] = useState(100);
  const skippedRef = useRef(false);

  useEffect(() => {
    if (mode !== 'playback') return;

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
  }, [mode]);

  useEffect(() => {
    if (progress <= 0 && !skippedRef.current && mode === 'playback') {
      skippedRef.current = true;
      onSkip();
    }
  }, [progress, onSkip, mode]);

  return {
    progress,
    remainingSeconds: Math.max(0, Math.ceil((progress / 100) * (DISCUSSION_AUTO_SKIP_MS / 1000))),
    isPaused: mode === 'paused',
  };
}
