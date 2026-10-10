'use client';

import { useLayoutEffect, useRef } from 'react';
import { Loader2, Pause } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/hooks/use-i18n';
import { AvatarDisplay } from '@/components/ui/avatar-display';
import type { AudioIndicatorState } from '@/components/roundtable/audio-indicator';
import { useSoftCloseCountdown } from '@/components/chat/use-soft-close-countdown';
import {
  buildCaptionModel,
  describeCaptionSpeaker,
  type CaptionModelInput,
  type CaptionStatus,
} from '@/lib/playback/caption-model';

export interface CaptionStripProps extends Omit<CaptionModelInput, 'names' | 'userMessage'> {
  /** Discussion TTS state of `audioAgentId` (a spinner while its audio is generated) */
  readonly audioIndicatorState?: AudioIndicatorState;
  readonly audioAgentId?: string | null;
  /**
   * A Q&A or discussion that interrupted the lecture is soft-closing: the
   * lecture resumes by itself at this time ('5 秒后继续讲课')
   */
  readonly lectureResumeDeadline?: number;
  /** The board is open and the AI is writing on it: the chip reads 边讲边写 */
  readonly isDrawingOnBoard?: boolean;
  readonly className?: string;
}

/** The status chip each caption status shows; idle shows none */
export const CAPTION_STATUS_LABEL_KEYS: Readonly<Record<CaptionStatus, string | null>> = {
  lecturing: 'stage.caption.lecturing',
  paused: 'stage.caption.paused',
  thinking: 'roundtable.thinking',
  answering: 'stage.caption.answering',
  discussion: 'stage.caption.discussing',
  idle: null,
};

/** Statuses where someone is speaking (the chip shows the wave) */
const SPEAKING_STATUSES: readonly CaptionStatus[] = ['lecturing', 'answering', 'discussion'];
/** Writing on the board shows as 边讲边写 over these (not paused or thinking) */
const DRAWING_STATUSES: readonly CaptionStatus[] = [...SPEAKING_STATUSES, 'idle'];
export const CAPTION_DRAWING_LABEL_KEY = 'stage.caption.drawing';

// The caption-wave keyframes own the bars' transform; the static 0.6 scale is
// the reduced-motion fallback only (the `scale` property would compose with it)
function Wave() {
  return (
    <span aria-hidden="true" className="inline-flex h-3 items-center gap-0.5">
      {[0, 0.15, 0.3, 0.45].map((delay) => (
        <i
          key={delay}
          className="block h-3 w-[2.5px] origin-center rounded-[2px] motion-reduce:scale-y-[0.6] bg-current motion-safe:animate-[caption-wave_1s_ease-in-out_infinite]"
          style={{ animationDelay: `${delay}s` }}
        />
      ))}
    </span>
  );
}

function LoadingDots() {
  return (
    <span className="flex h-6 items-center gap-1" aria-hidden="true">
      {[0, 0.2, 0.4].map((delay) => (
        <span
          key={delay}
          className="size-1.5 rounded-full bg-accent-text motion-safe:animate-[think-dot-pulse_1.2s_ease-in-out_infinite]"
          style={{ animationDelay: `${delay}s` }}
        />
      ))}
    </span>
  );
}

/**
 * The teacher caption under the slide (Classroom.dc.html): who is speaking,
 * what the classroom is doing and the current line, clamped to two lines.
 * Display-only — the control bar's play button owns play / pause.
 *
 * A lecture line clamps from its start; a streaming Q&A / discussion answer
 * shows its latest two lines instead, so the words being spoken stay visible.
 */
export function CaptionStrip({
  audioIndicatorState,
  audioAgentId,
  lectureResumeDeadline,
  isDrawingOnBoard,
  className,
  ...input
}: CaptionStripProps) {
  const { t } = useI18n();
  const names = {
    teacher: t('roundtable.teacher'),
    student: t('settings.agentRoles.student'),
    user: t('roundtable.you'),
  };
  const caption = buildCaptionModel({ ...input, names });
  // Nobody owns the line (thinking, waiting for the learner): the teacher stays
  const speaker = caption.role
    ? caption
    : describeCaptionSpeaker('teacher', { participants: input.participants, names });

  const resumeSeconds = useSoftCloseCountdown(lectureResumeDeadline);
  const isDrawing =
    !!isDrawingOnBoard && resumeSeconds === undefined && DRAWING_STATUSES.includes(caption.status);
  // The soft close's countdown back to the lecture replaces the status
  const statusText =
    resumeSeconds !== undefined
      ? t('stage.caption.resumeIn', { seconds: resumeSeconds })
      : isDrawing
        ? t(CAPTION_DRAWING_LABEL_KEY)
        : CAPTION_STATUS_LABEL_KEYS[caption.status]
          ? t(CAPTION_STATUS_LABEL_KEYS[caption.status]!)
          : null;
  const isSpeaking =
    isDrawing || (resumeSeconds === undefined && SPEAKING_STATUSES.includes(caption.status));
  // The learner's question is with the director: say so instead of dots
  const isAnsweringYou =
    caption.status === 'thinking' && !caption.text && input.sessionType === 'qa';
  const showDots =
    !isAnsweringYou && (caption.isLoading || (caption.status === 'thinking' && !caption.text));
  // Waiting for the learner (a called hand, the director's cue): the line rests
  const isWaitingForLearner = caption.view.phase === 'cueUser';
  const isGeneratingAudio =
    audioIndicatorState === 'generating' &&
    !!input.speakingAgentId &&
    input.speakingAgentId === audioAgentId;
  // Streaming answers follow their tail; lecture lines clamp from the start
  const followTail = caption.isInLiveFlow;

  const tailRef = useRef<HTMLParagraphElement>(null);
  useLayoutEffect(() => {
    const el = tailRef.current;
    if (!followTail || !el) return;
    el.scrollTop = el.scrollHeight;
  }, [caption.text, followTail]);

  return (
    <div
      data-testid="caption-strip"
      data-status={caption.status}
      className={cn(
        // Two 24px lines + the name row + padding: a fixed height, so the
        // contain-fitted slide above never resizes while the text changes.
        // Tablet (TabletLandscape.dc.html) tightens the inset and the avatar,
        // the phone (ClassroomPhone.dc.html) a little more.
        'flex h-[92px] w-full shrink-0 items-start gap-3 overflow-hidden rounded-[14px] border border-line bg-background px-4 py-3 @max-desktop/classroom:px-3.5 @max-phone/classroom:gap-2.5 @max-phone/classroom:px-3 @max-phone/classroom:py-2.5',
        className,
      )}
    >
      <span
        className={cn(
          'relative size-9 shrink-0 overflow-hidden rounded-full @max-desktop/classroom:size-8 @max-phone/classroom:size-7',
          // The primary ring marks a voice in progress; at rest (paused, or
          // counting down to the lecture) the avatar gets a plain hairline
          caption.status === 'paused' || resumeSeconds !== undefined
            ? 'ring-1 ring-line'
            : 'border-2 border-background ring-2 ring-primary',
        )}
      >
        {speaker.avatar && <AvatarDisplay src={speaker.avatar} alt="" />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="mb-0.5 flex h-4 items-center gap-2">
          <span className="truncate text-xs font-semibold text-fg-secondary">{speaker.name}</span>
          {statusText && (
            <span
              data-testid="caption-status"
              className={cn(
                'inline-flex shrink-0 items-center gap-1 text-[11px] font-semibold',
                caption.status === 'paused' || resumeSeconds !== undefined
                  ? 'text-fg-tertiary'
                  : 'text-accent-text',
              )}
            >
              {isSpeaking && <Wave />}
              {caption.status === 'paused' && resumeSeconds === undefined && (
                <Pause aria-hidden="true" className="size-2.5 fill-current stroke-none" />
              )}
              {statusText}
            </span>
          )}
          {isGeneratingAudio && (
            <Loader2
              data-testid="caption-audio-generating"
              aria-hidden="true"
              className="size-3 shrink-0 animate-spin text-warning"
            />
          )}
        </div>
        {showDots ? (
          <LoadingDots />
        ) : isAnsweringYou ? (
          <p
            data-testid="caption-text"
            className="text-[15px] leading-[1.6] text-fg-tertiary @max-phone/classroom:text-sm"
          >
            {t('stage.caption.answeringYou')}
          </p>
        ) : (
          <p
            ref={tailRef}
            data-testid="caption-text"
            data-overflow={followTail ? 'tail' : 'clamp'}
            className={cn(
              'whitespace-pre-wrap break-words text-[15px] leading-[1.6] @max-phone/classroom:text-sm',
              isWaitingForLearner ? 'text-fg-tertiary' : 'text-fg',
              // 2 × 1.6em: the latest two lines stay in view as text streams in
              followTail ? 'max-h-[3.2em] overflow-hidden' : 'line-clamp-2',
            )}
            suppressHydrationWarning
          >
            {caption.text}
          </p>
        )}
      </div>
    </div>
  );
}
