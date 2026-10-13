'use client';

/**
 * The strip a classroom shows over its course while the run producing it is
 * paused: which page failed, why, and the Retry. The scene list's failed tile
 * keeps its own Retry, but it is a small icon at the end of the list; this is
 * the place a learner who opens the course actually sees.
 *
 * Only the course owner sees it (the run's Retry spends the owner's provider
 * budget; see `mayStartOwnerGeneration`).
 */
import { useState } from 'react';
import { AlertCircle, RefreshCw } from 'lucide-react';

import type { RunPause } from '@/lib/generation-run-client/use-run-course';
import { useI18n } from '@/lib/hooks/use-i18n';
import { cn } from '@/lib/utils/cn';

export function GenerationPausedNotice({
  pause,
  onRetry,
}: {
  readonly pause: RunPause;
  readonly onRetry: () => Promise<void>;
}) {
  const { t } = useI18n();
  const [retrying, setRetrying] = useState(false);
  const failure = pause.failure
    ? 'key' in pause.failure
      ? t(pause.failure.key)
      : pause.failure.text
    : null;

  const retry = async () => {
    if (retrying) return;
    setRetrying(true);
    try {
      await onRetry();
    } finally {
      setRetrying(false);
    }
  };

  return (
    <div
      role="status"
      data-testid="generation-paused-notice"
      className="flex flex-none items-center gap-3 border-b border-line bg-warning-soft px-4 py-2 @max-phone/classroom:gap-2 @max-phone/classroom:px-3"
    >
      <AlertCircle className="size-4 shrink-0 text-warning" aria-hidden="true" />
      <p className="min-w-0 flex-1 text-sm leading-5 text-fg">
        <span className="font-medium">{t('workspace.coursePausedTitle')}</span>
        {pause.scene && (
          <span data-testid="generation-paused-scene">
            {' · '}
            {t('stage.sceneRailItem', { n: pause.scene.number, title: pause.scene.title })}
          </span>
        )}
        {failure && (
          <span className="text-fg-secondary" data-testid="generation-paused-reason">
            {' — '}
            {failure}
          </span>
        )}
      </p>
      <button
        type="button"
        onClick={() => void retry()}
        disabled={retrying}
        data-testid="generation-paused-retry"
        className={cn(
          'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90',
          'outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background',
          'disabled:cursor-default disabled:opacity-60 @max-desktop/classroom:h-11',
        )}
      >
        <RefreshCw className={cn('size-3.5', retrying && 'animate-spin')} aria-hidden="true" />
        {retrying ? t('generation.retryingScene') : t('generation.retryScene')}
      </button>
    </div>
  );
}
