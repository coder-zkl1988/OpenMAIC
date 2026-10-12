'use client';

import { useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/hooks/use-i18n';
import { AvatarDisplay } from '@/components/ui/avatar-display';
import { DEFAULT_USER_AVATAR } from '@/lib/constants/avatar-fallbacks';
import type { MentionCandidate } from '@/lib/chat/agent-mention';

/** The id of one option, for the textarea's aria-activedescendant */
export const mentionOptionId = (menuId: string, index: number) => `${menuId}-option-${index}`;

/**
 * The composer's @ menu (I23): the people in class whose name fits what the
 * learner typed after "@", above the composer box. The textarea keeps focus
 * and owns the keys (useAgentMention); a row is picked with a click, which
 * must not take focus from the textarea. No row carries a second control.
 */
export function AgentMentionMenu({
  id,
  candidates,
  activeIndex,
  onPick,
  onHighlight,
}: {
  readonly id: string;
  readonly candidates: readonly MentionCandidate[];
  readonly activeIndex: number;
  readonly onPick: (candidate: MentionCandidate) => void;
  readonly onHighlight: (index: number) => void;
}) {
  const { t } = useI18n();
  const optionRefs = useRef<(HTMLLIElement | null)[]>([]);

  // Keep the highlighted row in view when the keyboard walks past the edge
  useEffect(() => {
    optionRefs.current[activeIndex]?.scrollIntoView?.({ block: 'nearest' });
  }, [activeIndex]);

  const roleLabel = (role?: string) => {
    if (!role) return '';
    const key = `settings.agentRoles.${role}`;
    const label = t(key);
    return label !== key ? label : '';
  };

  return (
    <ul
      id={id}
      role="listbox"
      data-testid="agent-mention-menu"
      aria-label={t('stage.composer.mentionMenu')}
      className="absolute bottom-full left-0 z-30 mb-1.5 max-h-[220px] w-full max-w-[300px] overflow-y-auto overscroll-contain rounded-xl border border-line bg-background p-1 shadow-lg"
    >
      {candidates.map((candidate, index) => {
        const role = roleLabel(candidate.role);
        const active = index === activeIndex;
        return (
          <li
            key={candidate.id}
            ref={(node) => {
              optionRefs.current[index] = node;
            }}
            id={mentionOptionId(id, index)}
            role="option"
            aria-selected={active}
            data-testid="agent-mention-option"
            data-agent-id={candidate.id}
            // Picking keeps focus (and the caret) in the textarea
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onPick(candidate)}
            onMouseEnter={() => onHighlight(index)}
            className={cn(
              'flex min-w-0 cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 transition-colors',
              active ? 'bg-subtle' : 'hover:bg-subtle',
            )}
          >
            <span className="size-6 shrink-0 overflow-hidden rounded-full bg-subtle ring-1 ring-line">
              <AvatarDisplay
                src={candidate.avatar || DEFAULT_USER_AVATAR}
                alt=""
                className="text-xs"
              />
            </span>
            <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-fg">
              {candidate.name}
            </span>
            {role && <span className="shrink-0 text-[11px] text-fg-tertiary">{role}</span>}
          </li>
        );
      })}
    </ul>
  );
}
