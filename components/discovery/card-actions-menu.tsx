'use client';

import type { ComponentType, ReactNode } from 'react';
import { ChevronRight, MoreHorizontal } from 'lucide-react';
import { DropdownMenu as DropdownMenuPrimitive } from 'radix-ui';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useI18n } from '@/lib/hooks/use-i18n';
import { cn } from '@/lib/utils';

type Icon = ComponentType<{ className?: string }>;

/** The library menus' panel: 176px wide, a hairline border and a soft drop shadow. */
const PANEL =
  'rounded-xl border border-line bg-popover p-1 shadow-[0_12px_32px_-8px_rgba(0,0,0,0.18)] ring-0';

/**
 * Item styling. Items use the Radix primitive directly rather than the shared
 * DropdownMenuItem, whose focus rule recolours every descendant (the icon
 * included) to the accent foreground.
 */
const ITEM =
  'relative flex h-9 w-full cursor-default select-none items-center gap-2.5 rounded-[10px] px-2.5 text-[13px] text-fg outline-hidden focus:bg-subtle data-[state=open]:bg-subtle data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0';

/** Keeps a click or press inside the menu from reaching the card under it (React bubbles through portals). */
const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();

/**
 * The always-visible ⋯ menu of a library card (course or folder). The trigger
 * sits in the card's title row; the card root navigates on click and is
 * draggable, so the trigger and the menu keep their clicks and presses to
 * themselves.
 */
export function CardActionsMenu({
  children,
  onCloseAutoFocus,
  disabled = false,
  className,
}: {
  children: ReactNode;
  /** Lets a card keep focus elsewhere (e.g. on a rename input) when the menu closes. */
  onCloseAutoFocus?: (event: Event) => void;
  /** Locks the menu, e.g. while the card's inline delete confirm is showing. */
  disabled?: boolean;
  className?: string;
}) {
  const { t } = useI18n();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t('classroom.moreActions')}
          title={t('classroom.moreActions')}
          data-testid="card-actions-trigger"
          disabled={disabled}
          draggable={false}
          onClick={stop}
          onPointerDown={stop}
          className={cn(
            'inline-flex size-8 shrink-0 items-center justify-center rounded-[10px] text-icon transition-colors cursor-pointer',
            'hover:bg-subtle hover:text-fg data-[state=open]:bg-subtle data-[state=open]:text-fg',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-line',
            'disabled:pointer-events-none disabled:opacity-40',
            className,
          )}
        >
          <MoreHorizontal className="size-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        // The shared content defaults to the trigger's width (32px here).
        className={cn('w-44', PANEL)}
        onClick={stop}
        onPointerDown={stop}
        onCloseAutoFocus={onCloseAutoFocus}
      >
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** One row of a library card menu: a 14px icon and a 13px label. */
export function CardMenuItem({
  icon: ItemIcon,
  destructive = false,
  onSelect,
  children,
  className,
  testId,
}: {
  icon?: Icon;
  destructive?: boolean;
  onSelect: () => void;
  children: ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <DropdownMenuPrimitive.Item
      data-testid={testId}
      onSelect={onSelect}
      className={cn(ITEM, destructive && 'text-danger focus:bg-danger-soft', className)}
    >
      {ItemIcon && (
        <ItemIcon className={cn('size-3.5', destructive ? 'text-danger' : 'text-icon')} />
      )}
      {children}
    </DropdownMenuPrimitive.Item>
  );
}

/** The hairline between a card menu's groups. */
export function CardMenuSeparator() {
  return <DropdownMenuPrimitive.Separator className="mx-1.5 my-1 h-px bg-line" />;
}

/** A card menu row that opens a nested menu (移动到文件夹, a folder's 删除 modes). */
export function CardMenuSub({
  icon: ItemIcon,
  label,
  destructive = false,
  children,
  contentClassName,
  testId,
}: {
  icon?: Icon;
  label: ReactNode;
  destructive?: boolean;
  children: ReactNode;
  contentClassName?: string;
  testId?: string;
}) {
  return (
    <DropdownMenuSub>
      <DropdownMenuPrimitive.SubTrigger
        data-testid={testId}
        className={cn(ITEM, destructive && 'text-danger focus:bg-danger-soft')}
      >
        {ItemIcon && (
          <ItemIcon className={cn('size-3.5', destructive ? 'text-danger' : 'text-icon')} />
        )}
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <ChevronRight className="ml-auto size-3.5 text-icon-muted" />
      </DropdownMenuPrimitive.SubTrigger>
      <DropdownMenuSubContent
        // The shared sub panel clips and has no height cap; a long folder list
        // must scroll inside the viewport instead.
        className={cn(
          'w-56 max-h-(--radix-dropdown-menu-content-available-height) overflow-y-auto',
          PANEL,
          contentClassName,
        )}
        onClick={stop}
        onPointerDown={stop}
      >
        {children}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
