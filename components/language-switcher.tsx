'use client';

import { useI18n } from '@/lib/hooks/use-i18n';
import { supportedLocales } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

interface LanguageSwitcherProps {
  /** Called when the dropdown opens, so parent can close sibling dropdowns. */
  onOpen?: () => void;
  /**
   * `md` is the redesigned 32px pill button (home top-right pill); `sm` is
   * the 26px button inside the classroom header's 32px settings pill. The
   * default keeps the original look for the Pro WorkspaceRail.
   */
  size?: 'default' | 'sm' | 'md';
  /** Accessible name for the trigger; omitted, the short locale label names it. */
  ariaLabel?: string;
  className?: string;
}

/**
 * Locale picker pill. Backed by Radix DropdownMenu so its content is
 * portaled to `document.body` — important inside Pro mode's CommandBar
 * (which lives under an `overflow-hidden` canvas slot that would
 * otherwise clip the dropdown).
 */
export function LanguageSwitcher({
  onOpen,
  size = 'default',
  ariaLabel,
  className,
}: LanguageSwitcherProps) {
  const { locale, setLocale } = useI18n();

  return (
    <DropdownMenu
      modal={false}
      onOpenChange={(open) => {
        if (open) onOpen?.();
      }}
    >
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={ariaLabel}
          className={cn(
            'flex items-center gap-1 rounded-full text-xs font-bold hover:bg-white dark:hover:bg-gray-700 hover:shadow-sm transition-all',
            size === 'md'
              ? 'h-8 px-2.5 text-fg-secondary hover:text-fg'
              : size === 'sm'
                ? 'h-[26px] px-2.5 text-fg-secondary hover:text-fg'
                : 'px-3 py-1.5 text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200',
            className,
          )}
        >
          {supportedLocales.find((l) => l.code === locale)?.shortLabel ?? locale}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={8} className="min-w-[120px]">
        {supportedLocales.map((l) => (
          <DropdownMenuItem
            key={l.code}
            onSelect={() => setLocale(l.code)}
            className={cn(
              'cursor-pointer',
              locale === l.code &&
                'bg-purple-50 dark:bg-purple-900/20 text-purple-600 dark:text-purple-400',
            )}
          >
            {l.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
