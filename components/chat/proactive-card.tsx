'use client';

import { useState, useEffect, useCallback, type FocusEvent } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'motion/react';
import { Play } from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import type { DiscussionAction } from '@/lib/types/action';
import { AvatarDisplay } from '@/components/ui/avatar-display';
import { DISCUSSION_AUTO_SKIP_MS } from '@/lib/choreography';
import { cn } from '@/lib/utils';
import { useProactiveCountdown } from './use-proactive-countdown';

interface ProactiveCardCommonProps {
  action: DiscussionAction;
  mode: 'playback' | 'paused' | 'autonomous';
  agentName?: string;
  agentAvatar?: string;
  /**
   * The teacher opened the moment (a question to the class, or calling on a
   * classmate): the card words it as the teacher's question, not a classmate
   * starting a discussion
   */
  openedByTeacher?: boolean;
  /**
   * A moment of its own kind:
   * - 'ask-learner': the teacher's question to the whole class (I10). The
   *   learner answers first (我来答, `onAnswer`) or hears the class first
   *   (先听听大家, `onListen`); a quiet 跳过 (`onSkip`) lets the lecture go on.
   * - 'quiz-review': going over the quiz's wrong answers (I11), named by the
   *   card itself (no opener): 一起复盘 (`onListen`) or 跳过.
   */
  offer?: 'ask-learner' | 'quiz-review';
  /**
   * The card skips itself when its countdown runs out (the default). Off: no
   * countdown at all — the card waits for the learner (a question put to a
   * learner who is watching, a quiz review).
   */
  autoSkip?: boolean;
  /**
   * The countdown waits: the opener is still reading the card out. It starts
   * (or goes on) once this is false.
   */
  countdownHeld?: boolean;
  onSkip: () => void;
  /** The countdown ran out (defaults to onSkip) */
  onAutoSkip?: () => void;
  /** Join the moment (an 'ask-learner' card: hear the class first) */
  onListen: () => void;
  /** An 'ask-learner' card: the learner answers first */
  onAnswer?: () => void;
}

/**
 * The learner is on the card with the keyboard (or a screen reader moving
 * focus): its countdown stops, for good once the keyboard was used — they
 * choose join or skip themselves. Focus from a click only holds it while it
 * stays inside.
 */
function useCardEngagement() {
  const [focused, setFocused] = useState(false);
  const [byKeyboard, setByKeyboard] = useState(false);

  // Tabbing through the page while a card waits: the learner is navigating by
  // keyboard and may be on their way to it
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Tab') setByKeyboard(true);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);

  const handlers = {
    onFocus: (event: FocusEvent<HTMLElement>) => {
      setFocused(true);
      const target = event.target as HTMLElement;
      if (typeof target.matches === 'function' && target.matches(':focus-visible')) {
        setByKeyboard(true);
      }
    },
    onBlur: (event: FocusEvent<HTMLElement>) => {
      const next = event.relatedTarget as Node | null;
      if (!next || !event.currentTarget.contains(next)) setFocused(false);
    },
    onKeyDown: () => setByKeyboard(true),
  };
  return { engaged: focused || byKeyboard, handlers };
}

/** The card floating over an anchor (the fullscreen dock), outside the stream */
interface PortalProactiveCardProps extends ProactiveCardCommonProps {
  variant?: 'portal';
  /** Ref to the anchor element the card points to (the dock, an avatar) */
  anchorRef: React.RefObject<HTMLElement | null>;
  /** Where the card prefers to align relative to the anchor */
  align?: 'left' | 'right';
  /** Portal target — defaults to document.body. Pass the fullscreen container
   *  when in presentation mode so the card stays visible inside the top-layer. */
  portalContainer?: HTMLElement | null;
}

/** The card as a row of the interaction stream (no anchor) */
interface InlineProactiveCardProps extends ProactiveCardCommonProps {
  variant: 'inline';
}

type ProactiveCardProps = PortalProactiveCardProps | InlineProactiveCardProps;

const CARD_WIDTH = 288; // w-72
const VIEWPORT_PAD = 12;

/* The amber 发起讨论 card (Classroom.dc.html), shared by both variants */
const cardSurface =
  'relative flex flex-col gap-2 overflow-hidden rounded-[14px] border border-amber-200 bg-amber-50 px-3 pt-3.5 pb-3 dark:border-amber-500/30 dark:bg-amber-500/10';

/**
 * 主动讨论卡片组件
 *
 * `variant="inline"` renders the 发起讨论 card inside the interaction stream
 * (Classroom.dc.html); the default portal variant floats the same card over
 * an anchor in fullscreen. Both auto-skip once the countdown runs out
 * (unless `autoSkip` is off: then the card waits for the learner). The
 * countdown only runs while the card can be seen (its panel in view, the page
 * shown) and nothing holds it: it freezes while playback is paused, while the
 * opener still reads the card out (`countdownHeld`), and for a learner on the
 * card with the keyboard. The control bar's play / pause is the only pause
 * control, so neither variant has a toggle of its own.
 */
export const ProactiveCard = (props: ProactiveCardProps) =>
  props.variant === 'inline' ? (
    <InlineProactiveCard {...props} />
  ) : (
    <PortalProactiveCard {...props} />
  );

const primaryButton =
  'flex h-9 flex-1 items-center justify-center gap-1.5 rounded-[10px] bg-primary text-[13px] font-semibold text-primary-foreground transition-colors hover:bg-primary/90 active:scale-[0.98] cursor-pointer';
const secondaryButton =
  'h-9 shrink-0 rounded-[10px] border border-line bg-background px-4 text-[13px] font-medium text-fg-secondary transition-colors hover:bg-subtle hover:text-fg cursor-pointer';
const quietButton =
  'h-9 shrink-0 rounded-[10px] px-2 text-[13px] font-medium text-fg-tertiary transition-colors hover:bg-subtle hover:text-fg cursor-pointer';

/** The chip naming what the card offers */
function offerChipKey({
  offer,
  openedByTeacher,
}: Pick<ProactiveCardCommonProps, 'offer' | 'openedByTeacher'>): string {
  if (offer === 'quiz-review') return 'proactiveCard.review';
  return offer === 'ask-learner' || openedByTeacher
    ? 'proactiveCard.question'
    : 'proactiveCard.discussion';
}

/**
 * The card's contents: a 3px countdown bar, avatar, name, 讨论 chip, the
 * seconds left, the topic and 加入讨论 / 跳过 (no bar or seconds when the
 * card does not skip itself).
 */
function ProactiveCardContent({
  action,
  mode,
  agentName,
  agentAvatar,
  openedByTeacher,
  offer,
  autoSkip = true,
  countdownHeld,
  engaged,
  onSkip,
  onAutoSkip,
  onListen,
  onAnswer,
}: ProactiveCardCommonProps & { engaged: boolean }) {
  const { t } = useI18n();
  const { progress, remainingSeconds, isPaused } = useProactiveCountdown({
    mode,
    onSkip: onAutoSkip ?? onSkip,
    // Without auto-skip the countdown never runs
    held: !autoSkip || !!countdownHeld || engaged,
  });

  return (
    <>
      {autoSkip && (
        <span
          aria-hidden="true"
          data-testid="proactive-card-progress"
          className={`absolute top-0 left-0 h-[3px] transition-[width] duration-[50ms] ease-linear ${
            isPaused ? 'bg-line-strong' : 'bg-amber-500'
          }`}
          style={{ width: `${progress}%` }}
        />
      )}
      <div className="flex items-center gap-2">
        {agentAvatar && (
          <span className="size-6 shrink-0 overflow-hidden rounded-full ring-1 ring-amber-200 dark:ring-amber-500/40">
            <AvatarDisplay src={agentAvatar} alt="" />
          </span>
        )}
        {agentName && (
          <span className="min-w-0 truncate text-xs font-semibold text-fg-secondary">
            {agentName}
          </span>
        )}
        <span className="shrink-0 rounded-full bg-warning-soft px-1.5 text-[10px] leading-4 font-semibold text-warning">
          {t(offerChipKey({ offer, openedByTeacher }))}
        </span>
        {/* A ticking number would be read out every second, so the time
            limit is stated once (below) instead */}
        {autoSkip && (
          <span
            aria-hidden="true"
            className={`ml-auto shrink-0 text-xs font-semibold tabular-nums ${
              isPaused ? 'text-fg-tertiary' : 'text-warning'
            }`}
          >
            {remainingSeconds}s
          </span>
        )}
      </div>
      {autoSkip && (
        <span className="sr-only">
          {/* A keyboard or focus user on the card holds its countdown: say so */}
          {engaged
            ? t('proactiveCard.countdownPaused')
            : t('proactiveCard.autoSkipHint', {
                seconds: Math.round(DISCUSSION_AUTO_SKIP_MS / 1000),
              })}
        </span>
      )}
      <p className="text-sm leading-normal font-semibold text-fg">{action.topic}</p>
      {offer === 'ask-learner' ? (
        // Both start the moment: the learner answers first, or hears the class first
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            data-testid="proactive-card-answer"
            onClick={onAnswer ?? onListen}
            className={primaryButton}
          >
            {t('proactiveCard.answerFirst')}
          </button>
          <button
            type="button"
            data-testid="proactive-card-listen"
            onClick={onListen}
            className={secondaryButton}
          >
            {t('proactiveCard.listenFirst')}
          </button>
          {/* Declining is always possible: the card never blocks the lecture */}
          <button
            type="button"
            data-testid="proactive-card-skip"
            onClick={onSkip}
            className={quietButton}
          >
            {t('proactiveCard.skip')}
          </button>
        </div>
      ) : (
        <div className="flex gap-2">
          <button type="button" onClick={onListen} className={primaryButton}>
            <Play aria-hidden="true" className="size-3 fill-current" />
            {t(
              offer === 'quiz-review'
                ? 'proactiveCard.joinReview'
                : openedByTeacher
                  ? 'proactiveCard.joinTeacher'
                  : 'proactiveCard.join',
            )}
          </button>
          <button type="button" onClick={onSkip} className={secondaryButton}>
            {t('proactiveCard.skip')}
          </button>
        </div>
      )}
    </>
  );
}

/** The card's accessible name: who offers what */
function offerLabel(
  t: (key: string, options?: Record<string, unknown>) => string,
  {
    agentName,
    openedByTeacher,
    offer,
  }: Pick<ProactiveCardCommonProps, 'agentName' | 'openedByTeacher' | 'offer'>,
): string {
  if (offer === 'quiz-review') return t('proactiveCard.reviewOfferLabel');
  if (openedByTeacher || offer === 'ask-learner') {
    return agentName
      ? t('proactiveCard.teacherOfferLabel', { name: agentName })
      : t('proactiveCard.question');
  }
  return agentName
    ? t('proactiveCard.offerLabel', { name: agentName })
    : t('proactiveCard.discussion');
}

/** The stream row */
function InlineProactiveCard({ variant: _variant, ...props }: InlineProactiveCardProps) {
  const { t } = useI18n();
  const { engaged, handlers } = useCardEngagement();

  return (
    <motion.div
      role="group"
      aria-label={offerLabel(t, props)}
      data-testid="proactive-card-inline"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, transition: { duration: 0.15 } }}
      className={cn(cardSurface, 'shrink-0')}
      {...handlers}
    >
      <ProactiveCardContent {...props} engaged={engaged} />
    </motion.div>
  );
}

/**
 * 通过 React Portal 渲染到 document.body（全屏时为全屏容器），使用 fixed 定位，
 * 不受父级 overflow/z-index stacking context 影响。
 */
function PortalProactiveCard({
  variant: _variant,
  anchorRef,
  align = 'right',
  portalContainer,
  ...props
}: PortalProactiveCardProps) {
  const { t } = useI18n();
  const { engaged, handlers } = useCardEngagement();

  // Computed position state
  const [pos, setPos] = useState<{
    left: number;
    bottom: number;
    tailOffset: number;
  } | null>(null);

  const updatePosition = useCallback(() => {
    const el = anchorRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const anchorCenterX = rect.left + rect.width / 2;
    const anchorTop = rect.top;

    // Center card on anchor, clamped to viewport
    let cardLeft = anchorCenterX - CARD_WIDTH / 2;
    cardLeft = Math.max(
      VIEWPORT_PAD,
      Math.min(window.innerWidth - CARD_WIDTH - VIEWPORT_PAD, cardLeft),
    );
    const tailOffset = Math.max(16, Math.min(CARD_WIDTH - 16, anchorCenterX - cardLeft));
    const bottom = window.innerHeight - anchorTop + 12; // 12px gap above anchor

    setPos({ left: cardLeft, bottom, tailOffset });
  }, [anchorRef]);

  // Continuously track anchor position via rAF to handle CSS transitions, sidebar collapse, etc.
  useEffect(() => {
    let rafId: number;
    const tick = () => {
      updatePosition();
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [updatePosition]);

  if (!pos) return null;

  const card = (
    <motion.div
      initial={{ opacity: 0, y: 10, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, scale: 0.95, transition: { duration: 0.2 } }}
      className="pointer-events-auto fixed z-[60] w-72"
      style={{
        left: pos.left,
        bottom: pos.bottom,
        transformOrigin: align === 'left' ? 'bottom left' : 'bottom right',
      }}
    >
      {/* Opaque underlay: the card's dark tint must not show the slide through */}
      <div className="rounded-[14px] bg-background shadow-[0_8px_32px_rgba(0,0,0,0.12)] dark:shadow-[0_8px_32px_rgba(0,0,0,0.4)]">
        <div
          role="group"
          aria-label={offerLabel(t, props)}
          data-testid="proactive-card-portal"
          className={cardSurface}
          {...handlers}
        >
          <ProactiveCardContent {...props} engaged={engaged} />
        </div>
      </div>
      {/* Tail pointing at the anchor, in the card's (composited) fill */}
      <div
        aria-hidden="true"
        className="absolute -bottom-[5px] size-2.5 border-r border-b border-amber-200 bg-amber-50 dark:border-amber-500/30 dark:bg-[color-mix(in_oklab,var(--color-amber-500)_10%,var(--background))]"
        style={{ left: `${pos.tailOffset}px`, transform: 'translateX(-50%) rotate(45deg)' }}
      />
    </motion.div>
  );

  return createPortal(card, portalContainer || document.body);
}
