'use client';

import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
  type Ref,
  type RefObject,
} from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { MessageSquare, Mic, MicOff } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useASRAvailable } from '@/lib/hooks/use-asr-available';
import { AvatarDisplay } from '@/components/ui/avatar-display';
import { ProactiveCard } from '@/components/chat/proactive-card';
import { PresentationSpeechOverlay } from '@/components/roundtable/presentation-speech-overlay';
import { DEFAULT_USER_AVATAR } from '@/components/roundtable/constants';
import type { AudioIndicatorState } from '@/components/roundtable/audio-indicator';
import { useUserMessageOverlay } from '@/components/classroom/interaction/use-composer-controller';
import type { ComposerHandle } from '@/components/classroom/interaction/composer';
import { buildCaptionModel, type CaptionModelInput } from '@/lib/playback/caption-model';
import type { EngineMode } from '@/lib/playback';
import type { DiscussionAction } from '@/lib/types/action';

/** What the shell asks of the dock: the shortcuts and the stream's "continue" */
export interface PresentationDockHandle {
  /** T: open the composer card and focus the textarea as the user would */
  openText: () => void;
  /** V: open the card and start (or stop) recording */
  toggleVoice: () => void;
  /** A soft-closing session continues: open the card and focus it quietly */
  continueText: () => void;
  /** Escape / click outside: close the card and leave the composer; the draft stays */
  close: () => void;
  /** A question became the learner's line: show it until the answer starts */
  showUserMessage: (text: string) => void;
  /** A question went out: the card closes (a raised hand keeps it up with its status) */
  closeAfterSend: () => void;
}

export interface PresentationDockProps extends Omit<
  CaptionModelInput,
  'names' | 'userMessage' | 'avatars'
> {
  readonly dockRef?: Ref<PresentationDockHandle>;
  readonly engineMode: EngineMode;
  readonly audioIndicatorState?: AudioIndicatorState;
  /** The primary play action: a click on a speech bubble */
  readonly onBubbleClick?: () => void;
  /** The floating control bar, shown while the controls are visible */
  readonly controlBar: ReactNode;
  readonly controlsVisible: boolean;
  /** The shared composer's slot (ComposerSlot): the card adopts the one composer */
  readonly composerSlot: ReactNode;
  /** The shared composer, for focus / voice / dismiss */
  readonly composerRef: RefObject<ComposerHandle | null>;
  /** The composer is recording, or holds a draft in a focused box */
  readonly isComposing: boolean;
  /** A question waits for the current line (its status shows in the card) */
  readonly hasRaisedHand?: boolean;
  /**
   * Composing — the card is open, or the composer records or holds a draft:
   * the shell keeps the controls up, holds auto-advance and lets Escape close
   * the card instead of leaving fullscreen
   */
  readonly onInteractionChange?: (active: boolean) => void;
  readonly discussionRequest?: DiscussionAction | null;
  readonly discussionAgent?: { name?: string; avatar?: string };
  readonly onDiscussionStart?: (request: DiscussionAction) => void;
  readonly onDiscussionSkip?: () => void;
  /** The fullscreen element: the discussion card portals into the top layer */
  readonly portalContainerRef: RefObject<HTMLElement | null>;
}

type PendingAction = 'text' | 'voice' | 'continue';

/**
 * The fullscreen classroom (no artboard; owner decision): the speech overlay
 * fed by the caption model, the auto-hiding control bar, an avatar dock with
 * voice and text toggles that opens the shared composer as a floating card,
 * the thinking indicator and the 发起讨论 card over the dock. The interaction
 * panel stays collapsed meanwhile.
 */
export function PresentationDock({
  dockRef,
  engineMode,
  audioIndicatorState,
  onBubbleClick,
  controlBar,
  controlsVisible,
  composerSlot,
  composerRef,
  isComposing,
  hasRaisedHand,
  onInteractionChange,
  discussionRequest,
  discussionAgent,
  onDiscussionStart,
  onDiscussionSkip,
  portalContainerRef,
  ...captionInput
}: PresentationDockProps) {
  const { t } = useI18n();
  const asrAvailable = useASRAvailable();
  const { participants, speakingAgentId, thinkingState, currentSpeech, isCueUser } = captionInput;

  const userParticipant = participants.find((p) => p.role === 'user');
  const userAvatar = userParticipant?.avatar || DEFAULT_USER_AVATAR;

  // The learner's question over the current line, until the answer starts
  const { userMessage, showUserMessage } = useUserMessageOverlay({
    hasAgentFeedback: Boolean(captionInput.playbackView?.sourceText || thinkingState),
  });
  const caption = buildCaptionModel({
    ...captionInput,
    userMessage,
    names: {
      teacher: t('roundtable.teacher'),
      student: t('settings.agentRoles.student'),
      user: t('roundtable.you'),
    },
    avatars: { agentFallback: userAvatar },
  });

  // The card the learner opened (T, the toggles); a raised hand or the cue
  // shows it too, without counting as composing
  const [isOpen, setIsOpen] = useState(false);
  const isCardVisible = isOpen || isComposing || !!hasRaisedHand || !!isCueUser;
  const isActive = isOpen || isComposing;

  useEffect(() => {
    onInteractionChange?.(isActive);
    return () => {
      if (isActive) onInteractionChange?.(false);
    };
  }, [isActive, onInteractionChange]);

  // Run what opened the card once it is shown: a hidden textarea takes no focus
  const pendingActionRef = useRef<PendingAction | null>(null);
  const runAction = useCallback(
    (action: PendingAction) => {
      const composer = composerRef.current;
      if (action === 'text') composer?.focus();
      else if (action === 'voice') composer?.toggleVoice();
      else composer?.openTextInput();
    },
    [composerRef],
  );
  useEffect(() => {
    const pending = pendingActionRef.current;
    if (!isCardVisible || !pending) return;
    pendingActionRef.current = null;
    runAction(pending);
  });
  const open = useCallback(
    (action: PendingAction) => {
      setIsOpen(true);
      if (isCardVisible) runAction(action);
      else pendingActionRef.current = action;
    },
    [isCardVisible, runAction],
  );

  const cardRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => {
    pendingActionRef.current = null;
    setIsOpen(false);
    composerRef.current?.dismiss();
  }, [composerRef]);
  const closeAfterSend = useCallback(() => {
    setIsOpen(false);
    // Not a dismiss: a voice question is still being handed over
    const active = document.activeElement;
    if (active instanceof HTMLElement && cardRef.current?.contains(active)) active.blur();
  }, []);

  useImperativeHandle(
    dockRef,
    () => ({
      openText: () => open('text'),
      toggleVoice: () => open('voice'),
      continueText: () => open('continue'),
      close,
      showUserMessage,
      closeAfterSend,
    }),
    [close, closeAfterSend, open, showUserMessage],
  );

  // Who the dock shows beside the learner: the speaking student, or the agent
  // whose discussion offer waits
  const discussionParticipant = discussionRequest
    ? participants.find((p) => p.id === discussionRequest.agentId)
    : undefined;
  const offerAgent = discussionRequest
    ? {
        id: discussionRequest.agentId || 'discussion',
        name: discussionParticipant?.name || discussionAgent?.name,
        avatar: discussionParticipant?.avatar || discussionAgent?.avatar,
      }
    : null;
  const dockAgent =
    (caption.activeRole === 'agent' && caption.speakingStudent) || offerAgent || null;

  // The fullscreen element, read once mounted: the discussion card portals
  // into the top layer (outside it the card would not show)
  const [portalContainer, setPortalContainer] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setPortalContainer(portalContainerRef.current);
  }, [portalContainerRef]);

  const showDock = controlsVisible || !!discussionRequest || isCardVisible;
  const dockRowRef = useRef<HTMLDivElement>(null);
  const isPaused = !!captionInput.isLivePaused || engineMode === 'paused';

  const toggleButton =
    'flex size-8 items-center justify-center rounded-full transition-colors active:scale-95 cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-ring/50';

  return (
    <div data-testid="presentation-dock" className="pointer-events-none absolute inset-0 z-20">
      {/* The teacher's line, bottom left (fills the stage for its own positioning) */}
      <PresentationSpeechOverlay
        playbackView={caption.view}
        participants={participants}
        speakingAgentId={speakingAgentId ?? null}
        isTopicPending={!!captionInput.isTopicPending}
        side="left"
        onBubbleClick={onBubbleClick}
        audioIndicatorState={audioIndicatorState ?? 'idle'}
        buttonState={caption.view.buttonState}
        isPaused={isPaused}
      />

      {/* Click outside the open card closes it (the bar and the dock stay usable) */}
      {isOpen && (
        <div
          data-testid="presentation-dock-backdrop"
          className="pointer-events-auto absolute inset-0 z-30"
          onClick={close}
        />
      )}

      {/* Centre: thinking, then the composer card, above the control bar */}
      <div className="absolute inset-x-0 bottom-[72px] z-40 flex flex-col items-center gap-3 px-4">
        <AnimatePresence>
          {thinkingState?.stage === 'director' && !currentSpeech && !userMessage && (
            <motion.div
              key="thinking"
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              className="flex items-center gap-2 rounded-full border border-line bg-background/80 px-4 py-2 backdrop-blur-xl"
            >
              <span aria-hidden="true" className="flex gap-1">
                {[0, 0.2, 0.4].map((delay) => (
                  <span
                    key={delay}
                    className="size-1.5 rounded-full bg-accent-text motion-safe:animate-[think-dot-pulse_1.2s_ease-in-out_infinite]"
                    style={{ animationDelay: `${delay}s` }}
                  />
                ))}
              </span>
              <span className="text-[11px] font-medium text-fg-tertiary">
                {t('roundtable.thinking')}
              </span>
            </motion.div>
          )}
        </AnimatePresence>
        {/* Hidden, never unmounted: the composer inside keeps its draft and
            its raised-hand status. Only its body is display:none — the card
            itself goes sr-only, so the composer's always-mounted live regions
            still announce 已举手 / delivered / lowered while it is closed. */}
        <div
          ref={cardRef}
          data-testid="presentation-composer-card"
          data-visible={isCardVisible ? 'true' : 'false'}
          className={cn(
            isCardVisible
              ? 'pointer-events-auto w-[min(480px,100%)] rounded-[22px] border border-line bg-background/95 p-2 shadow-[0_8px_32px_rgba(0,0,0,0.08)] backdrop-blur-xl dark:shadow-[0_8px_32px_rgba(0,0,0,0.4)]'
              : 'sr-only [&_[data-composer-body]]:hidden',
          )}
        >
          {composerSlot}
        </div>
      </div>

      {/* Bottom right: a student's line, then the dock */}
      <div className="absolute right-4 bottom-3 z-40 flex flex-col items-end gap-3">
        <PresentationSpeechOverlay
          playbackView={caption.view}
          participants={participants}
          speakingAgentId={speakingAgentId ?? null}
          isTopicPending={!!captionInput.isTopicPending}
          userAvatar={userAvatar}
          side="right"
          onBubbleClick={onBubbleClick}
          audioIndicatorState={audioIndicatorState ?? 'idle'}
          buttonState={caption.view.buttonState}
          isPaused={isPaused}
        />
        <AnimatePresence>
          {showDock && (
            <motion.div
              key="dock"
              initial={{ opacity: 0, scale: 0.92 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.92 }}
              transition={{ duration: 0.2, ease: 'easeOut' }}
              className="pointer-events-auto"
            >
              <div
                ref={dockRowRef}
                data-testid="presentation-dock-row"
                className="flex h-12 items-center gap-1.5 rounded-full border border-line bg-background/85 px-2 shadow-[0_8px_32px_rgba(0,0,0,0.08)] backdrop-blur-xl dark:shadow-[0_8px_32px_rgba(0,0,0,0.4)]"
              >
                {dockAgent && (
                  <span
                    key={dockAgent.id}
                    title={dockAgent.name}
                    className="size-8 shrink-0 overflow-hidden rounded-full ring-2 ring-accent-line"
                  >
                    {dockAgent.avatar && <AvatarDisplay src={dockAgent.avatar} alt="" />}
                  </span>
                )}
                <button
                  type="button"
                  aria-label={
                    asrAvailable ? t('roundtable.voiceInput') : t('roundtable.voiceInputDisabled')
                  }
                  title={
                    asrAvailable ? t('roundtable.voiceInput') : t('roundtable.voiceInputDisabled')
                  }
                  disabled={!asrAvailable}
                  onClick={() => open('voice')}
                  className={cn(
                    toggleButton,
                    'text-icon hover:bg-subtle hover:text-fg disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent',
                  )}
                >
                  {asrAvailable ? (
                    <Mic aria-hidden="true" className="size-4" />
                  ) : (
                    <MicOff aria-hidden="true" className="size-4" />
                  )}
                </button>
                <button
                  type="button"
                  aria-label={t('roundtable.textInput')}
                  title={t('roundtable.textInput')}
                  aria-pressed={isOpen}
                  onClick={() => (isOpen ? close() : open('text'))}
                  className={cn(
                    toggleButton,
                    isOpen
                      ? 'bg-primary text-primary-foreground'
                      : 'text-icon hover:bg-subtle hover:text-fg',
                  )}
                >
                  <MessageSquare aria-hidden="true" className="size-4" />
                </button>
                <span
                  className={cn(
                    'size-8 shrink-0 overflow-hidden rounded-full ring-2 transition-shadow',
                    isCueUser
                      ? 'ring-warning'
                      : caption.activeRole === 'user' || isOpen
                        ? 'ring-primary'
                        : 'ring-line',
                  )}
                  title={t('roundtable.you')}
                >
                  <AvatarDisplay src={userAvatar} alt="" />
                </span>
              </div>
              <AnimatePresence>
                {discussionRequest && portalContainer && (
                  <ProactiveCard
                    key={discussionRequest.id}
                    action={discussionRequest}
                    mode={engineMode === 'paused' ? 'paused' : 'playback'}
                    anchorRef={dockRowRef}
                    portalContainer={portalContainer}
                    align="right"
                    agentName={offerAgent?.name}
                    agentAvatar={offerAgent?.avatar}
                    onSkip={() => onDiscussionSkip?.()}
                    onListen={() => onDiscussionStart?.(discussionRequest)}
                  />
                )}
              </AnimatePresence>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* The control bar: an auto-hiding pill at the foot of the stage */}
      <div
        className={cn(
          'absolute inset-x-0 bottom-3 z-30 flex justify-center px-4 transition-all duration-300',
          controlsVisible ? 'translate-y-0 opacity-100' : 'translate-y-2 opacity-0',
        )}
      >
        <div className={cn('max-w-full', controlsVisible && 'pointer-events-auto')}>
          {controlBar}
        </div>
      </div>
    </div>
  );
}
