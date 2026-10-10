'use client';

import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/hooks/use-i18n';
import {
  Flashlight,
  MousePointer2,
  MessageSquare,
  Zap,
  Loader2,
  PenLine,
  Play,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

interface InlineActionTagProps {
  actionName: string;
  state: string;
}

// ── Style tokens ──────────────────────────────────────────────

const SPOTLIGHT_STYLE =
  'bg-yellow-50 dark:bg-yellow-500/15 border-yellow-300/40 dark:border-yellow-500/30 text-yellow-700 dark:text-yellow-300';
const LASER_STYLE =
  'bg-red-50 dark:bg-red-500/15 border-red-300/40 dark:border-red-500/30 text-red-600 dark:text-red-300';
const DISCUSS_STYLE = 'bg-warning-soft border-warning/20 text-warning';
const DEFAULT_STYLE = 'bg-subtle border-line text-icon';

// ── Action config ─────────────────────────────────────────────

interface ActionCfg {
  Icon: LucideIcon;
  /** Inline chips only — whiteboard chips share one style */
  style?: string;
  /** Whiteboard family — grouped in a chip row under the bubble */
  wb?: boolean;
}

/** Every action the chat can show a chip for; labels live in `chat.actionTag.<name>` */
export const ACTION_CONFIG: Readonly<Record<string, ActionCfg>> = {
  // Slide effects
  spotlight: { Icon: Flashlight, style: SPOTLIGHT_STYLE },
  laser: { Icon: MousePointer2, style: LASER_STYLE },
  play_video: { Icon: Play, style: SPOTLIGHT_STYLE },

  // Whiteboard lifecycle
  wb_open: { Icon: PenLine, wb: true },
  wb_close: { Icon: PenLine, wb: true },
  wb_clear: { Icon: PenLine, wb: true },
  wb_delete: { Icon: PenLine, wb: true },

  // Whiteboard drawing
  wb_draw_text: { Icon: PenLine, wb: true },
  wb_draw_shape: { Icon: PenLine, wb: true },
  wb_draw_chart: { Icon: PenLine, wb: true },
  wb_draw_latex: { Icon: PenLine, wb: true },
  wb_draw_table: { Icon: PenLine, wb: true },
  wb_draw_line: { Icon: PenLine, wb: true },
  wb_draw_code: { Icon: PenLine, wb: true },
  wb_edit_code: { Icon: PenLine, wb: true },

  // Social
  discussion: { Icon: MessageSquare, style: DISCUSS_STYLE },
};

/** The i18n key of an action's chip label */
export function getActionTagLabelKey(actionName: string): string {
  return `chat.actionTag.${actionName}`;
}

/** Whiteboard actions are collected into a chip row under the bubble; others stay inline */
export function isWhiteboardAction(actionName: string): boolean {
  return ACTION_CONFIG[actionName]?.wb ?? actionName.startsWith('wb_');
}

// ── Component ─────────────────────────────────────────────────

export function InlineActionTag({ actionName, state }: InlineActionTagProps) {
  const { t } = useI18n();
  const config = ACTION_CONFIG[actionName];
  const labelKey = getActionTagLabelKey(actionName);
  const translated = config ? t(labelKey) : labelKey;
  // Unknown actions fall back to their raw name
  const label = translated === labelKey ? actionName : translated;
  const isRunning = state === 'running' || state === 'input-available';

  if (isWhiteboardAction(actionName)) {
    // Whiteboard chip (ClassroomWhiteboard.dc.html): 22px, 11px/600; the
    // running one is outlined with a spinner
    return (
      <span
        data-action={actionName}
        data-state={isRunning ? 'running' : 'done'}
        className={cn(
          'inline-flex h-[22px] items-center gap-1 whitespace-nowrap rounded-full px-2 text-[11px] font-semibold leading-none',
          'text-primary-7 dark:text-accent-text',
          isRunning ? 'border border-accent-line bg-background' : 'bg-accent-soft',
        )}
      >
        {isRunning ? (
          <Loader2 className="size-[11px] shrink-0 animate-spin" strokeWidth={2.25} />
        ) : (
          <PenLine className="size-[11px] shrink-0" strokeWidth={2.25} />
        )}
        {label}
      </span>
    );
  }

  const Icon = config?.Icon || Zap;
  const style = config?.style || DEFAULT_STYLE;

  return (
    <span
      data-action={actionName}
      className={cn(
        'inline-flex items-center mx-1 rounded-full border align-middle leading-none whitespace-nowrap',
        'px-1.5 py-0.5 text-[11px] font-semibold',
        style,
        isRunning && 'animate-pulse',
      )}
    >
      {isRunning ? (
        <Loader2 className="size-3 animate-spin shrink-0" />
      ) : (
        <Icon className="size-3 shrink-0" />
      )}
      <span className="ml-0.5">{label}</span>
    </span>
  );
}
