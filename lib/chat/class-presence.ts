/**
 * Who has been present in this course so far, as facts for the director
 * (I06): how often each agent spoke across the course's Q&A, discussion and
 * aside sessions, where it last spoke, how many learner messages came since,
 * and how each lecture moment ended for the learner. Pure: built from the
 * loaded chat sessions on every Pi request.
 *
 * The lecture moments come from the discussion badges on the lecture
 * bubbles: the playback chrome writes one badge per moment when its outcome
 * is known (joined / skipped / auto-skipped / not shown), and updates it on a
 * replay.
 */

import type { UIMessage } from 'ai';
import type {
  ChatMessageMetadata,
  ChatSession,
  ClassMomentOutcome,
  ClassPresence,
  ClassPresenceAgent,
  LectureDiscussionBadgeParams,
} from '@/lib/types/chat';
import { PI_REQUEST_BOUNDS } from '@/lib/types/chat';
import type { DiscussionOutcome } from '@/lib/playback/types';

type ChatMessage = UIMessage<ChatMessageMetadata>;
type MessagePart = ChatMessage['parts'][number];

const DISCUSSION_OUTCOMES: readonly DiscussionOutcome[] = [
  'joined',
  'skipped',
  'auto_skipped',
  'not_shown',
];

/** The part type of a lecture bubble's discussion badge */
export const LECTURE_MOMENT_PART_TYPE = 'action-discussion';

export function isDiscussionOutcome(value: unknown): value is DiscussionOutcome {
  return typeof value === 'string' && (DISCUSSION_OUTCOMES as readonly string[]).includes(value);
}

/** A lecture moment with a known outcome, as its badge recorded it */
export interface LectureMomentRecord extends LectureDiscussionBadgeParams {
  discussionActionId: string;
  outcome: DiscussionOutcome;
  /** The page the moment belongs to (its lecture session's scene) */
  sceneId?: string;
}

/** A badge's params, when the part is a lecture moment badge with an id and an outcome */
function readMomentBadge(part: MessagePart): LectureDiscussionBadgeParams | null {
  const candidate = part as unknown as { type?: unknown; input?: unknown };
  if (candidate.type !== LECTURE_MOMENT_PART_TYPE) return null;
  const input = candidate.input as Partial<LectureDiscussionBadgeParams> | undefined;
  if (!input || typeof input !== 'object') return null;
  if (typeof input.discussionActionId !== 'string' || !input.discussionActionId) return null;
  if (!isDiscussionOutcome(input.outcome)) return null;
  return input as LectureDiscussionBadgeParams;
}

/** Lecture sessions in the order their pages were first lectured */
function lectureSessionsInOrder(sessions: readonly ChatSession[]): ChatSession[] {
  return sessions
    .map((session, index) => ({ session, index }))
    .filter(({ session }) => session.type === 'lecture')
    .sort((a, b) => a.session.createdAt - b.session.createdAt || a.index - b.index)
    .map(({ session }) => session);
}

/**
 * Every lecture moment whose outcome is known, oldest first: by when its page
 * was first lectured, then badge order (an updated badge moves to the end of
 * its bubble). A moment recorded more than once keeps its latest outcome, at
 * its latest position. Badges persisted before they carried an id and an
 * outcome are left out.
 */
export function collectLectureMoments(sessions: readonly ChatSession[]): LectureMomentRecord[] {
  const moments = new Map<string, LectureMomentRecord>();
  for (const session of lectureSessionsInOrder(sessions)) {
    for (const message of session.messages) {
      for (const part of message.parts) {
        const badge = readMomentBadge(part);
        if (!badge) continue;
        const id = badge.discussionActionId!;
        moments.delete(id);
        moments.set(id, {
          ...badge,
          discussionActionId: id,
          outcome: badge.outcome!,
          ...(session.sceneId ? { sceneId: session.sceneId } : {}),
        });
      }
    }
  }
  return [...moments.values()];
}

/**
 * A lecture bubble's parts with this moment's badge written: an earlier badge
 * of the same moment is replaced and the new one goes last (the latest
 * outcome, at its latest position); other parts are left as they are.
 */
export function upsertLectureMomentBadge(
  parts: readonly MessagePart[],
  params: LectureDiscussionBadgeParams & { discussionActionId: string },
  now: number = Date.now(),
): MessagePart[] {
  const kept = parts.filter((part) => {
    const candidate = part as unknown as {
      type?: unknown;
      input?: { discussionActionId?: unknown };
    };
    return !(
      candidate.type === LECTURE_MOMENT_PART_TYPE &&
      candidate.input?.discussionActionId === params.discussionActionId
    );
  });
  const badge = {
    type: LECTURE_MOMENT_PART_TYPE,
    actionId: `discussion-${now}`,
    actionName: 'discussion',
    input: params,
    state: 'result',
    output: { success: true },
  } as unknown as MessagePart;
  return [...kept, badge];
}

/** The text a message shows (its text parts) */
function messageText(message: ChatMessage): string {
  return message.parts
    .map((part) =>
      part.type === 'text' ? ((part as { type: 'text'; text?: string }).text ?? '') : '',
    )
    .join('');
}

/** Empty, or only the "..." an interrupted answer leaves */
function isEmptyTurnText(text: string): boolean {
  return /^[\s.…]*$/.test(text);
}

const clampCount = (value: number) =>
  Math.min(Math.max(0, value), PI_REQUEST_BOUNDS.presenceCountMax);

/** One spoken turn or learner message, in course time */
interface PresenceEvent {
  kind: 'agent' | 'learner';
  agentId?: string;
  sceneId?: string;
  at: number;
  sessionIndex: number;
  messageIndex: number;
}

/**
 * The visible turns and learner messages of this course's Q&A, discussion
 * and aside sessions (lecture narration is not a turn), in time order. A turn
 * needs an agent, text beyond "...", and not to have been cut off.
 */
function presenceEvents(sessions: readonly ChatSession[]): PresenceEvent[] {
  const events: PresenceEvent[] = [];
  sessions.forEach((session, sessionIndex) => {
    if (session.type !== 'qa' && session.type !== 'discussion') return;
    session.messages.forEach((message, messageIndex) => {
      const at = message.metadata?.createdAt ?? session.createdAt;
      if (message.role === 'user') {
        events.push({ kind: 'learner', at, sessionIndex, messageIndex });
        return;
      }
      if (message.role !== 'assistant') return;
      const agentId = message.metadata?.agentId;
      if (!agentId || message.metadata?.interrupted) return;
      if (isEmptyTurnText(messageText(message))) return;
      events.push({
        kind: 'agent',
        agentId,
        sceneId: session.sceneId,
        at,
        sessionIndex,
        messageIndex,
      });
    });
  });
  return events.sort(
    (a, b) => a.at - b.at || a.sessionIndex - b.sessionIndex || a.messageIndex - b.messageIndex,
  );
}

/**
 * The class presence a Pi request sends (config.classPresence): one entry per
 * requested agent, in agentIds order — those who never spoke included, with
 * 0 turns and no last scene — and the newest lecture moments with their
 * outcome. Undefined when the request names no agent.
 *
 * `sessions` are the course's loaded sessions, the requesting session's
 * messages included.
 */
export function buildClassPresence({
  sessions,
  agentIds,
}: {
  sessions: readonly ChatSession[];
  agentIds: readonly string[];
}): ClassPresence | undefined {
  const ids = [...new Set(agentIds.filter((id) => typeof id === 'string' && id))];
  if (ids.length === 0) return undefined;

  const events = presenceEvents(sessions);
  const learnerEventsAfter = (index: number) =>
    events.slice(index + 1).filter((event) => event.kind === 'learner').length;

  const agents: ClassPresenceAgent[] = ids.map((agentId) => {
    let turns = 0;
    let lastIndex = -1;
    events.forEach((event, index) => {
      if (event.kind !== 'agent' || event.agentId !== agentId) return;
      turns += 1;
      lastIndex = index;
    });
    if (lastIndex < 0) return { agentId, turns: 0 };
    const last = events[lastIndex];
    return {
      agentId,
      turns: clampCount(turns),
      ...(last.sceneId ? { lastSceneId: last.sceneId } : {}),
      learnerTurnsSince: clampCount(learnerEventsAfter(lastIndex)),
    };
  });

  const moments: ClassMomentOutcome[] = collectLectureMoments(sessions)
    .slice(-PI_REQUEST_BOUNDS.presenceMomentsMax)
    .map((moment) => ({ actionId: moment.discussionActionId, outcome: moment.outcome }));

  return { agents, ...(moments.length > 0 ? { moments } : {}) };
}

/**
 * The sessions with the requesting session's messages as the request sends
 * them: the session list may not have caught up with a message just added,
 * or with a session just created (then it is appended).
 */
export function withRequestMessages(
  sessions: readonly ChatSession[],
  request: {
    sessionId: string;
    type: ChatSession['type'];
    sceneId?: string;
    messages: readonly ChatMessage[];
  },
): ChatSession[] {
  const messages = [...request.messages];
  if (sessions.some((session) => session.id === request.sessionId)) {
    return sessions.map((session) =>
      session.id === request.sessionId ? { ...session, messages } : session,
    );
  }
  const now = messages.at(-1)?.metadata?.createdAt ?? Date.now();
  return [
    ...sessions,
    {
      id: request.sessionId,
      type: request.type,
      title: '',
      status: 'active',
      messages,
      config: { agentIds: [] },
      toolCalls: [],
      pendingToolCalls: [],
      ...(request.sceneId ? { sceneId: request.sceneId } : {}),
      createdAt: now,
      updatedAt: now,
    },
  ];
}
