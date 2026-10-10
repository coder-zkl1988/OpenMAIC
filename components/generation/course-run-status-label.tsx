'use client';

/**
 * The state of the run producing a course, as a course list shows it: the
 * home page's cards and the Pro workspace's course rail say it the same way.
 */
import { AlertCircle, Clock, Loader2 } from 'lucide-react';

import type { CourseRunStatus } from '@/lib/generation-run-client/course-card';
import { useI18n } from '@/lib/hooks/use-i18n';
import { cn } from '@/lib/utils/cn';

type Translate = ReturnType<typeof useI18n>['t'];

/** The words for a run state ("Generating 2/8", "Paused", …). */
export function courseRunStatusText(status: CourseRunStatus, t: Translate): string {
  switch (status.kind) {
    case 'outlining':
      return t('classroom.runOutlining');
    case 'awaiting-confirmation':
      return t('classroom.runAwaitingConfirmation');
    case 'generating':
      return t('classroom.runGenerating', { completed: status.completed, total: status.total });
    case 'paused':
      return t('classroom.runPaused');
  }
}

/** The run state's icon: a spinner while the run works, else what it waits for. */
export function CourseRunStatusIcon({
  status,
  className,
}: {
  readonly status: CourseRunStatus;
  readonly className?: string;
}) {
  if (status.kind === 'paused') return <AlertCircle className={className} aria-hidden="true" />;
  if (status.kind === 'awaiting-confirmation') {
    return <Clock className={className} aria-hidden="true" />;
  }
  return <Loader2 className={cn('animate-spin', className)} aria-hidden="true" />;
}

/**
 * The pill a course card shows while its run is not over. `size="md"` is the
 * home library card's 12px pill on the primary scale; the default is the
 * compact 11px pill the Pro workspace rail keeps.
 */
export function CourseRunStatusLabel({
  status,
  size = 'sm',
}: {
  readonly status: CourseRunStatus;
  readonly size?: 'sm' | 'md';
}) {
  const { t } = useI18n();
  const paused = status.kind === 'paused';
  return (
    <span
      className={cn(
        'shrink-0 inline-flex items-center gap-1 rounded-full font-medium',
        size === 'md'
          ? cn(
              'px-2 py-px text-xs leading-[18px]',
              paused
                ? 'bg-warning-soft text-warning'
                : 'bg-primary-1 text-primary-6 dark:bg-accent-soft dark:text-accent-text',
            )
          : cn(
              'px-2 py-0.5 text-[11px]',
              paused
                ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300'
                : 'bg-violet-100 text-violet-600 dark:bg-violet-900/30 dark:text-violet-400',
            ),
      )}
      data-testid="course-run-status"
    >
      <CourseRunStatusIcon status={status} className="size-3" />
      {courseRunStatusText(status, t)}
    </span>
  );
}
