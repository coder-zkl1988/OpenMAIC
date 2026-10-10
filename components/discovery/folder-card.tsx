'use client';

import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { AlertTriangle, Folder, FolderMinus, Pencil, Trash2 } from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useNearViewport } from '@/lib/hooks/use-near-viewport';
import { cn } from '@/lib/utils';
import { SlideThumbnail } from '@/components/slide-renderer/SlideThumbnail';
import type { Slide } from '@openmaic/dsl';
import type { FolderRecord } from '@/lib/types/folder';
import type { DeleteFolderMode, StageListItem } from '@/lib/utils/stage-storage';
import { CardActionsMenu, CardMenuItem, CardMenuSeparator, CardMenuSub } from './card-actions-menu';

/** Maximum number of course covers stacked on a folder tile. */
const MAX_COVERS = 3;

/**
 * Folder card. Same visual footprint as a ClassroomCard (16:9 tile + title /
 * meta row). The tile shows up to {@link MAX_COVERS} member course covers
 * stacked with a slight offset; an empty folder falls back to a centered
 * folder icon. The meta line reads "文件夹 · N 门课程".
 *
 * Its ⋯ menu offers 重命名 and 删除: an empty folder is deleted after the
 * inline confirm; a non-empty one asks which mode (keep the courses
 * ungrouped, or delete them too). The tile is also a drop target: dragging a
 * course card onto it files the course into this folder (the course card's
 * ⋯ → 移动到文件夹 is the accessible fallback).
 */
export function FolderCard({
  folder,
  courseCount,
  coverSlides,
  coverCandidates = [],
  requestThumbnail,
  onOpen,
  onRename,
  onDelete,
  onDropCourse,
}: {
  folder: FolderRecord;
  courseCount: number;
  /** Up to {@link MAX_COVERS} first-slide thumbnails of the member courses. */
  coverSlides: Slide[];
  /** The member courses whose thumbnails fill (or may fill) the cover slots. */
  coverCandidates?: readonly StageListItem[];
  /** Loads a member's thumbnail; called for the candidates while the tile is near the viewport. */
  requestThumbnail?: (stageId: string, version: number) => () => void;
  onOpen: () => void;
  onRename: (newName: string) => Promise<string | null>;
  /** Delete the folder with the chosen mode. */
  onDelete: (mode: DeleteFolderMode) => void;
  /** Files the dragged course (its stage id is in the payload) into this folder. */
  onDropCourse: (stageId: string) => void;
}) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(folder.name);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const dragDepth = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  // Set while 重命名 closes the ⋯ menu: the menu then hands focus to the new
  // input instead of back to its trigger (the open menu traps focus, so the
  // input cannot take it any earlier).
  const renameFromMenu = useRef(false);
  const [thumbWidth, setThumbWidth] = useState(0);
  const nearViewport = useNearViewport(thumbRef);
  // A stable key, so a re-render with the same candidates does not re-request.
  const candidateKey = coverCandidates.map((c) => `${c.id}@${c.updatedAt}`).join('|');

  useEffect(() => {
    if (!nearViewport || !requestThumbnail || !candidateKey) return;
    const withdraws = candidateKey.split('|').map((key) => {
      const at = key.lastIndexOf('@');
      return requestThumbnail(key.slice(0, at), Number(key.slice(at + 1)));
    });
    return () => withdraws.forEach((withdraw) => withdraw());
  }, [nearViewport, requestThumbnail, candidateKey]);

  // Clear lingering drop highlight when a course drag ends (covers Escape-
  // cancelled drags that may not fire dragleave on every target).
  useEffect(() => {
    const handler = () => {
      dragDepth.current = 0;
      setDropActive(false);
    };
    window.addEventListener('course-drag-end', handler);
    return () => window.removeEventListener('course-drag-end', handler);
  }, []);

  const startEditing = ({ focus = true }: { focus?: boolean } = {}) => {
    setDraft(folder.name);
    setError(null);
    setEditing(true);
    if (focus) requestAnimationFrame(() => inputRef.current?.focus());
  };

  const shake = () => {
    inputRef.current?.animate(
      [
        { transform: 'translateX(0)' },
        { transform: 'translateX(-4px)' },
        { transform: 'translateX(4px)' },
        { transform: 'translateX(0)' },
      ],
      { duration: 200 },
    );
  };

  const commit = async () => {
    if (!editing || submitting) return;
    const trimmed = draft.trim();
    if (trimmed === folder.name) {
      setEditing(false);
      return;
    }
    // Empty name: show an error and keep editing (do not silently exit).
    if (!trimmed) {
      setError(t('classroom.folderNameEmpty'));
      shake();
      return;
    }
    setSubmitting(true);
    const err = await onRename(trimmed);
    setSubmitting(false);
    if (err) {
      setError(err);
      shake();
      return;
    }
    setEditing(false);
  };

  const covers = coverSlides.slice(0, MAX_COVERS);
  // Emptiness is derived from courseCount (the authoritative source), not from
  // covers.length — a non-empty folder whose courses have no cached thumbnails
  // must not show the empty-folder icon. `hasCovers` gates the cover stack.
  const hasCovers = covers.length > 0;

  return (
    <div
      className="group cursor-pointer"
      data-testid="folder-card"
      onClick={editing ? undefined : onOpen}
      onDragEnter={(e) => {
        if (editing) return;
        // Only react to course-card drags (carrying a stage-id payload).
        if (!Array.from(e.dataTransfer.types).includes('text/stage-id')) return;
        dragDepth.current += 1;
        setDropActive(true);
      }}
      onDragOver={(e) => {
        if (editing) return;
        if (!Array.from(e.dataTransfer.types).includes('text/stage-id')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
      }}
      onDragLeave={() => {
        // dragenter/dragleave fire per child element; balance them with a
        // counter so the highlight clears only when the pointer fully exits.
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDropActive(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        dragDepth.current = 0;
        setDropActive(false);
        const stageId = e.dataTransfer.getData('text/stage-id');
        if (stageId) onDropCourse(stageId);
      }}
    >
      {/* The card's keyboard target: Enter / Space open the folder like a
          click, except while the inline delete confirmation is up. */}
      <div
        ref={thumbRef}
        role={confirmingDelete ? undefined : 'button'}
        tabIndex={confirmingDelete ? undefined : 0}
        aria-label={confirmingDelete ? undefined : t('classroom.openFolder', { name: folder.name })}
        onKeyDown={(e) => {
          if (confirmingDelete || editing || e.target !== e.currentTarget) return;
          if (e.key !== 'Enter' && e.key !== ' ') return;
          e.preventDefault();
          onOpen();
        }}
        className={cn(
          'relative w-full aspect-[16/9] rounded-2xl bg-gradient-to-br from-accent-soft to-blue-50 dark:to-blue-900/20 overflow-hidden transition-transform duration-200 group-hover:scale-[1.02] ring-1',
          'outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background',
          dropActive
            ? 'ring-2 ring-primary ring-offset-2 ring-offset-background scale-[1.03]'
            : 'ring-accent-line/50',
        )}
      >
        {hasCovers ? (
          <CoverStack covers={covers} thumbWidth={thumbWidth} setThumbWidth={setThumbWidth} />
        ) : courseCount === 0 ? (
          // Truly empty folder: folder icon.
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
            <div className="size-14 rounded-2xl bg-primary-2 dark:bg-accent-soft flex items-center justify-center">
              <Folder className="size-7 text-primary-5 dark:text-accent-text" />
            </div>
          </div>
        ) : (
          // Non-empty but no cached covers: a neutral stacked-card placeholder
          // distinct from the empty-folder icon, so it does not read as empty.
          <div className="absolute inset-0 flex items-center justify-center">
            <div
              className="w-[60%] aspect-[16/9] rounded-xl bg-primary-2/80 dark:bg-accent-line/30 shadow-md ring-1 ring-accent-line/40"
              style={{ transform: 'translate(-3%, 2%)' }}
            />
            <div
              className="absolute w-[60%] aspect-[16/9] rounded-xl bg-primary-3/60 dark:bg-accent-line/20 shadow-md ring-1 ring-accent-line/40"
              style={{ transform: 'translate(3%, -1%)' }}
            />
          </div>
        )}

        {dropActive && (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-primary-5/20 backdrop-blur-[2px]">
            <Folder className="size-8 text-white drop-shadow" />
          </div>
        )}

        {/* Inline delete confirmation overlay (empty folder + destructive path). */}
        <AnimatePresence>
          {confirmingDelete && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 bg-black/50 backdrop-blur-[6px]"
              onClick={(e) => e.stopPropagation()}
            >
              {courseCount > 0 && (
                <div className="flex items-center gap-1.5 text-amber-300">
                  <AlertTriangle className="size-3.5" />
                  <span className="text-[11px] font-medium">
                    {t('classroom.deleteFolderConfirmRemove')}
                  </span>
                </div>
              )}
              <span className="px-4 text-center text-[13px] font-medium text-white/90">
                {courseCount === 0
                  ? t('classroom.deleteFolderEmptyDesc')
                  : t('classroom.deleteFolderTitle', { name: folder.name })}
              </span>
              <div className="flex gap-2">
                <button
                  type="button"
                  className="px-3.5 py-1 rounded-lg text-[12px] font-medium bg-white/15 text-white/80 hover:bg-white/25 backdrop-blur-sm transition-colors"
                  onClick={() => setConfirmingDelete(false)}
                >
                  {t('common.cancel')}
                </button>
                <button
                  type="button"
                  className="px-3.5 py-1 rounded-lg text-[12px] font-medium bg-red-500/90 text-white hover:bg-red-500 transition-colors"
                  onClick={() => {
                    // Close the overlay before the async delete: on success the
                    // card unmounts; on failure the user sees the error toast
                    // and the card is interactive again (not stuck behind the
                    // backdrop).
                    setConfirmingDelete(false);
                    onDelete(courseCount === 0 ? 'ungroup' : 'remove');
                  }}
                >
                  {t('classroom.delete')}
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Info — name + "文件夹 · N 门课程", then the ⋯ menu. */}
      <div className="mt-2.5 pl-1 flex items-start gap-1">
        <div className="flex-1 min-w-0">
          {editing ? (
            <div onClick={(e) => e.stopPropagation()}>
              <input
                ref={inputRef}
                value={draft}
                onChange={(e) => {
                  setDraft(e.target.value);
                  setError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commit();
                  if (e.key === 'Escape') setEditing(false);
                }}
                onBlur={commit}
                disabled={submitting}
                maxLength={80}
                aria-label={t('classroom.rename')}
                className="block h-[22px] w-full bg-transparent border-b border-accent-line text-[15px] leading-[22px] font-medium text-fg outline-none disabled:opacity-50"
              />
              {error && <p className="mt-1 text-[11px] text-destructive">{error}</p>}
            </div>
          ) : (
            <p
              className="text-[15px] leading-[22px] font-medium text-fg line-clamp-2 break-words"
              title={folder.name}
            >
              {folder.name}
            </p>
          )}
          <p className="mt-0.5 flex items-center gap-1.5 text-xs leading-[18px] text-fg-tertiary">
            <Folder className="size-3 shrink-0" />
            <span className="truncate">
              {t('classroom.folderBadge')} · {courseCount} {t('classroom.folderCourseCountUnit')}
            </span>
          </p>
        </div>

        <CardActionsMenu
          disabled={confirmingDelete}
          onCloseAutoFocus={(e) => {
            if (!renameFromMenu.current) return;
            renameFromMenu.current = false;
            e.preventDefault();
            inputRef.current?.focus();
          }}
        >
          <CardMenuItem
            icon={Pencil}
            testId="card-action-rename"
            onSelect={() => {
              renameFromMenu.current = true;
              startEditing({ focus: false });
            }}
          >
            {t('classroom.rename')}
          </CardMenuItem>
          <CardMenuSeparator />
          {courseCount === 0 ? (
            // Empty folder: the inline confirm.
            <CardMenuItem
              icon={Trash2}
              destructive
              testId="card-action-delete"
              onSelect={() => setConfirmingDelete(true)}
            >
              {t('classroom.delete')}
            </CardMenuItem>
          ) : (
            // Non-empty: choose whether the courses stay (ungrouped) or go too.
            <CardMenuSub
              icon={Trash2}
              destructive
              label={t('classroom.delete')}
              testId="card-action-delete"
              contentClassName="w-64"
            >
              <CardMenuItem
                icon={FolderMinus}
                testId="folder-delete-ungroup"
                onSelect={() => onDelete('ungroup')}
                className="h-auto items-start py-2 [&>svg]:mt-0.5"
              >
                <span className="flex min-w-0 flex-col">
                  <span>{t('classroom.deleteFolderOnly')}</span>
                  <span className="text-[11px] leading-4 text-fg-tertiary">
                    {t('classroom.deleteFolderUngroupDesc')}
                  </span>
                </span>
              </CardMenuItem>
              <CardMenuSeparator />
              <CardMenuItem
                icon={Trash2}
                destructive
                testId="folder-delete-remove"
                onSelect={() => setConfirmingDelete(true)}
              >
                {t('classroom.deleteFolderAndCourses', { count: courseCount })}
              </CardMenuItem>
            </CardMenuSub>
          )}
        </CardActionsMenu>
      </div>
    </div>
  );
}

/**
 * Render member course covers as a tidy, slightly-fanned stack: each rear cover
 * peeks out from behind the one in front, offset up and to alternating sides,
 * with a gentle rotation. Inspired by the iOS Photos / macOS folder cover —
 * restrained, geometric, readable. The frontmost cover is the most recently
 * updated member.
 */
function CoverStack({
  covers,
  thumbWidth,
  setThumbWidth,
}: {
  covers: Slide[];
  thumbWidth: number;
  setThumbWidth: (w: number) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      setThumbWidth(Math.round(entry.contentRect.width));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [setThumbWidth]);

  const count = covers.length;
  // `covers` is ordered most-recent-first; that cover is the front (drawn last,
  // on top). Rear covers offset up + alternate sides + small rotation so a sliver
  // of each is visible behind the front. Offsets are % of the tile for consistency.
  const rear: Array<{ dx: number; dy: number; rot: number }> = [
    { dx: -8, dy: 10, rot: -5 }, // rearmost (left, up, tilted left)
    { dx: 8, dy: 5, rot: 5 }, // mid (right, up a bit, tilted right)
  ];

  return (
    <div ref={containerRef} className="absolute inset-0 flex items-center justify-center">
      {/* Render back→front: iterate covers in reverse so the front is last (on top). */}
      {[...covers].reverse().map((cover, i) => {
        const depthFromFront = count - 1 - i; // 0 = frontmost
        const isFront = depthFromFront === 0;
        const cfg = rear[depthFromFront - 1] ?? rear[rear.length - 1];
        const widthPct = isFront ? 66 : 60;
        return (
          <div
            key={i}
            className="absolute"
            style={{
              width: `${widthPct}%`,
              transform: isFront
                ? 'translate(0, 0)'
                : `translate(${cfg.dx}%, -${cfg.dy}%) rotate(${cfg.rot}deg)`,
              zIndex: i + 1,
              opacity: isFront ? 1 : 0.85,
            }}
          >
            {thumbWidth > 0 && (
              <div className="aspect-[16/9] w-full rounded-xl overflow-hidden shadow-md ring-1 ring-black/5 bg-subtle">
                <SlideThumbnail
                  slide={cover}
                  size={Math.round((thumbWidth * widthPct) / 100)}
                  viewportSize={cover.viewportSize ?? 1000}
                  viewportRatio={cover.viewportRatio ?? 0.5625}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
