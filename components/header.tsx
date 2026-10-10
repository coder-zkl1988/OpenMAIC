'use client';

import type { ReactNode } from 'react';
import { ArrowLeft } from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useRouter, useSearchParams } from 'next/navigation';
import type { StageMode } from '@/lib/types/stage';
import { classroomExitLabelKey, exitClassroom } from '@/lib/workbench/classroom-exit';
import { cn } from '@/lib/utils';
import { HeaderControls } from './stage/header-controls';

interface HeaderProps {
  readonly currentSceneTitle: string;
  readonly mode?: StageMode;
  readonly proModeActive?: boolean;
  readonly canEdit?: boolean;
  readonly onToggleEditMode?: () => void;
  /** Replaces the default back-to-home arrow as the header's leftmost
      control. `PlaybackChromeRoot` passes the workbench's return control
      here while a session is attached and full-screen playback is on, so the
      top-left back affordance becomes the back-to-workspace control instead of a home arrow
      (which would navigate away from the hosted classroom entirely). */
  readonly backControl?: ReactNode;
  /** Drops the back slot entirely (no `backControl`, no home arrow). The
      embedded workbench form uses this: the conversation sits beside/above
      the classroom, so any back affordance here would duplicate the chat's
      own back and could exit the workbench. */
  readonly hideBackControl?: boolean;
  /** Hide application-global controls in a workbench-attached classroom. */
  readonly hideGlobalControls?: boolean;
  /** Hide course-level share/export in a workbench-attached classroom. */
  readonly hideCourseActions?: boolean;
  /**
   * `compact` (tablet and narrower, TabletLandscape.dc.html): a 52px header
   * with a 44px back button, the title, "n / m" and the ⋯ menu that holds
   * every header control. `phone` (ClassroomPhone.dc.html) is the compact
   * header with tighter insets, a 15px title and a vertical ⋮ trigger.
   * `default` is the 56px desktop header.
   */
  readonly layout?: 'default' | 'compact' | 'phone';
  /** 0-based current scene, for the compact header's "n / m" */
  readonly sceneIndex?: number;
  /** Scene count, for the compact header's "n / m" */
  readonly sceneCount?: number;
}

export function Header({
  currentSceneTitle,
  mode,
  proModeActive,
  canEdit,
  onToggleEditMode,
  backControl,
  hideBackControl,
  hideGlobalControls,
  hideCourseActions,
  layout = 'default',
  sceneIndex,
  sceneCount,
}: HeaderProps) {
  const { t } = useI18n();
  const router = useRouter();
  const searchParams = useSearchParams();
  const exitLabel = t(classroomExitLabelKey(searchParams));
  if (layout === 'compact' || layout === 'phone') {
    const phone = layout === 'phone';
    const showCounter = sceneIndex !== undefined && sceneCount !== undefined && sceneCount > 0;
    return (
      <header
        className={
          phone
            ? 'h-[52px] shrink-0 px-1 flex items-center gap-0.5 z-10 bg-transparent'
            : 'h-[52px] shrink-0 px-2 flex items-center gap-1 z-10 bg-transparent'
        }
      >
        {hideBackControl
          ? null
          : (backControl ?? (
              <button
                onClick={() => exitClassroom(router, searchParams)}
                className="shrink-0 size-11 flex items-center justify-center rounded-[10px] text-icon hover:bg-subtle hover:text-fg transition-colors"
                title={exitLabel}
                aria-label={exitLabel}
              >
                <ArrowLeft className="w-5 h-5" />
              </button>
            ))}
        {/* The edit cross-fade guard is explained on the desktop title below */}
        {mode !== 'edit' ? (
          <h1
            className={cn(
              'min-w-0 flex-1 truncate font-semibold text-fg',
              phone ? 'text-[15px] leading-[22px]' : 'text-base leading-6',
            )}
            suppressHydrationWarning
          >
            {currentSceneTitle || t('common.loading')}
          </h1>
        ) : (
          <div className="flex-1" />
        )}
        {/* The control bar drops its counter at this width; the header carries it */}
        {showCounter && (
          <span
            data-testid="page-counter"
            className={cn(
              'shrink-0 select-none text-xs font-medium tabular-nums text-fg-tertiary',
              phone ? 'px-1' : 'px-2',
            )}
          >
            <span aria-hidden="true">
              {sceneIndex + 1} / {sceneCount}
            </span>
            <span className="sr-only">
              {t('stage.pageCounter', { current: sceneIndex + 1, total: sceneCount })}
            </span>
          </span>
        )}
        <HeaderControls
          variant="overflow"
          overflowIcon={phone ? 'vertical' : 'horizontal'}
          mode={mode}
          proModeActive={proModeActive}
          canEdit={canEdit}
          onToggleEditMode={onToggleEditMode}
          showGlobalControls={!hideGlobalControls}
          showCourseActions={!hideCourseActions}
        />
      </header>
    );
  }

  return (
    <>
      <header className="h-14 shrink-0 pl-3 pr-5 flex items-center justify-between z-10 bg-transparent gap-4">
        <div className="flex items-center gap-1.5 min-w-0 flex-1">
          {hideBackControl
            ? null
            : (backControl ?? (
                <button
                  onClick={() => exitClassroom(router, searchParams)}
                  className="shrink-0 size-9 flex items-center justify-center rounded-[10px] text-icon hover:bg-subtle hover:text-fg transition-colors"
                  title={exitLabel}
                  aria-label={exitLabel}
                >
                  <ArrowLeft className="w-5 h-5" />
                </button>
              ))}
          {/* Title — hidden when `mode === 'edit'`. Header lives
              inside `PlaybackChromeRoot`, which is unmounted by `Stage`
              once mode flips to 'edit', so in steady state this branch
              is always taken. The guard exists for the ~280ms
              AnimatePresence exit window where the playback chrome
              is still rendering its exit animation while `mode` has
              already flipped — without the guard, this title would
              briefly stack on top of the incoming EditChromeRoot's
              CommandBar title during the cross-fade. */}
          {mode !== 'edit' && (
            <h1
              className="min-w-0 truncate text-base leading-6 font-semibold text-fg"
              suppressHydrationWarning
            >
              {currentSceneTitle || t('common.loading')}
            </h1>
          )}
        </div>

        {/* Standalone classroom keeps the full cluster. Workbench-attached
            classrooms omit both the global capsule and course share/export. */}
        <HeaderControls
          mode={mode}
          proModeActive={proModeActive}
          canEdit={canEdit}
          onToggleEditMode={onToggleEditMode}
          showGlobalControls={!hideGlobalControls}
          showCourseActions={!hideCourseActions}
        />
      </header>
    </>
  );
}
