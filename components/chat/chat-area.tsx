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
import type { SessionType } from '@/lib/types/chat';
import type { DiscussionRequest } from '@/lib/types/roundtable';
import type { Action } from '@/lib/types/action';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useStageStore } from '@/lib/store';
import { buildLectureNotes } from '@/lib/chat/lecture-notes';
import { PanelRightClose, BookOpen, Users } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  useChatSessions,
  MANUAL_STOP_END_OPTIONS,
  type EndSessionOptions,
  type SessionCleanupPayload,
  type ChatMessageSendOptions,
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
   * stays mounted on 笔记 so the offer's auto-skip countdown keeps running.
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
  startDiscussion: (request: DiscussionRequest) => Promise<void>;
  startLecture: (sceneId: string) => Promise<string>;
  addLectureMessage: (sessionId: string, action: Action, actionIndex: number) => void;
  getIsStreaming: () => boolean;
  getActiveSessionType: () => string | null;
  getLectureMessageId: (sessionId: string) => string | null;
  pauseBuffer: (sessionId: string) => void;
  resumeBuffer: (sessionId: string) => void;
  pauseActiveLiveBuffer: () => boolean;
  resumeActiveLiveBuffer: () => void;
  switchToTab: (tab: ChatAreaTab) => void;
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
      getLectureMessageId,
      pauseBuffer,
      resumeBuffer,
      pauseActiveLiveBuffer,
      resumeActiveLiveBuffer,
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
    });

    // 互动 is the default tab: participants, the conversation and the composer live there
    const [selectedTab, setActiveTab] = useState<PanelTab>('interaction');
    // 场景 left behind by a switch to the side panel (no such tab there) reads as 互动
    const activeTab: PanelTab =
      selectedTab === 'scenes' && !scenesTab ? 'interaction' : selectedTab;
    const isDraggingRef = useRef(false);
    const [isDragging, setIsDragging] = useState(false);

    // Derive lecture notes directly from scenes — updates reactively as scenes stream in.
    const lectureNotes = useMemo(() => buildLectureNotes(scenes), [scenes]);

    // Lecture narration stays in 笔记; the stream shows Q&A / discussion only
    const chatSessions = useMemo(() => sessions.filter((s) => s.type !== 'lecture'), [sessions]);

    // Whether there's an active discussion/QA session (for the amber dot on 互动)
    const hasActiveChatSession = useMemo(
      () => chatSessions.some((s) => s.status === 'active'),
      [chatSessions],
    );

    // A 发起讨论 offer waits for an answer: the 互动 dot shows it on 笔记 too
    const hasPendingOffer = Boolean(streamTrailing);

    const softClosingChatSession = useMemo(
      () => chatSessions.find((s) => s.status === 'soft-closing'),
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
        if (session?.status === 'soft-closing') {
          const payload = await confirmSoftClosingSession(sessionId);
          if (payload) onStopSession?.(payload);
          return;
        }
        await endSession(sessionId, MANUAL_STOP_END_OPTIONS);
        onStopSession?.({ sessionId, source: 'manual_stop' });
      },
      [chatSessions, confirmSoftClosingSession, endSession, onStopSession],
    );

    const handleStopActiveSession = useCallback(async () => {
      const active = chatSessions.find(
        (session) => session.status === 'active' || session.status === 'soft-closing',
      );
      if (active) await handleEndSession(active.id);
    }, [chatSessions, handleEndSession]);

    const handleContinueActiveSoftClosingSession = useCallback((): boolean => {
      const softClosing = chatSessions.find((session) => session.status === 'soft-closing');
      return softClosing ? continueSoftClosingSession(softClosing.id) : false;
    }, [chatSessions, continueSoftClosingSession]);

    // Only on the way out of sight, not on every render while hidden
    const isFooterHidden = collapsed || activeTab !== 'interaction';
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
      getIsStreaming: () => isStreaming,
      getActiveSessionType: () => activeSessionType,
      getLectureMessageId,
      pauseBuffer,
      resumeBuffer,
      pauseActiveLiveBuffer,
      resumeActiveLiveBuffer,
      switchToTab,
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

    // Amber pulse dot while a session is live or a discussion offer waits, and
    // another tab is in front
    const interactionDot = (hasActiveChatSession || hasPendingOffer) &&
      activeTab !== 'interaction' && (
        <span className="absolute -top-0.5 -right-0.5 flex h-2 w-2">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" />
          <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500" />
        </span>
      );

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
            card keeps counting down to its auto-skip */}
        <TabsContent
          value="interaction"
          forceMount
          className={cn(
            'flex min-h-0 flex-1 flex-col overflow-hidden data-[state=inactive]:hidden',
            !stacked && 'border-t border-line',
          )}
        >
          {header}
          <ConversationStream
            sessions={chatSessions}
            scenes={scenes}
            isStreaming={isStreaming}
            activeBubbleId={activeBubbleId}
            onEndSession={handleEndSession}
            onContinueSession={handleContinueSession}
            trailing={streamTrailing}
            density={layout}
          />
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
