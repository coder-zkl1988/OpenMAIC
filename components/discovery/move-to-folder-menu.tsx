'use client';

import { Check, Plus } from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import type { FolderRecord } from '@/lib/types/folder';
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
