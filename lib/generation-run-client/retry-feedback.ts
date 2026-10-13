/**
 * What the learner is told when a paused run's Retry does not go through: the
 * classroom and the course lists send the same command and answer its
 * refusals the same way.
 */
import { toast } from 'sonner';

import { getClientTranslation } from '@/lib/i18n';

import { RunApiError, runApiErrorText } from './api';

export function reportRunRetryFailure(error: unknown): void {
  if (error instanceof RunApiError && error.errorCode === 'ACTIVE_RUN_LIMIT') {
    // A paused run does not count against the limit; its Retry does.
    toast.error(getClientTranslation('generation.activeRunLimit'));
  } else if (error instanceof RunApiError && error.errorCode === 'RUN_STATE_CONFLICT') {
    // Retried in another tab or on the other list: the run is moving again.
    toast.info(getClientTranslation('generation.runChangedElsewhere'));
  } else if (error instanceof RunApiError) {
    toast.error(runApiErrorText(error, getClientTranslation));
  } else {
    toast.error(getClientTranslation('generation.sceneGenerateFailed'));
  }
}
