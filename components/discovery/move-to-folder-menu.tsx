'use client';

import { Check, FolderInput, Plus } from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import type { FolderRecord } from '@/lib/types/folder';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { CardMenuItem, CardMenuSeparator } from './card-actions-menu';

/**
 * The move-course-to-folder entries, rendered inside the course card's ⋯ menu
 * (its 移动到文件夹 submenu). Lists "Ungrouped" plus every folder (the current
 * one gets a ✓), and a "New folder" entry that asks the caller to open a
 * folder dialog (a Radix DropdownMenu is modal, so an inline <input> cannot
 * keep focus there — the dialog is the focus surface; selecting the entry
 * closes the menu first).
 */
export function MoveToFolderMenuItems({
  folders,
  currentFolderId,
  onMove,
  onCreateAndMove,
}: {
  folders: FolderRecord[];
  currentFolderId: string | undefined;
  onMove: (folderId: string | undefined) => void;
  /** Request to create a new folder and move this course into it. */
  onCreateAndMove: () => void;
}) {
  const { t } = useI18n();

  return (
    <>
      {/* Ungrouped */}
      <CardMenuItem onSelect={() => onMove(undefined)} testId="move-to-folder-ungrouped">
        <span className="min-w-0 flex-1 truncate">{t('classroom.ungrouped')}</span>
        {currentFolderId === undefined && (
          <Check aria-hidden className="size-3.5 text-primary-6 dark:text-accent-text" />
        )}
      </CardMenuItem>

      {/* All folders */}
      {folders.map((f) => (
        <CardMenuItem key={f.id} onSelect={() => onMove(f.id)} testId="move-to-folder-option">
          <span className="min-w-0 flex-1 truncate">{f.name}</span>
          {currentFolderId === f.id && (
            <Check aria-hidden className="size-3.5 text-primary-6 dark:text-accent-text" />
          )}
        </CardMenuItem>
      ))}

      <CardMenuSeparator />

      {/* New folder — opens the folder dialog (focus-safe). */}
      <CardMenuItem icon={Plus} onSelect={onCreateAndMove} testId="move-to-folder-new">
        {t('classroom.newFolderInline')}
      </CardMenuItem>
    </>
  );
}

/**
 * The standalone move-course-to-folder menu: the 📂 hover button on a course
 * tile (the caller positions it via the card overlay), or, with
 * `variant="items"`, just the entries for a caller-owned DropdownMenu (the
 * phone course-options dialog). Same listing as {@link MoveToFolderMenuItems}:
 * "Ungrouped" plus every folder (the current one gets a ✓), and a "New folder"
 * entry that asks the caller to open a folder dialog (a Radix DropdownMenu is
 * modal, so an inline <input> cannot keep focus there — the dialog is the
 * focus surface).
 */
export function MoveToFolderMenu({
  folders,
  currentFolderId,
  onMove,
  onCreateAndMove,
  variant = 'icon',
}: {
  variant?: 'icon' | 'items';
  folders: FolderRecord[];
  currentFolderId: string | undefined;
  onMove: (folderId: string | undefined) => void;
  /** Request to create a new folder and move this course into it. */
  onCreateAndMove: () => void;
}) {
  const { t } = useI18n();

  const items = (
    <>
      <DropdownMenuLabel>{t('classroom.moveToFolderLabel')}</DropdownMenuLabel>
      <DropdownMenuSeparator />

      {/* Ungrouped */}
      <DropdownMenuItem
        onClick={() => onMove(undefined)}
        className="flex items-center justify-between"
      >
        <span>{t('classroom.ungrouped')}</span>
        {currentFolderId === undefined && (
          <Check className="size-3.5 text-primary-6 dark:text-accent-text" />
        )}
      </DropdownMenuItem>

      {/* All folders */}
      {folders.map((f) => (
        <DropdownMenuItem
          key={f.id}
          onClick={() => onMove(f.id)}
          className="flex items-center justify-between"
        >
          <span className="truncate">{f.name}</span>
          {currentFolderId === f.id && (
            <Check className="size-3.5 text-primary-6 dark:text-accent-text shrink-0" />
          )}
        </DropdownMenuItem>
      ))}

      <DropdownMenuSeparator />

      {/* New folder — opens the folder dialog (focus-safe). */}
      <DropdownMenuItem onClick={onCreateAndMove}>
        <Plus className="size-3.5 mr-1.5" />
        {t('classroom.newFolderInline')}
      </DropdownMenuItem>
    </>
  );

  if (variant === 'items') return items;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t('classroom.moveToFolder')}
          title={t('classroom.moveToFolder')}
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          className="absolute top-2 right-20 size-7 inline-flex items-center justify-center rounded-full bg-black/30 hover:bg-black/50 text-white hover:text-white backdrop-blur-sm opacity-0 transition-opacity z-10 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary pointer-coarse:opacity-100 group-hover:opacity-100"
        >
          <FolderInput className="size-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-56"
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
      >
        {items}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
