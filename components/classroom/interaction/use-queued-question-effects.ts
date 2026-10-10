'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { useI18n } from '@/lib/hooks/use-i18n';
import type { HandState } from '@/lib/playback';

/**
 * A question sent mid-line that waits for the teacher to finish ("raised
 * hand"). The owner moves it from queued to delivered or cancelled; a
 * cancelled question's text goes back into the input, and so does a restored
 * one (left unsent by an earlier visit).
 */
export interface QueuedQuestionState {
  id: number;
  text: string;
  status: 'queued' | 'delivered' | 'cancelled' | 'restored';
  /** What the teacher finishes before answering: the line (default) or another step. */
  waitsFor?: 'sentence' | 'step';
}

/**
 * Polls how far the line in flight has been spoken (0..1, engine
 * getSpeechProgress) once per frame while `active`; null otherwise.
 */
export function useSpeechProgress(
  getProgress: (() => number | null) | undefined,
  active: boolean,
): number | null {
  const [progress, setProgress] = useState<number | null>(null);

  const polling = active && !!getProgress;

  useEffect(() => {
    if (!polling) return;
    let frame = 0;
    const tick = () => {
      setProgress(getProgress());
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      // A later wait must not start from this one's last reading
      setProgress(null);
    };
  }, [getProgress, polling]);

  return polling ? progress : null;
}

export interface UseQueuedQuestionEffectsOptions {
  queuedQuestion?: QueuedQuestionState | null;
  /** The send cooldown (the composer hides its controls while it runs) */
  isSendCooldown: boolean;
  isSendCoolingDown: () => boolean;
  /** A delivered question: show it as the user's line */
  onDelivered: (text: string) => void;
  /** A cancelled or restored question: give its text back to the composer */
  onReturned: (text: string) => void;
  /**
   * Where a keyboard user lands after their question is delivered, so they can
   * follow up (today the text-input toggle; a host can point it at its textarea)
   */
  focusTargetRef: RefObject<HTMLElement | null>;
  /** A text-less raised hand (engine getHandState) */
  handState?: HandState | null;
  /** Engine getSpeechProgress: polled for the "hand raised" progress while something waits */
  getSpeechProgress?: () => number | null;
}

/**
 * The raised-hand lifecycle on the composer side: each owner-driven
 * transition (delivered / cancelled / restored) runs once, keyed by id and
 * status; the always-mounted live region's text; and the focus handoff that
 * keeps a keyboard user's place when the queued pill unmounts under them.
 */
export function useQueuedQuestionEffects({
  queuedQuestion,
  isSendCooldown,
  isSendCoolingDown,
  onDelivered,
  onReturned,
  focusTargetRef,
  handState,
  getSpeechProgress,
}: UseQueuedQuestionEffectsOptions) {
  const { t } = useI18n();

  // The raised-hand pill unmounts once its question goes out; focus on its
  // Cancel would then fall to <body>. React detaches refs before removing
  // nodes, so the detach still sees focus inside the pill.
  const statusRef = useRef<HTMLSpanElement>(null);
  const pillNodeRef = useRef<HTMLDivElement | null>(null);
  const pillHadFocusRef = useRef(false);
  const pillRef = useCallback((node: HTMLDivElement | null) => {
    if (!node) {
      pillHadFocusRef.current = !!pillNodeRef.current?.contains(document.activeElement);
    }
    pillNodeRef.current = node;
  }, []);
  // Set while the send cooldown hides the focus target at delivery
  const focusTargetWhenShownRef = useRef(false);

  // Raised-hand outcome (owner-driven): a delivered question shows its bubble
  // now; a cancelled one goes back into the input so nothing typed is lost.
  // Keyed by id + status so each transition runs once (not replayed on mount).
  const handledRef = useRef(
    queuedQuestion ? `${queuedQuestion.id}:${queuedQuestion.status}` : null,
  );
  useEffect(() => {
    if (!queuedQuestion) return;
    const key = `${queuedQuestion.id}:${queuedQuestion.status}`;
    if (handledRef.current === key) return;
    handledRef.current = key;
    const pillHadFocus = pillHadFocusRef.current;
    pillHadFocusRef.current = false;
    focusTargetWhenShownRef.current = false;
    if (queuedQuestion.status === 'delivered') {
      onDelivered(queuedQuestion.text);
      // Keep a keyboard user's place on Cancel: hand them to the focus target
      // to follow up — never opening the input, which would pause the live
      // answer. The send cooldown hides it until the answer starts; the
      // status, announcing the delivery, holds focus until then.
      if (pillHadFocus) {
        if (focusTargetRef.current) {
          focusTargetRef.current.focus();
        } else {
          focusTargetWhenShownRef.current = isSendCoolingDown();
          statusRef.current?.focus();
        }
      }
    } else if (queuedQuestion.status === 'cancelled' || queuedQuestion.status === 'restored') {
      // Back into the (reopened) input, which takes focus
      onReturned(queuedQuestion.text);
    }
    // Re-runs with fresh callbacks are no-ops: the key above already matches
  }, [focusTargetRef, isSendCoolingDown, onDelivered, onReturned, queuedQuestion]);

  // The cooldown ended: finish handing focus to the target, unless the user
  // has moved on meanwhile
  useEffect(() => {
    if (isSendCooldown || !focusTargetWhenShownRef.current) return;
    focusTargetWhenShownRef.current = false;
    const active = document.activeElement;
    if (active && active !== document.body && active !== statusRef.current) return;
    focusTargetRef.current?.focus();
  }, [focusTargetRef, isSendCooldown]);

  const isQueued = queuedQuestion?.status === 'queued';
  // What the teacher finishes first: the line in flight or another step
  const label = t(
    queuedQuestion?.waitsFor === 'step'
      ? 'roundtable.handRaisedQueuedStep'
      : 'roundtable.handRaisedQueued',
  );
  // Always mounted, so it announces: a live region that appears together with
  // its text is often not read out
  const liveText = isQueued
    ? label
    : queuedQuestion?.status === 'delivered'
      ? t('roundtable.handRaisedDelivered')
      : '';

  const speechProgress = useSpeechProgress(getSpeechProgress, isQueued || handState === 'raised');

  return {
    isQueued,
    label,
    liveText,
    /** The always-mounted sr-only status; also where focus parks during the cooldown */
    statusRef,
    /** Attach to the queued pill so its unmount can tell whether it held focus */
    pillRef,
    isHandRaised: handState === 'raised',
    isHandCalled: handState === 'called',
    /** 0..1 of the line the raised hand waits for (null when not polled) */
    speechProgress,
  };
}
