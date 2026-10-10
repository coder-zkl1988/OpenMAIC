'use client';

import { memo, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import type { ChatSession, ChatMessageMetadata } from '@/lib/types/chat';
import type { UIMessage } from 'ai';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/hooks/use-i18n';
import { AvatarDisplay } from '@/components/ui/avatar-display';
import { CircleStop } from 'lucide-react';
import { useAgentRegistry } from '@/lib/orchestration/registry/store';
import { InlineActionTag, isWhiteboardAction } from './inline-action-tag';
import { useSoftCloseCountdown } from './use-soft-close-countdown';

/** Extended message part type covering standard + custom action parts */
interface MessagePart {
  type: string;
  text?: string;
  _partId?: string;
  actionName?: string;
  state?: string;
}

interface ChatSessionProps {
  readonly session: ChatSession;
  readonly isActive: boolean;
  readonly isStreaming?: boolean;
  readonly activeBubbleId?: string | null;
  readonly onEndSession?: (sessionId: string) => void;
  readonly onContinueSession?: (sessionId: string) => void;
}

type SenderRole = 'teacher' | 'assistant' | 'student';

const AVATARS = {
  teacher: '/avatars/teacher.png',
  user: '/avatars/user.png',
};

/** Session badge colours (Classroom.dc.html): Q&A on the accent, 讨论 on warning */
const SESSION_BADGE_STYLES: Record<string, string> = {
  qa: 'bg-accent-soft text-accent-text',
  discussion: 'bg-warning-soft text-warning',
};

/** Role chip colours next to an agent's name */
const ROLE_CHIP_STYLES: Record<SenderRole, string> = {
  teacher: 'bg-blue-50 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300',
  assistant: 'bg-success-soft text-success',
  student: 'bg-subtle text-icon',
};

function actionNameOf(part: MessagePart): string {
  return part.actionName || part.type.replace('action-', '');
}

function LoadingDots() {
  return (
    <span className="flex h-[22px] items-center gap-1.5" aria-hidden="true">
      {[0, 200, 400].map((delay) => (
        <span
          key={delay}
          className="size-1.5 rounded-full bg-accent-text/70 animate-pulse"
          style={{ animationDelay: `${delay}ms` }}
        />
      ))}
    </span>
  );
}

/**
 * MessageBubble — renders one message as a single chat bubble.
 *
 * Text is already paced by the StreamBuffer (30ms / 1 char) before it reaches
 * React state. No UI-layer animation is needed — we render parts directly.
 * Action badges only appear once the buffer's tick loop reaches them (after
 * all preceding text is fully revealed). Whiteboard actions are collected into
 * a chip row under the bubble; other actions stay inline in the text.
 */
const MessageBubble = memo(function MessageBubble({
  message,
  isUser,
  isStreaming,
  isLastMessage,
  isActive,
  isActiveBubble,
}: {
  message: UIMessage<ChatMessageMetadata>;
  isUser: boolean;
  isStreaming: boolean;
  isLastMessage: boolean;
  isActive: boolean;
  isActiveBubble: boolean;
}) {
  const { t } = useI18n();
  const parts: MessagePart[] = (message.parts || []) as MessagePart[];
  const isLive = !!(isStreaming && isLastMessage);

  const isText = (p: MessagePart) => p.type === 'text' && !!p.text;
  const isAction = (p: MessagePart) => !!p.type?.startsWith('action-');
  const hasBubbleContent = parts.some(
    (p) => isText(p) || (isAction(p) && !isWhiteboardAction(actionNameOf(p))),
  );
  const boardParts = parts
    .map((part, index) => ({ part, index }))
    .filter(({ part }) => isAction(part) && isWhiteboardAction(actionNameOf(part)));

  // Loading dots (between agent_start and first text_delta)
  if (!hasBubbleContent && boardParts.length === 0) {
    if (!isActive || message.role !== 'assistant') return null;
    return (
      <div className="w-fit rounded-[4px_14px_14px_14px] border border-line bg-background px-3 py-2">
        <LoadingDots />
      </div>
    );
  }

  const lastTextIdx = parts.reduce(
    (acc: number, p: MessagePart, i: number) => (p.type === 'text' && p.text ? i : acc),
    -1,
  );

  return (
    <>
      {hasBubbleContent && (
        <div
          className={cn(
            'w-fit max-w-full px-3 py-2 text-left text-[14px] leading-[1.6] transition-[box-shadow,border-color] duration-300',
            isUser
              ? 'rounded-[14px_4px_14px_14px] bg-primary text-white'
              : 'rounded-[4px_14px_14px_14px] border border-line bg-background text-fg',
            isActiveBubble && !isUser && 'border-accent-line ring-2 ring-accent-soft',
          )}
        >
          <span className="whitespace-pre-wrap break-words">
            {parts.map((part: MessagePart, i: number) => {
              if (part.type === 'text' || part.type === 'step-start') {
                const text = part.type === 'text' ? part.text : '';
                if (!text) return null;

                const isLast = i === lastTextIdx;

                return (
                  <span key={`${message.id}-${i}`}>
                    {text}
                    {isLive && isLast && (
                      <span className="inline-block w-1.5 h-1.5 rounded-full bg-current opacity-50 animate-pulse ml-1 align-middle" />
                    )}
                    {message.metadata?.interrupted && isLast && !isLive && (
                      <span className="inline-block w-1.5 h-1.5 rounded-full bg-danger ml-1 align-middle" />
                    )}
                  </span>
                );
              }

              if (isAction(part) && !isWhiteboardAction(actionNameOf(part))) {
                return (
                  <InlineActionTag
                    key={`${message.id}-action-${i}`}
                    actionName={actionNameOf(part)}
                    state={part.state || 'result'}
                  />
                );
              }

              return null;
            })}
          </span>
        </div>
      )}

      {boardParts.length > 0 && (
        <div role="group" aria-label={t('chat.actionTag.group')} className="flex flex-wrap gap-1">
          {boardParts.map(({ part, index }) => (
            <InlineActionTag
              key={`${message.id}-action-${index}`}
              actionName={actionNameOf(part)}
              state={part.state || 'result'}
            />
          ))}
        </div>
      )}
    </>
  );
});

/**
 * One Q&A / discussion session inside the flat conversation stream
 * (Classroom.dc.html): a centred session badge, user bubbles on the right,
 * agent rows (avatar, name, role chip, bubble) on the left, the persistent
 * "问答已结束 / 讨论已结束" marker, and the soft-close row during the grace
 * window. The stream owns scrolling; this component renders no scroll box.
 */
export function ChatSessionComponent({
  session,
  isActive,
  isStreaming,
  activeBubbleId,
  onEndSession,
  onContinueSession,
}: ChatSessionProps) {
  const { t } = useI18n();
  const isDiscussion = session.type === 'discussion';
  const isQA = session.type === 'qa';
  const isEnded = session.status === 'completed' && (isDiscussion || isQA);
  const isSoftClosing = session.status === 'soft-closing' && (isDiscussion || isQA);
  const remainingSoftCloseSeconds = useSoftCloseCountdown(session.softCloseDeadline);
  // Announce the grace window once, when it opens: the visible countdown ticks
  // every second, and a live region around it would re-read the whole row each
  // time. A new deadline (another soft-close) announces again.
  const [softCloseAnnouncement, setSoftCloseAnnouncement] = useState<{
    readonly deadline?: number;
    readonly seconds: number;
  } | null>(null);
  if (
    isSoftClosing &&
    remainingSoftCloseSeconds !== undefined &&
    softCloseAnnouncement?.deadline !== session.softCloseDeadline
  ) {
    setSoftCloseAnnouncement({
      deadline: session.softCloseDeadline,
      seconds: remainingSoftCloseSeconds,
    });
  }
  const getAgentConfig = (id: string) => useAgentRegistry.getState().getAgent(id);

  const senderName = (metadata: ChatMessageMetadata | undefined) => {
    const agentId = metadata?.agentId;
    if (agentId) {
      const i18nName = t(`settings.agentNames.${agentId}`);
      if (i18nName !== `settings.agentNames.${agentId}`) return i18nName;
    }
    return metadata?.senderName || t('chat.unknown');
  };

  const senderRole = (metadata: ChatMessageMetadata | undefined): SenderRole => {
    if (metadata?.originalRole === 'teacher') return 'teacher';
    const role = metadata?.agentId ? getAgentConfig(metadata.agentId)?.role : undefined;
    return role === 'teacher' || role === 'assistant' ? role : 'student';
  };

  // The same action as the control bar's stop pill, so the same label
  const endButtonText = isDiscussion ? t('roundtable.stopDiscussion') : t('roundtable.stopQA');
  const softCloseCountdownKey = isDiscussion
    ? 'chat.softCloseCountdown.discussion'
    : 'chat.softCloseCountdown.qa';
  const endedText = isDiscussion ? t('roundtable.discussionEnded') : t('roundtable.qaEnded');

  return (
    <section
      data-testid="chat-session"
      data-session-type={session.type}
      data-status={session.status}
      className="flex flex-col gap-3"
    >
      {/* Session badge */}
      {(isQA || isDiscussion) && (
        <div className="flex justify-center">
          <span
            className={cn(
              'inline-flex h-5 items-center rounded-full px-2 text-[11px] font-semibold',
              SESSION_BADGE_STYLES[session.type],
            )}
          >
            {t(`chat.badge.${session.type}`)}
          </span>
        </div>
      )}

      {/* Messages */}
      {session.messages.map((message, msgIdx) => {
        const isUser = message.metadata?.originalRole === 'user';
        const isActiveBubble = activeBubbleId === message.id;
        const isLastMessage = msgIdx === session.messages.length - 1;
        const bubble = (
          <MessageBubble
            message={message}
            isUser={isUser}
            isStreaming={!!isStreaming}
            isLastMessage={isLastMessage}
            isActive={isActive}
            isActiveBubble={isActiveBubble}
          />
        );

        if (isUser) {
          return (
            <motion.div
              key={message.id}
              data-message-id={message.id}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3 }}
              className="flex justify-end"
            >
              <div className="flex max-w-[78%] flex-col items-end">{bubble}</div>
            </motion.div>
          );
        }

        const role = senderRole(message.metadata);
        return (
          <motion.div
            key={message.id}
            data-message-id={message.id}
            data-active={isActiveBubble || undefined}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3 }}
            className="flex items-start gap-2"
          >
            <span className="size-7 shrink-0 overflow-hidden rounded-full bg-subtle ring-1 ring-line">
              <AvatarDisplay
                src={message.metadata?.senderAvatar || AVATARS.teacher}
                alt=""
                className="text-xs"
              />
            </span>
            <div className="flex min-w-0 max-w-[85%] flex-col gap-1">
              <div className="flex min-w-0 items-center gap-1.5">
                <span className="truncate text-xs font-semibold text-fg-secondary">
                  {senderName(message.metadata)}
                </span>
                <span
                  className={cn(
                    'shrink-0 rounded-full px-1.5 text-[10px] font-semibold leading-4',
                    ROLE_CHIP_STYLES[role],
                  )}
                >
                  {t(`settings.agentRoles.${role}`)}
                </span>
              </div>
              {bubble}
            </div>
          </motion.div>
        );
      })}

      {/* Session ended marker — persistent, type-specific */}
      <AnimatePresence>
        {isEnded && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
            className="flex items-center justify-center gap-1 text-[11px] text-fg-tertiary"
          >
            <CircleStop className="size-[11px]" />
            {endedText}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Always mounted, so the one-time soft-close announcement is read */}
      {(isQA || isDiscussion) && (
        <span role="status" className="sr-only">
          {isSoftClosing && onEndSession && softCloseAnnouncement
            ? t(softCloseCountdownKey, { seconds: softCloseAnnouncement.seconds })
            : ''}
        </span>
      )}

      {/* Soft-close row: the grace window before the session ends by itself
        (HandRaiseFlow.dc.html step 4). The ticking copy is hidden from
        assistive tech; the status above announces it once. */}
      <AnimatePresence>
        {isSoftClosing && onEndSession && (
          <motion.div
            initial={{ opacity: 0, y: 5 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 5 }}
            className="flex flex-col items-center gap-2 rounded-[14px] border border-line bg-background p-2.5"
          >
            <span aria-hidden="true" className="text-center text-xs text-fg-secondary">
              {t(softCloseCountdownKey, { seconds: remainingSoftCloseSeconds ?? 0 })}
            </span>
            <div className="flex flex-wrap justify-center gap-1.5">
              <button
                type="button"
                onClick={() => onEndSession(session.id)}
                className="flex h-8 items-center gap-1 rounded-lg border border-danger/30 bg-danger-soft px-2.5 text-xs font-semibold text-danger transition-colors hover:border-danger/50 cursor-pointer"
              >
                <CircleStop className="size-3" />
                {endButtonText}
              </button>
              {onContinueSession && (
                <button
                  type="button"
                  onClick={() => onContinueSession(session.id)}
                  className="flex h-8 items-center gap-1.5 rounded-lg border border-accent-line bg-background px-2.5 text-xs font-semibold text-accent-text transition-colors hover:bg-accent-soft cursor-pointer"
                >
                  {t('chat.softClosing')}
                  {remainingSoftCloseSeconds !== undefined && (
                    <span
                      aria-hidden="true"
                      className="text-[11px] font-medium tabular-nums text-fg-tertiary"
                    >
                      {remainingSoftCloseSeconds}s
                    </span>
                  )}
                </button>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}
