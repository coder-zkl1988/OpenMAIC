'use client';

import {
  useImperativeHandle,
  forwardRef,
  useRef,
  useCallback,
  useState,
  useMemo,
  useEffect,
  type ReactNode,
} from 'react';
import type { LectureProgress, SessionType } from '@/lib/types/chat';
import type { Action, DiscussionAction } from '@/lib/types/action';
import type { DiscussionOutcome } from '@/lib/playback/types';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useStageStore } from '@/lib/store';
import {
  buildLectureNoteMoments,
  buildLectureNotes,
  type LectureNoteMoment,
} from '@/lib/chat/lecture-notes';
import { collectLectureMoments } from '@/lib/chat/class-presence';
import { PanelRightClose, BookOpen, Users } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { AvatarDisplay } from '@/components/ui/avatar-display';
import { ProactiveCardInViewContext } from './use-proactive-countdown';
import {
  useChatSessions,
  isAsideSession,
  MANUAL_STOP_END_OPTIONS,
  type AsideMessageSendOptions,
  type EndSessionOptions,
  type SessionCleanupPayload,
  type ChatMessageSendOptions,
  type ClassMomentRequest,
} from './use-chat-sessions';
import { ConversationStream } from './conversation-stream';
import { LectureNotesView } from './lecture-notes-view';

interface ChatAreaProps {
  className?: string;
  width?: number;
  onWidthChange?: (width: number) => void;
  collapsed?: boolean;
  onCollapseChange?: (collapsed: boolean) => void;
  activeBubbleId?: string | null;
  onActiveBubble?: (messageId: string | null) => void;
  onLiveSpeech?: (text: string | null, agentId?: string | null) => void;
  onSpeechProgress?: (ratio: number | null) => void;
  onThinking?: (state: { stage: string; agentId?: string } | null) => void;
  onCueUser?: (fromAgentId?: string, prompt?: string) => void;
  onLiveSessionError?: () => void;
  onSoftCloseSession?: (payload: SessionCleanupPayload) => void;
  onSoftClosingChange?: (softClosing: boolean, deadline?: number, endReason?: string) => void;
  onStopSession?: (payload: SessionCleanupPayload) => void;
  onSegmentSealed?: (
    messageId: string,
    partId: string,
    fullText: string,
    agentId: string | null,
  ) => void;
  /** When provided and returns true, StreamBuffer holds on the current text item after reveal. */
  shouldHoldAfterReveal?: () => { holding: boolean; segmentDone: number } | boolean;
  /**
   * The teaching assistant's aside (it answers while the lecture keeps
   * playing): its live text and speaker, its thinking, and whether it is open
   * and streaming. Never reported through the lecture-facing callbacks.
   */
  onAsideLiveSpeech?: (text: string | null, agentId?: string | null) => void;
  onAsideThinking?: (state: { stage: string; agentId?: string } | null) => void;
  onAsideStateChange?: (state: { sessionId: string | null; isStreaming: boolean }) => void;
  /** Where the lecture stands on the current scene, read as each Pi request leaves (I14) */
  getLectureProgress?: () => LectureProgress | null | undefined;
  currentSceneId?: string | null;
  currentActionIndex?: number | null;
  canJumpToAction?: (sceneId: string, actionIndex: number) => boolean;
  onJumpToAction?: (sceneId: string, actionIndex: number) => void;
  /** The stream's soft-close row continued the session (the shell reopens the composer) */
  onSoftCloseContinued?: () => void;
  /** Above the stream on the 互动 tab (the participants block) */
  header?: ReactNode;
  /**
   * Below the stream on the 互动 tab (the composer). Kept mounted on 笔记 and
   * while collapsed — only hidden — so a draft or a recording survives.
   */
  footer?: ReactNode;
  /**
   * After the stream's latest item (the inline 发起讨论 card). The 互动 tab
   * stays mounted on 笔记 so the offer keeps where its countdown stood; the
   * countdown itself only runs while 互动 is in front and the panel is open.
   */
  streamTrailing?: ReactNode;
  /**
   * The composer went out of sight (笔记 in front, or the panel collapsed):
   * the shell drops a live recording, which would otherwise go on unseen
   */
  onFooterHidden?: () => void;
  /**
   * `touch` (tablet and narrower, TabletLandscape.dc.html): a 52px tab row
   * of 44px targets and no drag-resize (the host fixes the width at 320)
   */
  density?: 'default' | 'touch';
  /**
   * `panel`: the side panel (desktop, tablet landscape). `stacked`
   * (TabletPortrait.dc.html) and `phone` (ClassroomPhone.dc.html): a
   * full-width section under the stage that fills the rest of the column, no
   * drag-resize and no collapse button, with a 3-column segmented control
   * 互动 / 笔记 / 场景 (40px, 36px on phone). `collapsed` hides it (fullscreen).
   */
  layout?: 'panel' | 'stacked' | 'phone';
  /** The 场景 tab's content (stacked layouts only; the scene grid) */
  scenes?: ReactNode;
  /** Who is online, shown on the stacked layouts' 互动 tab */
  onlineCount?: number;
  /**
   * A class moment's card waits in the stream (`streamTrailing`), opened by
   * this agent. While 笔记 / 场景 is in front, the 互动 tab shows their
   * avatar (not just the dot), and the card's countdown waits until it is seen.
   */
  pendingOffer?: { name?: string; avatar?: string; label: string } | null;
  /** Who an agent is, for the notes' class moments (no id: the teacher) */
  describeAgent?: (agentId?: string) => { name: string; avatar?: string } | undefined;
  /** 现在聊聊 on a class moment the learner let pass (the notes) */
  onDiscussMoment?: (moment: LectureNoteMoment) => void;
  /** Whether such a moment can be opened now (nothing else is live) */
  canDiscussMoment?: boolean;
}

/**
 * The panel's tabs. 'chat' / 'lecture' are the pre-redesign ids, kept as
 * aliases so existing `switchToTab('chat')` callers keep working. 'scenes'
 * exists only in the stacked layouts; elsewhere it shows 互动.
 */
export type ChatAreaTab = 'interaction' | 'notes' | 'scenes' | 'chat' | 'lecture';
type PanelTab = 'interaction' | 'notes' | 'scenes';

function resolvePanelTab(tab: ChatAreaTab): PanelTab {
  if (tab === 'chat' || tab === 'interaction') return 'interaction';
  return tab === 'scenes' ? 'scenes' : 'notes';
}

/** The stacked layouts' segmented control (TabletPortrait / ClassroomPhone.dc.html) */
const SEGMENT_TRIGGER =
  'relative h-full rounded-[10px] px-2 font-medium text-icon hover:text-fg data-[state=active]:bg-background data-[state=active]:font-semibold data-[state=active]:text-fg group-data-[variant=default]/tabs-list:data-[state=active]:shadow-[0_1px_2px_rgba(0,0,0,0.08)] dark:data-[state=active]:border-transparent dark:data-[state=active]:bg-background';

export interface ChatAreaRef {
  createSession: (type: SessionType, title: string) => Promise<string>;
  endSession: (sessionId: string, options?: EndSessionOptions) => Promise<void>;
  endActiveSession: (options?: EndSessionOptions) => Promise<void>;
  stopActiveSession: () => Promise<void>;
  continueActiveSoftClosingSession: () => boolean;
  softPauseActiveSession: () => Promise<void>;
  resumeActiveSession: () => Promise<void>;
  sendMessage: (content: string, options?: ChatMessageSendOptions) => Promise<void>;
  startDiscussion: (request: ClassMomentRequest) => Promise<void>;
  startLecture: (sceneId: string) => Promise<string>;
  addLectureMessage: (sessionId: string, action: Action, actionIndex: number) => void;
  /** How a lecture moment ended, as a badge on its page's lecture bubble (I06) */
  recordLectureMoment: (
    sceneId: string,
    action: DiscussionAction,
    moment: { agentId?: string; outcome: DiscussionOutcome },
  ) => void;
  getIsStreaming: () => boolean;
  getActiveSessionType: () => string | null;
  getLectureMessageId: (sessionId: string) => string | null;
  pauseBuffer: (sessionId: string) => void;
  resumeBuffer: (sessionId: string) => void;
  pauseActiveLiveBuffer: () => boolean;
  resumeActiveLiveBuffer: () => void;
  switchToTab: (tab: ChatAreaTab) => void;
  /** Ask the teaching assistant on the side (a new aside, or a follow-up in the open one) */
  sendAsideMessage: (content: string, options: AsideMessageSendOptions) => Promise<void>;
  /** End the open aside, keeping its messages */
  endAsideSession: () => Promise<void>;
}

const DEFAULT_WIDTH = 360;
const MIN_WIDTH = 240;
const MAX_WIDTH = 560;

export const ChatArea = forwardRef<ChatAreaRef, ChatAreaProps>(
  (
    {
      className,
      width = DEFAULT_WIDTH,
      onWidthChange,
      collapsed = false,
      onCollapseChange,
      activeBubbleId,
      onActiveBubble,
      onLiveSpeech,
      onSpeechProgress,
      onThinking,
      onCueUser,
      onLiveSessionError,
      onSoftCloseSession,
      onSoftClosingChange,
      onStopSession,
      onSegmentSealed,
      shouldHoldAfterReveal,
      onAsideLiveSpeech,
      onAsideThinking,
      onAsideStateChange,
      getLectureProgress,
      currentSceneId,
      currentActionIndex,
      canJumpToAction,
      onJumpToAction,
      onSoftCloseContinued,
      header,
      footer,
      streamTrailing,
      onFooterHidden,
      density = 'default',
      layout = 'panel',
      scenes: scenesTab,
      onlineCount,
      pendingOffer,
      describeAgent,
      onDiscussMoment,
      canDiscussMoment,
    },
    ref,
  ) => {
    const { t } = useI18n();
    const touch = density === 'touch';
    const stacked = layout !== 'panel';
    const phone = layout === 'phone';
    const scenes = useStageStore((s) => s.scenes);
    const {
      sessions,
      activeSessionType,
      isStreaming,
      createSession,
      endSession,
      endActiveSession,
      continueSoftClosingSession,
      confirmSoftClosingSession,
      softPauseActiveSession,
      resumeActiveSession,
      sendMessage,
      startDiscussion,
      startLecture,
      addLectureMessage,
      recordLectureMoment,
      getLectureMessageId,
      pauseBuffer,
      resumeBuffer,
      pauseActiveLiveBuffer,
      resumeActiveLiveBuffer,
      asideSessionId,
      isAsideStreaming,
      sendAsideMessage,
      endAsideSession,
    } = useChatSessions({
      onLiveSpeech,
      onSpeechProgress,
      onThinking,
      onCueUser,
      onActiveBubble,
      onLiveSessionError,
      onSoftCloseSession,
      onStopSession,
      onSegmentSealed,
      shouldHoldAfterReveal,
      onAsideLiveSpeech,
      onAsideThinking,
      getLectureProgress,
    });

    // The aside's open / streaming state, reported on the way out (the
    // callback read through a ref, so an inline one does not re-report)
    const onAsideStateChangeRef = useRef(onAsideStateChange);
    useEffect(() => {
      onAsideStateChangeRef.current = onAsideStateChange;
    });
    useEffect(() => {
      onAsideStateChangeRef.current?.({
        sessionId: asideSessionId ?? null,
        isStreaming: !!isAsideStreaming,
      });
    }, [asideSessionId, isAsideStreaming]);

    // 互动 is the default tab: participants, the conversation and the composer live there
    const [selectedTab, setActiveTab] = useState<PanelTab>('interaction');
    // 场景 left behind by a switch to the side panel (no such tab there) reads as 互动
    const activeTab: PanelTab =
      selectedTab === 'scenes' && !scenesTab ? 'interaction' : selectedTab;
    const isDraggingRef = useRef(false);
    const [isDragging, setIsDragging] = useState(false);

    // Derive lecture notes directly from scenes — updates reactively as scenes stream in.
    const lectureNotes = useMemo(() => buildLectureNotes(scenes), [scenes]);
    // The class moments, with how each ended (the lecture bubbles' badges)
    const lectureSessions = useMemo(() => sessions.filter((s) => s.type === 'lecture'), [sessions]);
    const noteMoments = useMemo(
      () => buildLectureNoteMoments(scenes, collectLectureMoments(lectureSessions)),
      [lectureSessions, scenes],
    );

    // Lecture narration stays in 笔记; the stream shows Q&A / discussion only
    const chatSessions = useMemo(() => sessions.filter((s) => s.type !== 'lecture'), [sessions]);

    // Whether there's an active discussion/QA session (for the amber dot on 互动)
    const hasActiveChatSession = useMemo(
      () => chatSessions.some((s) => s.status === 'active'),
      [chatSessions],
    );

    // A 发起讨论 offer waits for an answer: the 互动 dot shows it on 笔记 too
    const hasPendingOffer = Boolean(streamTrailing);

    // The lecture-facing session (an aside never soft-closes or takes the stop pill)
    const softClosingChatSession = useMemo(
      () => chatSessions.find((s) => s.status === 'soft-closing' && !isAsideSession(s)),
      [chatSessions],
    );

    useEffect(() => {
      onSoftClosingChange?.(
        Boolean(softClosingChatSession),
        softClosingChatSession?.softCloseDeadline,
        softClosingChatSession?.endReason,
      );
    }, [softClosingChatSession, onSoftClosingChange]);

    // Wrap endSession for QA/Discussion: also notify parent for engine cleanup
    const handleEndSession = useCallback(
      async (sessionId: string) => {
        const session = chatSessions.find((candidate) => candidate.id === sessionId);
        // An aside ends on its own: the lecture keeps playing, so the
        // parent's engine cleanup (which ends a Q&A's interruption) never runs
        if (session && isAsideSession(session)) {
          if (session.id === asideSessionId) await endAsideSession();
          return;
        }
        if (session?.status === 'soft-closing') {
          const payload = await confirmSoftClosingSession(sessionId);
          if (payload) onStopSession?.(payload);
          return;
        }
        await endSession(sessionId, MANUAL_STOP_END_OPTIONS);
        onStopSession?.({ sessionId, source: 'manual_stop' });
      },
      [
        asideSessionId,
        chatSessions,
        confirmSoftClosingSession,
        endAsideSession,
        endSession,
        onStopSession,
      ],
    );

    // The stop pill acts on the lecture-facing Q&A / discussion, never the aside
    const handleStopActiveSession = useCallback(async () => {
      const active = chatSessions.find(
        (session) =>
          (session.status === 'active' || session.status === 'soft-closing') &&
          !isAsideSession(session),
      );
      if (active) await handleEndSession(active.id);
    }, [chatSessions, handleEndSession]);

    const handleContinueActiveSoftClosingSession = useCallback((): boolean => {
      const softClosing = chatSessions.find(
        (session) => session.status === 'soft-closing' && !isAsideSession(session),
      );
      return softClosing ? continueSoftClosingSession(softClosing.id) : false;
    }, [chatSessions, continueSoftClosingSession]);

    // Only on the way out of sight, not on every render while hidden
    const isFooterHidden = collapsed || activeTab !== 'interaction';
    // The stream's trailing card (a class moment's offer) can be seen
    const isTrailingInView = !isFooterHidden;
    const onFooterHiddenRef = useRef(onFooterHidden);
    useEffect(() => {
      onFooterHiddenRef.current = onFooterHidden;
    });
    const wasFooterHiddenRef = useRef(isFooterHidden);
    useEffect(() => {
      if (isFooterHidden && !wasFooterHiddenRef.current) onFooterHiddenRef.current?.();
      wasFooterHiddenRef.current = isFooterHidden;
    }, [isFooterHidden]);

    const switchToTab = useCallback((tab: ChatAreaTab) => {
      setActiveTab(resolvePanelTab(tab));
    }, []);

    // The stream's "continue" — the shell also reopens the composer
    const handleContinueSession = useCallback(
      (sessionId: string) => {
        if (continueSoftClosingSession(sessionId)) onSoftCloseContinued?.();
      },
      [continueSoftClosingSession, onSoftCloseContinued],
    );

    useImperativeHandle(ref, () => ({
      createSession,
      endSession,
      endActiveSession,
      stopActiveSession: handleStopActiveSession,
      continueActiveSoftClosingSession: handleContinueActiveSoftClosingSession,
      softPauseActiveSession,
      resumeActiveSession,
      sendMessage,
      startDiscussion,
      startLecture,
      addLectureMessage,
      recordLectureMoment,
      getIsStreaming: () => isStreaming,
      getActiveSessionType: () => activeSessionType,
      getLectureMessageId,
      pauseBuffer,
      resumeBuffer,
      pauseActiveLiveBuffer,
      resumeActiveLiveBuffer,
      switchToTab,
      sendAsideMessage,
      endAsideSession,
    }));

    // Drag-to-resize
    const handleDragStart = useCallback(
      (e: React.MouseEvent) => {
        e.preventDefault();
        isDraggingRef.current = true;
        setIsDragging(true);
        const startX = e.clientX;
        const startWidth = width;

        const handleMouseMove = (me: MouseEvent) => {
          const delta = startX - me.clientX;
          const newWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth + delta));
          onWidthChange?.(newWidth);
        };

        const handleMouseUp = () => {
          isDraggingRef.current = false;
          setIsDragging(false);
          document.removeEventListener('mousemove', handleMouseMove);
          document.removeEventListener('mouseup', handleMouseUp);
          document.body.style.cursor = '';
          document.body.style.userSelect = '';
        };

        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);
      },
      [width, onWidthChange],
    );

    const displayWidth = collapsed ? 0 : width;

    // A class moment's card waits out of sight: the 互动 tab shows its opener
    // (the card's countdown waits until 互动 is back in front)
    const offerHint = pendingOffer && activeTab !== 'interaction' && (
      <span data-testid="interaction-offer-hint" className="absolute -top-1.5 -right-2 flex size-4">
        <span
          aria-hidden="true"
          className="absolute inset-0 animate-ping rounded-full bg-amber-400 opacity-60"
        />
        <span
          aria-hidden="true"
          className="relative size-4 overflow-hidden rounded-full bg-background ring-2 ring-amber-500"
        >
          {pendingOffer.avatar ? (
            <AvatarDisplay src={pendingOffer.avatar} alt="" />
          ) : (
            <span className="block size-full bg-amber-500" />
          )}
        </span>
        <span className="sr-only">{pendingOffer.label}</span>
      </span>
    );

    // Amber pulse dot while a session is live or a discussion offer waits, and
    // another tab is in front
    const interactionDot =
      offerHint ||
      ((hasActiveChatSession || hasPendingOffer) && activeTab !== 'interaction' && (
        <span className="absolute -top-0.5 -right-0.5 flex h-2 w-2">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" />
          <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500" />
        </span>
      ));

    // Tab header row: 互动 / 笔记 + collapse. The selected trigger
    // (data-state="active") takes the panel's weight, colour and primary
    // underline over the base TabsTrigger's line-variant look
    const panelTabRow = (
      <div
        className={cn(
          'flex shrink-0 items-center gap-1',
          touch ? 'h-[52px] pt-1 pr-1 pl-2' : 'mt-2 h-10 px-3',
        )}
      >
        <TabsList variant="line" className={cn('w-0 flex-1', touch ? 'h-11' : 'h-full')}>
          <TabsTrigger
            value="interaction"
            className={cn(
              "relative flex-1 gap-1.5 rounded-lg text-icon data-[state=active]:font-semibold data-[state=active]:text-fg after:rounded-full after:bg-primary data-[state=active]:after:opacity-100 [&_svg:not([class*='size-'])]:size-3.5",
              touch ? 'text-sm' : 'text-[13px]',
            )}
          >
            <Users />
            {t('chat.tabs.chat')}
            {interactionDot}
          </TabsTrigger>
          <TabsTrigger
            value="notes"
            className={cn(
              "flex-1 gap-1.5 rounded-lg text-icon data-[state=active]:font-semibold data-[state=active]:text-fg after:rounded-full after:bg-primary data-[state=active]:after:opacity-100 [&_svg:not([class*='size-'])]:size-3.5",
              touch ? 'text-sm' : 'text-[13px]',
            )}
          >
            <BookOpen />
            {t('chat.tabs.lecture')}
          </TabsTrigger>
        </TabsList>

        {onCollapseChange && (
          <button
            type="button"
            onClick={() => onCollapseChange(true)}
            aria-label={t('chat.collapsePanel')}
            title={t('chat.collapsePanel')}
            className={cn(
              'flex shrink-0 items-center justify-center rounded-[10px] text-icon transition-all duration-200 hover:text-fg active:scale-90 cursor-pointer',
              touch
                ? 'size-11 hover:bg-subtle'
                : 'size-7 bg-subtle ring-1 ring-black/[0.04] dark:ring-white/[0.06]',
            )}
          >
            <PanelRightClose className={touch ? 'size-[18px]' : 'size-4'} />
          </button>
        )}
      </div>
    );

    // Stacked: one segmented control of three equal tabs, the online count on 互动
    const stackedTabRow = (
      <TabsList
        className={cn(
          'grid h-auto w-auto shrink-0 grid-cols-3 gap-0.5 bg-subtle p-[3px]',
          phone ? 'mx-3 mt-2 mb-1 rounded-[10px]' : 'mx-4 mt-3 mb-1 rounded-xl',
        )}
      >
        <TabsTrigger
          value="interaction"
          className={cn(
            SEGMENT_TRIGGER,
            phone ? 'h-9 gap-1 rounded-lg text-[13px]' : 'h-10 gap-1.5 text-sm',
          )}
        >
          {t('chat.tabs.chat')}
          {onlineCount !== undefined && (
            <span
              className={cn(
                'inline-flex items-center font-medium text-fg-tertiary',
                phone ? 'gap-[3px] text-[11px]' : 'gap-1 text-xs',
              )}
            >
              <span
                aria-hidden="true"
                className={cn(
                  'shrink-0 rounded-full bg-success',
                  phone ? 'size-[5px]' : 'size-1.5',
                )}
              />
              {phone ? (
                <>
                  <span aria-hidden="true">{onlineCount}</span>
                  <span className="sr-only">
                    {t('stage.participants.online', { count: onlineCount })}
                  </span>
                </>
              ) : (
                t('stage.participants.online', { count: onlineCount })
              )}
            </span>
          )}
          {interactionDot}
        </TabsTrigger>
        <TabsTrigger
          value="notes"
          className={cn(SEGMENT_TRIGGER, phone ? 'h-9 rounded-lg text-[13px]' : 'h-10 text-sm')}
        >
          {t('chat.tabs.lecture')}
        </TabsTrigger>
        <TabsTrigger
          value="scenes"
          className={cn(SEGMENT_TRIGGER, phone ? 'h-9 rounded-lg text-[13px]' : 'h-10 text-sm')}
        >
          {t('chat.tabs.scenes')}
        </TabsTrigger>
      </TabsList>
    );

    const tabs = (
      <Tabs
        value={activeTab}
        onValueChange={(v) => setActiveTab(v as PanelTab)}
        // Stacked: no overflow clipping up the chain, so the section's minimum
        // height is the tab row plus the composer — the parent column shrinks
        // the stage first and the composer stays in view (the on-screen
        // keyboard's inset included)
        className={cn('flex flex-col gap-0', stacked ? 'flex-1' : 'h-full')}
      >
        {stacked ? stackedTabRow : panelTabRow}

        {/* 互动: participants and the flat conversation stream. Hidden, not
            unmounted, on 笔记 / 场景 (as when collapsed): a pending 发起讨论
            card keeps its place, its countdown frozen until it is seen */}
        <TabsContent
          value="interaction"
          forceMount
          className={cn(
            'flex min-h-0 flex-1 flex-col overflow-hidden data-[state=inactive]:hidden',
            !stacked && 'border-t border-line',
          )}
        >
          {header}
          {/* A pending card counts down only while it can be seen */}
          <ProactiveCardInViewContext.Provider value={isTrailingInView}>
            <ConversationStream
              sessions={chatSessions}
              scenes={scenes}
              isStreaming={isStreaming}
              asideSessionId={asideSessionId}
              isAsideStreaming={isAsideStreaming}
              activeBubbleId={activeBubbleId}
              onEndSession={handleEndSession}
              onContinueSession={handleContinueSession}
              trailing={streamTrailing}
              density={layout}
            />
          </ProactiveCardInViewContext.Provider>
        </TabsContent>

        {/* 笔记: lecture notes with jump-to-line */}
        <TabsContent
          value="notes"
          className={cn(
            'flex flex-1 flex-col overflow-hidden border-t border-line',
            stacked && 'mt-1 min-h-0',
          )}
        >
          <LectureNotesView
            notes={lectureNotes}
            currentSceneId={currentSceneId}
            currentActionIndex={currentActionIndex}
            canJumpToAction={canJumpToAction}
            onJumpToAction={onJumpToAction}
            moments={noteMoments}
            describeAgent={describeAgent}
            onDiscussMoment={onDiscussMoment}
            canDiscussMoment={canDiscussMoment}
          />
        </TabsContent>

        {/* 场景 (stacked only): the scene grid */}
        {stacked && scenesTab && (
          <TabsContent value="scenes" className="mt-1 flex min-h-0 flex-1 flex-col overflow-hidden">
            {scenesTab}
          </TabsContent>
        )}

        {/* The 互动 composer: hidden, never unmounted, on 笔记 / 场景 */}
        {footer && (
          <div className={cn('shrink-0', activeTab !== 'interaction' && 'hidden')}>{footer}</div>
        )}
      </Tabs>
    );

    // One element type and nesting for both layouts: rotating a tablet across
    // the stacked threshold keeps the stream, the notes and the offer mounted
    return (
      <aside
        aria-label={t('chat.panelLabel')}
        data-testid={stacked ? 'interaction-section' : undefined}
        data-layout={stacked ? layout : undefined}
        style={
          stacked
            ? undefined
            : {
                width: displayWidth,
                transition: isDragging ? 'none' : 'width 0.3s ease',
              }
        }
        className={cn(
          stacked
            ? // Under the stage: the rest of the column, full width
              cn(
                'relative flex w-full flex-1 flex-col border-t border-line bg-background',
                collapsed && 'hidden',
              )
            : cn(
                'relative z-20 flex shrink-0 flex-col overflow-visible bg-background shadow-[-2px_0_24px_rgba(0,0,0,0.02)]',
                !collapsed && 'border-l border-line',
              ),
          className,
        )}
      >
        {/* Drag handle (desktop only) */}
        {!collapsed && !touch && !stacked && (
          <div
            onMouseDown={handleDragStart}
            className="absolute left-0 top-0 bottom-0 z-50 w-1.5 cursor-col-resize group transition-colors hover:bg-accent-line/40 active:bg-accent-line/60"
          >
            <div className="absolute left-0.5 top-1/2 h-8 w-0.5 -translate-y-1/2 rounded-full bg-line-strong transition-colors group-hover:bg-accent-text" />
          </div>
        )}

        <div
          className={cn(
            'flex w-full flex-col',
            stacked ? 'flex-1' : 'h-full overflow-hidden',
            collapsed && 'hidden',
          )}
        >
          {tabs}
        </div>
      </aside>
    );
  },
);

ChatArea.displayName = 'ChatArea';
