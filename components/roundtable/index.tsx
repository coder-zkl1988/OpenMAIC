'use client';

import { useRef, useEffect, useId, useImperativeHandle, type Ref } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Mic, MicOff, Send, MessageSquare, Loader2, Quote, X, Hand } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { AudioIndicatorState } from './audio-indicator';
import { usePlaybackControls } from '@/components/canvas/use-playback-controls';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useSettingsStore } from '@/lib/store/settings';
import { ProactiveCard } from '@/components/chat/proactive-card';
import { PresentationSpeechOverlay } from '@/components/roundtable/presentation-speech-overlay';
import { AvatarDisplay } from '@/components/ui/avatar-display';
import { useAgentRegistry } from '@/lib/orchestration/registry/store';
import { DEFAULT_USER_AVATAR } from '@/components/roundtable/constants';
import {
  useComposerController,
  useUserMessageOverlay,
  type MessageSendResult,
} from '@/components/classroom/interaction/use-composer-controller';
import {
  useQueuedQuestionEffects,
  type QueuedQuestionState,
} from '@/components/classroom/interaction/use-queued-question-effects';
import { useClassroomShortcuts } from '@/components/classroom/interaction/use-classroom-shortcuts';
import { buildCaptionModel } from '@/lib/playback/caption-model';
import type { DiscussionAction } from '@/lib/types/action';
import type { EngineMode, PlaybackView } from '@/lib/playback';
import type { Participant } from '@/lib/types/roundtable';

export type { MessageSendResult, QueuedQuestionState };

/** What the shell may ask of the composer (the stream's soft-close "continue discussion") */
export interface RoundtableComposerHandle {
  openTextInput: () => void;
}

export interface DiscussionRequest {
  topic: string;
  prompt?: string;
  agentId?: string; // Agent ID to initiate discussion (default: 'default-1')
}

interface RoundtableProps {
  readonly mode?: 'playback' | 'autonomous';
  readonly initialParticipants?: Participant[];
  readonly playbackView?: PlaybackView; // Centralised derived state from Stage
  readonly currentSpeech?: string | null; // Live SSE speech (from StreamBuffer — discussion/QA)
  readonly lectureSpeech?: string | null; // Active lecture speech (from PlaybackEngine, full text)
  readonly idleText?: string | null; // Static idle text (first speech action)
  readonly playbackCompleted?: boolean; // True when engine finished all actions (show restart icon)
  readonly discussionRequest?: DiscussionAction | null;
  readonly engineMode?: EngineMode;
  readonly isStreaming?: boolean;
  readonly sessionType?: 'qa' | 'discussion';
  readonly speakingAgentId?: string | null;
  readonly audioIndicatorState?: AudioIndicatorState;
  readonly speechProgress?: number | null; // StreamBuffer reveal progress (0–1) for auto-scroll
  readonly thinkingState?: { stage: string; agentId?: string } | null;
  readonly isCueUser?: boolean;
  readonly isTopicPending?: boolean;
  readonly canSendMessage?: () => boolean;
  readonly onMessageSend?: (message: string) => MessageSendResult;
  readonly onDiscussionStart?: (request: DiscussionAction) => void;
  readonly onDiscussionSkip?: () => void;
  /** Which input opened: voice must pause narration (the mic would record it); text need not. */
  readonly onInputActivate?: (kind: 'text' | 'voice') => void;
  readonly onUserInputActivity?: (
    kind: 'text_input' | 'composition_start' | 'recording_start',
  ) => void;

  readonly onResumeTopic?: () => void;
  readonly onPlayPause?: () => void;
  readonly isDiscussionPaused?: boolean;
  readonly onDiscussionPause?: () => void;
  readonly onDiscussionResume?: () => void;
  readonly totalActions?: number;
  readonly currentActionIndex?: number;
  /** The interaction panel is collapsed (fullscreen overlays centre on the stage) */
  readonly chatCollapsed?: boolean;
  readonly isPresenting?: boolean;
  readonly controlsVisible?: boolean;
  readonly onPresentationInteractionChange?: (active: boolean) => void;
  /** Ref to the fullscreen container — passed to ProactiveCard so its portal
   *  renders inside the top-layer during presentation mode. */
  readonly fullscreenContainerRef?: React.RefObject<HTMLDivElement | null>;
  /** The composer's imperative handle for the shell (the control bar owns playback) */
  readonly composerRef?: Ref<RoundtableComposerHandle>;
  readonly elementReferencePill?: {
    sceneLabel: string;
    elementType: string;
    displaySummary: string;
  };
  readonly onClearElementReference?: () => void;
  readonly queuedQuestion?: QueuedQuestionState | null;
  readonly onCancelQueuedQuestion?: () => void;
}

const VOICE_WAVE_BARS = [
  { peak: 18, duration: 0.55 },
  { peak: 24, duration: 0.72 },
  { peak: 15, duration: 0.63 },
  { peak: 22, duration: 0.68 },
  { peak: 27, duration: 0.78 },
  { peak: 19, duration: 0.61 },
  { peak: 26, duration: 0.74 },
  { peak: 17, duration: 0.58 },
  { peak: 23, duration: 0.7 },
  { peak: 16, duration: 0.57 },
  { peak: 21, duration: 0.66 },
  { peak: 14, duration: 0.53 },
] as const;

function VoiceWaveformBars({ barClassName }: { readonly barClassName: string }) {
  return VOICE_WAVE_BARS.map((bar, i) => (
    <motion.div
      key={i}
      animate={{
        height: [4, bar.peak, 4],
        opacity: [0.3, 1, 0.3],
      }}
      transition={{
        repeat: Infinity,
        duration: bar.duration,
        delay: i * 0.05,
        ease: 'easeInOut',
      }}
      className={cn('w-1 rounded-full', barClassName)}
    />
  ));
}

export function Roundtable({
  mode: _mode = 'autonomous',
  initialParticipants = [],
  playbackView,
  currentSpeech,
  lectureSpeech,
  idleText,
  playbackCompleted,
  discussionRequest,
  engineMode = 'idle',
  isStreaming,
  sessionType,
  speakingAgentId,
  audioIndicatorState,
  speechProgress: _speechProgress,
  thinkingState,
  isCueUser,
  isTopicPending,
  onMessageSend,
  canSendMessage,
  onDiscussionStart,
  onDiscussionSkip,
  onInputActivate,
  onUserInputActivity,

  onResumeTopic,
  onPlayPause,
  isDiscussionPaused,
  onDiscussionPause,
  onDiscussionResume,
  chatCollapsed,
  isPresenting,
  controlsVisible,
  onPresentationInteractionChange,
  fullscreenContainerRef,
  composerRef,
  elementReferencePill,
  onClearElementReference,
  queuedQuestion,
  onCancelQueuedQuestion,
}: RoundtableProps) {
  const { t } = useI18n();
  const chatAreaWidth = useSettingsStore((s) => s.chatAreaWidth);

  // Separate participants by role
  const teacherParticipant = initialParticipants.find((p) => p.role === 'teacher');
  const studentParticipants = initialParticipants.filter(
    (p) => p.role !== 'teacher' && p.role !== 'user',
  );
  const userParticipant = initialParticipants.find((p) => p.role === 'user');

  const userAvatar = userParticipant?.avatar || DEFAULT_USER_AVATAR;

  // The "you asked" overlay over the current line, cleared once the answer starts
  const { userMessage, showUserMessage } = useUserMessageOverlay({
    hasAgentFeedback: Boolean(playbackView?.sourceText || thinkingState),
  });

  // Who speaks and what: role, name, text and the overlay-enriched view
  const caption = buildCaptionModel({
    playbackView,
    participants: initialParticipants,
    speakingAgentId,
    currentSpeech,
    lectureSpeech,
    idleText,
    playbackCompleted,
    isStreaming,
    sessionType,
    thinkingState,
    isCueUser,
    isTopicPending,
    isLivePaused: isDiscussionPaused,
    userMessage,
    names: {
      teacher: t('roundtable.teacher'),
      student: t('settings.agentRoles.student'),
      user: t('roundtable.you'),
    },
    avatars: { agentFallback: userAvatar },
  });
  // The speech bubble lives in the shell's caption strip; this model still
  // drives the fullscreen overlays, the avatar highlights and the cue prompt
  const {
    role: bubbleRole,
    activeRole,
    isInLiveFlow,
    speakingStudent,
    view: enrichedPlaybackView,
  } = caption;

  // Draft, open input, voice and the send cooldown
  const composer = useComposerController({
    speakingAgentId,
    isStreaming,
    canSendMessage,
    onMessageSend,
    onUserMessage: showUserMessage,
    onInputActivate,
    onUserInputActivity,
    onClearElementReference,
  });
  const { isInputOpen, isSendCooldown, voice } = composer;
  const isVoiceOpen = voice.isOpen;
  const asrEnabled = voice.available;

  // The dock's text-input toggle, where a delivered question hands a keyboard
  // user so they can follow up
  const textInputToggleRef = useRef<HTMLButtonElement>(null);
  // Raised hand: delivered / cancelled / restored transitions, the live
  // region and the focus handoff
  const queued = useQueuedQuestionEffects({
    queuedQuestion,
    isSendCooldown,
    isSendCoolingDown: composer.isSendCoolingDown,
    onDelivered: showUserMessage,
    onReturned: composer.restoreDraft,
    focusTargetRef: textInputToggleRef,
  });

  // The dock's agent avatar: the fullscreen discussion card points at it
  const presentationActionAnchorRef = useRef<HTMLDivElement>(null);
  const presentationAgentAvatarRef = useRef<HTMLDivElement>(null);

  // Space pauses / resumes the live answer; a fullscreen bubble click runs the
  // primary play action (the shell's control bar owns the rest)
  const controls = usePlaybackControls({
    engineMode,
    sessionType,
    isTopicPending,
    isInLiveFlow,
    isLivePaused: isDiscussionPaused,
    // Don't allow pause during thinking or before text arrives
    canPauseLive: !thinkingState && !!currentSpeech,
    onResumeTopic,
    onLivePause: onDiscussionPause,
    onLiveResume: onDiscussionResume,
    onPlayPause,
  });

  // The stream's soft-close "continue discussion" reopens the text input here
  useImperativeHandle(composerRef, () => ({ openTextInput: composer.openTextInput }), [
    composer.openTextInput,
  ]);

  // Keyboard shortcuts for the fullscreen composer (#255); outside fullscreen
  // the shell owns them for the panel composer
  useClassroomShortcuts({
    enabled: !!isPresenting,
    isComposerOpen: isInputOpen || isVoiceOpen,
    onDismiss: composer.dismiss,
    isInLiveFlow,
    onToggleLivePause: controls.toggleLivePause,
    focusComposer: composer.toggleInput,
    toggleVoice: voice.toggle,
    canUseVoice: asrEnabled,
  });

  const isPresentationInteractionActive = composer.isActive;

  useEffect(() => {
    onPresentationInteractionChange?.(isPresentationInteractionActive);

    return () => {
      if (isPresentationInteractionActive) {
        onPresentationInteractionChange?.(false);
      }
    };
  }, [isPresentationInteractionActive, onPresentationInteractionChange]);

  // Intentionally non-reactive: agent metadata is treated as immutable during a classroom session.
  const agentRegistry = useAgentRegistry.getState();
  const getAgentConfig = (id: string) => agentRegistry.getAgent(id);

  const presentationDiscussionParticipant = discussionRequest
    ? discussionRequest.agentId === teacherParticipant?.id
      ? teacherParticipant || null
      : studentParticipants.find((student) => student.id === discussionRequest.agentId) || null
    : null;
  const presentationDiscussionAgentConfig = discussionRequest
    ? getAgentConfig(discussionRequest.agentId || '')
    : null;

  const showPresentationDock =
    !!controlsVisible || !!discussionRequest || isCueUser || isPresentationInteractionActive;
  const referencePill = elementReferencePill ? (
    <div
      data-testid="slide-element-reference-pill"
      className="pointer-events-auto flex max-w-[min(520px,calc(100vw-3rem),100%)] items-center gap-2 rounded-full border border-violet-200 bg-white/95 px-3 py-1.5 text-xs shadow-lg backdrop-blur dark:border-violet-700 dark:bg-gray-900/95"
      onClick={(event) => event.stopPropagation()}
    >
      <Quote className="h-3.5 w-3.5 shrink-0 text-violet-600 dark:text-violet-400" />
      <span className="shrink-0 font-semibold text-violet-700 dark:text-violet-300">
        {elementReferencePill.sceneLabel} · {elementReferencePill.elementType} ·
      </span>
      <span className="min-w-0 truncate text-gray-600 dark:text-gray-300">
        {elementReferencePill.displaySummary}
      </span>
      <button
        type="button"
        onClick={composer.clearReference}
        className="-mr-1 rounded-full p-0.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-800 dark:hover:text-gray-200"
        aria-label={t('chat.elementReference.clear')}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  ) : null;
  // Raised hand: a sent question waiting for the teacher to finish the line
  // (or, when no line is playing, the current step)
  const queuedStatusId = useId();
  // Always mounted: a live region that appears together with its text is
  // often not announced. Also where focus lands if the pill unmounts under it.
  const queuedQuestionLiveRegion = (
    <span ref={queued.statusRef} role="status" aria-live="polite" tabIndex={-1} className="sr-only">
      {queued.liveText}
    </span>
  );
  // The pill never outgrows its container and only the texts truncate — the
  // question gets what the status label leaves — so Cancel stays visible
  // however long the translated label is.
  const queuedQuestionIndicator =
    queued.isQueued && queuedQuestion ? (
      <div
        ref={queued.pillRef}
        data-testid="roundtable-queued-question"
        className="pointer-events-auto flex max-w-[min(520px,calc(100vw-3rem),100%)] items-center gap-2 rounded-full border border-amber-300 bg-white/95 px-3 py-1.5 text-xs shadow-lg backdrop-blur dark:border-amber-600 dark:bg-gray-900/95"
        onClick={(event) => event.stopPropagation()}
      >
        <Hand
          aria-hidden="true"
          className="h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400"
        />
        <span
          id={queuedStatusId}
          className="min-w-0 truncate font-semibold text-amber-700 dark:text-amber-300"
          title={queued.label}
        >
          {queued.label}
        </span>
        <span
          className="min-w-0 flex-1 truncate text-gray-600 dark:text-gray-300"
          title={queuedQuestion.text}
        >
          {queuedQuestion.text}
        </span>
        <button
          type="button"
          aria-describedby={queuedStatusId}
          onClick={onCancelQueuedQuestion}
          onKeyDown={(event) => {
            // Keep Space/Enter on this button: the window shortcut treats Space
            // as play/pause, which would deliver the question instead
            if (event.key === ' ' || event.key === 'Enter') event.stopPropagation();
          }}
          className="-mr-1 shrink-0 rounded-full px-2 py-0.5 font-semibold text-amber-700 hover:bg-amber-50 dark:text-amber-300 dark:hover:bg-amber-900/30"
        >
          {t('roundtable.cancelQueuedQuestion')}
        </button>
      </div>
    ) : null;

  if (isPresenting) {
    return (
      <div className="h-0 w-full relative z-10 overflow-visible">
        {queuedQuestionLiveRegion}
        {/* Speech overlay — fills the full stage area via absolute positioning */}
        <PresentationSpeechOverlay
          playbackView={enrichedPlaybackView}
          participants={initialParticipants}
          speakingAgentId={speakingAgentId ?? null}
          isTopicPending={!!isTopicPending}
          side="left"
          onBubbleClick={controls.primaryAction}
          audioIndicatorState={audioIndicatorState ?? 'idle'}
          buttonState={enrichedPlaybackView?.buttonState}
          isPaused={isDiscussionPaused || engineMode === 'paused'}
        />

        {/* Click-outside backdrop to dismiss input/voice (the control bar pill stays usable) */}
        {(isInputOpen || isVoiceOpen) && (
          <div
            className="fixed top-[var(--desktop-titlebar-height)] left-0 right-0 bottom-[72px] z-[45] pointer-events-auto"
            onClick={() => {
              composer.setInputOpen(false);
              voice.setOpen(false);
              voice.cancelRecording();
            }}
          />
        )}

        {/* ── Center stack: input / voice / thinking — anchored above the shell's control bar pill ── */}
        <div
          className="fixed bottom-[72px] left-0 z-[50] flex flex-col items-center justify-center gap-3 pointer-events-none transition-[right] duration-300"
          style={{ right: chatCollapsed === false ? (chatAreaWidth ?? 320) : 0 }}
        >
          {referencePill}
          {queuedQuestionIndicator}
          {/* Input panel */}
          <AnimatePresence>
            {isInputOpen && (
              <motion.div
                key="presentation-input-stage"
                initial={{ opacity: 0, scale: 0.95, y: 15, filter: 'blur(4px)' }}
                animate={{ opacity: 1, scale: 1, y: 0, filter: 'blur(0px)' }}
                exit={{ opacity: 0, scale: 0.95, y: 15, filter: 'blur(4px)' }}
                className="w-[min(480px,calc(100vw-3rem))] pointer-events-auto"
              >
                <div className="flex items-center gap-3 bg-white/70 dark:bg-black/60 backdrop-blur-xl rounded-full px-4 py-2 shadow-[0_8px_32px_rgba(0,0,0,0.08)] dark:shadow-[0_8px_32px_rgba(0,0,0,0.4)] border border-gray-200/60 dark:border-white/10">
                  <div className="flex-1 min-w-0 flex items-center">
                    <textarea
                      {...composer.textareaProps}
                      placeholder={t('roundtable.inputPlaceholder')}
                      autoFocus
                      rows={1}
                      className="w-full resize-none bg-transparent border-none focus:ring-0 focus:outline-none outline-none shadow-none ring-0 text-gray-900 dark:text-white text-sm placeholder:text-gray-400 dark:placeholder:text-gray-400 py-0 leading-[40px] max-h-[80px]"
                      style={{ fieldSizing: 'content' } as Record<string, string>}
                    />
                  </div>
                  <button
                    onClick={composer.send}
                    disabled={isSendCooldown}
                    className={cn(
                      'w-10 h-10 rounded-full flex items-center justify-center transition-all shrink-0',
                      isSendCooldown
                        ? 'bg-gray-500/50 cursor-not-allowed'
                        : 'bg-purple-600 hover:bg-purple-700 shadow-[0_4px_16px_rgba(147,51,234,0.3)]',
                    )}
                  >
                    {isSendCooldown ? (
                      <Loader2 className="w-4 h-4 text-white animate-spin" />
                    ) : (
                      <Send className="w-4 h-4 text-white" />
                    )}
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Voice panel */}
          <AnimatePresence>
            {isVoiceOpen && (
              <motion.div
                key="presentation-voice-stage"
                initial={{ opacity: 0, scale: 0.9, y: 20, filter: 'blur(4px)' }}
                animate={{ opacity: 1, scale: 1, y: 0, filter: 'blur(0px)' }}
                exit={{ opacity: 0, scale: 0.9, y: 20, filter: 'blur(4px)' }}
                className="pointer-events-auto"
              >
                <div className="flex items-center gap-4 bg-white/70 dark:bg-black/60 backdrop-blur-xl rounded-full px-5 py-3 shadow-[0_8px_32px_rgba(0,0,0,0.08)] dark:shadow-[0_8px_32px_rgba(0,0,0,0.4)] border border-gray-200/60 dark:border-white/10">
                  {/* Waveform bars */}
                  <div className="flex items-center gap-0.5 h-8">
                    <VoiceWaveformBars barClassName="bg-gradient-to-t from-purple-400 to-indigo-400" />
                  </div>
                  <span className="text-[11px] font-semibold tracking-wider text-purple-600 dark:text-purple-300 uppercase">
                    {voice.isProcessing ? t('roundtable.processing') : t('roundtable.listening')}
                  </span>
                  {/* Mic button */}
                  <button
                    type="button"
                    aria-label={
                      voice.isRecording
                        ? t('roundtable.stopRecording')
                        : t('roundtable.startRecording')
                    }
                    className="relative group cursor-pointer bg-transparent border-none p-0"
                    onClick={voice.toggle}
                  >
                    <div className="relative w-12 h-12 rounded-full bg-gradient-to-br from-purple-600 to-indigo-700 shadow-[0_4px_20px_rgba(147,51,234,0.3)] flex items-center justify-center group-hover:scale-105 transition-transform duration-300 border border-white/20">
                      <Mic className="w-5 h-5 text-white" />
                    </div>
                    <div className="absolute inset-0 rounded-full border-2 border-purple-500 opacity-40 animate-[ping_2s_ease-in-out_infinite]" />
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* "Your turn" cue prompt — clickable, opens input panel */}
          <AnimatePresence>
            {isCueUser && !bubbleRole && !thinkingState && !isInputOpen && !isVoiceOpen && (
              <motion.div
                key="presentation-cue-user"
                initial={{ opacity: 0, scale: 0.92, y: 8 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.92, y: 8 }}
                transition={{ duration: 0.22, ease: [0.21, 1, 0.36, 1] }}
                className="pointer-events-auto"
              >
                <button
                  onClick={() => (asrEnabled ? voice.toggle() : composer.toggleInput())}
                  className="flex items-center gap-2 px-5 py-2.5 rounded-full bg-white/70 dark:bg-black/50 backdrop-blur-xl border border-amber-400/50 dark:border-amber-500/50 shadow-[0_0_16px_rgba(245,158,11,0.2),0_8px_32px_rgba(0,0,0,0.06)] dark:shadow-[0_0_16px_rgba(245,158,11,0.25),0_8px_32px_rgba(0,0,0,0.4)] text-amber-600 dark:text-amber-400 text-sm font-semibold tracking-wide hover:bg-gray-100/80 dark:hover:bg-black/60 hover:border-amber-500/70 dark:hover:border-amber-400/70 hover:shadow-[0_0_24px_rgba(245,158,11,0.25)] dark:hover:shadow-[0_0_24px_rgba(245,158,11,0.35)] transition-all active:scale-95 animate-pulse"
                >
                  {asrEnabled ? <Mic className="w-4 h-4" /> : <MessageSquare className="w-4 h-4" />}
                  {t('roundtable.yourTurn')}
                </button>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Director thinking indicator */}
          <AnimatePresence>
            {thinkingState?.stage === 'director' && !currentSpeech && !userMessage && (
              <motion.div
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.9 }}
                className="flex items-center gap-2 px-4 py-2 bg-white/70 dark:bg-black/50 backdrop-blur-xl rounded-full border border-gray-200/60 dark:border-white/10"
              >
                <div className="flex gap-1">
                  {[0, 0.2, 0.4].map((delay) => (
                    <motion.div
                      key={delay}
                      animate={{ opacity: [0.3, 1, 0.3] }}
                      transition={{ repeat: Infinity, duration: 1.2, delay }}
                      className="w-1.5 h-1.5 rounded-full bg-purple-400"
                    />
                  ))}
                </div>
                <span className="text-[10px] text-gray-500 dark:text-gray-400 font-medium">
                  {t('roundtable.thinking')}
                </span>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* ── Right-side stack: bubble + dock — flex column, no hardcoded px ── */}
        <div
          className="fixed bottom-5 z-[48] flex flex-col items-end gap-3 pointer-events-none transition-[right] duration-300"
          style={{ right: chatCollapsed ? 20 : 20 + (chatAreaWidth ?? 320) }}
        >
          {/* Right-side speech bubble (flows above dock via flex) */}
          <PresentationSpeechOverlay
            playbackView={enrichedPlaybackView}
            participants={initialParticipants}
            speakingAgentId={speakingAgentId ?? null}
            isTopicPending={!!isTopicPending}
            userAvatar={userAvatar}
            side="right"
            onBubbleClick={controls.primaryAction}
            audioIndicatorState={audioIndicatorState ?? 'idle'}
            buttonState={enrichedPlaybackView?.buttonState}
            isPaused={isDiscussionPaused || engineMode === 'paused'}
          />

          {/* Dock */}
          <AnimatePresence>
            {showPresentationDock && (
              <motion.div
                initial={{ opacity: 0, scale: 0.92 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.92 }}
                transition={{ duration: 0.2, ease: 'easeOut' }}
                className="pointer-events-auto"
              >
                <div
                  ref={presentationActionAnchorRef}
                  className="flex items-center gap-2.5 rounded-full bg-white/70 dark:bg-black/60 backdrop-blur-xl border border-gray-200/60 dark:border-white/10 shadow-[0_8px_32px_rgba(0,0,0,0.08)] dark:shadow-[0_8px_32px_rgba(0,0,0,0.4)] px-2.5 py-2"
                >
                  {/* Speaking / discussion-requesting agent avatar — shows when
                      a student agent is actively speaking OR a discussion request
                      is pending (so the user can see who's asking before joining) */}
                  <AnimatePresence>
                    {((activeRole === 'agent' && speakingStudent) ||
                      presentationDiscussionParticipant) && (
                      <motion.div
                        ref={presentationAgentAvatarRef}
                        key={`dock-agent-${(speakingStudent || presentationDiscussionParticipant)?.id}`}
                        initial={{ opacity: 0, scale: 0.8, width: 0 }}
                        animate={{ opacity: 1, scale: 1, width: 'auto' }}
                        exit={{ opacity: 0, scale: 0.8, width: 0 }}
                        transition={{ duration: 0.2, ease: 'easeOut' }}
                        className="shrink-0 overflow-hidden"
                      >
                        <div className="relative w-10 h-10 rounded-full flex items-center justify-center">
                          <div className="absolute inset-0 rounded-full border-2 border-blue-500 shadow-[0_0_6px_rgba(59,130,246,0.3)] transition-all duration-300" />
                          <div className="w-8 h-8 rounded-full bg-gray-200 dark:bg-gray-800 overflow-hidden relative z-10 text-lg">
                            <AvatarDisplay
                              src={
                                (speakingStudent || presentationDiscussionParticipant)?.avatar ||
                                '/avatars/user.png'
                              }
                              alt={
                                (speakingStudent || presentationDiscussionParticipant)?.name || ''
                              }
                            />
                          </div>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                  {isSendCooldown ? (
                    <div className="flex items-center justify-center w-8 h-8">
                      <div className="flex items-center gap-[3px]">
                        {[0, 1, 2].map((i) => (
                          <motion.div
                            key={i}
                            animate={{ y: [0, -3, 0], opacity: [0.35, 0.9, 0.35] }}
                            transition={{
                              repeat: Infinity,
                              duration: 0.9,
                              delay: i * 0.12,
                              ease: 'easeInOut',
                            }}
                            className="w-[3px] h-[3px] rounded-full bg-purple-400"
                          />
                        ))}
                      </div>
                    </div>
                  ) : (
                    <>
                      <button
                        aria-label={
                          asrEnabled
                            ? t('roundtable.voiceInput')
                            : t('roundtable.voiceInputDisabled')
                        }
                        onClick={(e) => {
                          e.stopPropagation();
                          if (asrEnabled) voice.toggle();
                        }}
                        disabled={!asrEnabled}
                        className={cn(
                          'w-8 h-8 rounded-full flex items-center justify-center transition-all active:scale-95',
                          !asrEnabled
                            ? 'text-gray-500 cursor-not-allowed'
                            : isVoiceOpen
                              ? 'bg-purple-600 text-white'
                              : 'text-gray-500 dark:text-gray-300 hover:text-gray-700 dark:hover:text-white hover:bg-gray-200/50 dark:hover:bg-white/10',
                        )}
                      >
                        {asrEnabled ? <Mic className="w-4 h-4" /> : <MicOff className="w-4 h-4" />}
                      </button>
                      <button
                        ref={textInputToggleRef}
                        aria-label={t('roundtable.textInput')}
                        onClick={(e) => {
                          e.stopPropagation();
                          composer.toggleInput();
                        }}
                        className={cn(
                          'w-8 h-8 rounded-full flex items-center justify-center transition-all active:scale-95',
                          isInputOpen
                            ? 'bg-purple-600 text-white'
                            : 'text-gray-500 dark:text-gray-300 hover:text-gray-700 dark:hover:text-white hover:bg-gray-200/50 dark:hover:bg-white/10',
                        )}
                      >
                        <MessageSquare className="w-4 h-4" />
                      </button>
                    </>
                  )}

                  <button
                    type="button"
                    aria-label={t('roundtable.you')}
                    className="relative group cursor-pointer shrink-0 bg-transparent border-none p-0"
                    onClick={(e) => {
                      e.stopPropagation();
                      composer.toggleInput();
                    }}
                  >
                    <div
                      className={cn(
                        'relative w-10 h-10 rounded-full transition-all duration-300 flex items-center justify-center',
                        activeRole === 'user' || isInputOpen || isCueUser
                          ? 'scale-105'
                          : 'opacity-70 group-hover:opacity-100 group-hover:scale-100',
                      )}
                    >
                      <div
                        className={cn(
                          'absolute inset-0 rounded-full border-2 transition-all duration-300',
                          isCueUser
                            ? 'border-amber-500 shadow-[0_0_10px_rgba(245,158,11,0.4)] animate-pulse'
                            : activeRole === 'user' || isInputOpen
                              ? 'border-purple-500 shadow-[0_0_6px_rgba(168,85,247,0.3)]'
                              : 'border-gray-300/40 dark:border-white/20 group-hover:border-purple-400/50',
                        )}
                      />
                      <div className="w-8 h-8 rounded-full bg-gray-200 dark:bg-gray-800 overflow-hidden relative z-10 text-lg">
                        <AvatarDisplay src={userAvatar} alt={t('roundtable.you')} />
                      </div>
                    </div>
                  </button>
                </div>

                <AnimatePresence>
                  {discussionRequest && (
                    <ProactiveCard
                      action={discussionRequest}
                      mode={engineMode === 'paused' ? 'paused' : 'playback'}
                      anchorRef={presentationAgentAvatarRef}
                      portalContainer={fullscreenContainerRef?.current}
                      align="left"
                      agentName={
                        presentationDiscussionParticipant?.name ||
                        presentationDiscussionAgentConfig?.name
                      }
                      agentAvatar={
                        presentationDiscussionParticipant?.avatar ||
                        presentationDiscussionAgentConfig?.avatar
                      }
                      agentColor={presentationDiscussionAgentConfig?.color}
                      onSkip={() => onDiscussionSkip?.()}
                      onListen={() => onDiscussionStart?.(discussionRequest)}
                      onTogglePause={() => onPlayPause?.()}
                    />
                  )}
                </AnimatePresence>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    );
  }

  // Outside fullscreen the interaction panel owns participants and the
  // composer (components/classroom/interaction); this component only serves
  // presentation mode until the presentation dock replaces it
  return null;
}
