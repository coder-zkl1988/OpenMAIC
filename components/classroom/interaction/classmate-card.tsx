'use client';

import { createContext, useContext, useState, type ReactNode } from 'react';
import { MessageCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/hooks/use-i18n';
import { AvatarDisplay } from '@/components/ui/avatar-display';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useAgentRegistry } from '@/lib/orchestration/registry/store';
import { DEFAULT_USER_AVATAR } from '@/lib/constants/avatar-fallbacks';
import { classmateIntro } from '@/lib/classroom/classmate-intro';

/**
 * "Ask them" on a classmate card (I23): the classroom addresses the
 * learner's draft to that person ("@Name ") and focuses the composer. Absent
 * outside the classroom's playback: the cards show no such button.
 */
export const ClassmateAskContext = createContext<((agentId: string) => void) | null>(null);

/** Who the card is about, as the classroom shows them */
export interface ClassmateCardPerson {
  readonly id: string;
  readonly name: string;
  readonly avatar?: string;
}

/**
 * A classmate card (I24): opened with a click, a tap or Enter on someone's
 * tile or avatar. It says who the person is — name, role and how they come
 * across — and never what their persona tells the model about their level or
 * the mistakes they tend to make. Desktop and touch share one popover; on a
 * phone it spans the screen's width.
 */
export function ClassmateCard({
  person,
  triggerLabel,
  triggerClassName,
  compact,
  children,
}: {
  readonly person: ClassmateCardPerson;
  /** The trigger's accessible name: who it is, and what they are doing */
  readonly triggerLabel: string;
  readonly triggerClassName?: string;
  /** The phone layout: the card takes the screen's width */
  readonly compact?: boolean;
  /** What the trigger shows (a tile, an avatar) */
  readonly children: ReactNode;
}) {
  const { t } = useI18n();
  const onAsk = useContext(ClassmateAskContext);
  const [open, setOpen] = useState(false);
  // Read when shown: agent metadata does not change during a lesson
  const config = open ? useAgentRegistry.getState().getAgent(person.id) : undefined;
  const intro = config ? classmateIntro({ id: person.id, persona: config.persona }, t) : '';
  const roleKey = `settings.agentRoles.${config?.role}`;
  const roleLabel = config ? t(roleKey) : '';
  const showRole = !!roleLabel && roleLabel !== roleKey;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="classmate-card-trigger"
          data-agent-id={person.id}
          aria-label={triggerLabel}
          className={cn(
            'cursor-pointer rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
            triggerClassName,
          )}
        >
          {children}
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="center"
        data-testid="classmate-card"
        className={cn(
          'rounded-[14px] border-line bg-background p-3 text-fg',
          compact ? 'w-[min(20rem,calc(100vw-1.5rem))]' : 'w-64',
        )}
      >
        <div className="flex items-center gap-2.5">
          <span className="size-10 shrink-0 overflow-hidden rounded-full bg-subtle ring-1 ring-line">
            <AvatarDisplay src={person.avatar || DEFAULT_USER_AVATAR} alt="" />
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-fg">{person.name}</p>
            {showRole && (
              <span
                className="mt-0.5 inline-block rounded-full px-1.5 py-0.5 text-[10px] leading-tight text-white"
                // The agent's own colour is data on the agent
                style={{ backgroundColor: config?.color || 'var(--icon-muted)' }}
              >
                {roleLabel}
              </span>
            )}
          </div>
        </div>
        {intro && (
          <p
            data-testid="classmate-card-intro"
            className="mt-2 text-xs leading-relaxed text-fg-secondary"
          >
            {intro}
          </p>
        )}
        {onAsk && (
          <button
            type="button"
            data-testid="classmate-card-ask"
            onClick={() => {
              setOpen(false);
              onAsk(person.id);
            }}
            className="mt-3 flex h-8 w-full items-center justify-center gap-1.5 rounded-lg border border-accent-line bg-background text-xs font-semibold text-accent-text transition-colors hover:bg-accent-soft cursor-pointer"
          >
            <MessageCircle aria-hidden="true" className="size-3.5" />
            {t('stage.participants.askThem', { name: person.name })}
          </button>
        )}
      </PopoverContent>
    </Popover>
  );
}
