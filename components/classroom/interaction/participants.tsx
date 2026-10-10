'use client';

import { Hand } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/hooks/use-i18n';
import { AvatarDisplay } from '@/components/ui/avatar-display';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useAgentRegistry } from '@/lib/orchestration/registry/store';
import { DEFAULT_USER_AVATAR } from '@/components/roundtable/constants';
import type { PlaybackView } from '@/lib/playback';
import type { Participant } from '@/lib/types/roundtable';

/** What a participant's tile says under the name */
export type ParticipantStatus = 'speaking' | 'wantsToSpeak' | 'handRaised' | 'role';

/** The grid holds five tiles; past that the last agent slot becomes a "+N" tile */
export const PARTICIPANT_GRID_COLUMNS = 5;

/**
 * Who is speaking right now (讲解中): the lecturing teacher, or the agent whose
 * live answer is being revealed. Nobody while the lecture or the answer is
 * paused, or while the classroom waits for the learner.
 */
export function resolveSpeakingParticipantId({
  playbackView,
  speakingAgentId,
  participants,
  isLivePaused,
}: {
  readonly playbackView?: Pick<PlaybackView, 'phase' | 'activeRole'>;
  readonly speakingAgentId?: string | null;
  readonly participants: readonly Participant[];
  readonly isLivePaused?: boolean;
}): string | null {
  if (!playbackView) return null;
  const { phase, activeRole } = playbackView;
  const live = phase === 'discussionActive' && !isLivePaused;
  if (phase !== 'lecturePlaying' && !live) return null;
  if (activeRole === 'agent') return speakingAgentId ?? null;
  if (activeRole === 'teacher') {
    // A Q&A answer names its speaker; the lecture is the teacher's
    return speakingAgentId ?? participants.find((p) => p.role === 'teacher')?.id ?? null;
  }
  return null;
}

/**
 * The status line of one tile: speaking wins, then the agent asking to start
 * a discussion (想发言), then the learner's raised hand (举手中); otherwise
 * the role label.
 */
export function resolveParticipantStatus(
  participant: Pick<Participant, 'id' | 'role'>,
  {
    speakingId,
    discussionAgentId,
    userHandRaised,
  }: {
    readonly speakingId?: string | null;
    readonly discussionAgentId?: string | null;
    readonly userHandRaised?: boolean;
  },
): ParticipantStatus {
  if (speakingId && participant.id === speakingId) return 'speaking';
  if (discussionAgentId && participant.id === discussionAgentId) return 'wantsToSpeak';
  if (participant.role === 'user' && userHandRaised) return 'handRaised';
  return 'role';
}

/**
 * The tiles the grid shows: everyone when they fit, else the first agents, a
 * "+N" tile for the rest and the learner last (the learner never hides).
 */
export function layoutParticipantGrid(participants: readonly Participant[]): {
  visible: Participant[];
  overflow: Participant[];
} {
  if (participants.length <= PARTICIPANT_GRID_COLUMNS) {
    return { visible: [...participants], overflow: [] };
  }
  const user = participants.find((p) => p.role === 'user');
  const agents = participants.filter((p) => p !== user);
  // One slot for "+N", one for the learner when present
  const agentSlots = PARTICIPANT_GRID_COLUMNS - 1 - (user ? 1 : 0);
  return {
    visible: [...agents.slice(0, agentSlots), ...(user ? [user] : [])],
    overflow: agents.slice(agentSlots),
  };
}

const STATUS_LABEL_KEYS: Record<Exclude<ParticipantStatus, 'role'>, string> = {
  speaking: 'stage.participants.speaking',
  wantsToSpeak: 'stage.participants.wantsToSpeak',
  handRaised: 'stage.participants.handRaised',
};

// The speaking badge's bars; the reduced-motion fallback is a static scale
function SpeakingBars() {
  return (
    <span aria-hidden="true" className="inline-flex h-2 items-center gap-px">
      {[0, 0.15, 0.3].map((delay) => (
        <i
          key={delay}
          className="block h-2 w-[1.5px] origin-center rounded-[1px] bg-current motion-reduce:scale-y-[0.6] motion-safe:animate-[caption-wave_1s_ease-in-out_infinite]"
          style={{ animationDelay: `${delay}s` }}
        />
      ))}
    </span>
  );
}

interface ParticipantsProps {
  readonly participants: readonly Participant[];
  readonly playbackView?: PlaybackView;
  readonly speakingAgentId?: string | null;
  /** The live answer's reveal is paused (nobody is speaking) */
  readonly isLivePaused?: boolean;
  /** The director is preparing this agent's turn (agent_loading spinner) */
  readonly thinkingState?: { stage: string; agentId?: string } | null;
  /** The agent offering a discussion (想发言) */
  readonly discussionAgentId?: string | null;
  /** The learner's question waits for the current line (举手中) */
  readonly userHandRaised?: boolean;
  /**
   * `panel` (desktop / tablet landscape): the '5 人在线' line over the grid.
   * `stacked` (TabletPortrait.dc.html): no count (the 互动 tab carries it), a
   * row of 60px tiles with 44px avatars. `phone` (ClassroomPhone.dc.html): a
   * five-column grid of 36px avatars with names; the status is the ring and
   * the badge (and a screen-reader label).
   */
  readonly layout?: 'panel' | 'stacked' | 'phone';
}

/** The avatar and its badges per layout */
const AVATAR_SIZE = {
  panel: 'size-11 @max-desktop/classroom:size-10',
  stacked: 'size-11',
  phone: 'size-9',
} as const;
const BADGE_SIZE = {
  panel: 'size-[18px]',
  stacked: 'size-[18px]',
  phone: 'size-[15px]',
} as const;

/**
 * The interaction panel's participants block (Classroom.dc.html): '5 人在线'
 * and a five-column grid of 44px avatars (40px below the classroom's
 * desktop width, TabletLandscape.dc.html) with name and status — 讲解中 for
 * the speaker, 想发言 for the agent offering a discussion, 举手中 for the
 * learner's raised hand, else the role. Hovering an agent shows its persona.
 * The stacked and phone layouts drop the count line (see `layout`).
 */
export function Participants({
  participants,
  playbackView,
  speakingAgentId,
  isLivePaused,
  thinkingState,
  discussionAgentId,
  userHandRaised,
  layout = 'panel',
}: ParticipantsProps) {
  const { t } = useI18n();
  const phone = layout === 'phone';
  const avatarSize = AVATAR_SIZE[layout];
  const onlineCount = participants.filter((p) => p.isOnline).length;
  const speakingId = resolveSpeakingParticipantId({
    playbackView,
    speakingAgentId,
    participants,
    isLivePaused,
  });
  const { visible, overflow } = layoutParticipantGrid(participants);
  // Intentionally non-reactive: agent metadata is immutable during a classroom session
  const getAgentConfig = (id: string) => useAgentRegistry.getState().getAgent(id);

  // A stacked row lays out fixed 60px tiles; the grids share the width
  const tileClass = layout === 'stacked' ? 'w-[60px] shrink-0' : 'min-w-0';

  const describe = (participant: Participant) => {
    const status = resolveParticipantStatus(participant, {
      speakingId,
      discussionAgentId,
      userHandRaised,
    });
    const config = participant.role === 'user' ? undefined : getAgentConfig(participant.id);
    const role =
      config?.role === 'teacher' || config?.role === 'assistant' || config?.role === 'student'
        ? config.role
        : participant.role === 'teacher'
          ? 'teacher'
          : 'student';
    const label =
      status === 'role' ? t(`settings.agentRoles.${role}`) : t(STATUS_LABEL_KEYS[status]);
    return { status, label, config };
  };

  const statusText = (status: ParticipantStatus, label: string) => (
    <span
      className={cn(
        'max-w-full truncate text-[11px]',
        status === 'speaking' && 'font-semibold text-accent-text',
        (status === 'wantsToSpeak' || status === 'handRaised') && 'font-semibold text-warning',
        status === 'role' && 'text-fg-tertiary',
      )}
    >
      {label}
    </span>
  );

  const avatar = (participant: Participant, status: ParticipantStatus) => {
    const isLoading =
      thinkingState?.stage === 'agent_loading' && thinkingState.agentId === participant.id;
    return (
      <span className={cn('relative shrink-0', avatarSize)}>
        <span
          className={cn(
            'block overflow-hidden rounded-full border-2 border-background bg-subtle',
            avatarSize,
            status === 'speaking'
              ? 'ring-2 ring-primary'
              : status === 'wantsToSpeak' || status === 'handRaised'
                ? 'ring-2 ring-amber-500'
                : 'ring-1 ring-line',
          )}
        >
          <AvatarDisplay
            src={participant.avatar || DEFAULT_USER_AVATAR}
            alt=""
            className={phone ? 'text-base' : 'text-xl'}
          />
        </span>
        {isLoading && (
          <span
            data-testid="participant-loading"
            aria-hidden="true"
            className="absolute inset-0 rounded-full border-2 border-accent-text border-t-transparent animate-spin"
          />
        )}
        {status === 'speaking' && (
          <span
            aria-hidden="true"
            className={cn(
              'absolute -right-[3px] -bottom-[3px] flex items-center justify-center rounded-full border-2 border-background bg-primary text-primary-foreground',
              BADGE_SIZE[layout],
            )}
          >
            <SpeakingBars />
          </span>
        )}
        {(status === 'wantsToSpeak' || status === 'handRaised') && (
          <span
            aria-hidden="true"
            className={cn(
              'absolute -right-[3px] -top-[3px] flex items-center justify-center rounded-full border-2 border-background bg-amber-500 text-white',
              BADGE_SIZE[layout],
            )}
          >
            <Hand className={cn('stroke-[3]', phone ? 'size-[7px]' : 'size-[9px]')} />
          </span>
        )}
      </span>
    );
  };

  const tile = (participant: Participant) => {
    const { status, label, config } = describe(participant);
    const i18nDescription = t(`settings.agentDescriptions.${participant.id}`);
    const description =
      i18nDescription !== `settings.agentDescriptions.${participant.id}`
        ? i18nDescription
        : config?.persona || '';
    // A custom role has no translation: show no chip rather than the raw key
    const roleChipKey = `settings.agentRoles.${config?.role}`;
    const roleChip = config ? t(roleChipKey) : '';
    const showRoleChip = !!roleChip && roleChip !== roleChipKey;
    const body = (
      <div
        data-testid="participant-tile"
        data-participant-id={participant.id}
        data-status={status}
        className={cn('flex min-w-0 flex-col items-center', phone ? 'gap-[3px]' : 'gap-1')}
      >
        {avatar(participant, status)}
        <span
          className={cn(
            'max-w-full truncate font-semibold text-fg',
            phone ? 'text-[11px]' : 'text-xs',
          )}
        >
          {participant.name}
        </span>
        {/* The phone grid has no room for the line: the ring and badge show it */}
        {phone ? <span className="sr-only">{label}</span> : statusText(status, label)}
      </div>
    );
    if (participant.role === 'user')
      return (
        <li key={participant.id} className={tileClass}>
          {body}
        </li>
      );
    return (
      <li key={participant.id} className={tileClass}>
        <HoverCard openDelay={300} closeDelay={100}>
          <HoverCardTrigger asChild>
            <div className="cursor-default">{body}</div>
          </HoverCardTrigger>
          <HoverCardContent
            side="bottom"
            align="center"
            className="w-64 p-3 max-h-[300px] overflow-y-auto"
          >
            <div className="flex items-center gap-2">
              <span className="size-8 shrink-0 overflow-hidden rounded-full bg-subtle">
                <AvatarDisplay src={participant.avatar || DEFAULT_USER_AVATAR} alt="" />
              </span>
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{participant.name}</p>
                {showRoleChip && (
                  <span
                    className="mt-0.5 inline-block rounded-full px-1.5 py-0.5 text-[10px] leading-tight text-white"
                    style={{ backgroundColor: config?.color || 'var(--icon-muted)' }}
                  >
                    {roleChip}
                  </span>
                )}
              </div>
            </div>
            {description && (
              <p className="mt-2 whitespace-pre-line text-xs leading-relaxed text-muted-foreground">
                {description}
              </p>
            )}
          </HoverCardContent>
        </HoverCard>
      </li>
    );
  };

  const overflowTile = overflow.length > 0 && (
    <li key="overflow" className={tileClass}>
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            data-testid="participants-overflow"
            aria-label={t('stage.participants.more', { count: overflow.length })}
            className="flex w-full min-w-0 flex-col items-center gap-1 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring/50 cursor-pointer"
          >
            <span
              className={cn(
                'flex items-center justify-center rounded-full bg-subtle text-[13px] font-semibold text-fg-secondary ring-1 ring-line',
                avatarSize,
                // Someone hidden in the list is speaking or wants to: hint at it
                overflow.some((p) => describe(p).status !== 'role') && 'ring-2 ring-amber-500',
              )}
            >
              +{overflow.length}
            </span>
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-60 rounded-[14px] p-2">
          <ul className="flex flex-col gap-1">
            {overflow.map((participant) => {
              const { status, label } = describe(participant);
              return (
                <li
                  key={participant.id}
                  data-testid="participant-overflow-row"
                  data-status={status}
                  className="flex items-center gap-2 rounded-lg px-2 py-1.5"
                >
                  <span className="size-7 shrink-0 overflow-hidden rounded-full bg-subtle ring-1 ring-line">
                    <AvatarDisplay src={participant.avatar || DEFAULT_USER_AVATAR} alt="" />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-xs font-semibold text-fg">
                    {participant.name}
                  </span>
                  {statusText(status, label)}
                </li>
              );
            })}
          </ul>
        </PopoverContent>
      </Popover>
    </li>
  );

  const userTile = visible.find((p) => p.role === 'user');
  const agentTiles = visible.filter((p) => p !== userTile);

  return (
    <section
      aria-label={t('stage.participants.label')}
      data-testid="participants"
      data-layout={layout}
      className={cn(
        'shrink-0 border-b border-line',
        layout === 'panel' && 'px-4 py-3.5',
        layout === 'stacked' && 'px-5 pt-2.5 pb-3',
        phone && 'px-3 pt-1.5 pb-2.5',
      )}
    >
      {/* Stacked layouts show the count on the 互动 tab instead */}
      {layout === 'panel' && (
        <div className="mb-3 flex items-center gap-1.5 text-xs font-semibold text-fg-secondary">
          <span
            aria-hidden="true"
            className="size-2 rounded-full bg-success ring-[3px] ring-success-soft"
          />
          {t('stage.participants.online', { count: onlineCount })}
        </div>
      )}
      <ul
        className={cn(
          layout === 'stacked'
            ? // Five 60px tiles at most (380px): the stacked layout is ≥ 600px wide
              'flex gap-5'
            : cn('grid grid-cols-5', phone ? 'gap-0.5' : 'gap-1'),
        )}
      >
        {agentTiles.map(tile)}
        {overflowTile}
        {userTile && tile(userTile)}
      </ul>
    </section>
  );
}
