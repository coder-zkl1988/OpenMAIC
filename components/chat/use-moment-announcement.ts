'use client';

import { useEffect, useState } from 'react';
import { DISCUSSION_TRIGGER_DELAY_MS } from '@/lib/choreography';
import type { TriggerEvent } from '@/lib/playback/types';

/**
 * The breath (ms) between the teacher's last line and a class moment's card
 * when the card is read out: the reading takes the place of the usual pause
 * (DISCUSSION_TRIGGER_DELAY_MS) instead of adding to it.
 */
export const MOMENT_ANNOUNCE_LEAD_MS = 600;

/** The longest a reading may hold the card's countdown (a voice that never ends) */
export const MOMENT_ANNOUNCE_MAX_HOLD_MS = 15_000;

/**
 * How long a shown card still holds its countdown, besides its reading: the
 * part of the usual pause the engine did not spend before showing it. The
 * time before the countdown is then max(usual pause, lead + reading) — merged,
 * never stacked — and a reading that fails at once still leaves the learner
 * the usual pause.
 */
export function momentCountdownHoldMs(usedTriggerDelayMs: number): number {
  return Math.max(0, DISCUSSION_TRIGGER_DELAY_MS - usedTriggerDelayMs);
}

/**
 * Read a class moment's card out in its opener's voice (I07): when a card
 * shows, its topic is spoken by the agent who opens the moment, and the card's
 * countdown holds until the reading is over (and the rest of the usual pause
 * has passed). `announce` reads (it settles at once when nothing would be
 * heard, e.g. muted) and returns its cancel; the reading stops when the card
 * goes (join, skip, a new card, a scene switch).
 */
export function useMomentAnnouncement({
  trigger,
  announce,
  holdMs,
}: {
  trigger: TriggerEvent | null;
  announce: (text: string, agentId: string | null, onSettled?: () => void) => () => void;
  /** Extra hold after the card shows (momentCountdownHoldMs of the delay the engine used) */
  holdMs: (trigger: TriggerEvent) => number;
}): {
  /** The card's countdown must wait */
  holding: boolean;
  /** The opener while their reading plays (their tile lights up) */
  speakingAgentId: string | null;
} {
  // Keyed by the card, so a new card starts from a clean state
  const [state, setState] = useState<{
    id: string | null;
    reading: boolean;
    held: boolean;
  }>({ id: null, reading: false, held: false });

  const triggerId = trigger?.id ?? null;
  useEffect(() => {
    if (!trigger) return;
    const id = trigger.id;
    let reading = true;
    let waiting = true;
    let done = false;
    const update = () => {
      if (done) return;
      const held = reading || waiting;
      if (!held) done = true;
      setState({ id, reading, held });
    };
    const hold = Math.max(0, holdMs(trigger));
    const waitTimer = setTimeout(() => {
      waiting = false;
      update();
    }, hold);
    const capTimer = setTimeout(() => {
      reading = false;
      waiting = false;
      update();
    }, MOMENT_ANNOUNCE_MAX_HOLD_MS);
    setState({ id, reading: true, held: true });
    const cancel = announce(trigger.question, trigger.agentId ?? null, () => {
      reading = false;
      update();
    });
    return () => {
      done = true;
      clearTimeout(waitTimer);
      clearTimeout(capTimer);
      cancel();
      // A card offered again (after a raised hand) is read again
      setState({ id: null, reading: false, held: false });
    };
    // One reading per card: the trigger object and the callbacks may change identity
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [triggerId]);

  if (!trigger) return { holding: false, speakingAgentId: null };
  // A card whose reading has not started yet holds too
  if (state.id !== trigger.id) return { holding: true, speakingAgentId: null };
  return {
    holding: state.held,
    speakingAgentId: state.reading ? (trigger.agentId ?? null) : null,
  };
}
