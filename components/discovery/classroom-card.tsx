'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Atom, FolderInput, Pencil, Sparkles, Trash2 } from 'lucide-react';
import type { Slide } from '@openmaic/dsl';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useNearViewport } from '@/lib/hooks/use-near-viewport';
import { cn } from '@/lib/utils';
import type { CourseRunStatus } from '@/lib/generation-run-client/course-card';
import type { FolderRecord } from '@/lib/types/folder';
import type { StageListItem } from '@/lib/utils/stage-storage';
import { CourseRunStatusLabel } from '@/components/generation/course-run-status-label';
import { SlideThumbnail } from '@/components/slide-renderer/SlideThumbnail';
import { ThumbnailSkeleton } from './thumbnail-skeleton';
import { CardActionsMenu, CardMenuItem, CardMenuSeparator, CardMenuSub } from './card-actions-menu';
import { MoveToFolderMenuItems } from './move-to-folder-menu';

/** What the ⋯ menu's 移动到文件夹 submenu needs. */
export interface ClassroomCardMoveTarget {
  folders: FolderRecord[];
  /** The folder the course is filed in (undefined: ungrouped). */
  currentFolderId: string | undefined;
  onMove: (folderId: string | undefined) => void;
  /** Request to create a new folder and move this course into it. */
  onCreateAndMove: () => void;
}

/**
 * A course in the home library: a 16:9 thumbnail, then a title (up to two
 * lines) with a meta line under it ("12 页 · 今天", or the run's status while
 * the course is generated) and an always-visible ⋯ menu (重命名 / 移动到文件夹 /
 * 删除). The card opens the course on click and can be dragged onto a folder.
 */
export function ClassroomCard({
  classroom,
  slide,
  requestThumbnail,
  formatDate,
  runStatus = null,
  pendingCourse = false,
  moveTarget,
  overlay,
  onDelete,
  onRename,
  confirmingDelete,
  onConfirmDelete,
  onCancelDelete,
  onClick,
}: {
  classroom: StageListItem;
  /** The first slide; null when the course has none, undefined until loaded. */
  slide?: Slide | null;
  /** Loads the thumbnail while the card is near the viewport (absent: nothing to load). */
  requestThumbnail?: (stageId: string, version: number) => () => void;
  formatDate: (ts: number) => string;
  /** The state of the run generating this course, while it runs. */
  runStatus?: CourseRunStatus | null;
  /** The card is a run whose course does not exist yet: it can only be opened or deleted. */
  pendingCourse?: boolean;
  /** Folders the course can be moved to (absent: no 移动到文件夹 entry). */
  moveTarget?: ClassroomCardMoveTarget;
  /** Extra absolutely-positioned layers over the thumbnail (badges). */
  overlay?: ReactNode;
  /** Asks to delete the card; the caller answers with `confirmingDelete`. */
  onDelete: (id: string) => void;
  onRename: (id: string, newName: string) => void;
  confirmingDelete: boolean;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
  onClick: () => void;
}) {
  const { t } = useI18n();
  const thumbRef = useRef<HTMLDivElement>(null);
  const [thumbWidth, setThumbWidth] = useState(0);
  const [editing, setEditing] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const nameInputRef = useRef<HTMLInputElement>(null);
  // Set while 重命名 closes the ⋯ menu: the menu then hands focus to the new
  // input instead of back to its trigger.
  const renameFromMenu = useRef(false);
  const nearViewport = useNearViewport(thumbRef);

  useEffect(() => {
    if (!nearViewport || !requestThumbnail) return;
    return requestThumbnail(classroom.id, classroom.updatedAt);
  }, [nearViewport, requestThumbnail, classroom.id, classroom.updatedAt]);

  useEffect(() => {
    const el = thumbRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      setThumbWidth(Math.round(entry.contentRect.width));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    // From the menu, the input is focused once the menu has closed: the open
    // menu still traps focus and would take it straight back (a blur, which
    // commits the rename).
    if (editing && !renameFromMenu.current) nameInputRef.current?.focus();
  }, [editing]);

  const isTaskEngineMode = classroom.taskEngineMode === true;
  const showModeBadge = classroom.interactiveMode || isTaskEngineMode;
  const ModeBadgeIcon = isTaskEngineMode ? Sparkles : Atom;
  const modeBadgeLabel = isTaskEngineMode ? 'Vocational Mode' : t('toolbar.interactiveModeLabel');

  const startRename = () => {
    setNameDraft(classroom.name);
    setEditing(true);
  };

  const commitRename = () => {
    if (!editing) return;
    const trimmed = nameDraft.trim();
    if (trimmed && trimmed !== classroom.name) {
      onRename(classroom.id, trimmed);
    }
    setEditing(false);
  };

  return (
    <div
      className="group cursor-pointer"
      data-testid="library-card"
      onClick={confirmingDelete ? undefined : onClick}
      draggable={!confirmingDelete && !editing && !pendingCourse}
      onDragStart={(e) => {
        e.dataTransfer.setData('text/stage-id', classroom.id);
        e.dataTransfer.effectAllowed = 'move';
      }}
      onDragEnd={() => {
        // Notify folder cards to clear any lingering drop highlight (Escape-
        // cancelled drags may not fire dragleave on every target).
        window.dispatchEvent(new CustomEvent('course-drag-end'));
      }}
    >
      {/* Thumbnail — large radius. A course sits on white with a hairline
          ring; a course still being generated shows a still slide outline. */}
      {/* Also the card's keyboard target (the card itself is a div, not a
          link): Enter / Space open it like a click. Not while the delete
          confirmation, whose buttons sit inside it, is up. */}
      <div
        ref={thumbRef}
        role={confirmingDelete ? undefined : 'button'}
        tabIndex={confirmingDelete ? undefined : 0}
        aria-label={
          confirmingDelete
            ? undefined
            : pendingCourse
              ? `${t('workspace.viewGenerationProgress')}: ${classroom.name}`
              : t('classroom.openCourse', { name: classroom.name })
        }
        onKeyDown={(e) => {
          if (confirmingDelete || e.target !== e.currentTarget) return;
          if (e.key !== 'Enter' && e.key !== ' ') return;
          e.preventDefault();
          onClick();
        }}
        className={cn(
          'relative w-full aspect-[16/9] rounded-2xl overflow-hidden transition-transform duration-200 group-hover:scale-[1.02]',
          'outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background',
          pendingCourse ? 'bg-subtle dark:bg-card' : 'bg-white ring-1 ring-line dark:bg-card',
        )}
      >
        {slide && thumbWidth > 0 ? (
          <SlideThumbnail
            slide={slide}
            size={thumbWidth}
            viewportSize={slide.viewportSize ?? 1000}
            viewportRatio={slide.viewportRatio ?? 0.5625}
          />
        ) : slide || (slide === undefined && requestThumbnail) ? (
          // Still loading, or loaded and waiting for the card's width.
          <ThumbnailSkeleton />
        ) : pendingCourse ? (
          <ThumbnailSkeleton static />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="size-12 rounded-2xl bg-gradient-to-br from-primary-2 to-blue-100 dark:from-accent-soft dark:to-blue-900/30 flex items-center justify-center">
              <span className="text-xl opacity-50">📄</span>
            </div>
          </div>
        )}

        {showModeBadge && (
          <span
            data-testid="course-mode-badge"
            className={cn(
              'absolute bottom-2 left-2 z-10 inline-flex h-[22px] items-center gap-1 rounded-full px-2 text-[11px] font-semibold',
              'bg-card/92 shadow-sm backdrop-blur-sm dark:bg-card/80',
              isTaskEngineMode
                ? 'text-warning ring-1 ring-warning/30'
                : 'text-interactive ring-1 ring-interactive/25',
            )}
          >
            <ModeBadgeIcon className="size-3" />
            {modeBadgeLabel}
          </span>
        )}

        {!confirmingDelete && overlay}

        {/* Inline delete confirmation overlay */}
        <AnimatePresence>
          {confirmingDelete && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-black/50 backdrop-blur-[6px]"
              onClick={(e) => e.stopPropagation()}
              data-testid="card-delete-confirm"
            >
              <span className="text-[13px] font-medium text-white/90">
                {t('classroom.deleteConfirmTitle')}?
              </span>
              <div className="flex gap-2">
                <button
                  type="button"
                  className="px-3.5 py-1 rounded-lg text-[12px] font-medium bg-white/15 text-white/80 hover:bg-white/25 backdrop-blur-sm transition-colors"
                  onClick={onCancelDelete}
                >
                  {t('common.cancel')}
                </button>
                <button
                  type="button"
                  className="px-3.5 py-1 rounded-lg text-[12px] font-medium bg-red-500/90 text-white hover:bg-red-500 transition-colors"
                  onClick={onConfirmDelete}
                >
                  {t('classroom.delete')}
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Info — outside the thumbnail: title + meta, then the ⋯ menu. */}
      <div className="mt-2.5 pl-1 flex items-start gap-1">
        <div className="flex-1 min-w-0">
          {editing ? (
            <div onClick={(e) => e.stopPropagation()}>
              <input
                ref={nameInputRef}
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitRename();
                  if (e.key === 'Escape') setEditing(false);
                }}
                onBlur={commitRename}
                maxLength={100}
                placeholder={t('classroom.renamePlaceholder')}
                aria-label={t('classroom.rename')}
                className="block h-[22px] w-full bg-transparent border-b border-accent-line text-[15px] leading-[22px] font-medium text-fg outline-none placeholder:text-icon-muted"
              />
            </div>
          ) : (
            <p
              className="text-[15px] leading-[22px] font-medium text-fg line-clamp-2 break-words cursor-text"
              title={classroom.name}
              onDoubleClick={
                pendingCourse
                  ? undefined
                  : (e) => {
                      e.stopPropagation();
                      startRename();
                    }
              }
            >
              {classroom.name}
            </p>
          )}
          {runStatus ? (
            <div className="mt-1 flex">
              <CourseRunStatusLabel status={runStatus} size="md" />
            </div>
          ) : (
            <p className="mt-0.5 text-xs leading-[18px] text-fg-tertiary truncate">
              {classroom.sceneCount} {t('classroom.slides')} · {formatDate(classroom.updatedAt)}
            </p>
          )}
        </div>

        <CardActionsMenu
          disabled={confirmingDelete}
          onCloseAutoFocus={(e) => {
            if (!renameFromMenu.current) return;
            renameFromMenu.current = false;
            e.preventDefault();
            nameInputRef.current?.focus();
          }}
        >
          {!pendingCourse && (
            <>
              <CardMenuItem
                icon={Pencil}
                testId="card-action-rename"
                onSelect={() => {
                  renameFromMenu.current = true;
                  startRename();
                }}
              >
                {t('classroom.rename')}
              </CardMenuItem>
              {moveTarget && (
                <CardMenuSub
                  icon={FolderInput}
                  label={t('classroom.moveToFolder')}
                  testId="card-action-move"
                >
                  <MoveToFolderMenuItems {...moveTarget} />
                </CardMenuSub>
              )}
              <CardMenuSeparator />
            </>
          )}
          <CardMenuItem
            icon={Trash2}
            destructive
            testId="card-action-delete"
            onSelect={() => onDelete(classroom.id)}
          >
            {t('classroom.delete')}
          </CardMenuItem>
        </CardActionsMenu>
      </div>
    </div>
  );
}
