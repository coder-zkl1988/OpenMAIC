'use client';

import { forwardRef, type ComponentPropsWithoutRef } from 'react';
import { Atom, Check } from 'lucide-react';
import { cn } from '@/lib/utils';

type DataAttributes = {
  [key: `data-${string}`]: string | number | boolean | undefined;
};

type InteractiveModeButtonProps = Omit<
  ComponentPropsWithoutRef<'button'>,
  'aria-pressed' | 'children'
> &
  DataAttributes & {
    pressed: boolean;
    label: string;
    onPressedChange: (pressed: boolean) => void;
  };

export const InteractiveModeButton = forwardRef<HTMLButtonElement, InteractiveModeButtonProps>(
  function InteractiveModeButton(
    { pressed, label, onPressedChange, className, onClick, ...buttonProps },
    ref,
  ) {
    return (
      <button
        {...buttonProps}
        ref={ref}
        type="button"
        aria-pressed={pressed}
        onClick={(event) => {
          onClick?.(event);
          if (!event.defaultPrevented) onPressedChange(!pressed);
        }}
        className={cn(
          'relative inline-flex h-8 shrink-0 cursor-pointer select-none items-center gap-1.5 whitespace-nowrap rounded-full border px-3 text-xs font-medium transition-all active:scale-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-interactive motion-reduce:transition-none motion-reduce:active:scale-100',
          // Off is a neutral pill that only tints its Atom icon; on fills with
          // the interactive (cyan) semantic pair and swaps the icon for a Check.
          pressed
            ? 'border-interactive/40 bg-interactive-soft text-interactive'
            : 'border-line bg-background text-fg-secondary hover:bg-subtle hover:text-fg',
          className,
        )}
      >
        {pressed ? (
          <Check aria-hidden="true" className="size-3.5" />
        ) : (
          <Atom aria-hidden="true" className="size-3.5 text-interactive" />
        )}
        <span>{label}</span>
      </button>
    );
  },
);
