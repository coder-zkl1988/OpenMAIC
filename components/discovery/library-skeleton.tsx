'use client';

import { useI18n } from '@/lib/hooks/use-i18n';

import { ThumbnailSkeleton } from './thumbnail-skeleton';

/** Tiles in the skeleton: two rows of the widest grid. */
const SKELETON_FOLDERS = 2;
const SKELETON_COURSES = 6;

/** The pulse the course cards use while their thumbnail loads. */
const PULSE = 'animate-pulse bg-slate-200/70 dark:bg-slate-700/50';

/**
 * Placeholder for the home library while its course and folder lists load.
 *
 * It mirrors the loaded layout exactly: the same grid, and tiles built from
 * the ClassroomCard / FolderCard boxes (a 16:9 thumbnail and a title / meta
 * row whose height comes from the same text styles), so the real cards
 * replace it without moving anything.
 */
export function LibrarySkeleton() {
  const { t } = useI18n();
  return (
    <div className="pt-8" role="status" aria-label={t('common.loading')} data-library-skeleton>
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-x-5 gap-y-8">
        {Array.from({ length: SKELETON_FOLDERS }, (_, i) => (
          <SkeletonTile key={`folder-${i}`} folder />
        ))}
        {Array.from({ length: SKELETON_COURSES }, (_, i) => (
          <SkeletonTile key={`course-${i}`} />
        ))}
      </div>
    </div>
  );
}

function SkeletonTile({ folder = false }: { folder?: boolean }) {
  return (
    <div aria-hidden data-skeleton-tile={folder ? 'folder' : 'course'}>
      <div
        className={
          folder
            ? 'relative w-full aspect-[16/9] rounded-2xl bg-slate-100 dark:bg-slate-800/80 overflow-hidden'
            : 'relative w-full aspect-[16/9] rounded-2xl bg-white ring-1 ring-line dark:bg-slate-800/80 overflow-hidden'
        }
      >
        {folder ? (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className={`size-14 rounded-2xl ${PULSE}`} />
          </div>
        ) : (
          <ThumbnailSkeleton />
        )}
      </div>
      {/* The cards' title row: a one-line title, the meta line under it and
          the 32px ⋯ slot. Same type styles as the real title and meta, with
          transparent text, so the row is exactly as tall as a loaded card's
          (whose title fits one line). */}
      <div className="mt-2.5 pl-1 flex items-start gap-1">
        <div className="flex-1 min-w-0">
          <p className="text-[15px] leading-[22px] font-medium text-transparent select-none">
            <span className={`inline-block w-3/4 rounded-md ${PULSE}`}>&nbsp;</span>
          </p>
          <p className="mt-0.5 text-xs leading-[18px] text-transparent select-none">
            <span className={`inline-block w-1/3 rounded ${PULSE}`}>&nbsp;</span>
          </p>
        </div>
        <span className="size-8 shrink-0" />
      </div>
    </div>
  );
}
