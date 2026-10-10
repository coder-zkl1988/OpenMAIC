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
}

/**
 * The panel's tabs. 'chat' / 'lecture' are the pre-redesign ids, kept as
 * aliases so existing `switchToTab('chat')` callers keep working.
 */
export type ChatAreaTab = 'interaction' | 'notes' | 'chat' | 'lecture';
type PanelTab = 'interaction' | 'notes';

function resolvePanelTab(tab: ChatAreaTab): PanelTab {
  return tab === 'chat' || tab === 'interaction' ? 'interaction' : 'notes';
}

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
    },
    ref,
  ) => {
    const { t } = useI18n();
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
    const [activeTab, setActiveTab] = useState<PanelTab>('interaction');
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

    return (
      <aside
        aria-label={t('chat.panelLabel')}
        style={{
          width: displayWidth,
          transition: isDragging ? 'none' : 'width 0.3s ease',
        }}
        className={cn(
          'relative z-20 flex shrink-0 flex-col overflow-visible bg-background shadow-[-2px_0_24px_rgba(0,0,0,0.02)]',
          !collapsed && 'border-l border-line',
          className,
        )}
      >
        {/* Drag handle */}
        {!collapsed && (
          <div
            onMouseDown={handleDragStart}
            className="absolute left-0 top-0 bottom-0 z-50 w-1.5 cursor-col-resize group transition-colors hover:bg-accent-line/40 active:bg-accent-line/60"
          >
            <div className="absolute left-0.5 top-1/2 h-8 w-0.5 -translate-y-1/2 rounded-full bg-line-strong transition-colors group-hover:bg-accent-text" />
          </div>
        )}

        <div className={cn('flex h-full w-full flex-col overflow-hidden', collapsed && 'hidden')}>
          <Tabs
            value={activeTab}
            onValueChange={(v) => setActiveTab(v as PanelTab)}
            className="flex h-full flex-col gap-0"
          >
            {/* Tab header row: 互动 / 笔记 + collapse. Radix marks the selected
                trigger with data-state="active" (the base TabsTrigger's
                `data-active:` variants never match), so the weight, colour and
                primary underline key off that */}
            <div className="mt-2 flex h-10 shrink-0 items-center gap-1 px-3">
              <TabsList variant="line" className="h-full w-0 flex-1">
                <TabsTrigger
                  value="interaction"
                  className="relative flex-1 gap-1.5 rounded-lg text-[13px] text-icon data-[state=active]:font-semibold data-[state=active]:text-fg after:rounded-full after:bg-primary data-[state=active]:after:opacity-100 [&_svg:not([class*='size-'])]:size-3.5"
                >
                  <Users />
                  {t('chat.tabs.chat')}
                  {/* Amber pulse dot while a session is live or a discussion
                      offer waits, and 笔记 is in front */}
                  {(hasActiveChatSession || hasPendingOffer) && activeTab === 'notes' && (
                    <span className="absolute -top-0.5 -right-0.5 flex h-2 w-2">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" />
                      <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500" />
                    </span>
                  )}
                </TabsTrigger>
                <TabsTrigger
                  value="notes"
                  className="flex-1 gap-1.5 rounded-lg text-[13px] text-icon data-[state=active]:font-semibold data-[state=active]:text-fg after:rounded-full after:bg-primary data-[state=active]:after:opacity-100 [&_svg:not([class*='size-'])]:size-3.5"
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
                  className="flex size-7 shrink-0 items-center justify-center rounded-[10px] bg-subtle text-icon ring-1 ring-black/[0.04] transition-all duration-200 hover:text-fg active:scale-90 dark:ring-white/[0.06] cursor-pointer"
                >
                  <PanelRightClose className="size-4" />
                </button>
              )}
            </div>

            {/* 互动: participants and the flat conversation stream. Hidden, not
                unmounted, on 笔记 (as when collapsed): a pending 发起讨论
                card keeps counting down to its auto-skip */}
            <TabsContent
              value="interaction"
              forceMount
              className="flex min-h-0 flex-1 flex-col overflow-hidden border-t border-line data-[state=inactive]:hidden"
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
              />
            </TabsContent>

            {/* 笔记: lecture notes with jump-to-line */}
            <TabsContent
              value="notes"
              className="flex flex-1 flex-col overflow-hidden border-t border-line"
            >
              <LectureNotesView
                notes={lectureNotes}
                currentSceneId={currentSceneId}
                currentActionIndex={currentActionIndex}
                canJumpToAction={canJumpToAction}
                onJumpToAction={onJumpToAction}
              />
            </TabsContent>

            {/* The 互动 composer: hidden, never unmounted, on 笔记 */}
            {footer && (
              <div className={cn('shrink-0', activeTab !== 'interaction' && 'hidden')}>
                {footer}
              </div>
            )}
          </Tabs>
        </div>
      </aside>
    );
  },
);

ChatArea.displayName = 'ChatArea';
