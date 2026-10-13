'use client';

import { useModelCapabilities } from '@/lib/model-settings/use-model-settings';
import { toast } from 'sonner';
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { useStageStore } from '@/lib/store';
import { PENDING_SCENE_ID } from '@/lib/store/stage';
import { useCanvasStore } from '@/lib/store/canvas';
import { useSettingsStore } from '@/lib/store/settings';
import { useI18n } from '@/lib/hooks/use-i18n';
import {
  isStackedClassroomLayout,
  isTouchClassroomLayout,
  useClassroomLayout,
} from '@/lib/hooks/use-classroom-layout';
import { useVisualViewportInset } from '@/lib/hooks/use-visual-viewport-inset';
import { SceneSidebar } from '@/components/stage/scene-sidebar';
import { Header } from '@/components/header';
import { CanvasArea } from '@/components/canvas/canvas-area';
import { ControlBar } from '@/components/classroom/control-bar';
import { CaptionStrip } from '@/components/classroom/caption-strip';
import {
  PresentationDock,
  type PresentationDockHandle,
} from '@/components/classroom/presentation-dock';
import { Composer, type ComposerHandle } from '@/components/classroom/interaction/composer';
import { ComposerSlot, useComposerHost } from '@/components/classroom/interaction/composer-slot';
import { Participants } from '@/components/classroom/interaction/participants';
import { ClassmateAskContext } from '@/components/classroom/interaction/classmate-card';
import { describeElementReferenceChip } from '@/components/classroom/interaction/element-reference-chip';
import {
  isSpaceActivatedTarget,
  useClassroomShortcuts,
} from '@/components/classroom/interaction/use-classroom-shortcuts';
import type { MessageSendResult } from '@/components/classroom/interaction/use-composer-controller';
import type { QueuedQuestionState } from '@/components/classroom/interaction/use-queued-question-effects';
import { ProactiveCard } from '@/components/chat/proactive-card';
import {
  AssistantAsideStreamStatus,
  HandRaiseStreamStatus,
  resolveCueSpeaker,
} from '@/components/chat/conversation-stream';
import { DEFAULT_TEACHER_AVATAR } from '@/lib/constants/avatar-fallbacks';
import { AvatarDisplay } from '@/components/ui/avatar-display';
import { useASRAvailable } from '@/lib/hooks/use-asr-available';
import { usePlaybackControls } from '@/components/canvas/use-playback-controls';
import {
  PlaybackEngine,
  computePlaybackView,
  shouldAutoResumeLecture,
  willResumeAfterSoftClose,
} from '@/lib/playback';
import type {
  EngineMode,
  TriggerEvent,
  Effect,
  HandCall,
  HandState,
  DiscussionOutcome,
  PlaybackEngineCallbacks,
  PlaybackEngineOptions,
} from '@/lib/playback';
import { MOMENT_ADVANCE_DELAY_MS, shouldAdvanceAfterMoment } from '@/lib/playback/auto-resume';
import { DISCUSSION_TRIGGER_DELAY_MS } from '@/lib/choreography';
import {
  MOMENT_ANNOUNCE_LEAD_MS,
  momentCountdownHoldMs,
  useMomentAnnouncement,
} from '@/components/chat/use-moment-announcement';
import type { LectureNoteMoment } from '@/lib/chat/lecture-notes';
import {
  canJumpWithinReconstructablePrefix,
  isUnsafePlaybackNavigationAction,
} from '@/lib/playback/action-navigation';
import {
  getActionResumeRestoreCursor,
  clearActionResumePosition,
  createActionResumePosition,
  getActionResumeStorageKey,
  isActionBoundaryResumePositionAt,
  readActionResumeState,
  saveActionResumePosition,
} from '@/lib/playback/action-resume';
import {
  clearRaisedHandDraft,
  getSessionStorage,
  saveRaisedHandDraft,
  takeRaisedHandDraft,
} from '@/lib/playback/raised-hand-draft';
import { loadCursor, saveCursor, type PlaybackCursor } from '@/lib/playback/cursor';
import {
  pickAssistantAgent,
  resolveAsideAgent,
  shouldAssistantAnswer,
} from '@/lib/playback/assistant-aside';
import { ActionEngine } from '@/lib/action/engine';
import { createAudioPlayer } from '@/lib/utils/audio-player';
import { useDiscussionTTS } from '@/lib/hooks/use-discussion-tts';
import { useWidgetIframeStore } from '@/lib/store/widget-iframe';
import type { AudioIndicatorState } from '@/components/roundtable/audio-indicator';
import type { Action, DiscussionAction, SpeechAction } from '@/lib/types/action';
import { cn } from '@/lib/utils';
import { ChatArea, type ChatAreaRef } from '@/components/chat/chat-area';
import type {
  ChatMessageSendOptions,
  SessionCleanupPayload,
} from '@/components/chat/use-chat-sessions';
import { agentsToParticipants, useAgentRegistry } from '@/lib/orchestration/registry/store';
import { pickClassroomTeacher } from '@/lib/orchestration/registry/agent-selection';
import type { AgentConfig } from '@/lib/orchestration/registry/types';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogFooter,
  AlertDialogAction,
  AlertDialogCancel,
} from '@/components/ui/alert-dialog';
import { AlertTriangle, ChevronLeft, ChevronRight } from 'lucide-react';
import { VisuallyHidden } from 'radix-ui';
import type { PPTElement } from '@openmaic/dsl';
import {
  getDisplayedWhiteboard,
  isWhiteboardReferenceAvailable,
} from '@/lib/whiteboard/element-reference';
import type {
  DiscussionMomentKind,
  ElementReference,
  LearnerStance,
  LectureProgress,
} from '@/lib/types/chat';
import { classifyLectureMoment, type MomentRosterMember } from '@/lib/chat/moment-kind';
import {
  mentionRoster,
  resolveAddressedAgentIds,
  type MentionCandidate,
} from '@/lib/chat/agent-mention';
import {
  QuizReviewContext,
  buildQuizReviewPrompt,
  buildQuizReviewTopic,
  type QuizReviewedEvent,
} from '@/lib/quiz/review-moment';
import type {
  PlaybackInteractiveComponentPick,
  PlaybackInteractivePickerState,
} from '@/components/scene-renderers/InteractiveIframeHost';
import { isCoursewareReferenceEnabled, isPiChatEnabled } from '@/lib/config/feature-flags';
import { getSlideElementPresentation } from '@/components/canvas/slide-element-pick-overlay';
import { shouldClearDraftElementReference } from '@/components/chat/element-reference-receipt';

type DraftElementReference = {
  reference: ElementReference;
  selectionVersion: number;
  sceneOrder?: number;
  elementType: PPTElement['type'] | 'interactive';
  displaySummary: string;
};

type ElementReferenceSendSnapshot = Pick<DraftElementReference, 'reference' | 'selectionVersion'>;

/**
 * The line on screen when playback rests at an action: the speech there, or
 * the last one before it (a raised hand answered before a non-speech action).
 */
function getSpeechTextAtOrBefore(
  actions: readonly Action[] = [],
  actionIndex: number,
): string | null {
  for (let i = Math.min(actionIndex, actions.length - 1); i >= 0; i--) {
    const action = actions[i];
    if (action.type === 'speech') return action.text;
  }
  return null;
}

/**
 * The classroom's teacher among the selected agents (the lecture's narrator,
 * as the participants block shows them), read when needed: the engine's
 * callbacks outlive a selection change within the scene.
 */
function currentClassroomTeacherId(): string | undefined {
  const registry = useAgentRegistry.getState();
  return pickClassroomTeacher(useSettingsStore.getState().selectedAgentIds ?? [], (id) =>
    registry.getAgent(id),
  )?.id;
}

/**
 * The kind of a lecture moment as the classroom's roster reads it, at call
 * time (I10): the teacher's line naming no classmate is a question to the
 * whole class ('ask-learner'); anything else is a classmate's moment.
 */
function currentLectureMomentKind(
  openerId: string | undefined,
  topic: string,
  t: (key: string) => string,
): 'lecture' | 'ask-learner' {
  const registry = useAgentRegistry.getState();
  const roster: MomentRosterMember[] = (useSettingsStore.getState().selectedAgentIds ?? []).flatMap(
    (id) => {
      const agent = registry.getAgent(id);
      if (!agent) return [];
      // A built-in agent goes by its localized name in the lesson's lines too
      const key = `settings.agentNames.${id}`;
      const localized = t(key);
      return [
        { id, role: agent.role, names: [agent.name, localized !== key ? localized : undefined] },
      ];
    },
  );
  return classifyLectureMoment({
    openerId: openerId ?? currentClassroomTeacherId(),
    topic,
    roster,
  });
}

/** A quiz review waiting on its card (I11): no opener, the director picks one */
interface QuizReviewOffer {
  id: string;
  sceneId: string;
  /** The card's words: the missed questions, never the answers */
  topic: string;
  /** Director-only: which questions went wrong, which were AI-graded */
  prompt: string;
}

/** The interaction panel's fixed width below desktop (TabletLandscape.dc.html) */
const TOUCH_PANEL_WIDTH = 320;

/** Auto-play's pause between a finished page and the next one (onComplete) */
const LECTURE_COMPLETE_ADVANCE_MS = 1500;

/**
 * Imperative handle exposed via `ref` so the parent (`Stage`) can tear
 * down playback state synchronously before flipping mode to `'edit'`.
 * Unmount cleanup would run anyway, but the toggle needs to `await`
 * `endActiveSession()` (which aborts SSE) before we trust the engine /
 * chat to be quiescent — fire-and-forget on unmount loses that guarantee.
 */
export interface PlaybackChromeRootHandle {
  /** Ends any active SSE session, stops the engine, cleans up TTS audio. */
  teardown: () => Promise<void>;
  /** Receives one identity-only pick from the sibling Interactive iframe host. */
  acceptInteractivePick: (pick: PlaybackInteractiveComponentPick) => boolean;
  /** Mirrors iframe Escape into the playback-owned picker state. */
  cancelElementPick: () => void;
}

interface PlaybackChromeRootProps {
  readonly onRetryOutline?: (outlineId: string) => Promise<void>;
  /** Whether the Pro Switch in Header should be enabled. */
  readonly canEnterProMode?: boolean;
  /** Pro Switch click handler — parent coordinates teardown + mode flip. */
  readonly onEnterProMode?: () => void;
  readonly proModeActive?: boolean;
  readonly headerBackControl?: ReactNode;
  readonly hideHeaderBackControl?: boolean;
  readonly hideHeader?: boolean;
  readonly hideHeaderGlobalControls?: boolean;
  readonly hideHeaderCourseActions?: boolean;
  readonly onInteractivePickerChange?: (state: PlaybackInteractivePickerState | null) => void;
}

/**
 * PlaybackChromeRoot — owns the entire playback/autonomous chrome and
 * its state. Mounted whenever `mode !== 'edit'`. The Pro Switch in
 * `Header` calls `onEnterProMode`; the parent `Stage` is responsible
 * for calling `ref.teardown()` before unmounting this root so SSE and
 * the engine wind down cleanly.
 */
export const PlaybackChromeRoot = forwardRef<PlaybackChromeRootHandle, PlaybackChromeRootProps>(
  function PlaybackChromeRoot(
    {
      onRetryOutline,
      canEnterProMode,
      onEnterProMode,
      proModeActive,
      headerBackControl,
      hideHeaderBackControl,
      hideHeader,
      hideHeaderGlobalControls,
      hideHeaderCourseActions,
      onInteractivePickerChange,
    },
    ref,
  ) {
    const { t } = useI18n();
    const {
      mode,
      stage,
      getCurrentScene,
      scenes,
      currentSceneId,
      setCurrentSceneId,
      generatingOutlines,
      outlines,
    } = useStageStore();
    const failedOutlines = useStageStore.use.failedOutlines();
    const generationComplete = useStageStore.use.generationComplete();
    const generationInterrupted = useStageStore.use.generationInterrupted();

    const currentScene = getCurrentScene();
    // The classroom a raised hand's unsent draft is kept under
    const draftStageId = stage?.id ?? currentScene?.stageId;
    const piChatEnabled = isPiChatEnabled();
    const coursewareReferenceEnabled = isCoursewareReferenceEnabled();
    const [elementPickActive, setElementPickActiveState] = useState(false);
    const elementPickActiveRef = useRef(false);
    const setElementPickActive = useCallback((next: boolean | ((active: boolean) => boolean)) => {
      const resolved = typeof next === 'function' ? next(elementPickActiveRef.current) : next;
      elementPickActiveRef.current = resolved;
      setElementPickActiveState(resolved);
    }, []);
    const [draftElementReference, setDraftElementReferenceState] =
      useState<DraftElementReference | null>(null);
    const draftElementReferenceRef = useRef<DraftElementReference | null>(null);
    const elementReferenceSceneIdRef = useRef(currentSceneId);
    const selectionVersionRef = useRef(0);
    const pendingInterruptElementReferenceRef = useRef<ElementReferenceSendSnapshot | undefined>(
      undefined,
    );
    // Raised hand: a question sent mid-line waits in the engine until the
    // current action finishes; the owner keeps what is sent with it.
    const queuedQuestionRef = useRef<{
      id: number;
      text: string;
      elementReference?: ElementReferenceSendSnapshot;
    } | null>(null);
    const queuedQuestionIdRef = useRef(0);
    const [queuedQuestion, setQueuedQuestion] = useState<QueuedQuestionState | null>(null);
    // A bare raised hand (no question): mirrors engine getHandState, and what
    // it waits for, worded once when it went up
    const [handState, setHandState] = useState<HandState | null>(null);
    const [handWaitsFor, setHandWaitsFor] = useState<'sentence' | 'step'>('sentence');
    // The discussion a called hand jumped ahead of (offered again afterwards)
    const [deferredDiscussion, setDeferredDiscussion] = useState<TriggerEvent | null>(null);
    // Shows the learner where to speak once a hand is called (set each render)
    const handCalledUiRef = useRef<() => void>(() => {});
    // Set while voice calls a raised hand: the recording owns focus
    const suppressHandCallFocusRef = useRef(false);
    // The teaching assistant's aside: while the lecture plays the teacher
    // keeps lecturing and the assistant answers in the 互动 panel, text only.
    // Tracked apart from the lecture-facing live state (chatSessionType,
    // isCueUser, thinkingState, speakingAgentId), which keeps driving the
    // caption, play / pause, the stop pill and the shortcuts for the lecture.
    const [asideSessionOpen, setAsideSessionOpenState] = useState(false);
    const asideSessionOpenRef = useRef(false);
    const [asideStreaming, setAsideStreamingState] = useState(false);
    const asideStreamingRef = useRef(false);
    // Who answers in the aside's current turn, once its answer has started
    // (kept until the turn settles, so 助教正在回答… never flashes back)
    const [asideSpeakingAgentId, setAsideSpeakingAgentId] = useState<string | null>(null);
    const [asideThinking, setAsideThinking] = useState<{
      stage: string;
      agentId?: string;
    } | null>(null);
    // A bare hand raised to the assistant: the lecture is not paused for it
    // (never the engine's hand); the next question goes to the assistant
    const [assistantHandRaised, setAssistantHandRaisedState] = useState(false);
    const assistantHandRaisedRef = useRef(false);
    // The engine, paused only while the learner records a question for the
    // assistant (the mic would pick up the teacher): resumed once it is sent
    // or the recording is dropped
    const assistantVoicePauseRef = useRef<PlaybackEngine | null>(null);
    // Shows the learner where to ask once a hand goes up to the assistant (set each render)
    const assistantHandUiRef = useRef<() => void>(() => {});
    // A Q&A / discussion with the teacher is open: mirrored for routing at call time
    const liveSessionOpenRef = useRef(false);
    // Who answers in the open aside: the assistant, or a classmate the
    // learner named (@) during the lecture. Follow-ups stay with them.
    const asideAgentIdRef = useRef<string | null>(null);
    const [asideAgentId, setAsideAgentIdState] = useState<string | null>(null);
    const setAsideAgentId = useCallback((agentId: string | null) => {
      asideAgentIdRef.current = agentId;
      setAsideAgentIdState(agentId);
    }, []);
    const setAsideSessionOpen = useCallback(
      (open: boolean) => {
        asideSessionOpenRef.current = open;
        if (!open) setAsideAgentId(null);
        setAsideSessionOpenState(open);
      },
      [setAsideAgentId],
    );
    const setAsideStreaming = useCallback((streaming: boolean) => {
      asideStreamingRef.current = streaming;
      setAsideStreamingState(streaming);
    }, []);
    const setAssistantHandRaised = useCallback((raised: boolean) => {
      assistantHandRaisedRef.current = raised;
      setAssistantHandRaisedState(raised);
    }, []);
    // The interaction panel, where focus may move to the composer on a call
    const panelRef = useRef<HTMLDivElement>(null);
    // The raised hand's text until the server accepts it or it is given back:
    // leaving the page meanwhile (reload, tab close, route change, Pro mode)
    // keeps it as a per-classroom draft that the next visit puts back.
    const unsentQuestionRef = useRef<{ stageId: string; text: string } | null>(null);
    const interactivePickHandlerRef = useRef<(pick: PlaybackInteractiveComponentPick) => boolean>(
      () => false,
    );

    const setDraftElementReference = useCallback((next: DraftElementReference | null) => {
      draftElementReferenceRef.current = next;
      setDraftElementReferenceState(next);
    }, []);

    // Layout state from settings store (persisted via localStorage)
    const sidebarCollapsed = useSettingsStore((s) => s.sidebarCollapsed);
    const setSidebarCollapsed = useSettingsStore((s) => s.setSidebarCollapsed);
    const chatAreaWidth = useSettingsStore((s) => s.chatAreaWidth);
    const setChatAreaWidth = useSettingsStore((s) => s.setChatAreaWidth);
    const chatAreaCollapsed = useSettingsStore((s) => s.chatAreaCollapsed);
    const setChatAreaCollapsed = useSettingsStore((s) => s.setChatAreaCollapsed);
    // Below the classroom's desktop width: the compact header with the ⋯ menu
    // and 44px touch targets. Tablet landscape keeps the numbered scene rail
    // and a fixed 320px panel; the rail ignores the persisted desktop
    // `sidebarCollapsed`, and its 展开场景栏 swaps in the full sidebar for this
    // session only. The stacked layouts (tablet portrait, phone) put the
    // interaction section under the stage, with the scenes in its 场景 tab;
    // they ignore the persisted panel collapse too.
    const classroomLayout = useClassroomLayout();
    const touchLayout = isTouchClassroomLayout(classroomLayout);
    const stackedLayout = isStackedClassroomLayout(classroomLayout);
    const phoneLayout = classroomLayout === 'phone';
    const [railSidebarOpen, setRailSidebarOpen] = useState(false);
    const setTTSMuted = useSettingsStore((s) => s.setTTSMuted);
    const setTTSVolume = useSettingsStore((s) => s.setTTSVolume);

    // PlaybackEngine state
    const [engineMode, setEngineMode] = useState<EngineMode>('idle');
    const [playbackCompleted, setPlaybackCompleted] = useState(false); // Distinguishes "never played" idle from "finished" idle
    const [lectureSpeech, setLectureSpeech] = useState<string | null>(null); // From PlaybackEngine (lecture)
    const [currentPlaybackActionIndex, setCurrentPlaybackActionIndex] = useState<number | null>(0);
    const [liveSpeech, setLiveSpeech] = useState<string | null>(null); // From buffer (discussion/QA)
    const [discussionTrigger, setDiscussionTrigger] = useState<TriggerEvent | null>(null);

    // Speaking agent tracking (Issue 2)
    const [speakingAgentId, setSpeakingAgentId] = useState<string | null>(null);

    // Thinking state (Issue 5)
    const [thinkingState, setThinkingState] = useState<{
      stage: string;
      agentId?: string;
    } | null>(null);

    // Cue user state (Issue 7): the director handed the floor to the learner
    const [isCueUser, setIsCueUser] = useState(false);
    const [cueAgentId, setCueAgentId] = useState<string | null>(null);
    // The cue's question to the learner (cue_user.prompt), when its last line asked one
    const [cuePrompt, setCuePrompt] = useState<string | null>(null);
    // A quiz just graded with wrong answers offers to go over them (I11)
    const [quizReviewOffer, setQuizReviewOffer] = useState<QuizReviewOffer | null>(null);
    // The learner's choice on a whole-class question's card, read by the
    // discussion start that confirmDiscussion triggers synchronously (I10)
    const pendingLearnerStanceRef = useRef<LearnerStance | undefined>(undefined);
    // The scene whose lecture has been heard (played here, or resumed past its
    // start): only then do requests say how far it got (I14)
    const lectureStartedSceneIdRef = useRef<string | null>(null);

    // Streaming state for stop button (Issue 1)
    const [chatIsStreaming, setChatIsStreaming] = useState(false);
    const [chatIsSoftClosing, setChatIsSoftClosing] = useState(false);
    // The soft close of a Q&A that interrupted the lecture: when it resumes
    const [lectureResumeDeadline, setLectureResumeDeadline] = useState<number | undefined>();
    const [chatSessionType, setChatSessionType] = useState<string | null>(null);

    // Topic pending state: session is soft-paused, bubble stays visible, waiting for user input
    const [isTopicPending, setIsTopicPending] = useState(false);

    // Active bubble ID for playback highlight in chat area (Issue 8)
    const [activeBubbleId, setActiveBubbleId] = useState<string | null>(null);

    // Scene switch confirmation dialog state
    const [pendingSceneId, setPendingSceneId] = useState<string | null>(null);
    const sceneSwitchRequestRef = useRef(0);
    const sceneSwitchConfirmingRef = useRef(false);
    const [isPresenting, setIsPresenting] = useState(false);
    // Read at call time by the question routing (fullscreen hides the aside)
    const isPresentingRef = useRef(false);
    useEffect(() => {
      isPresentingRef.current = isPresenting;
    }, [isPresenting]);
    const [controlsVisible, setControlsVisible] = useState(true);
    // The learner is composing: the composer records or holds a draft in a
    // focused box. While presenting, the dock reports instead (its open card
    // counts too).
    const [isComposerComposing, setIsComposerComposing] = useState(false);
    const [isDockInteractionActive, setIsDockInteractionActive] = useState(false);
    const isPresentationInteractionActive = isPresenting
      ? isDockInteractionActive
      : isComposerComposing;
    const studentComposingRef = useRef(false);
    useEffect(() => {
      studentComposingRef.current = isPresentationInteractionActive;
    }, [isPresentationInteractionActive]);

    // Whiteboard state (from canvas store so AI tools can open it)
    const whiteboardOpen = useCanvasStore.use.whiteboardOpen();
    const whiteboardDrawing = useCanvasStore.use.whiteboardDrawing();
    const runtimeProjection = useCanvasStore.use.runtimeWhiteboardProjection();
    const whiteboardClearing = useCanvasStore.use.whiteboardClearing();
    const { whiteboard: displayedWhiteboard, source: displayedWhiteboardSource } =
      getDisplayedWhiteboard(stage, runtimeProjection);
    const setWhiteboardOpenManually = useCanvasStore.use.setWhiteboardOpenManually();

    // Selected agents from settings store (Zustand)
    const selectedAgentIds = useSettingsStore((s) => s.selectedAgentIds);
    const ttsMuted = useSettingsStore((s) => s.ttsMuted);
    // Narration is on when the workspace's tts slot resolves to a provider.
    const ttsEnabled = !!useModelCapabilities().tts;

    // Generate participants from selected agents
    const participants = useMemo(
      () => agentsToParticipants(selectedAgentIds, t),
      [selectedAgentIds, t],
    );

    // Resolved AgentConfig array for hooks that need full agent objects
    // Subscribe to the agents record so voiceConfig changes trigger re-resolution
    const agentsRecord = useAgentRegistry((s) => s.agents);
    const selectedAgents = useMemo(
      () =>
        selectedAgentIds.map((id) => agentsRecord[id]).filter((a): a is AgentConfig => a != null),
      [agentsRecord, selectedAgentIds],
    );
    // The classroom's teaching assistant, who answers on the side while the
    // lecture plays (assistantAnswersDuringLecture; the setting defaults on)
    const assistantAgent = useMemo(() => pickAssistantAgent(selectedAgents), [selectedAgents]);
    // Who the learner may address with "@" (I23): everyone in class, under
    // the names the participants block shows
    const mentionCandidates = useMemo<MentionCandidate[]>(
      () =>
        participants
          .filter((participant) => participant.role !== 'user')
          .map((participant) => ({
            id: participant.id,
            name: participant.name,
            avatar: participant.avatar,
            role: agentsRecord[participant.id]?.role,
          })),
      [agentsRecord, participants],
    );
    const assistantAnswersEnabled =
      useSettingsStore((s) => s.assistantAnswersDuringLecture) !== false;

    // Discussion TTS: audio indicator state
    const [audioIndicatorState, setAudioIndicatorState] = useState<AudioIndicatorState>('idle');
    const [audioAgentId, setAudioAgentId] = useState<string | null>(null);

    const discussionTTS = useDiscussionTTS({
      enabled: ttsEnabled && !ttsMuted,
      agents: selectedAgents,
      onAudioStateChange: (agentId, state) => {
        setAudioAgentId(agentId);
        setAudioIndicatorState(state);
      },
    });
    // A class moment's card is read out in its opener's voice (I07): the
    // engine asks, per moment, whether the reading will take the place of the
    // pause before the card (read at call time: the callbacks outlive renders)
    const canVoiceRef = useRef(discussionTTS.canVoice);
    useEffect(() => {
      canVoiceRef.current = discussionTTS.canVoice;
    });
    // The pause the engine used before the card now offered: what is left of
    // the usual pause still holds the card's countdown
    const triggerDelayRef = useRef<{ id: string; delayMs: number } | null>(null);
    const announcement = useMomentAnnouncement({
      trigger: discussionTrigger,
      announce: discussionTTS.announce,
      holdMs: (trigger) =>
        momentCountdownHoldMs(
          triggerDelayRef.current?.id === trigger.id
            ? triggerDelayRef.current.delayMs
            : DISCUSSION_TRIGGER_DELAY_MS,
        ),
    });
    // A class moment the learner joined from its card is live: its end may
    // move the course on (I19)
    const lectureMomentLiveRef = useRef(false);
    // That end counting down to the next page (shown as the caption's countdown)
    const [momentAdvanceDeadline, setMomentAdvanceDeadline] = useState<number | undefined>();
    const momentAdvanceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    /** Drop a moment's countdown to the next page (typing, a new session, a switch) */
    const cancelMomentAdvance = useCallback(() => {
      if (momentAdvanceTimerRef.current) clearTimeout(momentAdvanceTimerRef.current);
      momentAdvanceTimerRef.current = null;
      setMomentAdvanceDeadline(undefined);
    }, []);

    const engineRef = useRef<PlaybackEngine | null>(null);
    const audioPlayerRef = useRef(createAudioPlayer());
    const chatAreaRef = useRef<ChatAreaRef>(null);
    // The one composer (in the panel, or in the fullscreen dock's card) and
    // the dock: T / V / Escape and the stream's soft-close "continue" reach
    // them through these
    const composerRef = useRef<ComposerHandle>(null);
    const presentationDockRef = useRef<PresentationDockHandle>(null);
    const composerHost = useComposerHost();
    // The side panels as they were before fullscreen collapsed them
    const panelsBeforePresentationRef = useRef<{ sidebar: boolean; chat: boolean } | null>(null);
    const lectureSessionIdRef = useRef<string | null>(null);
    const lectureActionCounterRef = useRef(0);
    const currentPlaybackActionIndexRef = useRef<number | null>(currentPlaybackActionIndex);
    const activeSceneIdRef = useRef<string | null>(currentSceneId);
    const discussionAbortRef = useRef<AbortController | null>(null);
    const presentationIdleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const cursorSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const pendingCursorRef = useRef<{ stageId: string; cursor: PlaybackCursor } | null>(null);
    const stageRef = useRef<HTMLDivElement>(null);
    // Auto-play's scene advance, held while the student composes (typing no
    // longer pauses the lecture, so it can complete under an open input)
    const heldAutoAdvanceRef = useRef<{ engine: PlaybackEngine; advance: () => void } | null>(null);
    // Run a held advance once the input closes and the assistant has finished
    // answering — unless the student asked a question instead (that Q&A now
    // owns the slide) or playback moved on. The switch ends the aside.
    useEffect(() => {
      if (isPresentationInteractionActive || asideStreaming) return;
      const held = heldAutoAdvanceRef.current;
      heldAutoAdvanceRef.current = null;
      if (!held || chatSessionType) return;
      const { engine, advance } = held;
      if (engineRef.current !== engine || engine.getMode() !== 'idle' || !engine.isExhausted()) {
        return;
      }
      advance();
    }, [asideStreaming, chatSessionType, isPresentationInteractionActive]);

    /** A send's reference and receipt: an accepted reference clears the draft it froze */
    const elementReferenceSendOptions = useCallback(
      (
        snapshot?: ElementReferenceSendSnapshot,
        onAccepted?: () => void,
      ): ChatMessageSendOptions | undefined =>
        snapshot
          ? {
              elementReference: snapshot.reference,
              onResponseAccepted: (response) => {
                onAccepted?.();
                const current = draftElementReferenceRef.current;
                if (
                  !shouldClearDraftElementReference(
                    response,
                    snapshot.selectionVersion,
                    current?.selectionVersion,
                  )
                ) {
                  return;
                }
                setDraftElementReference(null);
              },
            }
          : onAccepted
            ? { onResponseAccepted: onAccepted }
            : undefined,
      [setDraftElementReference],
    );

    const sendMessageWithElementReference = useCallback(
      (text: string, snapshot?: ElementReferenceSendSnapshot, onAccepted?: () => void) => {
        return chatAreaRef.current?.sendMessage(
          text,
          elementReferenceSendOptions(snapshot, onAccepted),
        );
      },
      [elementReferenceSendOptions],
    );

    /**
     * Who answers the learner now on the side, while the teacher keeps
     * lecturing: the teaching assistant when its aside applies, or the
     * classmate (or assistant) the message names (@) during the lecture;
     * else null for the teacher (resolveAsideAgent). Read at call time from
     * refs and the stores: a voice transcript arrives through a callback
     * captured when the recording started.
     */
    const resolveAssistantRoute = useCallback(
      (message?: string): string | null => {
        const engine = engineRef.current;
        const settings = useSettingsStore.getState();
        const registry = useAgentRegistry.getState();
        const assistantAgentId =
          pickAssistantAgent((settings.selectedAgentIds ?? []).map((id) => registry.getAgent(id)))
            ?.id ?? null;
        const addressed = message
          ? resolveAddressedAgentIds(
              message,
              mentionRoster(settings.selectedAgentIds ?? [], (id) => registry.getAgent(id), t),
            )
          : [];
        return resolveAsideAgent({
          enabled: settings.assistantAnswersDuringLecture !== false,
          assistantAgentId,
          asideOpen:
            asideSessionOpenRef.current ||
            asideStreamingRef.current ||
            assistantHandRaisedRef.current,
          engineMode: engine?.getMode() ?? null,
          liveSessionOpen: liveSessionOpenRef.current,
          teacherHandPending: !!queuedQuestionRef.current || !!engine?.getHandState(),
          pausedForVoice: !!engine && assistantVoicePauseRef.current === engine,
          addressed: addressed.map((id) => ({ id, role: registry.getAgent(id)?.role ?? '' })),
          asideAgentId: asideAgentIdRef.current,
          presenting: isPresentingRef.current,
        });
      },
      [t],
    );

    /**
     * A recording for the assistant is over (sent, cancelled, nothing heard):
     * the lecture it paused plays on, text reveal included. Only the pause it
     * made itself, on the engine that is still installed.
     */
    const resumeAfterAssistantVoice = useCallback(() => {
      const paused = assistantVoicePauseRef.current;
      assistantVoicePauseRef.current = null;
      if (!paused || engineRef.current !== paused || paused.getMode() !== 'paused') return;
      paused.resume();
      if (lectureSessionIdRef.current) {
        chatAreaRef.current?.resumeBuffer(lectureSessionIdRef.current);
      }
    }, []);

    /** UI side effects of a question going out, immediately or from a raised hand. */
    const markQuestionSent = useCallback(() => {
      // Auto-switch to the 互动 tab when the user sends a message
      chatAreaRef.current?.switchToTab('interaction');
      setIsCueUser(false);
      setCuePrompt(null);
      // Immediately mark streaming for synchronized stop button
      setChatIsStreaming(true);
      setChatSessionType((prev) => prev || 'qa');
      // Optimistic thinking: show thinking dots immediately so there's
      // no blank gap between userMessage expiry and the SSE thinking event.
      // The real SSE event will overwrite this with the same or updated value.
      setThinkingState({ stage: 'director' });
    }, []);

    /** The page is going away: keep an unsent raised hand as a draft for the next visit. */
    const persistUnsentQuestion = useCallback(() => {
      const unsent = unsentQuestionRef.current;
      if (unsent) saveRaisedHandDraft(getSessionStorage(), unsent.stageId, unsent.text);
    }, []);

    /** The raised hand was answered or given back: no draft is left behind. */
    const forgetUnsentQuestion = useCallback(() => {
      const unsent = unsentQuestionRef.current;
      unsentQuestionRef.current = null;
      if (unsent) clearRaisedHandDraft(getSessionStorage(), unsent.stageId);
    }, []);

    /**
     * The question goes to the teaching assistant: the lecture is neither
     * paused nor interrupted, and nothing lecture-facing is touched — no
     * discussion TTS cleanup (it would cancel browser speech narrating the
     * lecture), no live-buffer resume, no Q&A session type or thinking state.
     */
    const sendToAssistant = useCallback(
      (text: string, agentId: string, snapshot?: ElementReferenceSendSnapshot) => {
        // Sent now: supersedes an unsent raised hand (e.g. one Pro mode gave back)
        forgetUnsentQuestion();
        setAssistantHandRaised(false);
        setAsideAgentId(agentId);
        chatAreaRef.current?.switchToTab('interaction');
        // Optimistic, until the aside reports its own state; a new turn has
        // not started answering yet (the send cooldown waits for it)
        setAsideStreaming(true);
        setAsideSpeakingAgentId(null);
        setAsideThinking({ stage: 'director' });
        void chatAreaRef.current?.sendAsideMessage?.(text, {
          agentId,
          ...elementReferenceSendOptions(snapshot),
        });
        resumeAfterAssistantVoice();
      },
      [
        elementReferenceSendOptions,
        forgetUnsentQuestion,
        resumeAfterAssistantVoice,
        setAsideAgentId,
        setAsideStreaming,
        setAssistantHandRaised,
      ],
    );

    /**
     * Leaving playback aborts a delivered raised hand's request on purpose,
     * and that send settling would forget it. Take the question back from the
     * send (it only forgets the record it was given) so it stays unsent.
     */
    const detachUnsentQuestionFromSend = useCallback(() => {
      const unsent = unsentQuestionRef.current;
      if (unsent) unsentQuestionRef.current = { ...unsent };
    }, []);

    /** Drop a raised hand from the engine; the composer puts its text back into the input. */
    const dropQueuedQuestion = useCallback((): string | null => {
      const queued = queuedQuestionRef.current;
      if (!queued) return null;
      queuedQuestionRef.current = null;
      engineRef.current?.cancelQueuedInterrupt();
      setQueuedQuestion({ id: queued.id, text: queued.text, status: 'cancelled' });
      return queued.text;
    }, []);

    /**
     * Drop a raised hand (user cancel, navigation). Its text goes back into the
     * input, so it is no longer an unsent draft; returns the dropped text.
     */
    const cancelQueuedQuestion = useCallback((): string | null => {
      const text = dropQueuedQuestion();
      if (text !== null) forgetUnsentQuestion();
      return text;
    }, [dropQueuedQuestion, forgetUnsentQuestion]);

    /**
     * While the lecture plays, a question raises a hand: the engine holds it
     * until the current action finishes, and the element reference frozen now
     * travels with it. Returns undefined when it must be sent right away.
     */
    const raiseHand = useCallback(
      (text: string, elementReference?: ElementReferenceSendSnapshot): MessageSendResult => {
        const engine = engineRef.current;
        if (queuedQuestionRef.current) {
          // One raised hand at a time (the composer's send cooldown normally
          // keeps a second send from getting here)
          if (engine?.hasQueuedInterrupt()) return 'blocked';
          // Stale: the engine already dropped it (unreachable while every
          // engine-side drop goes through an owner cancel) — release it so it
          // can't block every later send
          cancelQueuedQuestion();
        }
        if (!engine) return undefined;
        // A bare hand already waits for this line: the question rides on it
        // (answered at the same boundary instead of calling the learner)
        const attached = engine.getHandState() === 'raised' && engine.attachQuestion(text);
        if (!attached && !engine.queueUserInterrupt(text)) return undefined;
        if (attached) setHandState(engine.getHandState());
        const id = ++queuedQuestionIdRef.current;
        queuedQuestionRef.current = { id, text, elementReference };
        unsentQuestionRef.current = draftStageId ? { stageId: draftStageId, text } : null;
        // Worded once, by what is in flight: a spoken line or another step
        const waitsFor = engine.isSpeechInFlight() ? 'sentence' : 'step';
        setQueuedQuestion({ id, text, status: 'queued', waitsFor });
        return 'queued';
      },
      [cancelQueuedQuestion, draftStageId],
    );

    /**
     * 举手 without a question: the engine calls the learner when the current
     * action ends (at once while paused or idle). Never kept as a draft —
     * there is no text to give back. While the assistant answers during the
     * lecture, the hand goes to the assistant instead: nothing pauses, the
     * composer opens and the assistant invites the question in the stream.
     */
    const raiseHandOnly = useCallback((): boolean => {
      if (resolveAssistantRoute()) {
        setAssistantHandRaised(true);
        assistantHandUiRef.current();
        return true;
      }
      const engine = engineRef.current;
      if (!engine) return false;
      // Worded before raising: a hand called at once leaves nothing in flight
      const waitsFor = engine.isSpeechInFlight() ? 'sentence' : 'step';
      if (!engine.raiseHand()) return false;
      setHandWaitsFor(waitsFor);
      setHandState(engine.getHandState());
      return true;
    }, [resolveAssistantRoute, setAssistantHandRaised]);

    /** 放下: a waiting hand is withdrawn; a called one gives the floor back and the lecture resumes. */
    const lowerHand = useCallback((): boolean => {
      // A hand raised to the assistant only comes down (the lecture never paused)
      if (assistantHandRaisedRef.current) {
        setAssistantHandRaised(false);
        return true;
      }
      const engine = engineRef.current;
      if (!engine?.lowerHand()) return false;
      setHandState(engine.getHandState());
      setDeferredDiscussion(null);
      // A hand called by pause froze the lecture's text reveal with the line
      if (engine.getMode() === 'playing' && lectureSessionIdRef.current) {
        chatAreaRef.current?.resumeBuffer(lectureSessionIdRef.current);
      }
      return true;
    }, [setAssistantHandRaised]);

    /** The engine moves the hand on its own (the boundary, play, a jump, a Q&A): mirror it. */
    const refreshHandState = useCallback(() => {
      setHandState(engineRef.current?.getHandState() ?? null);
    }, []);

    const updateCurrentPlaybackActionIndex = useCallback((actionIndex: number | null) => {
      currentPlaybackActionIndexRef.current = actionIndex;
      setCurrentPlaybackActionIndex(actionIndex);
    }, []);

    const persistCursorSafely = useCallback(
      ({ stageId, cursor }: { stageId: string; cursor: PlaybackCursor }) => {
        void saveCursor(stageId, cursor).catch((error) => {
          console.warn(`Failed to save playback cursor for stage ${stageId}:`, error);
        });
      },
      [],
    );

    const scheduleCursorSave = useCallback(
      (stageId: string, cursor: PlaybackCursor) => {
        pendingCursorRef.current = { stageId, cursor };
        if (cursorSaveTimerRef.current) clearTimeout(cursorSaveTimerRef.current);
        cursorSaveTimerRef.current = setTimeout(() => {
          cursorSaveTimerRef.current = null;
          const pending = pendingCursorRef.current;
          pendingCursorRef.current = null;
          if (pending) persistCursorSafely(pending);
        }, 1000);
      },
      [persistCursorSafely],
    );

    const actionResumeStorageKey = useMemo(
      () => getActionResumeStorageKey(stage?.id ?? currentScene?.stageId),
      [currentScene?.stageId, stage?.id],
    );

    const saveSceneResumePosition = useCallback(
      (
        sceneId: string | null | undefined,
        actionIndex: number | null | undefined,
        progress?: { atBoundary?: boolean },
      ) => {
        if (!sceneId || typeof window === 'undefined') return;
        const scene = scenes.find((s) => s.id === sceneId);
        const actions = scene?.actions ?? [];
        if (!scene || actions.length === 0) return;
        // A raised hand answered between actions: the next one had not started
        const atBoundary = progress?.atBoundary === true;

        if (Number.isInteger(actionIndex) && actionIndex! >= actions.length) {
          // ...after the last one: keep the last line's position until Play
          // runs the completion the raised hand preempted
          if (atBoundary || engineRef.current?.hasPendingLectureCompletion()) return;
          clearActionResumePosition(window.sessionStorage, actionResumeStorageKey, sceneId);
          return;
        }

        const action = Number.isInteger(actionIndex) ? actions[actionIndex!] : null;
        if (action && action.type !== 'speech' && !atBoundary) {
          const crossedUnsafe = actions
            .slice(0, actionIndex! + 1)
            .some(isUnsafePlaybackNavigationAction);
          // A raised hand answered just before this action keeps its boundary
          // position (Q&A pause, unmount, the restore jump, the resume itself)
          if (
            crossedUnsafe &&
            !isActionBoundaryResumePositionAt(
              window.sessionStorage,
              actionResumeStorageKey,
              sceneId,
              actionIndex!,
            )
          ) {
            clearActionResumePosition(window.sessionStorage, actionResumeStorageKey, sceneId);
          }
          return;
        }

        const position = createActionResumePosition(actions, actionIndex, { atBoundary });
        if (!position) return;
        if (
          !canJumpWithinReconstructablePrefix(actions, 0, position.actionIndex, {
            atBoundary: position.atBoundary === true,
          })
        ) {
          clearActionResumePosition(window.sessionStorage, actionResumeStorageKey, sceneId);
          return;
        }
        saveActionResumePosition(window.sessionStorage, actionResumeStorageKey, sceneId, position);
      },
      [actionResumeStorageKey, scenes],
    );

    const clearSceneResumePosition = useCallback(
      (sceneId: string | null | undefined) => {
        if (!sceneId || typeof window === 'undefined') return;
        clearActionResumePosition(window.sessionStorage, actionResumeStorageKey, sceneId);
      },
      [actionResumeStorageKey],
    );
    // Monotonic counter incremented on each scene switch — used to discard stale SSE callbacks
    const sceneEpochRef = useRef(0);
    // When true, the next engine init will auto-start playback (for auto-play scene advance)
    const autoStartRef = useRef(false);
    // Discussion buffer-level pause state (distinct from soft-pause which aborts SSE)
    const [isDiscussionPaused, setIsDiscussionPaused] = useState(false);

    /** Level-1 pause of the live answer: the text reveal and TTS freeze, SSE keeps buffering */
    const pauseLiveAnswer = useCallback(() => {
      const paused = chatAreaRef.current?.pauseActiveLiveBuffer();
      if (paused) {
        discussionTTS.pause();
        setIsDiscussionPaused(true);
      }
    }, [discussionTTS]);

    const resumeLiveAnswer = useCallback(() => {
      chatAreaRef.current?.resumeActiveLiveBuffer();
      discussionTTS.resume();
      setIsDiscussionPaused(false);
    }, [discussionTTS]);

    /**
     * Resume a soft-paused topic: re-call /chat with existing session messages.
     * The director picks the next agent to continue.
     */
    const doResumeTopic = useCallback(async () => {
      // Clear old bubble immediately — no lingering on interrupted text
      setIsTopicPending(false);
      setLiveSpeech(null);
      setSpeakingAgentId(null);
      setThinkingState({ stage: 'director' });
      setChatIsStreaming(true);
      // Transition engine back to live — onInputActivate paused it when soft-pausing,
      // so we must explicitly resume to keep engine mode in sync with the chat loop.
      engineRef.current?.resume();
      // Fire new chat round — SSE events will drive thinking → agent_start → speech
      await chatAreaRef.current?.resumeActiveSession();
    }, []);

    /** Reset all live/discussion state (shared by doSessionCleanup & onDiscussionEnd) */
    const resetLiveState = useCallback(() => {
      setLiveSpeech(null);
      setSpeakingAgentId(null);
      setThinkingState(null);
      setIsCueUser(false);
      setCueAgentId(null);
      setCuePrompt(null);
      setLectureResumeDeadline(undefined);
      setIsTopicPending(false);
      setChatIsStreaming(false);
      setChatIsSoftClosing(false);
      setChatSessionType(null);
      setIsDiscussionPaused(false);
    }, []);

    /** Full scene reset (scene switch) — resetLiveState + lecture/visual state */
    const resetSceneState = useCallback(
      (initial?: { actionIndex?: number | null; lectureSpeech?: string | null }) => {
        resetLiveState();
        setPlaybackCompleted(false);
        setLectureSpeech(initial?.lectureSpeech ?? null);
        updateCurrentPlaybackActionIndex(initial?.actionIndex ?? 0);
        setActiveBubbleId(null);
        setDiscussionTrigger(null);
        setHandState(null);
        setDeferredDiscussion(null);
        // The assistant's hand belongs to the scene it went up in (the
        // aside itself ends with the session, which reports back)
        setAssistantHandRaised(false);
        assistantVoicePauseRef.current = null;
        // A class moment and its countdown to the next page end with the scene
        lectureMomentLiveRef.current = false;
        cancelMomentAdvance();
        // As does a quiz review offer, and what is known of the lecture heard
        setQuizReviewOffer(null);
        lectureStartedSceneIdRef.current = null;
      },
      [
        cancelMomentAdvance,
        resetLiveState,
        setAssistantHandRaised,
        updateCurrentPlaybackActionIndex,
      ],
    );

    /** Request failure should exit live discussion UI without hard-closing the session. */
    const handleLiveSessionError = useCallback(() => {
      engineRef.current?.handleDiscussionError();
      lectureMomentLiveRef.current = false;
      resetLiveState();
      setActiveBubbleId(null);
    }, [resetLiveState]);

    /**
     * Unified session cleanup — called by both the control bar's stop and the
     * stream's end button. Handles the engine transition and clears the live
     * state; the stream keeps a persistent "ended" marker for the session.
     */
    const doSessionCleanup = useCallback(() => {
      engineRef.current?.handleEndDiscussion();

      // Stop any in-flight discussion TTS audio
      discussionTTS.cleanup();

      resetLiveState();
    }, [resetLiveState, discussionTTS]);

    // Shared stop-discussion handler (the control bar's stop pill)
    const handleStopDiscussion = useCallback(async () => {
      await chatAreaRef.current?.stopActiveSession();
    }, []);

    const handleContinueDiscussion = useCallback(() => {
      if (chatAreaRef.current?.continueActiveSoftClosingSession()) {
        setChatIsSoftClosing(false);
      }
    }, []);

    /**
     * Session-stop callback from the chat layer. Runs the normal cleanup, then —
     * only when a confirmed or timed-out soft close ended a Q&A that had
     * interrupted an active lecture — auto-resumes from the saved position.
     *
     * hadLectureInterruption MUST be read before doSessionCleanup(), because
     * handleEndDiscussion() restores and clears the saved lecture position.
     */
    /**
     * A joined class moment ended on a page already lectured, with auto-play
     * on (I19): count down, then complete the page as if its last line had
     * just played — onComplete then turns the page, timed so that it turns as
     * the caption's countdown ends. Typing, recording, a new session, play /
     * pause or a scene switch cancel it.
     */
    const scheduleMomentAdvance = useCallback(
      (engine: PlaybackEngine) => {
        cancelMomentAdvance();
        // Already typing or recording: the course waits for the learner
        if (studentComposingRef.current) return;
        const sceneId = useStageStore.getState().currentSceneId;
        setMomentAdvanceDeadline(Date.now() + MOMENT_ADVANCE_DELAY_MS);
        momentAdvanceTimerRef.current = setTimeout(
          () => {
            momentAdvanceTimerRef.current = null;
            const stillDue =
              engineRef.current === engine &&
              engine.getMode() === 'idle' &&
              engine.isExhausted() &&
              useStageStore.getState().currentSceneId === sceneId &&
              useSettingsStore.getState().autoPlayLecture &&
              !liveSessionOpenRef.current &&
              !studentComposingRef.current;
            if (!stillDue) {
              setMomentAdvanceDeadline(undefined);
              return;
            }
            engine.continuePlayback();
          },
          Math.max(0, MOMENT_ADVANCE_DELAY_MS - LECTURE_COMPLETE_ADVANCE_MS),
        );
      },
      [cancelMomentAdvance],
    );

    const handleSessionStop = useCallback(
      async (payload: SessionCleanupPayload) => {
        const engine = engineRef.current;
        const hadLectureInterruption = engine?.hasLectureInterruption() ?? false;
        // Read before cleanup: the session that stopped was a joined moment
        const wasLectureMoment = lectureMomentLiveRef.current;
        lectureMomentLiveRef.current = false;

        doSessionCleanup();

        if (!engine) return;
        const eligible = shouldAutoResumeLecture({
          source: payload.source,
          endReason: payload.endReason,
          hadLectureInterruption,
          engineMode: engine.getMode(),
          isExhausted: engine.isExhausted(),
          lectureCompletionPending: engine.hasPendingLectureCompletion(),
          playbackCompleted,
        });
        if (!eligible) {
          // A moment at the end of its page: back to the course, like a skip
          if (
            shouldAdvanceAfterMoment({
              source: payload.source,
              endReason: payload.endReason,
              wasLectureMoment,
              autoPlayLecture: !!useSettingsStore.getState().autoPlayLecture,
              // An interactive (or quiz) page waits for the learner: the widget
              // stays as they left it, and no countdown promises a page turn
              pageTurnsByItself:
                useStageStore.getState().scenes.find((s) => s.id === engine.getCurrentSceneId())
                  ?.type === 'slide',
              engineMode: engine.getMode(),
              isExhausted: engine.isExhausted(),
              lectureCompletionPending: engine.hasPendingLectureCompletion(),
            })
          ) {
            scheduleMomentAdvance(engine);
          }
          return;
        }

        // Use the restored engine position, not the stale React currentScene.
        const sceneId = engine.getCurrentSceneId();
        if (!sceneId || !chatAreaRef.current) return;

        // startLecture is async — re-check the engine is still idle AND still
        // the installed engine afterwards. A scene switch during the await
        // stops the captured engine (leaving it idle, so the mode check alone
        // passes) and installs a new one; resuming the orphan would emit
        // progress snapshots for the old scene over the new scene's cursor.
        const sessionId = await chatAreaRef.current.startLecture(sceneId);
        if (engineRef.current !== engine) {
          await chatAreaRef.current.endSession(sessionId);
          return;
        }
        if (engine.getMode() !== 'idle') {
          // The engine left idle during the async startLecture (e.g. a new live
          // session began) — tear down the lecture session we just
          // created/reactivated so it doesn't linger without playing.
          await chatAreaRef.current.endSession(sessionId);
          return;
        }
        lectureSessionIdRef.current = sessionId;
        engine.continuePlayback();
      },
      [doSessionCleanup, playbackCompleted, scheduleMomentAdvance],
    );

    // Imperative teardown so the parent can `await` SSE / engine / TTS
    // shutdown before flipping mode to 'edit'. Mirrors what the old in-
    // component `handleToggleEditMode` did, but exposed through ref so
    // the toggle lives one layer up.
    useImperativeHandle(
      ref,
      () => ({
        teardown: async () => {
          // Leaving playback unmounts the input, so surface a waiting raised
          // hand's text instead of silently dropping it. It also stays unsent:
          // if this root unmounts, the next visit puts it back into the input.
          const droppedQuestion = dropQueuedQuestion();
          if (droppedQuestion) {
            toast.info(t('roundtable.queuedQuestionNotSent'), { description: droppedQuestion });
          }
          // Ending the session aborts a delivered one the server has not
          // accepted yet: it stays unsent as well
          detachUnsentQuestionFromSend();
          await chatAreaRef.current?.endActiveSession();
          if (discussionAbortRef.current) {
            discussionAbortRef.current.abort();
            discussionAbortRef.current = null;
          }
          engineRef.current?.stop();
          discussionTTS.cleanup();
          resetSceneState();
        },
        acceptInteractivePick: (pick) => interactivePickHandlerRef.current(pick),
        cancelElementPick: () => setElementPickActive(false),
      }),
      [
        detachUnsentQuestionFromSend,
        discussionTTS,
        dropQueuedQuestion,
        resetSceneState,
        setElementPickActive,
        t,
      ],
    );

    const clearPresentationIdleTimer = useCallback(() => {
      if (presentationIdleTimerRef.current) {
        clearTimeout(presentationIdleTimerRef.current);
        presentationIdleTimerRef.current = null;
      }
    }, []);

    const resetPresentationIdleTimer = useCallback(() => {
      setControlsVisible(true);
      clearPresentationIdleTimer();
      if (isPresenting && !isPresentationInteractionActive) {
        presentationIdleTimerRef.current = setTimeout(() => {
          setControlsVisible(false);
        }, 3000);
      }
    }, [clearPresentationIdleTimer, isPresenting, isPresentationInteractionActive]);

    const togglePresentation = useCallback(async () => {
      const stageElement = stageRef.current;
      if (!stageElement) return;

      try {
        if (document.fullscreenElement === stageElement) {
          // Unlock Escape key before exiting fullscreen
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (navigator as any).keyboard?.unlock?.();
          await document.exitFullscreen();
          return;
        }

        setControlsVisible(true);
        await stageElement.requestFullscreen();
        // Lock Escape key so it doesn't auto-exit fullscreen (#255)
        // Escape is handled manually in our keydown handler instead
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (navigator as any).keyboard?.lock?.(['Escape']).catch(() => {});
        // Fullscreen shows the stage alone (the dock holds the composer);
        // leaving it puts the panels back as they were
        const { sidebarCollapsed: sidebar, chatAreaCollapsed: chat } = useSettingsStore.getState();
        panelsBeforePresentationRef.current = { sidebar, chat };
        setSidebarCollapsed(true);
        setChatAreaCollapsed(true);
      } catch {
        // Firefox may deny fullscreen from certain keyboard events (e.g. F11)
        console.warn('[Presentation] Fullscreen request denied — browser policy');
      }
    }, [setChatAreaCollapsed, setSidebarCollapsed]);

    useEffect(() => {
      const onFullscreenChange = () => {
        const active = document.fullscreenElement === stageRef.current;
        setIsPresenting(active);

        if (!active) {
          // Ensure keyboard unlock on any fullscreen exit
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (navigator as any).keyboard?.unlock?.();
          setControlsVisible(true);
          clearPresentationIdleTimer();
          // The composer goes back to the panel: restore the panels, and
          // drop a recording that would otherwise go on in a collapsed one
          const panels = panelsBeforePresentationRef.current;
          panelsBeforePresentationRef.current = null;
          if (panels) {
            setSidebarCollapsed(panels.sidebar);
            setChatAreaCollapsed(panels.chat);
            if (panels.chat) composerRef.current?.dismiss();
          }
        }
      };

      document.addEventListener('fullscreenchange', onFullscreenChange);
      return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
    }, [clearPresentationIdleTimer, setChatAreaCollapsed, setSidebarCollapsed]);

    useEffect(() => {
      if (!isPresenting) {
        setControlsVisible(true);
        clearPresentationIdleTimer();
        return;
      }

      const handleActivity = () => {
        resetPresentationIdleTimer();
      };

      window.addEventListener('mousemove', handleActivity);
      window.addEventListener('mousedown', handleActivity);
      window.addEventListener('touchstart', handleActivity);
      if (isPresentationInteractionActive) {
        setControlsVisible(true);
        clearPresentationIdleTimer();
      } else {
        resetPresentationIdleTimer();
      }

      return () => {
        window.removeEventListener('mousemove', handleActivity);
        window.removeEventListener('mousedown', handleActivity);
        window.removeEventListener('touchstart', handleActivity);
        clearPresentationIdleTimer();
      };
    }, [
      clearPresentationIdleTimer,
      isPresenting,
      isPresentationInteractionActive,
      resetPresentationIdleTimer,
    ]);

    // Initialize playback engine when scene changes
    useEffect(() => {
      let cancelled = false;
      const initializeScene = async () => {
        // A raised hand belongs to the scene it was asked in: give its text
        // back rather than answer it elsewhere (catch-all for scene changes
        // that bypass the gated switch).
        cancelQueuedQuestion();
        const previousEngine = engineRef.current;
        engineRef.current = null;
        previousEngine?.stop();

        const previousSceneId = activeSceneIdRef.current;
        if (previousSceneId && previousSceneId !== currentScene?.id) {
          saveSceneResumePosition(previousSceneId, currentPlaybackActionIndexRef.current);
        }

        // Bump epoch so any stale SSE callbacks from the previous scene are discarded
        sceneEpochRef.current++;

        // Wait for an in-flight presentation action before initializing the next
        // scene against shared whiteboard state.
        await chatAreaRef.current?.endActiveSession({ source: 'scene_switch' });
        if (cancelled) return;

        // Also abort the engine-level discussion controller
        if (discussionAbortRef.current) {
          discussionAbortRef.current.abort();
          discussionAbortRef.current = null;
        }

        // Stop any in-flight discussion TTS audio on scene switch
        discussionTTS.cleanup();

        const sessionResumeCursor =
          currentScene && typeof window !== 'undefined'
            ? getActionResumeRestoreCursor(
                readActionResumeState(window.sessionStorage, actionResumeStorageKey),
                currentScene.id,
                currentScene.actions ?? [],
              )
            : { actionIndex: 0, position: null };
        let savedResumeActionIndex = sessionResumeCursor.actionIndex;
        // Saved where a raised hand was answered: may rest on a non-speech action
        const resumeAtBoundary = sessionResumeCursor.position?.atBoundary === true;
        const playbackStageId = stage?.id ?? currentScene?.stageId;
        if (currentScene && playbackStageId && !sessionResumeCursor.position) {
          try {
            const cursor = await loadCursor(playbackStageId);
            if (
              cursor?.sceneId === currentScene.id &&
              currentScene.actions?.[cursor.actionIndex] &&
              canJumpWithinReconstructablePrefix(currentScene.actions, 0, cursor.actionIndex)
            ) {
              savedResumeActionIndex = cursor.actionIndex;
            }
          } catch (error) {
            console.warn(`Failed to load playback cursor for stage ${playbackStageId}:`, error);
          }
        }

        if (cancelled) return;

        // Reset all roundtable/live state so scenes are fully isolated. Use the
        // saved action cursor immediately so mount/refresh cannot persist the
        // default first-speech cursor before the async engine jump finishes.
        resetSceneState({
          actionIndex: savedResumeActionIndex,
          lectureSpeech: getSpeechTextAtOrBefore(currentScene?.actions, savedResumeActionIndex),
        });
        // Resumed past the start: the lecture before it was heard
        if (currentScene && savedResumeActionIndex > 0) {
          lectureStartedSceneIdRef.current = currentScene.id;
        }

        // A slide scene with no actions is still playable: the engine dwells on it
        // (see resolvePlaybackCursor) so a freshly inserted / emptied blank slide
        // shows for a beat and auto-play advances past it. Non-slide scenes
        // (quiz / interactive / pbl) without timeline actions get no lecture engine
        // as before. Don't touch `autoStartRef` here: in the PENDING_SCENE_ID
        // handoff `currentScene` is null while a pending auto-start legitimately
        // waits for the next generated scene to materialize.
        const hasPlayableActions =
          !!currentScene?.actions &&
          (currentScene.actions.length > 0 || currentScene.type === 'slide');
        if (!currentScene || !hasPlayableActions) {
          setEngineMode('idle');
          activeSceneIdRef.current = currentSceneId;

          return;
        }

        // Widget iframe messaging callback for interactive scenes, resolved lazily
        // at send time (keyed by sceneId). The interactive iframe now lives in the
        // keep-alive host (#619), which registers its postMessage callback a commit
        // after this engine is built — so resolving eagerly here would capture null
        // on a scene's first visit and silently drop every widget action. Looking it
        // up per-send always sees the live registration.
        const sceneIdForWidget = currentScene.id;
        const widgetSendMessage = (type: string, payload: Record<string, unknown>) =>
          useWidgetIframeStore.getState().getSendMessage(sceneIdForWidget)?.(type, payload);

        // Create ActionEngine for playback (with audioPlayer for TTS and widget messaging)
        const actionEngine = new ActionEngine(
          useStageStore,
          audioPlayerRef.current,
          widgetSendMessage,
        );

        // Create new PlaybackEngine
        const engineCallbacks: PlaybackEngineCallbacks = {
          onModeChange: (mode) => {
            setEngineMode(mode);
            // Playing on or a Q&A ends a called hand's turn
            refreshHandState();
          },
          onProgress: (snapshot, progress) => {
            // Identity guard: a superseded engine (scene switch during an
            // async resume) must not publish its old scene's position over
            // the installed engine's cursor.
            if (engineRef.current !== engine) return;
            // The lecture is under way here (a request says how far: I14)
            lectureStartedSceneIdRef.current = snapshot.sceneId ?? currentScene.id;
            // A jump or a restore drops a raised hand
            refreshHandState();
            updateCurrentPlaybackActionIndex(snapshot.actionIndex);
            saveSceneResumePosition(snapshot.sceneId, snapshot.actionIndex, progress);
            if (playbackStageId && snapshot.sceneId) {
              scheduleCursorSave(playbackStageId, {
                sceneId: snapshot.sceneId,
                actionIndex: snapshot.actionIndex,
                updatedAt: new Date().toISOString(),
              });
            }
          },
          onSceneChange: (_sceneId) => {
            // Scene change handled by engine
          },
          onSpeechStart: (text) => {
            setLectureSpeech(text);
            // Add to lecture session with incrementing index for dedup
            // Chat area pacing is handled by the StreamBuffer (onTextReveal)
            if (lectureSessionIdRef.current) {
              const idx = lectureActionCounterRef.current++;
              const speechId = `speech-${Date.now()}`;
              chatAreaRef.current?.addLectureMessage(
                lectureSessionIdRef.current,
                { id: speechId, type: 'speech', text } as Action,
                idx,
              );
              // Track active bubble for highlight (Issue 8)
              const msgId = chatAreaRef.current?.getLectureMessageId(lectureSessionIdRef.current!);
              if (msgId) setActiveBubbleId(msgId);
            }
          },
          onSpeechEnd: () => {
            // Don't clear lectureSpeech — let it persist until the next
            // onSpeechStart replaces it or the scene transitions.
            // Clearing here causes fallback to idleText (first sentence).
            setActiveBubbleId(null);
          },
          onEffectFire: (effect: Effect) => {
            // Add to lecture session with incrementing index
            if (
              lectureSessionIdRef.current &&
              (effect.kind === 'spotlight' || effect.kind === 'laser')
            ) {
              const idx = lectureActionCounterRef.current++;
              chatAreaRef.current?.addLectureMessage(
                lectureSessionIdRef.current,
                {
                  id: `${effect.kind}-${Date.now()}`,
                  type: effect.kind,
                  elementId: effect.targetId,
                } as Action,
                idx,
              );
            }
          },
          onProactiveShow: (trigger) => {
            if (!trigger.agentId) {
              // A moment without its opener (a course from before moments
              // named one) is the teacher's, never a student picked at random.
              // Mutate in-place so engine.currentTrigger also gets the agentId
              // (confirmDiscussion reads agentId from the same object reference)
              trigger.agentId = currentClassroomTeacherId();
            }
            setDiscussionTrigger(trigger);
            // The discussion a hand jumped ahead of is offered again
            setDeferredDiscussion(null);
          },
          onHandCalled: (call: HandCall) => {
            const deferred = call.deferredDiscussion;
            // Name the agent now: the card offered later re-uses this object,
            // so "X 的讨论排在你之后" and that card name the same agent
            if (deferred && !deferred.agentId) deferred.agentId = currentClassroomTeacherId();
            setDeferredDiscussion(deferred ?? null);
            refreshHandState();
            handCalledUiRef.current();
          },
          onProactiveHide: () => {
            setDiscussionTrigger(null);
          },
          onDiscussionOutcome: (trigger: TriggerEvent, outcome: DiscussionOutcome) => {
            if (engineRef.current !== engine) return;
            // A badge on the page's lecture bubble: the source of the class
            // presence's moments and of the notes' outcome (I06)
            chatAreaRef.current?.recordLectureMoment(
              currentScene.id,
              {
                type: 'discussion',
                id: trigger.id,
                topic: trigger.question,
                ...(trigger.prompt ? { prompt: trigger.prompt } : {}),
                ...(trigger.agentId ? { agentId: trigger.agentId } : {}),
              },
              // The opener actually used: a legacy moment is the teacher's
              { agentId: trigger.agentId ?? currentClassroomTeacherId(), outcome },
            );
            // Only a moment joined from its card moves the course on when it ends
            lectureMomentLiveRef.current = outcome === 'joined';
          },
          onDiscussionConfirmed: (topic, prompt, agentId) => {
            // Start SSE discussion via ChatArea
            handleDiscussionSSE(topic, prompt, agentId);
          },
          onDiscussionEnd: () => {
            // Abort any active SSE
            if (discussionAbortRef.current) {
              discussionAbortRef.current.abort();
              discussionAbortRef.current = null;
            }
            setDiscussionTrigger(null);
            // Stop any in-flight discussion TTS audio
            discussionTTS.cleanup();
            // Clear live state (idempotent — may already be cleared by doSessionCleanup)
            resetLiveState();
            // If all actions are exhausted (discussion was the last action), mark
            // playback as completed so the bubble shows reset instead of play —
            // unless a raised hand preempted the completion after the last line:
            // Play then continues into it (onComplete) instead of restarting.
            if (
              engineRef.current?.isExhausted() &&
              !engineRef.current.hasPendingLectureCompletion()
            ) {
              setPlaybackCompleted(true);
            }
          },
          onUserInterrupt: (text) => {
            // A question asked while called (or delivered) ends the hand's turn
            refreshHandState();
            const queued = queuedQuestionRef.current;
            if (queued) {
              queuedQuestionRef.current = null;
              const isRaisedHand = text === queued.text;
              if (
                isRaisedHand &&
                engineRef.current === engine &&
                useStageStore.getState().currentSceneId === currentScene.id
              ) {
                // The raised hand reached its boundary (or pause flushed it):
                // send it with the element reference frozen when it was asked
                setQueuedQuestion({ id: queued.id, text: queued.text, status: 'delivered' });
                // Still unsent until the server accepts it: a reload can land
                // between this delivery and the request going out. Settling
                // forgets only this record, so leaving can detach it first.
                const unsent = unsentQuestionRef.current;
                const settleUnsent = () => {
                  if (unsentQuestionRef.current === unsent) forgetUnsentQuestion();
                };
                void Promise.resolve(
                  sendMessageWithElementReference(text, queued.elementReference, settleUnsent),
                ).finally(settleUnsent);
                markQuestionSent();
                return;
              }
              // Never answer it in another scene, nor drop it silently for a
              // different message: give its text back instead
              setQueuedQuestion({ id: queued.id, text: queued.text, status: 'cancelled' });
              forgetUnsentQuestion();
              if (isRaisedHand) {
                // The scene changed before the scene-init effect cancelled it
                engine.stop();
                return;
              }
            }
            // User interrupted → start a discussion via chat
            const snapshot = pendingInterruptElementReferenceRef.current;
            pendingInterruptElementReferenceRef.current = undefined;
            void sendMessageWithElementReference(text, snapshot);
          },
          isAgentSelected: (agentId) => {
            const ids = useSettingsStore.getState().selectedAgentIds;
            return ids.includes(agentId);
          },
          getPlaybackSpeed: () => useSettingsStore.getState().playbackSpeed || 1,
          // The lecture's narrator: the classroom teacher (same pick as the
          // participants block and the lecture bubbles)
          getLectureAgentId: () => currentClassroomTeacherId() ?? null,
          onComplete: () => {
            // lectureSpeech intentionally NOT cleared — last sentence stays visible
            // until scene transition (auto-play) or user restarts. Scene change
            // effect handles the reset.
            lectureStartedSceneIdRef.current = currentScene.id;
            updateCurrentPlaybackActionIndex(currentScene.actions?.length ?? 0);
            clearSceneResumePosition(currentScene.id);
            setPlaybackCompleted(true);

            // End lecture session on playback complete
            if (lectureSessionIdRef.current) {
              chatAreaRef.current?.endSession(lectureSessionIdRef.current);
              lectureSessionIdRef.current = null;
            }
            // Auto-play: advance to next scene after a short pause
            const { autoPlayLecture } = useSettingsStore.getState();
            if (autoPlayLecture) {
              const advance = () => {
                const stageState = useStageStore.getState();
                if (!useSettingsStore.getState().autoPlayLecture) return;
                const allScenes = stageState.scenes;
                const curId = stageState.currentSceneId;
                const idx = allScenes.findIndex((s) => s.id === curId);
                if (idx >= 0 && idx < allScenes.length - 1) {
                  const currentScene = allScenes[idx];
                  if (
                    currentScene.type === 'quiz' ||
                    currentScene.type === 'interactive' ||
                    currentScene.type === 'pbl'
                  ) {
                    return;
                  }
                  autoStartRef.current = true;
                  stageState.setCurrentSceneId(allScenes[idx + 1].id);
                } else if (
                  idx === allScenes.length - 1 &&
                  stageState.generatingOutlines.length > 0
                ) {
                  // Last scene exhausted but next is still generating — go to pending page
                  const currentScene = allScenes[idx];
                  if (
                    currentScene.type === 'quiz' ||
                    currentScene.type === 'interactive' ||
                    currentScene.type === 'pbl'
                  ) {
                    return;
                  }
                  autoStartRef.current = true;
                  stageState.setCurrentSceneId(PENDING_SCENE_ID);
                }
              };
              setTimeout(() => {
                // Typing no longer pauses the lecture: don't move the slide out
                // from under a question the student is still composing — hold
                // the advance until the input closes. Likewise while the
                // assistant is still answering on the side.
                if (studentComposingRef.current || asideStreamingRef.current) {
                  heldAutoAdvanceRef.current = { engine, advance };
                  return;
                }
                advance();
              }, LECTURE_COMPLETE_ADVANCE_MS);
            }
          },
        };
        // A card read out in its opener's voice: the reading replaces the
        // usual pause before it (the card's countdown holds for the rest)
        const engineOptions: PlaybackEngineOptions = {
          discussionTriggerDelayMs: (trigger) => {
            const opener = trigger.agentId ?? currentClassroomTeacherId() ?? null;
            const delayMs = canVoiceRef.current(opener)
              ? MOMENT_ANNOUNCE_LEAD_MS
              : DISCUSSION_TRIGGER_DELAY_MS;
            triggerDelayRef.current = { id: trigger.id, delayMs };
            return delayMs;
          },
        };
        const engine = new PlaybackEngine(
          [currentScene],
          actionEngine,
          audioPlayerRef.current,
          engineCallbacks,
          engineOptions,
        );

        engineRef.current = engine;
        activeSceneIdRef.current = currentScene.id;

        // Auto-start if triggered by auto-play scene advance
        if (autoStartRef.current) {
          autoStartRef.current = false;
          (async () => {
            const chatArea = chatAreaRef.current;
            if (currentScene && chatArea) {
              const sessionId = await chatArea.startLecture(currentScene.id);
              if (engineRef.current !== engine) {
                await chatArea.endSession(sessionId);
                return;
              }
              lectureSessionIdRef.current = sessionId;
              lectureActionCounterRef.current = 0;
            }
            if (engineRef.current !== engine) return;
            engine.start();
          })();
        } else {
          // Load saved playback state and restore position (but never auto-play).
          if (
            savedResumeActionIndex > 0 &&
            engine.canJumpToAction(savedResumeActionIndex, { atBoundary: resumeAtBoundary })
          ) {
            void engine
              .jumpToAction(savedResumeActionIndex, {
                autoplay: false,
                atBoundary: resumeAtBoundary,
              })
              .then((restored) => {
                if (!restored || engineRef.current !== engine) return;
                updateCurrentPlaybackActionIndex(savedResumeActionIndex);
                const speech = getSpeechTextAtOrBefore(
                  currentScene.actions,
                  savedResumeActionIndex,
                );
                if (speech !== null) {
                  setLectureSpeech(speech);
                }
              });
          }
        }
      };

      void initializeScene();
      return () => {
        cancelled = true;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps -- Only re-run when scene changes, functions are stable refs
    }, [currentScene]);

    // Put back a raised hand that an earlier visit left unsent: into the
    // input, never sent by itself. Once per classroom while mounted, and only
    // in playback, once the composer is mounted to take it (its host appears
    // after the first commit). Declared after the scene-init effect, which
    // already gave back a question raised in the previous classroom.
    const restoredDraftStageIdRef = useRef<string | null>(null);
    useEffect(() => {
      if (mode !== 'playback' || !draftStageId || !composerHost) return;
      if (restoredDraftStageIdRef.current === draftStageId) return;
      restoredDraftStageIdRef.current = draftStageId;
      const text = takeRaisedHandDraft(getSessionStorage(), draftStageId);
      if (!text) return;
      setQueuedQuestion({ id: ++queuedQuestionIdRef.current, text, status: 'restored' });
      toast.info(t('roundtable.queuedQuestionRestored'));
    }, [composerHost, draftStageId, mode, t]);

    // Reload, tab close or leaving the site: keep an unsent raised hand as a
    // draft (a synchronous write, no confirm dialog). Unlike beforeunload,
    // pagehide keeps the page eligible for the back/forward cache.
    useEffect(() => {
      const onPageHide = () => persistUnsentQuestion();
      window.addEventListener('pagehide', onPageHide);
      return () => window.removeEventListener('pagehide', onPageHide);
    }, [persistUnsentQuestion]);

    // Cleanup on unmount
    useEffect(() => {
      const audioPlayer = audioPlayerRef.current;
      const chatArea = chatAreaRef.current;
      return () => {
        // A route change or Pro mode with a raised hand still unsent. ChatArea's
        // unmount aborts a delivered one's request: that settling must not
        // delete the draft written here
        detachUnsentQuestionFromSend();
        persistUnsentQuestion();
        if (cursorSaveTimerRef.current) clearTimeout(cursorSaveTimerRef.current);
        cursorSaveTimerRef.current = null;
        if (momentAdvanceTimerRef.current) clearTimeout(momentAdvanceTimerRef.current);
        momentAdvanceTimerRef.current = null;
        const pendingCursor = pendingCursorRef.current;
        pendingCursorRef.current = null;
        if (pendingCursor) persistCursorSafely(pendingCursor);
        saveSceneResumePosition(activeSceneIdRef.current, currentPlaybackActionIndexRef.current);
        if (engineRef.current) {
          engineRef.current.stop();
        }
        audioPlayer.destroy();
        if (discussionAbortRef.current) {
          discussionAbortRef.current.abort();
        }
        discussionTTS.cleanup();
        chatArea?.endActiveSession();
        clearPresentationIdleTimer();
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps -- unmount-only cleanup, clearPresentationIdleTimer is stable
    }, []);

    // Sync mute state from settings store to audioPlayer
    useEffect(() => {
      audioPlayerRef.current.setMuted(ttsMuted);
    }, [ttsMuted]);

    // Sync volume from settings store to audioPlayer
    const ttsVolume = useSettingsStore((s) => s.ttsVolume);
    useEffect(() => {
      if (!ttsMuted) {
        audioPlayerRef.current.setVolume(ttsVolume);
      }
    }, [ttsVolume, ttsMuted]);

    // Sync playback speed to audio player (for live-updating current audio)
    const playbackSpeed = useSettingsStore((s) => s.playbackSpeed);
    useEffect(() => {
      audioPlayerRef.current.setPlaybackRate(playbackSpeed);
    }, [playbackSpeed]);

    /**
     * Handle discussion SSE — POST /api/chat and push events to engine
     */
    const handleDiscussionSSE = useCallback(
      async (
        topic: string,
        prompt?: string,
        agentId?: string,
        moment?: { momentKind?: DiscussionMomentKind },
      ) => {
        // The teacher's discussion takes over: a hand raised to the assistant
        // comes down (startDiscussion ends an open aside first)
        setAssistantHandRaised(false);
        // A lecture moment's kind comes from who opens it and whom it names;
        // the learner's choice on a whole-class question's card goes with it
        const momentKind = moment?.momentKind ?? currentLectureMomentKind(agentId, topic, t);
        const learnerStance = pendingLearnerStanceRef.current;
        pendingLearnerStanceRef.current = undefined;
        // Start discussion display in ChatArea (lecture speech is preserved independently)
        // No agent (no teacher resolved for a legacy moment): the chat layer
        // gives the moment to the classroom's teacher; a quiz review names
        // none at all (the director picks)
        chatAreaRef.current?.startDiscussion({
          topic,
          prompt,
          agentId,
          momentKind,
          ...(momentKind === 'ask-learner' && learnerStance ? { learnerStance } : {}),
        });
        // Auto-switch to the 互动 tab when a discussion starts
        chatAreaRef.current?.switchToTab('interaction');
        // Immediately mark streaming for synchronized stop button
        setChatIsStreaming(true);
        setChatSessionType('discussion');
        // Optimistic thinking: show thinking dots immediately (same as onMessageSend)
        setThinkingState({ stage: 'director' });
      },
      [setAssistantHandRaised, t],
    );

    /**
     * A teacher's question to the whole class (I10): the learner answers first
     * (我来答) or hears the class first (先听听大家). Either way the moment is
     * joined; the choice travels with the discussion it starts.
     */
    const joinAskLearner = useCallback((stance: LearnerStance) => {
      pendingLearnerStanceRef.current = stance;
      try {
        engineRef.current?.confirmDiscussion();
      } finally {
        pendingLearnerStanceRef.current = undefined;
      }
    }, []);

    /** Where the lecture stands on this scene, for the next Pi request (I14) */
    const getLectureProgress = useCallback((): LectureProgress | null => {
      const sceneId = lectureStartedSceneIdRef.current;
      const actionIndex = currentPlaybackActionIndexRef.current;
      if (!sceneId || sceneId !== activeSceneIdRef.current || actionIndex === null) return null;
      return { sceneId, actionIndex };
    }, []);

    /**
     * The quiz on this page came back with wrong answers (I11): offer to go
     * over them, as a card the learner may skip. Only in the classroom, and
     * only for the page still shown.
     */
    const handleQuizReviewed = useCallback(
      (event: QuizReviewedEvent) => {
        const state = useStageStore.getState();
        if (state.mode !== 'playback' || state.currentSceneId !== event.sceneId) return;
        if (event.misses.length === 0) return;
        const topic = buildQuizReviewTopic(event.misses, {
          question: (number, stem) => t('quizReview.question', { n: number, text: stem }),
          separator: t('quizReview.separator'),
          more: (count) => t('quizReview.more', { count }),
          topic: (questions) => t('quizReview.topic', { questions }),
        });
        setQuizReviewOffer({
          id: `quiz-review-${event.sceneId}-${Date.now()}`,
          sceneId: event.sceneId,
          topic,
          prompt: buildQuizReviewPrompt(event.misses),
        });
      },
      [t],
    );

    // First speech text for idle display (extracted here for playbackView)
    const firstSpeechText = useMemo(
      () =>
        currentScene?.actions?.find((a): a is SpeechAction => a.type === 'speech')?.text ?? null,
      [currentScene],
    );

    // Whether the speaking agent is a student (for bubble role derivation)
    const speakingStudentFlag = useMemo(() => {
      if (!speakingAgentId) return false;
      const agent = useAgentRegistry.getState().getAgent(speakingAgentId);
      return agent?.role !== 'teacher';
    }, [speakingAgentId]);

    // The floor is the learner's: the director's cue, or a called raised hand
    const isLearnerCued = isCueUser || handState === 'called';

    // Centralised derived playback view
    const playbackView = useMemo(
      () =>
        computePlaybackView({
          engineMode,
          lectureSpeech,
          liveSpeech,
          speakingAgentId,
          thinkingState,
          isCueUser: isLearnerCued,
          isTopicPending,
          chatIsStreaming,
          discussionTrigger,
          playbackCompleted,
          idleText: firstSpeechText,
          speakingStudent: speakingStudentFlag,
          sessionType: chatSessionType,
        }),
      [
        engineMode,
        lectureSpeech,
        liveSpeech,
        speakingAgentId,
        thinkingState,
        isLearnerCued,
        isTopicPending,
        chatIsStreaming,
        discussionTrigger,
        playbackCompleted,
        firstSpeechText,
        speakingStudentFlag,
        chatSessionType,
      ],
    );

    const isTopicActive = playbackView.isTopicActive;

    // A Q&A / discussion with the teacher is open: the assistant's aside does not apply
    const liveSessionOpen = !!chatSessionType || isTopicPending || chatIsSoftClosing;
    useEffect(() => {
      liveSessionOpenRef.current = liveSessionOpen;
    }, [liveSessionOpen]);
    // The learner starts typing or recording, or a new session opens: a
    // moment's countdown to the next page stops (I19)
    useEffect(() => {
      if (isPresentationInteractionActive || liveSessionOpen) cancelMomentAdvance();
    }, [cancelMomentAdvance, isPresentationInteractionActive, liveSessionOpen]);
    // A question asked now goes to the assistant (举手 says so)
    const assistantAnswersNow = shouldAssistantAnswer({
      enabled: assistantAnswersEnabled,
      assistantAgentId: assistantAgent?.id ?? null,
      asideOpen: asideSessionOpen || asideStreaming || assistantHandRaised,
      engineMode,
      liveSessionOpen,
      teacherHandPending: queuedQuestion?.status === 'queued' || handState !== null,
      pausedForVoice: false,
      presenting: isPresenting,
    });

    /**
     * Gated scene switch — if a topic is active, show AlertDialog before switching.
     * Returns true if the switch was immediate, false if gated (dialog shown).
     */
    const gatedSceneSwitch = useCallback(
      async (targetSceneId: string): Promise<boolean> => {
        const requestId = ++sceneSwitchRequestRef.current;
        if (targetSceneId === currentSceneId) {
          setPendingSceneId(null);
          return false;
        }
        if (isTopicActive) {
          setPendingSceneId(targetSceneId);
          return false;
        }
        // Before awaiting: a boundary during the await must not answer the
        // raised hand in the scene being left
        cancelQueuedQuestion();
        await chatAreaRef.current?.endActiveSession({ source: 'scene_switch' });
        if (requestId !== sceneSwitchRequestRef.current) return false;
        setCurrentSceneId(targetSceneId);
        return true;
      },
      [cancelQueuedQuestion, currentSceneId, isTopicActive, setCurrentSceneId],
    );

    /** User confirmed scene switch via AlertDialog */
    const confirmSceneSwitch = useCallback(async () => {
      if (!pendingSceneId) return;
      cancelQueuedQuestion();
      const targetSceneId = pendingSceneId;
      const requestId = ++sceneSwitchRequestRef.current;
      sceneSwitchConfirmingRef.current = true;
      setPendingSceneId(null);
      try {
        await chatAreaRef.current?.endActiveSession({ source: 'scene_switch' });
        if (requestId !== sceneSwitchRequestRef.current) return;
        doSessionCleanup();
        setCurrentSceneId(targetSceneId);
      } finally {
        sceneSwitchConfirmingRef.current = false;
      }
    }, [cancelQueuedQuestion, pendingSceneId, setCurrentSceneId, doSessionCleanup]);

    /** User cancelled scene switch via AlertDialog */
    const cancelSceneSwitch = useCallback(() => {
      sceneSwitchRequestRef.current += 1;
      setPendingSceneId(null);
    }, []);

    // play/pause toggle
    const handlePlayPause = useCallback(async () => {
      const engine = engineRef.current;
      if (!engine) return;
      // The learner takes the controls: a moment's countdown to the next page stops
      cancelMomentAdvance();

      const mode = engine.getMode();
      // Pausing with a raised hand means "answer me now": the question goes out
      // immediately (the cut line replays when the lecture resumes).
      if (mode === 'playing' && engine.flushQueuedInterrupt()) {
        // A bare hand is called now: the line stops mid-way for the learner
        if (engine.getMode() === 'paused') {
          saveSceneResumePosition(currentScene?.id, currentPlaybackActionIndexRef.current);
          if (lectureSessionIdRef.current) {
            chatAreaRef.current?.pauseBuffer(lectureSessionIdRef.current);
          }
        }
        return;
      }
      if (mode === 'playing' || mode === 'live') {
        saveSceneResumePosition(currentScene?.id, currentPlaybackActionIndexRef.current);
        engine.pause();
        // Pause lecture buffer so text stops immediately
        if (lectureSessionIdRef.current) {
          chatAreaRef.current?.pauseBuffer(lectureSessionIdRef.current);
        }
      } else if (mode === 'paused') {
        engine.resume();
        // Resume lecture buffer
        if (lectureSessionIdRef.current) {
          chatAreaRef.current?.resumeBuffer(lectureSessionIdRef.current);
        }
      } else {
        const wasCompleted = playbackCompleted;
        setPlaybackCompleted(false);
        // Starting playback - create/reuse lecture session
        const chatArea = chatAreaRef.current;
        if (currentScene && chatArea) {
          const sessionId = await chatArea.startLecture(currentScene.id);
          if (engineRef.current !== engine) {
            await chatArea.endSession(sessionId);
            return;
          }
          lectureSessionIdRef.current = sessionId;
        }
        if (engineRef.current !== engine) return;
        if (wasCompleted) {
          // Restart from beginning (user clicked restart after completion)
          lectureActionCounterRef.current = 0;
          engine.start();
        } else {
          // Continue from current position (e.g. after discussion end)
          engine.continuePlayback();
        }
      }
    }, [cancelMomentAdvance, playbackCompleted, currentScene, saveSceneResumePosition]);

    // Volume, mute, speed, auto-play, the stop rule and the primary play action
    // (resume a pending topic, else pause/resume the live answer, else the lecture)
    const controls = usePlaybackControls({
      engineMode,
      sessionType: chatSessionType,
      isTopicPending,
      isInLiveFlow: !!playbackView.isInLiveFlow,
      isLivePaused: isDiscussionPaused,
      // Don't allow pause during thinking or before text arrives
      canPauseLive: !thinkingState && !!liveSpeech,
      onResumeTopic: doResumeTopic,
      onLivePause: pauseLiveAnswer,
      onLiveResume: resumeLiveAnswer,
      onPlayPause: handlePlayPause,
    });

    // get scene information
    const isPendingScene = currentSceneId === PENDING_SCENE_ID;
    const hasNextPending = generatingOutlines.length > 0;
    // True when every outline has materialized into a scene and nothing is
    // currently generating — signals the classroom has finished and the user
    // can see a completion page. Comparing scenes.length === outlines.length
    // (rather than just `scenes.length > 0`) means a partial generation with
    // some failed outlines does not falsely trigger completion. The persisted
    // generationComplete flag also marks completion directly, so an edited
    // finished deck (e.g. a deleted slide, leaving outlines.length > scenes)
    // still reads as complete.
    const isCourseComplete =
      generationComplete ||
      (outlines.length > 0 && scenes.length === outlines.length && generatingOutlines.length === 0);
    const canAdvanceToPendingSlot = hasNextPending || isCourseComplete;

    // previous scene (gated)
    const handlePreviousScene = useCallback(() => {
      if (isPendingScene) {
        // From pending page → go to last real scene
        if (scenes.length > 0) {
          void gatedSceneSwitch(scenes[scenes.length - 1].id);
        }
        return;
      }
      const currentIndex = scenes.findIndex((s) => s.id === currentSceneId);
      if (currentIndex > 0) {
        void gatedSceneSwitch(scenes[currentIndex - 1].id);
      }
    }, [currentSceneId, gatedSceneSwitch, isPendingScene, scenes]);

    // next scene (gated)
    const handleNextScene = useCallback(() => {
      if (isPendingScene) return; // Already on pending, nowhere to go
      const currentIndex = scenes.findIndex((s) => s.id === currentSceneId);
      if (currentIndex < scenes.length - 1) {
        void gatedSceneSwitch(scenes[currentIndex + 1].id);
      } else if (canAdvanceToPendingSlot) {
        // On last real scene → advance to pending slot (generating or completion page)
        void gatedSceneSwitch(PENDING_SCENE_ID);
      }
    }, [currentSceneId, gatedSceneSwitch, canAdvanceToPendingSlot, isPendingScene, scenes]);

    const currentSceneIndex = isPendingScene
      ? scenes.length
      : scenes.findIndex((s) => s.id === currentSceneId);
    const totalScenesCount = scenes.length + (canAdvanceToPendingSlot ? 1 : 0);
    const showElementReference = piChatEnabled && coursewareReferenceEnabled && mode === 'playback';
    const canPickSlideElement = Boolean(
      showElementReference &&
      !whiteboardOpen &&
      currentScene?.type === 'slide' &&
      currentScene.content.type === 'slide',
    );
    const isHtmlBackedInteractiveScene = Boolean(
      currentScene?.type === 'interactive' &&
      currentScene.content.type === 'interactive' &&
      typeof currentScene.content.html === 'string' &&
      currentScene.content.html.trim().length > 0,
    );
    const canPickInteractiveComponent = Boolean(
      showElementReference && !whiteboardOpen && isHtmlBackedInteractiveScene,
    );
    const canPickWhiteboardElement = Boolean(
      showElementReference &&
      whiteboardOpen &&
      !whiteboardClearing &&
      displayedWhiteboardSource === 'stage_snapshot' &&
      displayedWhiteboard?.elements.length,
    );
    const canPickElement =
      canPickSlideElement || canPickInteractiveComponent || canPickWhiteboardElement;

    const handlePickWhiteboardElement = useCallback(
      (element: PPTElement) => {
        if (!elementPickActiveRef.current || !canPickWhiteboardElement || !stage) return;
        if (
          !displayedWhiteboard ||
          displayedWhiteboard.elements.filter((item) => item.id === element.id).length !== 1
        )
          return;
        setElementPickActive(false);
        const selectionVersion = ++selectionVersionRef.current;
        setDraftElementReference({
          reference: {
            kind: 'whiteboard_element',
            whiteboardId: displayedWhiteboard.id,
            elementId: element.id,
          },
          selectionVersion,
          elementType: element.type,
          displaySummary: getSlideElementPresentation(element, t).displaySummary,
        });
      },
      [
        canPickWhiteboardElement,
        stage,
        displayedWhiteboard,
        setElementPickActive,
        setDraftElementReference,
        t,
      ],
    );

    const canSendReferencedMessage = useCallback(() => {
      const reference = draftElementReferenceRef.current?.reference;
      if (reference?.kind !== 'whiteboard_element') return true;
      const canvas = useCanvasStore.getState();
      if (
        !canvas.whiteboardClearing &&
        isWhiteboardReferenceAvailable(
          reference,
          useStageStore.getState().stage,
          canvas.runtimeWhiteboardProjection,
        )
      )
        return true;
      toast.info(t('chat.elementReference.whiteboardChanged'));
      return false;
    }, [t]);

    useEffect(() => {
      if (!elementPickActive || !canPickInteractiveComponent) return;
      const onKeyDown = (event: KeyboardEvent) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        setElementPickActive(false);
      };
      // An event focused inside the sandboxed iframe is handled by its picker
      // shim. This listener covers the same Escape affordance while focus is
      // still in playback chrome after the reference button arms the iframe.
      window.addEventListener('keydown', onKeyDown, true);
      return () => window.removeEventListener('keydown', onKeyDown, true);
    }, [canPickInteractiveComponent, elementPickActive, setElementPickActive]);

    const handlePickElement = useCallback(
      (element: PPTElement) => {
        if (
          !elementPickActiveRef.current ||
          !showElementReference ||
          currentScene?.type !== 'slide' ||
          currentScene.content.type !== 'slide'
        ) {
          return;
        }
        setElementPickActive(false);
        const selectionVersion = selectionVersionRef.current + 1;
        selectionVersionRef.current = selectionVersion;
        const { displaySummary } = getSlideElementPresentation(element, t);
        setDraftElementReference({
          reference: {
            kind: 'slide_element',
            sceneId: currentScene.id,
            elementId: element.id,
          },
          selectionVersion,
          sceneOrder: currentSceneIndex >= 0 ? currentSceneIndex : currentScene.order,
          elementType: element.type,
          displaySummary,
        });
      },
      [
        currentScene,
        currentSceneIndex,
        setDraftElementReference,
        setElementPickActive,
        showElementReference,
        t,
      ],
    );

    const handlePickInteractiveComponent = useCallback(
      (pick: PlaybackInteractiveComponentPick): boolean => {
        if (
          !elementPickActiveRef.current ||
          !canPickInteractiveComponent ||
          currentScene?.type !== 'interactive' ||
          currentScene.content.type !== 'interactive' ||
          pick.sceneId !== currentScene.id
        ) {
          return false;
        }
        // Consume the owner-owned arm synchronously. The iframe host is a sibling
        // projection and may still deliver a message from its previous render
        // before React publishes the inactive state back to it.
        setElementPickActive(false);
        const selectionVersion = selectionVersionRef.current + 1;
        selectionVersionRef.current = selectionVersion;
        setDraftElementReference({
          reference: {
            kind: 'interactive_component',
            sceneId: currentScene.id,
            selector: pick.selector,
          },
          selectionVersion,
          sceneOrder: currentSceneIndex >= 0 ? currentSceneIndex : currentScene.order,
          elementType: 'interactive',
          displaySummary: pick.selector,
        });
        return true;
      },
      [
        canPickInteractiveComponent,
        currentScene,
        currentSceneIndex,
        setDraftElementReference,
        setElementPickActive,
      ],
    );
    interactivePickHandlerRef.current = handlePickInteractiveComponent;

    // Declaring a state interface adds evidence to a reference; it never replaces
    // the component picker with a whole-area reference.
    const handleToggleElementPick = useCallback(() => {
      if (!canPickElement) return;
      setElementPickActive((active) => !active);
    }, [canPickElement, setElementPickActive]);

    useEffect(() => {
      if (!canPickElement) setElementPickActive(false);
    }, [canPickElement, setElementPickActive, whiteboardOpen]);

    // An armed picker belongs to the surface it was armed on. Opening or closing
    // the whiteboard (student toggle, Teacher action, or runtime visibility) ends
    // it instead of moving it to the other surface; a selected draft is kept.
    // Layout timing keeps the destination picker from painting for a frame.
    const previousWhiteboardOpenRef = useRef(whiteboardOpen);
    useLayoutEffect(() => {
      if (previousWhiteboardOpenRef.current === whiteboardOpen) return;
      previousWhiteboardOpenRef.current = whiteboardOpen;
      setElementPickActive(false);
    }, [setElementPickActive, whiteboardOpen]);

    useEffect(() => {
      if (showElementReference) return;
      setElementPickActive(false);
      setDraftElementReference(null);
    }, [setDraftElementReference, setElementPickActive, showElementReference]);

    useEffect(() => {
      if (!onInteractivePickerChange) return;
      if (
        showElementReference &&
        isHtmlBackedInteractiveScene &&
        currentScene?.type === 'interactive'
      ) {
        const selectedSelector =
          draftElementReference?.reference.kind === 'interactive_component' &&
          draftElementReference.reference.sceneId === currentScene.id
            ? draftElementReference.reference.selector
            : undefined;
        onInteractivePickerChange({
          sceneId: currentScene.id,
          active: canPickInteractiveComponent && elementPickActive,
          selectedSelector,
        });
      } else {
        onInteractivePickerChange(null);
      }
    }, [
      canPickInteractiveComponent,
      currentScene,
      draftElementReference,
      elementPickActive,
      isHtmlBackedInteractiveScene,
      onInteractivePickerChange,
      showElementReference,
    ]);

    useEffect(
      () => () => {
        onInteractivePickerChange?.(null);
      },
      [onInteractivePickerChange],
    );

    useEffect(() => {
      const previousSceneId = elementReferenceSceneIdRef.current;
      elementReferenceSceneIdRef.current = currentSceneId;
      if (
        previousSceneId === currentSceneId ||
        draftElementReferenceRef.current?.reference.kind === 'whiteboard_element'
      )
        return;
      setDraftElementReference(null);
    }, [currentSceneId, setDraftElementReference]);

    const canJumpToAction = useCallback(
      (sceneId: string, actionIndex: number): boolean => {
        if (sceneId !== currentSceneId) return false;
        return canJumpWithinReconstructablePrefix(
          currentScene?.actions ?? [],
          currentPlaybackActionIndex,
          actionIndex,
        );
      },
      [currentPlaybackActionIndex, currentScene?.actions, currentSceneId],
    );

    const handleJumpToAction = useCallback(
      async (sceneId: string, actionIndex: number) => {
        const engine = engineRef.current;
        if (!engine || sceneId !== currentSceneId || !currentScene) return;
        const autoplay = engine.getMode() === 'playing';
        // A jump drops a raised hand (the engine clears it): give its text back
        if (engine.canJumpToAction(actionIndex)) cancelQueuedQuestion();
        const jumped = await engine.jumpToAction(actionIndex, { autoplay });
        if (!jumped) return;
        setPlaybackCompleted(false);
        updateCurrentPlaybackActionIndex(actionIndex);
        const action = currentScene.actions?.[actionIndex];
        if (action?.type === 'speech') {
          setLectureSpeech(action.text);
        }
      },
      [cancelQueuedQuestion, currentScene, currentSceneId, updateCurrentPlaybackActionIndex],
    );

    // whiteboard toggle
    const handleWhiteboardToggle = () => {
      setWhiteboardOpenManually(!whiteboardOpen);
    };

    /**
     * Bring the 互动 tab into view: a collapsed panel hides the only composer.
     * The stacked section never collapses, so the desktop setting stays put.
     */
    const revealInteraction = useCallback(() => {
      if (!stackedLayout && useSettingsStore.getState().chatAreaCollapsed) {
        setChatAreaCollapsed(false);
      }
      chatAreaRef.current?.switchToTab('interaction');
    }, [setChatAreaCollapsed, stackedLayout]);

    // The director handed the floor to the learner, or a raised hand was
    // called: show where to answer
    useEffect(() => {
      if (isLearnerCued && !isPresenting && mode === 'playback') revealInteraction();
    }, [isLearnerCued, isPresenting, mode, revealInteraction]);

    // A raised hand was called: put the caret in the composer — unless the
    // learner is busy elsewhere (focus outside the panel, or the dock while
    // presenting) or already composing (a recording keeps going)
    useEffect(() => {
      handCalledUiRef.current = () => {
        if (mode !== 'playback' || suppressHandCallFocusRef.current) return;
        if (studentComposingRef.current) return;
        const active = document.activeElement;
        const isFree = (container: HTMLElement | null) =>
          !active || active === document.body || !!container?.contains(active);
        if (isPresenting) {
          if (isFree(stageRef.current)) presentationDockRef.current?.continueText();
          return;
        }
        if (!isFree(panelRef.current)) return;
        revealInteraction();
        composerRef.current?.openTextInput();
      };
    });

    // A hand went up to the assistant: open the composer for the question —
    // the panel's, or the dock's card while presenting — without reporting
    // activation (nothing pauses)
    useEffect(() => {
      assistantHandUiRef.current = () => {
        if (mode !== 'playback') return;
        if (isPresenting) {
          presentationDockRef.current?.continueText();
          return;
        }
        revealInteraction();
        composerRef.current?.openTextInput();
      };
    });

    // A 发起讨论 offer: the lecture waits on join / skip, so put the card in
    // view (a quiz review's card too)
    const discussionTriggerId = discussionTrigger?.id ?? quizReviewOffer?.id;
    useEffect(() => {
      if (discussionTriggerId && !isPresenting && mode === 'playback') revealInteraction();
    }, [discussionTriggerId, isPresenting, mode, revealInteraction]);

    // T / V / Escape / Space for the composer (#255): in the panel, or in the
    // fullscreen dock's card (Escape closes the card, not fullscreen)
    const asrAvailable = useASRAvailable();
    useClassroomShortcuts({
      enabled: mode === 'playback',
      isComposerOpen: isPresentationInteractionActive,
      onDismiss: () => {
        if (isPresenting) presentationDockRef.current?.close();
        else composerRef.current?.dismiss();
      },
      isInLiveFlow: !!playbackView.isInLiveFlow,
      onToggleLivePause: controls.toggleLivePause,
      focusComposer: () => {
        if (isPresenting) {
          presentationDockRef.current?.openText();
          return;
        }
        revealInteraction();
        composerRef.current?.focus();
      },
      toggleVoice: () => {
        if (isPresenting) {
          presentationDockRef.current?.toggleVoice();
          return;
        }
        revealInteraction();
        composerRef.current?.toggleVoice();
      },
      canUseVoice: asrAvailable,
      // The composer's 举手 slot (in the panel, or the dock's card): its
      // status row shows the hand
      toggleHand: () => {
        if (!isPresenting) revealInteraction();
        composerRef.current?.toggleHand();
      },
    });

    const isPresentationShortcutTarget = useCallback((target: EventTarget | null) => {
      if (!(target instanceof HTMLElement)) return false;

      if (target.isContentEditable || target.closest('[contenteditable="true"]')) {
        return true;
      }

      return (
        target.closest(
          ['input', 'textarea', 'select', '[role="slider"]', 'input[type="range"]'].join(', '),
        ) !== null
      );
    }, []);

    useEffect(() => {
      const onKeyDown = (event: KeyboardEvent) => {
        if (event.defaultPrevented) return;
        // Let modifier-key combos (Ctrl+C, Ctrl+S, etc.) pass through to the browser
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        if (
          isPresentationShortcutTarget(event.target) ||
          isPresentationShortcutTarget(document.activeElement)
        ) {
          return;
        }

        switch (event.key) {
          case 'ArrowLeft':
            if (!isPresenting) return;
            event.preventDefault();
            handlePreviousScene();
            resetPresentationIdleTimer();
            break;
          case 'ArrowRight':
            if (!isPresenting) return;
            event.preventDefault();
            handleNextScene();
            resetPresentationIdleTimer();
            break;
          case ' ':
          case 'Spacebar':
            // During active QA/discussion, the classroom shortcuts
            // (useClassroomShortcuts) own Space for buffer-level
            // pause/resume — don't also fire engine play/pause.
            if (chatSessionType === 'qa' || chatSessionType === 'discussion') break;
            // A focused control (举手, a dock toggle, ...) keeps Space for its
            // own activation instead of pausing the lecture
            if (isSpaceActivatedTarget(event.target)) break;
            event.preventDefault();
            handlePlayPause();
            break;
          case 'Escape':
            // With keyboard.lock(), Escape no longer auto-exits fullscreen.
            // While composing, the classroom shortcuts close the composer card.
            // Otherwise, manually exit fullscreen.
            if (isPresenting && !isPresentationInteractionActive) {
              event.preventDefault();
              togglePresentation();
            }
            break;
          case 'ArrowUp':
            event.preventDefault();
            setTTSVolume(ttsVolume + 0.1);
            break;
          case 'ArrowDown':
            event.preventDefault();
            setTTSVolume(ttsVolume - 0.1);
            break;
          case 'm':
          case 'M':
            event.preventDefault();
            setTTSMuted(!ttsMuted);
            break;
          case 's':
          case 'S':
            // Fullscreen keeps both panels collapsed (the dock replaces them)
            if (isPresenting) return;
            event.preventDefault();
            // Stacked: the scenes live in the section's 场景 tab. Tablet
            // landscape toggles between the rail and the full sidebar.
            if (stackedLayout) chatAreaRef.current?.switchToTab('scenes');
            else if (touchLayout) setRailSidebarOpen((open) => !open);
            else setSidebarCollapsed(!sidebarCollapsed);
            break;
          case 'c':
          case 'C':
            if (isPresenting) return;
            event.preventDefault();
            // The stacked section cannot collapse: C brings 互动 to the front
            if (stackedLayout) chatAreaRef.current?.switchToTab('interaction');
            else setChatAreaCollapsed(!chatAreaCollapsed);
            break;
          default:
            break;
        }
      };

      window.addEventListener('keydown', onKeyDown);
      return () => window.removeEventListener('keydown', onKeyDown);
    }, [
      chatSessionType,
      chatAreaCollapsed,
      handleNextScene,
      handlePlayPause,
      handlePreviousScene,
      isPresenting,
      isPresentationInteractionActive,
      isPresentationShortcutTarget,
      resetPresentationIdleTimer,
      setChatAreaCollapsed,
      setSidebarCollapsed,
      setTTSMuted,
      setTTSVolume,
      sidebarCollapsed,
      stackedLayout,
      togglePresentation,
      touchLayout,
      ttsMuted,
      ttsVolume,
    ]);

    // Intercept F11 to use our presentation fullscreen instead of browser fullscreen
    // This way ESC can exit fullscreen (browser F11 fullscreen requires F11 to exit)
    useEffect(() => {
      const onF11 = (event: KeyboardEvent) => {
        if (event.key === 'F11') {
          event.preventDefault();
          togglePresentation();
        }
      };

      window.addEventListener('keydown', onF11);
      return () => window.removeEventListener('keydown', onF11);
    }, [togglePresentation]);

    // Map engine mode to the CanvasArea's expected engine state
    const canvasEngineState = (() => {
      switch (engineMode) {
        case 'playing':
        case 'live':
          return 'playing';
        case 'paused':
          return 'paused';
        default:
          return 'idle';
      }
    })();

    // Build discussion request for the ProactiveCard from trigger — or, with
    // no lecture moment waiting, from a quiz review offer (no opener)
    const discussionRequest: DiscussionAction | null = discussionTrigger
      ? {
          type: 'discussion',
          id: discussionTrigger.id,
          topic: discussionTrigger.question,
          prompt: discussionTrigger.prompt,
          agentId: discussionTrigger.agentId,
        }
      : quizReviewOffer
        ? { type: 'discussion', id: quizReviewOffer.id, topic: quizReviewOffer.topic }
        : null;
    // What the card offers: the teacher's question to the whole class (I10)
    // or a quiz review (I11); otherwise a classmate's (or a called-on) moment
    const discussionOffer: 'ask-learner' | 'quiz-review' | undefined = discussionTrigger
      ? currentLectureMomentKind(discussionTrigger.agentId, discussionTrigger.question, t) ===
        'ask-learner'
        ? 'ask-learner'
        : undefined
      : quizReviewOffer
        ? 'quiz-review'
        : undefined;
    // A question put to the class waits for the learner (I10.2), and so does a
    // quiz review: neither card skips itself, and both offer 跳过. Page
    // autoplay is the learner's own preference, not a sign nobody is watching,
    // and a hidden page already freezes a countdown, so only a classmate's
    // moment keeps one.
    const discussionAutoSkip = discussionOffer === undefined;

    // The teacher caption sits under slides only: interactive / quiz / PBL
    // scenes are full-bleed, pending / complete pages have no line, and the
    // presentation overlay speaks for it in fullscreen
    const showCaption = !isPresenting && !isPendingScene && currentScene?.type === 'slide';
    const sessionTypeForUi =
      chatSessionType === 'qa' ? 'qa' : chatSessionType === 'discussion' ? 'discussion' : undefined;

    // The raised hand's progress bar polls the line in flight
    const getSpeechProgress = useCallback(
      () => engineRef.current?.getSpeechProgress?.() ?? null,
      [],
    );

    /**
     * A question from the composer: to the teaching assistant while it answers
     * during the lecture, else raise a hand mid-line, else send it now.
     */
    const handleMessageSend = (msg: string): MessageSendResult => {
      const draft = showElementReference ? draftElementReferenceRef.current : null;
      const elementReferenceSnapshot: ElementReferenceSendSnapshot | undefined = draft
        ? {
            reference: draft.reference,
            selectionVersion: draft.selectionVersion,
          }
        : undefined;
      // The assistant answers on the side: the lecture is not paused or
      // interrupted (and a voice question's pause is undone)
      const assistantAgentId = resolveAssistantRoute(msg);
      if (assistantAgentId) {
        sendToAssistant(msg, assistantAgentId, elementReferenceSnapshot);
        return;
      }
      // The teacher answers: a recording's pause is now the Q&A's
      assistantVoicePauseRef.current = null;
      // While the lecture plays, the question raises a hand: the
      // teacher finishes the current line, then answers it.
      const raised = raiseHand(msg, elementReferenceSnapshot);
      if (raised) return raised;
      // Called while idle (raised before Play): the question takes the floor.
      // Paused or playing, handleUserInterrupt below ends the hand's turn.
      if (engineRef.current?.getHandState() === 'called' && engineMode === 'idle') {
        engineRef.current.lowerHand();
        refreshHandState();
      }
      // Sent now: supersedes an unsent raised hand (e.g. one that
      // Pro mode gave back into the input)
      forgetUnsentQuestion();
      // Always clear Level-1 pause state — the closure may hold a stale
      // isDiscussionPaused value (e.g. voice input's onTranscription callback
      // captures onMessageSend before React re-renders with the updated state).
      setIsDiscussionPaused(false);
      // Clear the sticky livePausedRef so the next agent-loop buffer
      // starts unpaused. (pauseActiveLiveBuffer sets a ref that new
      // buffers inherit — must be cleared before sendMessage creates one.)
      chatAreaRef.current?.resumeActiveLiveBuffer();
      // Flush any buffered / in-flight TTS audio from the previous
      // agent turn so it doesn't leak into the next round.
      discussionTTS.cleanup();
      // Clear soft-paused state — user is continuing the topic
      if (isTopicPending) {
        setIsTopicPending(false);
        setLiveSpeech(null);
        setSpeakingAgentId(null);
      }
      setChatIsSoftClosing(false);
      // User interrupts during playback — handleUserInterrupt triggers
      // onUserInterrupt callback which already calls sendMessage, so skip
      // the direct sendMessage below to avoid sending twice.
      // Include 'paused' because onInputActivate pauses the engine before
      // the user finishes typing — without this the interrupt position
      // would never be saved and resuming after QA skips to the next sentence.
      if (
        engineRef.current &&
        (engineMode === 'playing' || engineMode === 'live' || engineMode === 'paused')
      ) {
        pendingInterruptElementReferenceRef.current = elementReferenceSnapshot;
        try {
          engineRef.current.handleUserInterrupt(msg);
        } finally {
          pendingInterruptElementReferenceRef.current = undefined;
        }
      } else {
        void sendMessageWithElementReference(msg, elementReferenceSnapshot);
      }
      markQuestionSent();
    };

    /** Which input became active: text keeps the lecture going, voice pauses it. */
    const handleInputActivate = (kind: 'text' | 'voice') => {
      // The learner speaks up: a moment's countdown to the next page stops
      cancelMomentAdvance();
      // Level-1 pause: freeze buffer tick + TTS audio while SSE keeps buffering.
      // User resumes manually via Space / pause button after closing the input.
      // No isDiscussionPaused guard — always attempt to pause the buffer.
      // The return value ensures UI state stays in sync with buffer state.
      if (chatSessionType === 'qa' || chatSessionType === 'discussion') {
        pauseLiveAnswer();
      }
      // Also pause playback engine — except typing during the lecture:
      // a text question raises a hand and waits for the line, while
      // voice must pause so the microphone doesn't record the teacher.
      const engine = engineRef.current;
      const mode = engine?.getMode();
      // A voice question for the assistant pauses the lecture only while
      // recording (the mic would pick up the teacher): resumed once it is
      // sent or dropped (onVoiceEnd)
      const forAssistant =
        !!engine && mode === 'playing' && kind === 'voice' && !!resolveAssistantRoute();
      // Voice stops the lecture like the pause button does: the text reveal
      // freezes with the audio, and a reload resumes from here
      const freezeLecture = () => {
        saveSceneResumePosition(currentScene?.id, currentPlaybackActionIndexRef.current);
        if (lectureSessionIdRef.current) {
          chatAreaRef.current?.pauseBuffer(lectureSessionIdRef.current);
        }
      };
      if (engine && mode === 'playing' && kind === 'voice' && engine.getHandState() === 'raised') {
        // Speaking up with a hand raised: it is called now (pause = at once),
        // and the recording keeps focus
        suppressHandCallFocusRef.current = true;
        try {
          engine.flushQueuedInterrupt();
        } finally {
          suppressHandCallFocusRef.current = false;
        }
        if (engine.getMode() === 'paused') freezeLecture();
        return;
      }
      if (engine && mode === 'live') {
        engine.pause();
      } else if (engine && mode === 'playing' && kind === 'voice') {
        engine.pause();
        freezeLecture();
        if (forAssistant) assistantVoicePauseRef.current = engine;
      }
    };

    // The fullscreen dock's side of a send (no-ops while the dock is not mounted)
    const showPresentationUserMessage = useCallback(
      (text: string) => presentationDockRef.current?.showUserMessage(text),
      [],
    );
    const closePresentationComposer = useCallback(
      () => presentationDockRef.current?.closeAfterSend(),
      [],
    );

    const elementReferenceChip = draftElementReference
      ? describeElementReferenceChip(draftElementReference, t)
      : undefined;

    // The discussion offer's agent, as the participants list names it
    const discussionParticipant = discussionRequest
      ? participants.find((p) => p.id === discussionRequest.agentId)
      : undefined;
    const discussionAgentConfig = discussionRequest
      ? useAgentRegistry.getState().getAgent(discussionRequest.agentId || '')
      : undefined;
    // The teacher opened the moment (a question to the class, or calling on a
    // classmate): the card words its offer as the teacher's question
    const discussionOpenedByTeacher = discussionAgentConfig?.role === 'teacher';
    // A classmate offering a moment wants to speak (想发言); the teacher who
    // opens one is putting a question to the class, as the card says, and
    // their tile keeps their role
    const offeringAgentId =
      discussionRequest?.agentId ??
      (handState === 'called' ? deferredDiscussion?.agentId : undefined);
    const wantsToSpeakAgentId =
      offeringAgentId && useAgentRegistry.getState().getAgent(offeringAgentId)?.role !== 'teacher'
        ? offeringAgentId
        : undefined;
    // The offer while its card is out of sight (another tab, a collapsed
    // panel): the opener's avatar points at it
    const discussionOfferName = discussionParticipant?.name || discussionAgentConfig?.name;
    const pendingOffer = discussionRequest
      ? {
          name: discussionOfferName,
          avatar: discussionParticipant?.avatar || discussionAgentConfig?.avatar,
          label:
            discussionOffer === 'quiz-review'
              ? t('proactiveCard.reviewOfferLabel')
              : discussionOfferName
                ? t(
                    discussionOpenedByTeacher || discussionOffer === 'ask-learner'
                      ? 'proactiveCard.teacherOfferLabel'
                      : 'proactiveCard.offerLabel',
                    { name: discussionOfferName },
                  )
                : t('proactiveCard.discussion'),
        }
      : null;

    /**
     * "Ask them" on a classmate card (I23): the composer comes into view,
     * addressed to that person ("@Name "), with the caret in it.
     */
    const askAgent = useCallback(
      (agentId: string) => {
        const person = participants.find((participant) => participant.id === agentId);
        if (!person) return;
        revealInteraction();
        composerRef.current?.mention(person.name);
      },
      [participants, revealInteraction],
    );

    /** Who an agent is, for the notes' class moments (no id: the classroom's teacher) */
    const describeMomentAgent = useCallback(
      (agentId?: string) => {
        const id = agentId ?? currentClassroomTeacherId();
        if (!id) return undefined;
        const participant = participants.find((p) => p.id === id);
        const config = useAgentRegistry.getState().getAgent(id);
        const name = participant?.name || config?.name;
        return name ? { name, avatar: participant?.avatar || config?.avatar } : undefined;
      },
      [participants],
    );

    /**
     * 现在聊聊 on a class moment the learner let pass (the notes, I07): it
     * opens now, as the card would have, with its opener and words. A lecture
     * playing is interrupted like a question (resumed after), and the moment's
     * badge says it was joined. It never moves the course on by itself.
     */
    const handleDiscussMoment = (moment: LectureNoteMoment) => {
      if (liveSessionOpenRef.current) return;
      cancelMomentAdvance();
      // A raised hand's question goes back into the input
      cancelQueuedQuestion();
      const engine = engineRef.current;
      const mode = engine?.getMode();
      // Interrupted like a question sent now (handleMessageSend)
      if (engine && (mode === 'playing' || mode === 'paused')) {
        if (!engine.beginLearnerDiscussion()) return;
      }
      lectureMomentLiveRef.current = false;
      chatAreaRef.current?.recordLectureMoment(
        moment.sceneId,
        {
          type: 'discussion',
          id: moment.actionId,
          topic: moment.topic,
          ...(moment.prompt ? { prompt: moment.prompt } : {}),
          ...(moment.agentId ? { agentId: moment.agentId } : {}),
        },
        { agentId: moment.agentId ?? currentClassroomTeacherId(), outcome: 'joined' },
      );
      void handleDiscussionSSE(moment.topic, moment.prompt, moment.agentId);
    };

    /**
     * 一起复盘 on a quiz review offer (I11): it opens now like a moment from the
     * notes — a lecture playing is interrupted as by a question — with no
     * opener (the director picks) and the client's summary as its words. It
     * never moves the course on by itself.
     */
    const startQuizReview = (offer: QuizReviewOffer) => {
      setQuizReviewOffer(null);
      if (useStageStore.getState().currentSceneId !== offer.sceneId) return;
      cancelMomentAdvance();
      cancelQueuedQuestion();
      const engine = engineRef.current;
      const playbackMode = engine?.getMode();
      if (engine && (playbackMode === 'playing' || playbackMode === 'paused')) {
        if (!engine.beginLearnerDiscussion()) return;
      }
      lectureMomentLiveRef.current = false;
      void handleDiscussionSSE(offer.topic, offer.prompt, undefined, {
        momentKind: 'quiz-review',
      });
    };

    // The card's buttons, whatever it offers: a lecture moment goes through
    // the engine (a whole-class question with the learner's choice), a quiz
    // review starts or goes away by itself
    const offerHandlers = {
      onListen: () => {
        if (discussionTrigger) {
          if (discussionOffer === 'ask-learner') joinAskLearner('listen');
          else engineRef.current?.confirmDiscussion();
        } else if (quizReviewOffer) {
          startQuizReview(quizReviewOffer);
        }
      },
      onAnswer: () => joinAskLearner('answer'),
      onSkip: () => {
        if (discussionTrigger) engineRef.current?.skipDiscussion();
        else setQuizReviewOffer(null);
      },
      onAutoSkip: () => engineRef.current?.skipDiscussion({ auto: true }),
    };

    // The stream's hand-raise rows: the hand, the queued question, the call
    const deferredDiscussionAgentName = deferredDiscussion?.agentId
      ? participants.find((p) => p.id === deferredDiscussion.agentId)?.name ||
        useAgentRegistry.getState().getAgent(deferredDiscussion.agentId)?.name
      : undefined;
    // A called hand is the teacher's call; the director's cue names its
    // agent, a classmate asking the learner included (I31)
    const streamCueSpeaker = resolveCueSpeaker({
      cued: isLearnerCued,
      handCalled: handState === 'called',
      cueAgentId,
      participants,
      getAgent: (id) => useAgentRegistry.getState().getAgent(id),
      fallback: { name: t('roundtable.teacher'), avatar: DEFAULT_TEACHER_AVATAR },
    });
    // The director's cue (not a called hand) says what it is: its question to
    // the learner, or a neutral hand-back — never "the class is paused" (I10.4)
    const isDirectorCue = isCueUser && handState !== 'called';
    const cueStatusText = isDirectorCue
      ? cuePrompt
        ? t('stage.composer.cueAsked', { name: streamCueSpeaker?.name ?? t('roundtable.teacher') })
        : t('stage.composer.cueHandBack')
      : undefined;
    // "Let me think" is the learner's own time, not a message; the others are
    // sent as the learner's reply
    const cueQuickReplies = [
      t('stage.handRaise.cueReplies.unsure'),
      t('stage.handRaise.cueReplies.hint'),
    ];
    const thinkAboutCue = () => {
      revealInteraction();
      composerRef.current?.focus();
    };
    const showHandStreamStatus =
      handState !== null ||
      assistantHandRaised ||
      queuedQuestion?.status === 'queued' ||
      streamCueSpeaker !== null;
    // The assistant's rows in the stream: its invitation while a hand is up
    // to it, then 助教正在回答… until its answer's bubble starts
    // Who answers on the side: the classmate the learner named (@), else the assistant
    const asideAgentConfig =
      (asideAgentId ? selectedAgents.find((agent) => agent.id === asideAgentId) : undefined) ??
      assistantAgent ??
      undefined;
    const asideParticipant = asideAgentConfig
      ? participants.find((p) => p.id === asideAgentConfig.id)
      : undefined;
    const assistantStreamStatus: 'prompt' | 'answering' | null =
      asideStreaming && !asideSpeakingAgentId && asideAgentConfig
        ? 'answering'
        : assistantHandRaised && assistantAgent
          ? 'prompt'
          : null;
    // The one answering on the side (回答中 on their participant tile)
    const asideAnsweringAgentId = asideStreaming
      ? (asideSpeakingAgentId ?? asideAgentConfig?.id ?? null)
      : null;

    // The stacked chrome is off while presenting: fullscreen shows the stage
    // and the dock, whatever the classroom's width
    const stackedChrome = stackedLayout && !isPresenting;
    const keyboardInset = useVisualViewportInset(stackedChrome && mode === 'playback');
    const onlineCount = participants.filter((p) => p.isOnline).length;

    const controlBar = (
      <ControlBar
        variant={isPresenting ? 'floating' : 'bar'}
        density={touchLayout ? 'touch' : 'default'}
        // Touch moves "n / m" into the header; keep it here when there is none
        showPageCounter={!touchLayout || isPresenting || hideHeader}
        // Phone: speed / volume / auto-play fold into a ⋯ sheet, which has to
        // portal into the fullscreen element while presenting
        condensed={phoneLayout}
        portalContainer={isPresenting ? stageRef.current : undefined}
        currentSceneIndex={currentSceneIndex}
        scenesCount={totalScenesCount}
        engineState={canvasEngineState}
        showStop={controls.showStop}
        stopKind={controls.stopKind}
        onStop={handleStopDiscussion}
        livePaused={isDiscussionPaused}
        canToggleLivePause={controls.canToggleLivePause}
        onToggleLivePause={controls.toggleLivePause}
        onPrev={handlePreviousScene}
        onNext={handleNextScene}
        onPlayPause={controls.primaryAction}
        whiteboardOpen={whiteboardOpen}
        onToggleWhiteboard={handleWhiteboardToggle}
        isPresenting={isPresenting}
        onTogglePresentation={togglePresentation}
        ttsEnabled={controls.ttsEnabled}
        ttsMuted={controls.ttsMuted}
        ttsVolume={controls.ttsVolume}
        onToggleMute={controls.toggleMute}
        onVolumeChange={controls.setTTSVolume}
        autoPlayLecture={controls.autoPlayLecture}
        onToggleAutoPlay={controls.toggleAutoPlay}
        playbackSpeed={controls.playbackSpeed}
        onCycleSpeed={controls.cycleSpeed}
        showElementReference={showElementReference}
        canPickElement={canPickElement}
        elementPickActive={elementPickActive}
        onToggleElementPick={handleToggleElementPick}
      />
    );

    return (
      <div
        ref={stageRef}
        className={cn(
          'flex-1 flex overflow-hidden bg-page',
          // Stacked: header, stage and control bar over the interaction section
          stackedChrome && 'flex-col',
          isPresenting && !controlsVisible && 'cursor-none',
        )}
        // Lift the section's composer above the on-screen keyboard
        style={keyboardInset > 0 ? { paddingBottom: keyboardInset } : undefined}
      >
        {/* Stacked layouts show the scenes in the section's 场景 tab instead.
          The slot stays in place so the column and the panel never remount */}
        {!stackedLayout && (
          <SceneSidebar
            {...(touchLayout
              ? {
                  variant: railSidebarOpen ? 'sidebar' : 'rail',
                  density: 'touch',
                  collapsed: isPresenting,
                  onCollapseChange: (collapsed: boolean) => setRailSidebarOpen(!collapsed),
                }
              : { collapsed: sidebarCollapsed, onCollapseChange: setSidebarCollapsed })}
            onSceneSelect={gatedSceneSwitch}
            onRetryOutline={onRetryOutline}
            isCourseComplete={isCourseComplete}
          />
        )}

        {/* Main Content Area. Stacked, it is as tall as its content (the stage
          sizes itself from the width) and gives way — the stage clips — only
          when the section below would otherwise lose its composer */}
        <div
          className={cn(
            'flex flex-col overflow-hidden min-w-0 relative',
            stackedChrome ? 'min-h-0' : 'flex-1',
          )}
        >
          {/* Header — playback only. The Pro Switch fires `onEnterProMode`
            (passed by the parent Stage) which awaits our `teardown()`
            before the parent flips mode to 'edit'. */}
          {!isPresenting && !hideHeader && (
            <Header
              currentSceneTitle={
                currentScene?.title ||
                (isCourseComplete && isPendingScene ? t('stage.courseComplete') : '')
              }
              mode={mode}
              proModeActive={proModeActive}
              canEdit={!!canEnterProMode}
              onToggleEditMode={onEnterProMode}
              backControl={headerBackControl}
              hideBackControl={hideHeaderBackControl}
              hideGlobalControls={hideHeaderGlobalControls}
              hideCourseActions={hideHeaderCourseActions}
              layout={phoneLayout ? 'phone' : touchLayout ? 'compact' : 'default'}
              sceneIndex={currentSceneIndex}
              sceneCount={totalScenesCount}
            />
          )}

          {/* Canvas Area — playback-only renderer. The parent Stage swaps
            this whole PlaybackChromeRoot out when entering edit mode, so
            no inline branching is needed here. */}
          {/* Stacked, the canvas sizes itself from the width (see CanvasArea's
            `stacked`) and may clip when the section below needs the room. One
            element either way: entering fullscreen must not remount the scene */}
          <div
            className={
              stackedChrome
                ? 'overflow-hidden relative min-h-0 isolate'
                : 'overflow-hidden relative flex-1 min-h-0 isolate'
            }
            suppressHydrationWarning
          >
            {/* A quiz graded here with wrong answers offers a review moment (I11) */}
            <QuizReviewContext.Provider value={handleQuizReviewed}>
              <CanvasArea
                stacked={stackedChrome ? (phoneLayout ? 'phone' : 'stacked') : undefined}
                currentScene={currentScene}
                mode={mode}
                engineState={canvasEngineState}
                isLiveSession={
                  chatIsStreaming ||
                  chatIsSoftClosing ||
                  isTopicPending ||
                  engineMode === 'live' ||
                  !!chatSessionType
                }
                whiteboardOpen={whiteboardOpen}
                onPlayPause={handlePlayPause}
                onWhiteboardClose={handleWhiteboardToggle}
                pageNumber={currentSceneIndex + 1}
                isPresenting={isPresenting}
                elementPickActive={elementPickActive}
                onPickElement={handlePickElement}
                whiteboardElementReference={
                  showElementReference &&
                  draftElementReference?.reference.kind === 'whiteboard_element'
                    ? draftElementReference.reference
                    : undefined
                }
                onPickWhiteboardElement={handlePickWhiteboardElement}
                onCancelElementPick={() => setElementPickActive(false)}
                isPendingScene={isPendingScene}
                isCourseComplete={isCourseComplete}
                isGenerationFailed={
                  isPendingScene && failedOutlines.some((f) => f.id === generatingOutlines[0]?.id)
                }
                isGenerationInterrupted={isPendingScene && generationInterrupted}
                onRetryGeneration={
                  onRetryOutline && generatingOutlines[0]
                    ? () => onRetryOutline(generatingOutlines[0].id)
                    : undefined
                }
                caption={
                  showCaption ? (
                    <CaptionStrip
                      playbackView={playbackView}
                      participants={participants}
                      speakingAgentId={speakingAgentId}
                      currentSpeech={liveSpeech}
                      lectureSpeech={lectureSpeech}
                      idleText={firstSpeechText}
                      playbackCompleted={playbackCompleted}
                      isStreaming={chatIsStreaming}
                      sessionType={sessionTypeForUi}
                      thinkingState={thinkingState}
                      isCueUser={isLearnerCued}
                      isTopicPending={isTopicPending}
                      isLivePaused={isDiscussionPaused}
                      // A soft close back to the lecture, or a moment's end
                      // counting down to the next page (I19)
                      lectureResumeDeadline={lectureResumeDeadline ?? momentAdvanceDeadline}
                      audioIndicatorState={audioIndicatorState}
                      audioAgentId={audioAgentId}
                      isDrawingOnBoard={whiteboardOpen && whiteboardDrawing !== null}
                      // The stage column sets the height: 92px, 108px beside the PiP
                      className="h-full"
                    />
                  ) : null
                }
              />
            </QuizReviewContext.Provider>
          </div>

          {/* Re-open handles for collapsed side panels (the S / C keys work too) */}
          {!isPresenting && !touchLayout && sidebarCollapsed && (
            <button
              type="button"
              onClick={() => setSidebarCollapsed(false)}
              aria-label={t('stage.expandSceneSidebar')}
              title={t('stage.expandSceneSidebar')}
              className="absolute left-0 top-1/2 z-30 flex h-12 w-3 -translate-y-1/2 items-center justify-center rounded-r-md border border-l-0 border-line bg-background/90 text-icon-muted transition-colors hover:w-4 hover:text-fg"
            >
              <ChevronRight className="size-3 shrink-0" />
            </button>
          )}
          {!isPresenting && !stackedLayout && chatAreaCollapsed && (
            <button
              type="button"
              onClick={() => setChatAreaCollapsed(false)}
              aria-label={t('stage.expandInteractionPanel')}
              title={t('stage.expandInteractionPanel')}
              className={cn(
                'absolute right-0 top-1/2 z-30 flex -translate-y-1/2 items-center justify-center rounded-l-md border border-r-0 border-line bg-background/90 text-icon-muted transition-colors hover:text-fg',
                // A 44px tab for touch: the persisted collapse can carry over from
                // desktop, and without a keyboard (no C key) this is the way back
                touchLayout ? 'h-14 w-11' : 'h-12 w-3 hover:w-4',
              )}
            >
              <ChevronLeft className={cn('shrink-0', touchLayout ? 'size-[18px]' : 'size-3')} />
            </button>
          )}
          {/* A class moment's card waits in the collapsed panel (its countdown
            frozen): its opener's avatar beside the handle opens it */}
          {mode === 'playback' &&
            !isPresenting &&
            !stackedLayout &&
            chatAreaCollapsed &&
            pendingOffer && (
              <button
                type="button"
                data-testid="collapsed-offer-hint"
                onClick={revealInteraction}
                aria-label={pendingOffer.label}
                title={pendingOffer.label}
                className={cn(
                  'absolute top-1/2 z-30 flex -translate-y-1/2 items-center justify-center rounded-full bg-background ring-2 ring-amber-500 shadow-[0_4px_16px_rgba(0,0,0,0.12)] transition-transform hover:scale-105 cursor-pointer',
                  touchLayout ? 'right-14 size-11' : 'right-5 size-9',
                )}
              >
                <span
                  aria-hidden="true"
                  className="absolute inset-0 animate-ping rounded-full bg-amber-400 opacity-40"
                />
                <span className="relative size-full overflow-hidden rounded-full">
                  {pendingOffer.avatar ? (
                    <AvatarDisplay src={pendingOffer.avatar} alt="" />
                  ) : (
                    <span className="block size-full bg-amber-500" />
                  )}
                </span>
              </button>
            )}

          {/* Fullscreen: the speech overlay, the auto-hiding control bar and
            the dock that holds the composer. Otherwise the control bar is the
            48px strip at the foot of the main column, and the interaction
            panel holds participants and the composer. */}
          {mode === 'playback' && isPresenting ? (
            <PresentationDock
              dockRef={presentationDockRef}
              participants={participants}
              playbackView={playbackView}
              speakingAgentId={speakingAgentId}
              currentSpeech={liveSpeech}
              lectureSpeech={lectureSpeech}
              idleText={firstSpeechText}
              playbackCompleted={playbackCompleted}
              isStreaming={chatIsStreaming}
              sessionType={sessionTypeForUi}
              thinkingState={thinkingState}
              isCueUser={isLearnerCued}
              isTopicPending={isTopicPending}
              isLivePaused={isDiscussionPaused}
              engineMode={engineMode}
              audioIndicatorState={audioIndicatorState}
              onBubbleClick={controls.primaryAction}
              controlBar={controlBar}
              controlsVisible={controlsVisible}
              composerSlot={<ComposerSlot host={composerHost} active />}
              composerRef={composerRef}
              isComposing={isComposerComposing}
              hasRaisedHand={
                queuedQuestion?.status === 'queued' || handState === 'raised' || assistantHandRaised
              }
              cueQuestion={
                // The director's question stays readable in fullscreen, with its replies
                isDirectorCue && cuePrompt ? (
                  <HandRaiseStreamStatus
                    cueSpeaker={streamCueSpeaker}
                    directorCue={{ prompt: cuePrompt }}
                    quickReplies={cueQuickReplies}
                    onQuickReply={(text) => void handleMessageSend(text)}
                    thinkReply={t('stage.handRaise.cueReplies.think')}
                    onThink={() => presentationDockRef.current?.openText()}
                  />
                ) : undefined
              }
              onInteractionChange={setIsDockInteractionActive}
              discussionRequest={discussionRequest}
              discussionAgent={discussionAgentConfig}
              discussionOffer={discussionOffer}
              discussionAutoSkip={discussionAutoSkip}
              onDiscussionStart={offerHandlers.onListen}
              onDiscussionAnswer={offerHandlers.onAnswer}
              onDiscussionSkip={offerHandlers.onSkip}
              onDiscussionAutoSkip={offerHandlers.onAutoSkip}
              discussionCountdownHeld={announcement.holding}
              portalContainerRef={stageRef}
            />
          ) : isPresenting ? (
            <div
              className={cn(
                'pointer-events-none absolute inset-x-0 bottom-3 z-30 flex justify-center px-4 transition-all duration-300',
                controlsVisible ? 'translate-y-0 opacity-100' : 'translate-y-2 opacity-0',
              )}
            >
              <div className={cn('max-w-full', controlsVisible && 'pointer-events-auto')}>
                {controlBar}
              </div>
            </div>
          ) : (
            controlBar
          )}
        </div>

        {/* Chat Area — playback / autonomous always renders it here; Pro
          (edit) mode unmounts this whole PlaybackChromeRoot, so the
          edit branch has no chat. */}
        <div
          ref={panelRef}
          className={cn('flex', stackedChrome ? 'w-full flex-1 flex-col' : 'shrink-0')}
        >
          <ClassmateAskContext.Provider value={mode === 'playback' ? askAgent : null}>
            <ChatArea
              ref={chatAreaRef}
              width={touchLayout ? TOUCH_PANEL_WIDTH : chatAreaWidth}
              onWidthChange={setChatAreaWidth}
              density={touchLayout ? 'touch' : 'default'}
              layout={stackedLayout ? (phoneLayout ? 'phone' : 'stacked') : 'panel'}
              // The stacked section ignores the persisted collapse; fullscreen hides it
              collapsed={stackedLayout ? isPresenting : chatAreaCollapsed}
              onCollapseChange={stackedLayout ? undefined : setChatAreaCollapsed}
              onlineCount={stackedLayout ? onlineCount : undefined}
              // 场景: the sidebar's titled thumbnails as a two-column grid
              scenes={
                stackedLayout ? (
                  <SceneSidebar
                    variant="grid"
                    collapsed={false}
                    onCollapseChange={() => undefined}
                    onSceneSelect={gatedSceneSwitch}
                    onRetryOutline={onRetryOutline}
                    isCourseComplete={isCourseComplete}
                  />
                ) : undefined
              }
              activeBubbleId={activeBubbleId}
              onActiveBubble={(id) => setActiveBubbleId(id)}
              // A class moment's card waiting out of sight, and the notes' moments
              pendingOffer={mode === 'playback' && !isPresenting ? pendingOffer : null}
              describeAgent={describeMomentAgent}
              onDiscussMoment={mode === 'playback' ? handleDiscussMoment : undefined}
              canDiscussMoment={!liveSessionOpen}
              currentSceneId={currentSceneId}
              currentActionIndex={currentPlaybackActionIndex}
              canJumpToAction={canJumpToAction}
              onJumpToAction={(sceneId, actionIndex) => {
                void handleJumpToAction(sceneId, actionIndex);
              }}
              onLiveSpeech={(text, agentId) => {
                // Capture epoch at call time — discard if scene has changed since
                const epoch = sceneEpochRef.current;
                // Use queueMicrotask to let any pending scene-switch reset settle first
                queueMicrotask(() => {
                  if (sceneEpochRef.current !== epoch) return; // stale — scene changed
                  setLiveSpeech(text);
                  if (agentId !== undefined) {
                    setSpeakingAgentId(agentId);
                  }
                  if (text !== null || agentId) {
                    setChatIsStreaming(true);
                    setChatSessionType(chatAreaRef.current?.getActiveSessionType?.() ?? null);
                    setIsTopicPending(false);
                  } else if (text === null && agentId === null) {
                    setChatIsStreaming(false);
                    // Don't clear chatSessionType here — it's needed by the stop
                    // button when director cues user (cue_user → done → liveSpeech null).
                    // It gets properly cleared in doSessionCleanup and scene change.
                  }
                });
              }}
              onThinking={(state) => {
                const epoch = sceneEpochRef.current;
                queueMicrotask(() => {
                  if (sceneEpochRef.current !== epoch) return;
                  setThinkingState(state);
                });
              }}
              onCueUser={(fromAgentId, prompt) => {
                setIsCueUser(true);
                setCueAgentId(fromAgentId ?? null);
                // The question the last line asked the learner, if it asked one
                setCuePrompt(prompt?.trim() || null);
              }}
              onLiveSessionError={handleLiveSessionError}
              onSoftCloseSession={() => {
                setThinkingState(null);
                setIsCueUser(false);
                setCuePrompt(null);
                setActiveBubbleId(null);
              }}
              onSoftClosingChange={(softClosing, deadline, endReason) => {
                setChatIsSoftClosing(softClosing);
                // The caption counts down to the lecture only when the close
                // will really resume it (the same rule as handleSessionStop)
                const engine = engineRef.current;
                setLectureResumeDeadline(
                  softClosing &&
                    deadline &&
                    engine &&
                    willResumeAfterSoftClose({
                      endReason,
                      hadLectureInterruption: engine.hasLectureInterruption(),
                      isExhausted: engine.isExhausted(),
                      lectureCompletionPending: engine.hasPendingLectureCompletion(),
                      playbackCompleted,
                    })
                    ? deadline
                    : undefined,
                );
              }}
              onSoftCloseContinued={() => {
                // The stream's "continue discussion": keep talking in the composer
                if (isPresenting) {
                  presentationDockRef.current?.continueText();
                } else {
                  revealInteraction();
                  composerRef.current?.openTextInput();
                }
              }}
              header={
                mode === 'playback' ? (
                  <Participants
                    participants={participants}
                    playbackView={playbackView}
                    speakingAgentId={speakingAgentId}
                    isLivePaused={isDiscussionPaused}
                    thinkingState={thinkingState ?? asideThinking}
                    answeringAgentId={asideAnsweringAgentId}
                    discussionAgentId={wantsToSpeakAgentId}
                    // The opener reading its card out loud lights up as speaking
                    announcingAgentId={announcement.speakingAgentId}
                    userHandRaised={
                      queuedQuestion?.status === 'queued' ||
                      handState !== null ||
                      assistantHandRaised
                    }
                    layout={phoneLayout ? 'phone' : stackedLayout ? 'stacked' : 'panel'}
                  />
                ) : undefined
              }
              streamTrailing={
                // Fullscreen shows the offer and the hand over the dock instead
                mode === 'playback' &&
                !isPresenting &&
                (showHandStreamStatus || assistantStreamStatus || discussionRequest) ? (
                  <>
                    {showHandStreamStatus && (
                      <HandRaiseStreamStatus
                        handState={handState ?? (assistantHandRaised ? 'raised' : null)}
                        pendingQuestion={
                          queuedQuestion?.status === 'queued'
                            ? { text: queuedQuestion.text, waitsFor: queuedQuestion.waitsFor }
                            : null
                        }
                        deferredDiscussionAgentName={deferredDiscussionAgentName}
                        cueSpeaker={streamCueSpeaker}
                        directorCue={isDirectorCue ? { prompt: cuePrompt ?? undefined } : null}
                        quickReplies={cueQuickReplies}
                        // A light reply goes out as the learner's own message
                        onQuickReply={(text) => void handleMessageSend(text)}
                        thinkReply={t('stage.handRaise.cueReplies.think')}
                        onThink={thinkAboutCue}
                      />
                    )}
                    {assistantStreamStatus && asideAgentConfig && (
                      <AssistantAsideStreamStatus
                        status={assistantStreamStatus}
                        assistant={{
                          name: asideParticipant?.name || asideAgentConfig.name,
                          avatar: asideParticipant?.avatar || asideAgentConfig.avatar,
                          isAssistant: asideAgentConfig.role === 'assistant',
                        }}
                      />
                    )}
                    {discussionRequest && (
                      <ProactiveCard
                        key={discussionRequest.id}
                        variant="inline"
                        action={discussionRequest}
                        mode={engineMode === 'paused' ? 'paused' : 'playback'}
                        agentName={discussionParticipant?.name || discussionAgentConfig?.name}
                        agentAvatar={discussionParticipant?.avatar || discussionAgentConfig?.avatar}
                        openedByTeacher={discussionOpenedByTeacher}
                        offer={discussionOffer}
                        autoSkip={discussionAutoSkip}
                        countdownHeld={announcement.holding}
                        onListen={offerHandlers.onListen}
                        onAnswer={offerHandlers.onAnswer}
                        onSkip={offerHandlers.onSkip}
                        onAutoSkip={offerHandlers.onAutoSkip}
                      />
                    )}
                  </>
                ) : undefined
              }
              // The composer itself is rendered once, below, into this slot
              // (or into the fullscreen dock's card while presenting)
              footer={
                mode === 'playback' ? (
                  <ComposerSlot host={composerHost} active={!isPresenting} />
                ) : undefined
              }
              // Out of sight, a live recording would go on unseen: drop it, keep
              // the draft. Entering fullscreen hides the panel but hands the
              // composer to the dock.
              onFooterHidden={() => {
                if (!isPresenting) composerRef.current?.dismiss();
              }}
              onStopSession={handleSessionStop}
              // The assistant's aside reports on its own channel: never the
              // lecture-facing live state, stop / error cleanup or TTS above
              onAsideLiveSpeech={(_text, agentId) => {
                if (agentId) setAsideSpeakingAgentId(agentId);
              }}
              onAsideThinking={setAsideThinking}
              getLectureProgress={getLectureProgress}
              onAsideStateChange={({ sessionId, isStreaming }) => {
                setAsideSessionOpen(!!sessionId);
                setAsideStreaming(isStreaming);
                if (!isStreaming) {
                  setAsideThinking(null);
                  setAsideSpeakingAgentId(null);
                }
              }}
              onSegmentSealed={discussionTTS.handleSegmentSealed}
              shouldHoldAfterReveal={discussionTTS.shouldHold}
            />
          </ClassmateAskContext.Provider>
        </div>

        {/* Scene switch confirmation dialog */}
        <AlertDialog
          open={!!pendingSceneId}
          onOpenChange={(open) => {
            if (!open && !sceneSwitchConfirmingRef.current) cancelSceneSwitch();
          }}
        >
          <AlertDialogContent
            container={isPresenting ? stageRef.current : undefined}
            className="max-w-sm rounded-2xl p-0 overflow-hidden border-0 shadow-[0_25px_60px_-12px_rgba(0,0,0,0.15)] dark:shadow-[0_25px_60px_-12px_rgba(0,0,0,0.5)]"
          >
            <VisuallyHidden.Root>
              <AlertDialogTitle>{t('stage.confirmSwitchTitle')}</AlertDialogTitle>
            </VisuallyHidden.Root>
            {/* Top accent bar */}
            <div className="h-1 bg-gradient-to-r from-amber-400 via-orange-400 to-red-400" />

            <div className="px-6 pt-5 pb-2 flex flex-col items-center text-center">
              {/* Icon */}
              <div className="w-12 h-12 rounded-full bg-amber-50 dark:bg-amber-900/20 flex items-center justify-center mb-4 ring-1 ring-amber-200/50 dark:ring-amber-700/30">
                <AlertTriangle className="w-6 h-6 text-amber-500 dark:text-amber-400" />
              </div>
              {/* Title */}
              <h3 className="text-base font-bold text-gray-900 dark:text-gray-100 mb-1.5">
                {t('stage.confirmSwitchTitle')}
              </h3>
              {/* Description */}
              <p className="text-sm text-gray-500 dark:text-gray-400 leading-relaxed">
                {t('stage.confirmSwitchMessage')}
              </p>
            </div>

            <AlertDialogFooter className="px-6 pb-5 pt-3 flex-row gap-3">
              <AlertDialogCancel onClick={cancelSceneSwitch} className="flex-1 rounded-xl">
                {t('common.cancel')}
              </AlertDialogCancel>
              <AlertDialogAction
                onClick={confirmSceneSwitch}
                className="flex-1 rounded-xl bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-600 hover:to-orange-600 text-white border-0 shadow-md shadow-amber-200/50 dark:shadow-amber-900/30"
              >
                {t('common.confirm')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {/* The one composer: its host sits in the panel's footer slot, or in
          the fullscreen dock's card while presenting (ComposerSlot) */}
        {mode === 'playback' &&
          composerHost &&
          createPortal(
            <Composer
              composerRef={composerRef}
              // The send cooldown also ends when the assistant's answer starts
              speakingAgentId={speakingAgentId ?? asideSpeakingAgentId}
              isStreaming={chatIsStreaming || asideStreaming}
              canSendMessage={canSendReferencedMessage}
              onMessageSend={handleMessageSend}
              onInputActivate={handleInputActivate}
              onUserInputActivity={handleContinueDiscussion}
              elementReferencePill={elementReferenceChip}
              onClearElementReference={() => setDraftElementReference(null)}
              queuedQuestion={queuedQuestion}
              onCancelQueuedQuestion={cancelQueuedQuestion}
              hand={{
                state: assistantHandRaised ? 'raised' : handState,
                waitsFor: handWaitsFor,
                onRaise: raiseHandOnly,
                onLower: lowerHand,
                assistant: assistantHandRaised,
              }}
              getSpeechProgress={getSpeechProgress}
              isCueUser={isLearnerCued}
              cueStatusText={cueStatusText}
              // The director's question to the learner: the box invites their answer
              cueAsksLearner={isDirectorCue && !!cuePrompt}
              isLiveSession={!!sessionTypeForUi}
              isFollowUp={sessionTypeForUi === 'qa' || asideSessionOpen}
              assistantAnswers={assistantAnswersNow}
              onVoiceEnd={resumeAfterAssistantVoice}
              onInteractionChange={setIsComposerComposing}
              // Fullscreen only: the overlay's learner line and the card closing
              onUserMessage={showPresentationUserMessage}
              onSent={closePresentationComposer}
              density={touchLayout ? 'touch' : 'default'}
              layout={
                isPresenting ? 'panel' : phoneLayout ? 'phone' : stackedLayout ? 'stacked' : 'panel'
              }
              mentionCandidates={mentionCandidates}
              className={
                isPresenting
                  ? 'border-t-0 bg-transparent p-0'
                  : // TabletPortrait 10/16/16, ClassroomPhone 8/12/12
                    phoneLayout
                    ? 'px-3 pt-2 pb-3'
                    : stackedLayout
                      ? 'px-4 pt-2.5 pb-4'
                      : undefined
              }
            />,
            composerHost,
          )}
      </div>
    );
  },
);
