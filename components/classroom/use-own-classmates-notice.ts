'use client';

/**
 * A course generated with its own classmates is taught by them, even when the
 * learner picked preset classmates in the AgentBar (the preset choice is
 * parked, see `restoreAgentSelection`). The first time that happens the
 * classroom says so, once, and offers to always use the preset classmates.
 */

import { useEffect } from 'react';
import { toast } from 'sonner';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useStageStore } from '@/lib/store';
import { useSettingsStore } from '@/lib/store/settings';

/** How long the notice stays: it carries a choice, so longer than a plain toast */
export const OWN_CLASSMATES_NOTICE_MS = 12_000;

/**
 * Whether to tell the learner now that this course's own classmates replaced
 * their preset ones: their preset is parked, the course has classmates of its
 * own (so they are the ones on stage), and the notice was never shown.
 */
export function shouldShowOwnClassmatesNotice(params: {
  readonly parkedPresetAgentIds: readonly string[] | undefined;
  readonly ownClassmatesNoticeSeen: boolean | undefined;
  readonly courseHasOwnClassmates: boolean;
}): boolean {
  return (
    params.courseHasOwnClassmates &&
    !params.ownClassmatesNoticeSeen &&
    (params.parkedPresetAgentIds?.length ?? 0) > 0
  );
}

/** Show the one-time notice once the classroom is loaded (`ready`). */
export function useOwnClassmatesNotice(ready: boolean): void {
  const { t } = useI18n();
  const parkedPresetAgentIds = useSettingsStore((s) => s.parkedPresetAgentIds);
  const ownClassmatesNoticeSeen = useSettingsStore((s) => s.ownClassmatesNoticeSeen);
  const courseHasOwnClassmates = useStageStore(
    (s) => (s.stage?.generatedAgentConfigs?.length ?? 0) > 0,
  );

  useEffect(() => {
    if (
      !ready ||
      !shouldShowOwnClassmatesNotice({
        parkedPresetAgentIds,
        ownClassmatesNoticeSeen,
        courseHasOwnClassmates,
      })
    ) {
      return;
    }
    const settings = useSettingsStore.getState();
    settings.setOwnClassmatesNoticeSeen(true);
    toast(t('stage.ownClassmates.title'), {
      description: t('stage.ownClassmates.description'),
      duration: OWN_CLASSMATES_NOTICE_MS,
      action: {
        label: t('stage.ownClassmates.alwaysPreset'),
        onClick: () => {
          const current = useSettingsStore.getState();
          current.setPresetAgentsInGeneratedCourses(true);
          // This course switches to the preset classmates right away
          current.restoreParkedPresetAgents();
        },
      },
    });
  }, [courseHasOwnClassmates, ownClassmatesNoticeSeen, parkedPresetAgentIds, ready, t]);
}
