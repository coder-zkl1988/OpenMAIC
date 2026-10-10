'use client';

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { MessageSquare } from 'lucide-react';
import type { ChatSession } from '@/lib/types/chat';
import type { Scene } from '@/lib/types/stage';
import { useI18n } from '@/lib/hooks/use-i18n';
import { ChatSessionComponent } from './chat-session';

/** A page divider '第 N 页 · 场景标题' or one Q&A / discussion session */
export type ConversationStreamItem =
  | {
      readonly kind: 'divider';
      readonly key: string;
      readonly sceneId: string;
      /** 1-based page number in scene order */
      readonly pageNumber: number;
      readonly title: string;
    }
  | { readonly kind: 'session'; readonly key: string; readonly session: ChatSession };

/**
 * The flat stream's rows: Q&A / discussion sessions in chronological order
 * (lecture sessions stay in 笔记), with a page divider wherever the session's
 * scene differs from the previous session's. Sessions without a scene, or
 * whose scene is gone, get no divider.
 */
export function buildConversationStream(
  sessions: readonly ChatSession[],
  scenes: readonly Pick<Scene, 'id' | 'title' | 'order'>[],
): ConversationStreamItem[] {
  const ordered = [...scenes].sort((a, b) => a.order - b.order);
  const pageOf = new Map(ordered.map((scene, index) => [scene.id, { index, scene }]));
  const chronological = sessions
    .map((session, index) => ({ session, index }))
    .filter(({ session }) => session.type !== 'lecture')
    // Stable: equal timestamps keep their creation order
    .sort((a, b) => a.session.createdAt - b.session.createdAt || a.index - b.index)
    .map(({ session }) => session);

  const items: ConversationStreamItem[] = [];
  let previousSceneId: string | undefined;
  for (const session of chronological) {
    if (session.sceneId && session.sceneId !== previousSceneId) {
      const page = pageOf.get(session.sceneId);
      if (page) {
        items.push({
          kind: 'divider',
          key: `divider-${session.id}`,
          sceneId: session.sceneId,
          pageNumber: page.index + 1,
          title: page.scene.title,
        });
      }
      previousSceneId = session.sceneId;
    }
    items.push({ kind: 'session', key: session.id, session });
  }
  return items;
}

/** How close (px) to the bottom still counts as "following" the stream */
const FOLLOW_THRESHOLD = 40;

interface ConversationStreamProps {
  readonly sessions: readonly ChatSession[];
  readonly scenes: readonly Scene[];
  readonly isStreaming: boolean;
  readonly activeBubbleId?: string | null;
  readonly onEndSession: (sessionId: string) => Promise<void> | void;
  readonly onContinueSession: (sessionId: string) => void;
}

/**
 * The 互动 tab's conversation stream (Classroom.dc.html): one scroll container
 * on the page background holding every Q&A / discussion session in order,
 * separated by page dividers. Auto-scroll follows new content only while the
 * reader is at the bottom; scrolling up to read history suspends it.
 */
export function ConversationStream({
  sessions,
  scenes,
  isStreaming,
  activeBubbleId,
  onEndSession,
  onContinueSession,
}: ConversationStreamProps) {
  const { t } = useI18n();
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);
  const items = useMemo(() => buildConversationStream(sessions, scenes), [sessions, scenes]);
  const sessionCount = items.reduce((n, item) => n + (item.kind === 'session' ? 1 : 0), 0);
  const hasSessions = sessionCount > 0;

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    isAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_THRESHOLD;
  }, []);

  // One container-level observer: whatever grows (streamed text, a new bubble,
  // whiteboard chips, the soft-close row) keeps the bottom in view while the
  // reader follows the stream
  useEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (isAtBottomRef.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(content);
    return () => observer.disconnect();
    // Re-attach when the scroll container mounts (the empty state has none)
  }, [hasSessions]);

  // A new session (a question sent, a discussion joined) always comes into view
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || sessionCount === 0) return;
    isAtBottomRef.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [sessionCount]);

  // Bring the bubble being spoken into view
  useEffect(() => {
    if (!activeBubbleId) return;
    const bubble = [
      ...(scrollRef.current?.querySelectorAll<HTMLElement>('[data-message-id]') ?? []),
    ].find((node) => node.dataset.messageId === activeBubbleId);
    if (!bubble) return;
    bubble.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    isAtBottomRef.current = true;
  }, [activeBubbleId]);

  if (!hasSessions) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center bg-page p-6 text-center">
        <div className="mb-3 flex size-12 items-center justify-center rounded-full bg-subtle text-icon-muted">
          <MessageSquare className="size-6" />
        </div>
        <p className="text-xs font-medium text-fg-secondary">{t('chat.noConversations')}</p>
        <p className="mt-1 text-[11px] text-fg-tertiary">{t('chat.startConversation')}</p>
      </div>
    );
  }

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      // A log of the sessions. While an answer streams in (one character at a
      // time) the log is busy, so screen readers wait for the finished text
      // instead of reading fragments. Focusable so the hidden-scrollbar
      // history scrolls with the keyboard.
      role="log"
      aria-label={t('chat.conversationLog')}
      aria-busy={isStreaming || undefined}
      tabIndex={0}
      data-testid="conversation-stream"
      className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden bg-page scrollbar-hide outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50"
    >
      <div ref={contentRef} className="flex min-h-full flex-col justify-end gap-3 p-4">
        {items.map((item) => {
          if (item.kind === 'divider') {
            const pageLabel = t('chat.lectureNotes.pageLabel', { n: item.pageNumber });
            return (
              <div
                key={item.key}
                data-testid="conversation-page-divider"
                className="flex items-center gap-2 text-[11px] text-fg-tertiary"
              >
                <span className="h-px flex-1 bg-line" />
                <span className="max-w-[80%] truncate">
                  {item.title ? `${pageLabel} · ${item.title}` : pageLabel}
                </span>
                <span className="h-px flex-1 bg-line" />
              </div>
            );
          }
          const { session } = item;
          const isActive = session.status === 'active' || session.status === 'soft-closing';
          return (
            <ChatSessionComponent
              key={item.key}
              session={session}
              isActive={isActive}
              isStreaming={isStreaming && isActive}
              activeBubbleId={activeBubbleId}
              onEndSession={onEndSession}
              onContinueSession={onContinueSession}
            />
          );
        })}
      </div>
    </div>
  );
}
