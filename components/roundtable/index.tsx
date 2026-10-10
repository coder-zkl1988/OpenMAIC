'use client';

import { useState, useRef, useEffect, useId, useImperativeHandle, type Ref } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Mic,
  MicOff,
  Send,
  MessageSquare,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Quote,
  X,
  Hand,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { AudioIndicatorState } from './audio-indicator';
import { usePlaybackControls } from '@/components/canvas/use-playback-controls';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useSettingsStore } from '@/lib/store/settings';
import { ProactiveCard } from '@/components/chat/proactive-card';
import { PresentationSpeechOverlay } from '@/components/roundtable/presentation-speech-overlay';
import { AvatarDisplay } from '@/components/ui/avatar-display';
import { HoverCard, HoverCardTrigger, HoverCardContent } from '@/components/ui/hover-card';
import { useAgentRegistry } from '@/lib/orchestration/registry/store';
import { DEFAULT_TEACHER_AVATAR, DEFAULT_USER_AVATAR } from '@/components/roundtable/constants';
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
  readonly showEndFlash?: boolean;
  readonly endFlashSessionType?: 'qa' | 'discussion';
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

// This must stay in sync with the non-presentation textarea's max-h-[56px] class.
const NON_PRESENTATION_INPUT_MAX_HEIGHT_PX = 56;

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
  showEndFlash,
  endFlashSessionType = 'discussion',
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
  const nonPresentationInputRef = useRef<HTMLTextAreaElement>(null);
  const agentScrollRef = useRef<HTMLDivElement>(null);
  const teacherAvatarRef = useRef<HTMLDivElement>(null);
  const studentAvatarRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  // Separate participants by role
  const teacherParticipant = initialParticipants.find((p) => p.role === 'teacher');
  const studentParticipants = initialParticipants.filter(
    (p) => p.role !== 'teacher' && p.role !== 'user',
  );
  const userParticipant = initialParticipants.find((p) => p.role === 'user');

  const teacherAvatar = teacherParticipant?.avatar || DEFAULT_TEACHER_AVATAR;
  const teacherName = teacherParticipant?.name || t('roundtable.teacher');
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

  useEffect(() => {
    if (isPresenting) return;
    const textarea = nonPresentationInputRef.current;
    if (!textarea) return;

    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(
      textarea.scrollHeight,
      NON_PRESENTATION_INPUT_MAX_HEIGHT_PX,
    )}px`;
  }, [composer.draft, isInputOpen, isPresenting]);

  // End flash visible state (Issue 3)
  const [endFlashVisible, setEndFlashVisible] = useState(false);
  useEffect(() => {
    if (showEndFlash) {
      setEndFlashVisible(true);
      const timer = setTimeout(() => setEndFlashVisible(false), 1800);
      return () => clearTimeout(timer);
    } else {
      setEndFlashVisible(false);
    }
  }, [showEndFlash]);

  // The text-input toggle (either layout), where a delivered question hands a
  // keyboard user so they can follow up
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

  // Stable ref object for the current discussion agent's avatar
  const discussionAnchorRef = useRef<HTMLDivElement>(null);
  const presentationActionAnchorRef = useRef<HTMLDivElement>(null);
  const presentationAgentAvatarRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!discussionRequest) {
      discussionAnchorRef.current = null;
      return;
    }
    if (discussionRequest.agentId === teacherParticipant?.id) {
      discussionAnchorRef.current = teacherAvatarRef.current;
    } else {
      discussionAnchorRef.current =
        studentAvatarRefs.current.get(discussionRequest.agentId || '') || null;
    }
  }, [discussionRequest, teacherParticipant?.id]);

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

  // Keyboard shortcuts for roundtable interaction (#255)
  useClassroomShortcuts({
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

        {/* ── End flash notification ── */}
        <AnimatePresence>
          {endFlashVisible && (
            <motion.div
              initial={{ opacity: 0, y: 10, scale: 0.9 }}
              animate={{
                opacity: [0, 1, 1, 0],
                y: [10, 0, 0, 6],
                scale: [0.9, 1, 1, 0.95],
              }}
              transition={{
                duration: 1.8,
                times: [0, 0.15, 0.7, 1],
                ease: 'easeOut',
              }}
              className="fixed bottom-20 -translate-x-1/2 z-[50] bg-gray-100/80 dark:bg-gray-800/80 backdrop-blur-md text-gray-700 dark:text-white px-3.5 py-1.5 rounded-full text-xs font-medium pointer-events-none"
              style={{
                left: `calc((100vw - ${chatCollapsed === false ? (chatAreaWidth ?? 320) : 0}px) / 2)`,
              }}
            >
              <span className="w-1.5 h-1.5 rounded-full bg-gray-400 inline-block mr-1.5" />
              {endFlashSessionType === 'discussion'
                ? t('roundtable.discussionEnded')
                : t('roundtable.qaEnded')}
            </motion.div>
          )}
        </AnimatePresence>

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

  // Slim participants + composer strip under the stage. The control bar and
  // the caption strip (shell) own playback and the current line; this strip
  // moves into the interaction panel next.
  return (
    <div className="h-24 w-full flex relative z-10 border-t border-line bg-background/60 backdrop-blur-md">
      {queuedQuestionLiveRegion}
      {/* Left: Teacher identity */}
      <div className="w-[84px] shrink-0 flex items-center justify-center border-r border-line relative">
        <div
          ref={teacherAvatarRef}
          className="relative group cursor-pointer flex flex-col items-center justify-center"
        >
          <HoverCard openDelay={300} closeDelay={100}>
            <HoverCardTrigger asChild>
              <div className="flex flex-col items-center gap-1">
                <div
                  className={cn(
                    'relative w-11 h-11 rounded-full transition-all duration-500 flex items-center justify-center',
                    activeRole === 'teacher' ? 'scale-105' : 'opacity-90 scale-95',
                  )}
                >
                  <div
                    className={cn(
                      'absolute inset-0 rounded-full border-2 transition-all duration-500',
                      activeRole === 'teacher'
                        ? 'border-purple-500 dark:border-purple-400 shadow-[0_0_12px_rgba(168,85,247,0.4)]'
                        : 'border-gray-200 dark:border-gray-700 group-hover:border-purple-300 dark:group-hover:border-purple-600',
                    )}
                  />

                  <div className="w-9 h-9 rounded-full bg-white dark:bg-gray-800 overflow-hidden relative z-10 shadow-sm border border-gray-50 dark:border-gray-700">
                    <img
                      src={teacherAvatar}
                      alt={teacherName}
                      className="w-full h-full object-cover"
                    />
                  </div>

                  {activeRole === 'teacher' && (
                    <div className="absolute -right-0.5 top-0 w-3.5 h-3.5 bg-green-500 dark:bg-green-400 rounded-full border-2 border-white dark:border-gray-800 flex items-center justify-center z-20">
                      <div className="w-1 h-1 bg-white rounded-full animate-pulse" />
                    </div>
                  )}
                </div>

                <span
                  className={cn(
                    'max-w-[76px] truncate px-2 py-0.5 rounded-full text-[10px] font-bold tracking-wider uppercase border shadow-sm transition-all duration-300 bg-white/90 dark:bg-gray-800/90',
                    activeRole === 'teacher' && !speakingStudent
                      ? 'text-purple-600 dark:text-purple-400 border-purple-200 dark:border-purple-700'
                      : 'text-gray-400 dark:text-gray-500 border-gray-100 dark:border-gray-700 group-hover:text-purple-500 dark:group-hover:text-purple-400 group-hover:border-purple-200 dark:group-hover:border-purple-600',
                  )}
                >
                  {teacherName}
                </span>
              </div>
            </HoverCardTrigger>
            <HoverCardContent
              side="top"
              align="center"
              className="w-64 p-3 max-h-[300px] overflow-y-auto"
            >
              {(() => {
                const teacherConfig = getAgentConfig(teacherParticipant?.id || '');
                return (
                  <>
                    <div className="flex items-center gap-2">
                      <div className="w-8 h-8 rounded-full overflow-hidden shrink-0 bg-gray-100 dark:bg-gray-800">
                        <img
                          src={teacherAvatar}
                          alt={teacherName}
                          className="w-full h-full object-cover"
                        />
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">{teacherName}</p>
                        <span
                          className="inline-block text-[10px] leading-tight px-1.5 py-0.5 rounded-full text-white mt-0.5"
                          style={{
                            backgroundColor: teacherConfig?.color || '#8b5cf6',
                          }}
                        >
                          {t('settings.agentRoles.teacher')}
                        </span>
                      </div>
                    </div>
                    {teacherConfig?.persona && (
                      <p className="text-xs text-muted-foreground mt-2 leading-relaxed whitespace-pre-line">
                        {teacherConfig.persona}
                      </p>
                    )}
                  </>
                );
              })()}
            </HoverCardContent>
          </HoverCard>

          {/* ProactiveCard from teacher avatar */}
          <AnimatePresence>
            {discussionRequest && discussionRequest.agentId === teacherParticipant?.id && (
              <ProactiveCard
                action={discussionRequest}
                mode={engineMode === 'paused' ? 'paused' : 'playback'}
                anchorRef={teacherAvatarRef}
                align="left"
                agentName={teacherName}
                agentAvatar={teacherAvatar}
                agentColor={getAgentConfig(teacherParticipant?.id || '')?.color}
                onSkip={() => onDiscussionSkip?.()}
                onListen={() => onDiscussionStart?.(discussionRequest)}
                onTogglePause={() => onPlayPause?.()}
              />
            )}
          </AnimatePresence>
        </div>
      </div>

      {/* Center: composer stage */}
      <div className="flex-1 relative mx-3 my-2 min-w-0">
        {/* End flash banner (Issue 3) */}
        <AnimatePresence>
          {endFlashVisible && (
            <motion.div
              initial={{ opacity: 0, y: -10, scale: 0.9 }}
              animate={{
                opacity: [0, 1, 1, 0],
                y: [-10, 0, 0, -6],
                scale: [0.9, 1, 1, 0.95],
              }}
              transition={{
                duration: 1.8,
                times: [0, 0.15, 0.7, 1],
                ease: 'easeOut',
              }}
              className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-50 bg-gray-800/80 backdrop-blur-md text-white px-3.5 py-1.5 rounded-full text-xs font-medium pointer-events-none"
            >
              <span className="w-1.5 h-1.5 rounded-full bg-gray-400 inline-block mr-1.5" />
              {endFlashSessionType === 'discussion'
                ? t('roundtable.discussionEnded')
                : t('roundtable.qaEnded')}
            </motion.div>
          )}
        </AnimatePresence>

        <div
          data-testid="roundtable-non-presentation-card"
          onClick={() => {
            if (isInputOpen || isVoiceOpen) composer.dismiss();
          }}
          className="relative w-full h-full rounded-2xl bg-subtle/60 border border-line overflow-hidden cursor-default"
        >
          {/* One row: the element reference / raised hand on the left, the text
              input on the right. The pills keep their content width up to 45%
              and the input takes the rest, so the two never overlap however
              narrow the card gets (both panels open at 1280px). */}
          <div className="pointer-events-none absolute inset-0 z-30 flex items-center gap-2 px-3">
            {(elementReferencePill || queuedQuestionIndicator) && (
              <div className="flex min-w-0 max-w-[45%] shrink flex-col justify-center gap-1.5">
                {referencePill}
                {queuedQuestionIndicator}
              </div>
            )}
            {/* Text input box */}
            <AnimatePresence>
              {isInputOpen && (
                <motion.div
                  key="input-stage"
                  data-testid="roundtable-non-presentation-input-stage"
                  initial={{
                    opacity: 0,
                    scale: 0.95,
                    y: 10,
                    filter: 'blur(4px)',
                  }}
                  animate={{ opacity: 1, scale: 1, y: 0, filter: 'blur(0px)' }}
                  exit={{ opacity: 0, scale: 0.95, y: 10, filter: 'blur(4px)' }}
                  onClick={(e) => e.stopPropagation()}
                  className="flex min-w-0 flex-1 items-center justify-end self-stretch"
                >
                  <div
                    data-testid="roundtable-non-presentation-input-panel"
                    className="pointer-events-auto relative w-fit max-w-[min(520px,52vw,100%)] min-w-[min(200px,100%)] sm:min-w-[min(300px,100%)] bg-background/95 backdrop-blur-md p-1.5 rounded-2xl rounded-br-none shadow-xl border border-accent-line flex items-end gap-2"
                  >
                    <div className="pl-3 flex-1 py-1 min-w-0">
                      <textarea
                        ref={nonPresentationInputRef}
                        {...composer.textareaProps}
                        placeholder={t('roundtable.inputPlaceholder')}
                        autoFocus
                        rows={1}
                        className="w-full resize-none overflow-y-auto bg-transparent border-none focus:ring-0 focus:outline-none outline-none shadow-none ring-0 text-fg text-sm placeholder:text-fg-tertiary min-h-[32px] max-h-[56px]"
                      />
                    </div>
                    <button
                      onClick={composer.send}
                      disabled={isSendCooldown}
                      className={cn(
                        'p-2.5 rounded-xl transition shadow-md shrink-0',
                        isSendCooldown
                          ? 'bg-line-strong text-fg-tertiary cursor-not-allowed'
                          : 'bg-primary text-primary-foreground hover:bg-primary/90',
                      )}
                    >
                      {isSendCooldown ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <Send className="w-4 h-4" />
                      )}
                    </button>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          <AnimatePresence>
            {/* Audio recording status */}
            {isVoiceOpen && (
              <motion.div
                key="voice-stage"
                initial={{
                  opacity: 0,
                  scale: 0.9,
                  x: 20,
                  filter: 'blur(4px)',
                }}
                animate={{ opacity: 1, scale: 1, x: 0, filter: 'blur(0px)' }}
                exit={{ opacity: 0, scale: 0.9, x: 20, filter: 'blur(4px)' }}
                onClick={(e) => e.stopPropagation()}
                className="absolute right-3 top-1/2 -translate-y-1/2 z-30 flex items-center gap-3 pointer-events-none"
              >
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-bold tracking-widest text-accent-text uppercase">
                    {voice.isProcessing ? t('roundtable.processing') : t('roundtable.listening')}
                  </span>
                  <div className="flex items-center gap-0.5 h-8 px-2 py-1.5 bg-background/80 backdrop-blur-md rounded-xl border border-accent-line">
                    <VoiceWaveformBars barClassName="bg-primary" />
                  </div>
                </div>

                <button
                  type="button"
                  aria-label={
                    voice.isRecording
                      ? t('roundtable.stopRecording')
                      : t('roundtable.startRecording')
                  }
                  className="pointer-events-auto relative group cursor-pointer"
                  onClick={voice.toggle}
                >
                  <div className="relative w-12 h-12 rounded-full bg-primary shadow-[0_4px_20px_color-mix(in_srgb,var(--primary)_30%,transparent)] flex items-center justify-center z-20 group-hover:scale-105 transition-transform duration-300">
                    <Mic className="w-5 h-5 text-primary-foreground" />
                  </div>
                  <div className="absolute inset-0 rounded-full border-2 border-primary opacity-40 animate-[ping_2s_ease-in-out_infinite] z-10" />
                </button>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Cue user: waiting for the learner to speak */}
          <AnimatePresence>
            {isCueUser && !bubbleRole && !thinkingState && !isInputOpen && !isVoiceOpen && (
              <motion.div
                initial={{ opacity: 0, scale: 0.85 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.85 }}
                transition={{ duration: 0.35, ease: [0.21, 1, 0.36, 1] }}
                className="absolute inset-0 z-20 flex items-center justify-center gap-3"
              >
                {/* Action circle — voice (ASR on) or text input (ASR off) */}
                <div className="relative flex items-center justify-center">
                  <motion.div
                    animate={{ scale: [1, 1.8], opacity: [0.25, 0] }}
                    transition={{
                      repeat: Infinity,
                      duration: 2.2,
                      ease: 'easeOut',
                    }}
                    className="absolute w-10 h-10 rounded-full border border-amber-400/50 dark:border-amber-500/35"
                  />
                  <motion.button
                    onClick={(e) => {
                      e.stopPropagation();
                      if (asrEnabled) voice.toggle();
                      else composer.toggleInput();
                    }}
                    animate={{ scale: [1, 1.05, 1] }}
                    transition={{
                      repeat: Infinity,
                      duration: 2,
                      ease: 'easeInOut',
                    }}
                    className={cn(
                      'relative w-10 h-10 rounded-full flex items-center justify-center shadow-lg cursor-pointer hover:shadow-xl active:scale-95 z-10 bg-gradient-to-br',
                      asrEnabled
                        ? 'from-amber-400 to-orange-500 dark:from-amber-500 dark:to-orange-600 shadow-amber-400/30 dark:shadow-amber-600/20'
                        : 'from-purple-400 to-indigo-500 dark:from-purple-500 dark:to-indigo-600 shadow-purple-400/30 dark:shadow-purple-600/20',
                    )}
                  >
                    {asrEnabled ? (
                      <Mic className="w-4 h-4 text-white drop-shadow-sm" />
                    ) : (
                      <MessageSquare className="w-4 h-4 text-white drop-shadow-sm" />
                    )}
                  </motion.button>
                </div>
                <motion.span
                  animate={{ opacity: [0.6, 1, 0.6] }}
                  transition={{
                    repeat: Infinity,
                    duration: 2.5,
                    ease: 'easeInOut',
                  }}
                  className="text-xs font-semibold text-warning"
                >
                  {t('roundtable.yourTurn')}
                </motion.span>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      {/* Right: Participants — agent strip, input toggles, the learner */}
      <div className="shrink-0 flex items-center gap-2 pl-2 pr-3 border-l border-line">
        {/* Companion agent avatars — scrollable on overflow, arrows on hover */}
        <div className="relative group/scroll max-w-[132px]">
          <button
            onClick={() => {
              agentScrollRef.current?.scrollBy({
                left: -80,
                behavior: 'smooth',
              });
            }}
            className="absolute left-0 top-0 bottom-0 w-5 z-10 flex items-center justify-center bg-gradient-to-r from-background/90 to-transparent opacity-0 group-hover/scroll:opacity-100 transition-opacity cursor-pointer"
          >
            <ChevronLeft className="w-3.5 h-3.5 text-icon-muted" />
          </button>

          <div
            ref={agentScrollRef}
            className="overflow-x-auto overflow-y-hidden px-1 scrollbar-hide"
            onWheel={(e) => {
              if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
                e.currentTarget.scrollLeft += e.deltaY;
                e.preventDefault();
              }
            }}
          >
            <div className="flex gap-1 w-max py-1">
              {studentParticipants.map((student) => {
                const isSpeaking = speakingAgentId === student.id;
                const isThinkingAgent =
                  thinkingState?.stage === 'agent_loading' && thinkingState.agentId === student.id;
                const agentConfig = getAgentConfig(student.id);
                const roleLabelKey = agentConfig?.role as
                  | 'teacher'
                  | 'assistant'
                  | 'student'
                  | undefined;
                const roleLabel = roleLabelKey ? t(`settings.agentRoles.${roleLabelKey}`) : '';
                const i18nDescription = t(`settings.agentDescriptions.${student.id}`);
                const description =
                  i18nDescription !== `settings.agentDescriptions.${student.id}`
                    ? i18nDescription
                    : agentConfig?.persona || '';
                const hasDescription = !!description;
                const isDiscussionAgent =
                  !!discussionRequest && discussionRequest.agentId === student.id;
                return (
                  <div
                    key={student.id}
                    data-agent-id={student.id}
                    ref={(el) => {
                      if (el) studentAvatarRefs.current.set(student.id, el);
                      else studentAvatarRefs.current.delete(student.id);
                    }}
                    className="relative group/student shrink-0"
                  >
                    {/* Breathing glow for discussion agent */}
                    {isDiscussionAgent && (
                      <motion.div
                        animate={{
                          scale: [1, 1.2, 1],
                          opacity: [0.7, 0, 0.7],
                        }}
                        transition={{
                          repeat: Infinity,
                          duration: 2,
                          ease: 'easeInOut',
                        }}
                        className="absolute inset-0 rounded-full pointer-events-none"
                        style={{
                          border: `2px solid ${agentConfig?.color || '#d97706'}`,
                        }}
                      />
                    )}
                    <HoverCard openDelay={300} closeDelay={100}>
                      <HoverCardTrigger asChild>
                        <div
                          className={cn(
                            'relative w-9 h-9 rounded-full transition-all duration-300 cursor-pointer',
                            isSpeaking
                              ? 'opacity-100 grayscale-0 scale-110'
                              : 'opacity-50 grayscale-[0.2] scale-95 hover:opacity-100 hover:grayscale-0 hover:scale-100',
                          )}
                        >
                          <div
                            className={cn(
                              'absolute inset-0 rounded-full border-2 transition-all duration-300',
                              isSpeaking
                                ? 'border-purple-500 dark:border-purple-400 shadow-[0_0_8px_rgba(168,85,247,0.4)]'
                                : 'border-white dark:border-gray-700',
                            )}
                          />
                          <div className="absolute inset-0.5 rounded-full bg-gray-100 dark:bg-gray-800 overflow-hidden">
                            <img
                              src={student.avatar}
                              alt={student.name}
                              className="w-full h-full"
                            />
                          </div>
                          {/* Speaking indicator */}
                          {isSpeaking && (
                            <div className="absolute -right-0.5 -top-0.5 w-3 h-3 bg-green-500 rounded-full border border-white dark:border-gray-800 z-20 flex items-center justify-center">
                              <div className="w-1 h-1 bg-white rounded-full animate-pulse" />
                            </div>
                          )}
                          {/* Loading indicator (Issue 5) */}
                          {isThinkingAgent && (
                            <div className="absolute inset-0 rounded-full border-2 border-purple-400 border-t-transparent animate-spin z-20" />
                          )}
                        </div>
                      </HoverCardTrigger>
                      <HoverCardContent
                        side="top"
                        align="center"
                        className="w-64 p-3 max-h-[300px] overflow-y-auto"
                      >
                        <div className="flex items-center gap-2">
                          <div className="w-8 h-8 rounded-full overflow-hidden shrink-0 bg-gray-100 dark:bg-gray-800">
                            <img
                              src={student.avatar}
                              alt={student.name}
                              className="w-full h-full"
                            />
                          </div>
                          <div className="min-w-0">
                            <p className="text-sm font-medium truncate">{student.name}</p>
                            {roleLabel && roleLabel !== `settings.agentRoles.${roleLabelKey}` && (
                              <span
                                className="inline-block text-[10px] leading-tight px-1.5 py-0.5 rounded-full text-white mt-0.5"
                                style={{
                                  backgroundColor: agentConfig?.color || '#6b7280',
                                }}
                              >
                                {roleLabel}
                              </span>
                            )}
                          </div>
                        </div>
                        {hasDescription && (
                          <p className="text-xs text-muted-foreground mt-2 leading-relaxed whitespace-pre-line">
                            {description}
                          </p>
                        )}
                      </HoverCardContent>
                    </HoverCard>
                  </div>
                );
              })}
            </div>
          </div>

          <button
            onClick={() => {
              agentScrollRef.current?.scrollBy({
                left: 80,
                behavior: 'smooth',
              });
            }}
            className="absolute right-0 top-0 bottom-0 w-5 z-10 flex items-center justify-center bg-gradient-to-l from-background/90 to-transparent opacity-0 group-hover/scroll:opacity-100 transition-opacity cursor-pointer"
          >
            <ChevronRight className="w-3.5 h-3.5 text-icon-muted" />
          </button>

          {/* ProactiveCard for student/non-teacher agents — rendered via portal */}
          <AnimatePresence>
            {discussionRequest &&
              discussionRequest.agentId !== teacherParticipant?.id &&
              (() => {
                const matchedStudent = studentParticipants.find(
                  (s) => s.id === discussionRequest.agentId,
                );
                const agentConfig = getAgentConfig(discussionRequest.agentId || '');
                return (
                  <ProactiveCard
                    action={discussionRequest}
                    mode={engineMode === 'paused' ? 'paused' : 'playback'}
                    anchorRef={discussionAnchorRef}
                    align="left"
                    agentName={matchedStudent?.name || agentConfig?.name}
                    agentAvatar={matchedStudent?.avatar || agentConfig?.avatar}
                    agentColor={agentConfig?.color}
                    onSkip={() => onDiscussionSkip?.()}
                    onListen={() => onDiscussionStart?.(discussionRequest)}
                    onTogglePause={() => onPlayPause?.()}
                  />
                );
              })()}
          </AnimatePresence>
        </div>

        {studentParticipants.length > 0 && (
          <div aria-hidden="true" className="h-10 w-px shrink-0 bg-line" />
        )}

        {/* Voice / text toggles */}
        <div className="flex flex-col gap-1.5 shrink-0">
          {isSendCooldown ? (
            /* Unified cooldown indicator — replaces both buttons with a single dot wave */
            <div className="flex items-center justify-center w-8 h-8">
              <div className="flex items-center gap-[3px]">
                {[0, 1, 2].map((i) => (
                  <motion.div
                    key={i}
                    animate={{
                      y: [0, -3, 0],
                      opacity: [0.35, 0.9, 0.35],
                    }}
                    transition={{
                      repeat: Infinity,
                      duration: 0.9,
                      delay: i * 0.12,
                      ease: 'easeInOut',
                    }}
                    className="w-[4px] h-[4px] rounded-full bg-purple-400 dark:bg-purple-400"
                  />
                ))}
              </div>
            </div>
          ) : (
            <>
              <button
                aria-label={
                  asrEnabled ? t('roundtable.voiceInput') : t('roundtable.voiceInputDisabled')
                }
                onClick={(e) => {
                  e.stopPropagation();
                  if (asrEnabled) voice.toggle();
                }}
                disabled={!asrEnabled}
                className={cn(
                  'w-8 h-8 rounded-full border flex items-center justify-center transition-all active:scale-95 shadow-sm',
                  !asrEnabled
                    ? 'bg-gray-100 dark:bg-gray-800/50 text-gray-300 dark:text-gray-600 border-gray-200 dark:border-gray-700 cursor-not-allowed'
                    : isVoiceOpen
                      ? 'bg-purple-600 dark:bg-purple-500 border-purple-600 dark:border-purple-500 text-white shadow-purple-200 dark:shadow-purple-800'
                      : 'bg-white dark:bg-gray-800 border-gray-200 dark:border-gray-700 text-gray-400 dark:text-gray-500 hover:bg-purple-50 dark:hover:bg-purple-900/20 hover:text-purple-600 dark:hover:text-purple-400 hover:border-purple-200 dark:hover:border-purple-700',
                )}
              >
                {asrEnabled ? <Mic className="w-3.5 h-3.5" /> : <MicOff className="w-3.5 h-3.5" />}
              </button>
              <button
                ref={textInputToggleRef}
                aria-label={t('roundtable.textInput')}
                onClick={(e) => {
                  e.stopPropagation();
                  composer.toggleInput();
                }}
                className={cn(
                  'w-8 h-8 rounded-full border flex items-center justify-center transition-all active:scale-95 shadow-sm',
                  isInputOpen
                    ? 'bg-purple-600 dark:bg-purple-500 border-purple-600 dark:border-purple-500 text-white shadow-purple-200 dark:shadow-purple-800'
                    : 'bg-white dark:bg-gray-800 border-gray-200 dark:border-gray-700 text-gray-400 dark:text-gray-500 hover:bg-purple-50 dark:hover:bg-purple-900/20 hover:text-purple-600 dark:hover:text-purple-400 hover:border-purple-200 dark:hover:border-purple-700',
                )}
              >
                <MessageSquare className="w-3.5 h-3.5" />
              </button>
            </>
          )}
        </div>

        {/* User avatar (clickable to open input) */}
        <div
          className="relative group cursor-pointer shrink-0"
          onClick={(e) => {
            e.stopPropagation();
            composer.toggleInput();
          }}
        >
          <div
            className={cn(
              'relative w-12 h-12 rounded-full transition-all duration-300 flex items-center justify-center',
              activeRole === 'user' || isInputOpen || isCueUser
                ? 'scale-105'
                : 'opacity-50 grayscale-[0.2] scale-95 group-hover:opacity-100 group-hover:grayscale-0 group-hover:scale-100',
            )}
          >
            <div
              className={cn(
                'absolute inset-0 rounded-full border-2 transition-all duration-300',
                isCueUser
                  ? 'border-amber-500 dark:border-amber-400 shadow-[0_0_12px_rgba(245,158,11,0.4)] animate-pulse'
                  : activeRole === 'user' || isInputOpen
                    ? 'border-purple-600 dark:border-purple-400 shadow-[0_0_8px_rgba(168,85,247,0.3)]'
                    : 'border-white dark:border-gray-700 group-hover:border-purple-200 dark:group-hover:border-purple-600',
              )}
            />
            <div className="w-10 h-10 rounded-full bg-gray-50 dark:bg-gray-800 overflow-hidden relative z-10 shadow-sm border border-gray-50 dark:border-gray-700 text-xl">
              <AvatarDisplay src={userAvatar} alt={t('roundtable.you')} />
            </div>
            <div className="absolute -top-0.5 -right-0.5 w-4 h-4 bg-white dark:bg-gray-800 rounded-full flex items-center justify-center shadow-md border border-gray-100 dark:border-gray-700 z-20">
              <div
                className={cn(
                  'w-1.5 h-1.5 rounded-full',
                  isInputOpen || isCueUser
                    ? 'bg-purple-500 animate-pulse'
                    : 'bg-gray-300 dark:bg-gray-600',
                )}
              />
            </div>
          </div>
          {/* Cue user hint (Issue 7) */}
          <AnimatePresence>
            {isCueUser && (
              <motion.div
                initial={{ opacity: 0, y: 4, scale: 0.9 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 4, scale: 0.9 }}
                className="absolute -bottom-2 left-1/2 -translate-x-1/2 whitespace-nowrap px-2 py-0.5 bg-amber-500 text-white text-[9px] font-bold rounded-full shadow-sm z-30"
              >
                {t('roundtable.yourTurn')}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
