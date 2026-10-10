'use client';

import { useId, type Ref } from 'react';
import { useI18n } from '@/lib/hooks/use-i18n';

interface ComposerStatusRowsProps {
  /**
   * A raised hand waits for the current line: a question (its text), or a
   * bare hand ('' — the row then shows the label alone)
   */
  readonly queuedText?: string | null;
  /** 'hand': a bare hand, called rather than answered at the boundary */
  readonly queuedKind?: 'question' | 'hand';
  /** What it waits for: 已举手 · 老师讲完这句就回答你, 已举手 · 讲完这句就请你发言 (or "this step") */
  readonly queuedLabel: string;
  /** 0..1 of the line the question waits for; null hides the bar */
  readonly speechProgress?: number | null;
  readonly onCancelQueued?: () => void;
  /** Lets the owner tell whether the row held focus when it unmounts */
  readonly queuedRowRef?: Ref<HTMLDivElement>;
  /** The director handed the floor to the learner */
  readonly isCueUser?: boolean;
}

function Dot() {
  return <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-amber-500" />;
}

/**
 * The status rows above the composer (Classroom.dc.html, HandRaiseFlow.dc.html):
 * the raised hand — '已举手 · 老师讲完这句就回答你' with the question, or a bare
 * hand's '已举手 · 讲完这句就请你发言' — with 撤回 and the line's progress, or
 * the cue '轮到你发言了 · 课堂已暂停'. Visual only — the composer's
 * always-mounted live region announces the raised hand, the call and 撤回.
 */
export function ComposerStatusRows({
  queuedText,
  queuedKind = 'question',
  queuedLabel,
  speechProgress,
  onCancelQueued,
  queuedRowRef,
  isCueUser,
}: ComposerStatusRowsProps) {
  const { t } = useI18n();
  const labelId = useId();

  if (queuedText != null) {
    // The row never outgrows the panel and only the texts truncate — the
    // question gets what the label leaves — so 撤回 always stays visible
    return (
      <div
        ref={queuedRowRef}
        data-testid="composer-queued-question"
        data-kind={queuedKind}
        className="mx-1 mb-2.5"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex min-w-0 items-center gap-1.5 text-xs">
          <Dot />
          <span
            id={labelId}
            title={queuedLabel}
            className="min-w-0 shrink truncate font-semibold text-warning"
          >
            {queuedLabel}
          </span>
          {queuedText ? (
            <span title={queuedText} className="min-w-0 flex-1 truncate text-fg-tertiary">
              {queuedText}
            </span>
          ) : (
            <span className="flex-1" />
          )}
          <button
            type="button"
            aria-describedby={labelId}
            onClick={onCancelQueued}
            onKeyDown={(event) => {
              // Keep Space/Enter on this button: the window shortcut treats
              // Space as play/pause, which would deliver the question instead
              if (event.key === ' ' || event.key === 'Enter') event.stopPropagation();
            }}
            className="h-7 shrink-0 rounded-full border border-line bg-background px-2.5 text-xs font-semibold text-fg-secondary transition-colors hover:bg-subtle hover:text-fg cursor-pointer"
          >
            {t('roundtable.cancelQueuedQuestion')}
          </button>
        </div>
        {speechProgress != null && (
          <div
            aria-hidden="true"
            data-testid="composer-queued-progress"
            className="mt-1.5 h-[3px] overflow-hidden rounded-full bg-warning-soft"
          >
            <div
              className="h-full rounded-full bg-amber-500"
              style={{ width: `${Math.round(Math.min(1, Math.max(0, speechProgress)) * 100)}%` }}
            />
          </div>
        )}
      </div>
    );
  }

  if (isCueUser) {
    return (
      <div
        data-testid="composer-cue"
        className="mb-2 ml-1 flex items-center gap-1.5 text-xs font-semibold text-warning"
      >
        <Dot />
        {t('stage.composer.cueStatus')}
      </div>
    );
  }

  return null;
}
