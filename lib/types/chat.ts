import type { InteractiveStateEvidence } from '@/lib/interactive/chat-observation';
/**
 * Shared Type Definitions for Multi-Agent Orchestration
 *
 * Defines the session-based multi-agent conversation system with
 * support for QA, Discussion, and Lecture session types.
 */

import type { UIMessage } from 'ai';
import type { Locale } from '@/lib/i18n/types';
import type { CleanupSource } from '@/lib/playback/auto-resume';
import type { DiscussionOutcome } from '@/lib/playback/types';
import type { ThinkingConfig } from './provider';

// Session Types
export type SessionType = 'qa' | 'discussion' | 'lecture';
export type SessionStatus =
  | 'idle'
  | 'active'
  | 'soft-closing'
  | 'interrupted'
  | 'completed'
  | 'error';

/**
 * Metadata attached to chat messages
 */
export interface ChatMessageMetadata {
  senderName?: string;
  senderAvatar?: string;
  originalRole?: 'teacher' | 'agent' | 'user';
  actions?: MessageAction[];
  agentId?: string;
  agentColor?: string;
  createdAt?: number;
  interrupted?: boolean;
  /** Why the director cast this speaker (from agent_start), kept for offline casting stats */
  castReason?: CastReason;
}

/**
 * Action buttons that can be attached to messages
 */
export interface MessageAction {
  id: string;
  label: string;
  icon?: string;
  variant?: 'spotlight' | 'highlight' | 'reset' | 'insert' | 'draw';
}

/**
 * Chat session representing a conversation with one or more agents
 */
export interface ChatSession {
  id: string;
  type: SessionType;
  title: string;
  status: SessionStatus;
  messages: UIMessage<ChatMessageMetadata>[];
  config: SessionConfig;
  toolCalls: ToolCallRecord[];
  pendingToolCalls: ToolCallRequest[];
  createdAt: number;
  updatedAt: number;
  sceneId?: string;
  lastActionIndex?: number;
  endReason?: string;
  /** Absolute deadline for the client-side soft-closing grace window. */
  softCloseDeadline?: number;
  directorState?: DirectorState;
}

export interface PiSessionBoundaryContext {
  isFirstRequestInLiveSession: true;
  previousEndSource?: CleanupSource;
  sameSceneAsPrevious?: boolean;
}

/**
 * Advance the session's conflict-order clock without trusting wall time to be
 * monotonic. Restored data may come from a clock ahead of this device, and the
 * local clock itself can move backwards.
 */
export function nextChatUpdatedAt(
  session: Pick<ChatSession, 'updatedAt'>,
  now = Date.now(),
): number {
  return Math.max(now, session.updatedAt + 1);
}

/** Apply a lifecycle transition and advance the same conflict-order clock. */
export function withChatSessionStatus(
  session: ChatSession,
  status: SessionStatus,
  now = Date.now(),
): ChatSession {
  return { ...session, status, updatedAt: nextChatUpdatedAt(session, now) };
}

/** Advance conflict order once a streamed message segment is fully revealed. */
export function withChatSegmentSealed(session: ChatSession, now = Date.now()): ChatSession {
  return { ...session, updatedAt: nextChatUpdatedAt(session, now) };
}

/** Advance conflict order only when paced text has actually finished revealing. */
export function withChatSegmentReveal(
  session: ChatSession,
  isComplete: boolean,
  now = Date.now(),
): ChatSession {
  return isComplete ? withChatSegmentSealed(session, now) : session;
}

/** Mark streams that cannot survive a reload as interrupted without stale ordering. */
export function interruptActiveChatSessions(
  sessions: ChatSession[],
  now = Date.now(),
): ChatSession[] {
  return sessions.map((session) =>
    session.status === 'active' ? withChatSessionStatus(session, 'interrupted', now) : session,
  );
}

/**
 * Session configuration
 */
export interface SessionConfig {
  agentIds: string[];
  triggerAgentId?: string; // For discussion: first agent to speak
  defaultAgentId?: string; // For QA: the responding agent
  /**
   * Discussion only: the opener's own words, as the learner saw them on the
   * card. Kept so follow-ups and retries send the same moment to the server.
   */
  discussionTopic?: string;
  /** Discussion only: where the teacher wants the moment to go (director-only) */
  discussionPrompt?: string;
  /** Discussion only: which kind of class moment this session is */
  momentKind?: DiscussionMomentKind;
  /** Discussion only ('ask-learner'): what the learner chose on the card */
  learnerStance?: LearnerStance;
  /**
   * A teaching-assistant aside: the assistant answered in the chat while the
   * teacher kept lecturing (the session stays type 'qa')
   */
  aside?: boolean;
}

/**
 * Pending tool call request sent to client for execution
 */
export interface ToolCallRequest {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  agentId: string;
  status: 'pending' | 'executing';
  requestedAt: number;
}

/**
 * Completed tool call record with result
 */
export interface ToolCallRecord {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  agentId: string;
  result?: unknown;
  error?: string;
  status: 'pending' | 'executing' | 'completed' | 'failed';
  requestedAt: number;
  completedAt?: number;
}

/**
 * Server-Sent Event types for streaming session updates
 */
export type SessionEvent =
  | { type: 'message'; data: UIMessage<ChatMessageMetadata> }
  | {
      type: 'tool_request';
      data: { sessionId: string; toolCalls: ToolCallRequest[] };
    }
  | { type: 'tool_complete'; data: ToolCallRecord }
  | {
      type: 'agent_switch';
      data: { fromAgentId: string | null; toAgentId: string };
    }
  | { type: 'session_status'; data: { status: SessionStatus; reason?: string } }
  | { type: 'error'; data: { message: string } }
  | { type: 'done'; data: SessionSummary }
  | {
      type: 'text_start';
      data: { messageId: string; agentId: string; agentName: string };
    }
  | { type: 'text_delta'; data: { messageId: string; delta: string } }
  | { type: 'text_end'; data: { messageId: string; content: string } };

/**
 * Summary data sent when session completes
 */
export interface SessionSummary {
  sessionId: string;
  totalTurns: number;
  totalMessages: number;
  totalToolCalls: number;
  endReason: string;
}

/**
 * Request body for creating a new session
 */
export interface CreateSessionRequest {
  type: SessionType;
  title?: string;
  trigger: {
    message?: string;
    agentIds: string[];
    triggerAgentId?: string;
  };
}

/**
 * Request body for sending a message to a session
 */
export interface SendMessageRequest {
  content: string;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  storeState: {
    stage: unknown;
    scenes: unknown[];
    currentSceneId: string | null;
    mode: 'autonomous' | 'playback';
    whiteboardOpen: boolean;
  };
}

/**
 * Request body for submitting tool results
 */
export interface ToolResultsRequest {
  results: ToolCallRecord[];
}

/**
 * Session list item (without full messages for efficiency)
 */
export interface SessionListItem {
  id: string;
  type: SessionType;
  title: string;
  status: SessionStatus;
  messageCount: number;
  toolCallCount: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * Convert a full ChatSession to a list item (without messages)
 */
export function toSessionListItem(session: ChatSession): SessionListItem {
  return {
    id: session.id,
    type: session.type,
    title: session.title,
    status: session.status,
    messageCount: session.messages.length,
    toolCallCount: session.toolCalls.length,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

/**
 * A single item in a lecture note — either speech text or an action badge.
 * Ordered to match the original action sequence in the scene.
 */
export type LectureNoteItem =
  | {
      kind: 'speech';
      text: string;
      actionIndex: number;
      actionId: string;
      actionType: string;
    }
  | {
      kind: 'action';
      type: string;
      label?: string;
      actionIndex: number;
      actionId: string;
      actionType: string;
    };

/**
 * A completed lecture note entry for one scene.
 * Built from Scene.actions, displayed in the Notes tab.
 */
export interface LectureNoteEntry {
  sceneId: string;
  sceneTitle: string;
  sceneOrder: number;
  items: LectureNoteItem[];
  completedAt: number;
}

// ==================== Stateless Multi-Agent API Types ====================

import type { Stage, Scene, StageMode } from '@/lib/types/stage';
import type { SceneOutline } from '@/lib/types/generation';
import type { AgentTurnSummary, WhiteboardActionRecord } from '@/lib/orchestration/types';
import type { DirectorCompactionTrace } from '@/lib/chat/pi/director-compaction';
import type { DirectorToolTraceEntry } from '@/lib/chat/pi/types';
import type { BaiduSubSources, WebSearchProviderId } from '@/lib/web-search/types';

/**
 * Accumulated director state passed between per-agent requests.
 * Client-maintained — backend is stateless.
 */
export interface DirectorState {
  turnCount: number;
  agentResponses: AgentTurnSummary[];
  whiteboardLedger: WhiteboardActionRecord[];
}

/** Browser-selected identity for one PPT element. Content is resolved by the Host. */
export interface SlideElementReference {
  kind: 'slide_element';
  sceneId: string;
  elementId: string;
}

/** Browser-selected identity for one source-authored Interactive DOM component. */
export interface InteractiveComponentReference {
  kind: 'interactive_component';
  sceneId: string;
  selector: string;
}

/** Identity only; content is resolved from this request's Stage snapshot. */
export interface WhiteboardElementReference {
  kind: 'whiteboard_element';
  whiteboardId: string;
  elementId: string;
}

export type ElementReference =
  | SlideElementReference
  | InteractiveComponentReference
  | WhiteboardElementReference;

// ==================== Classroom Context (persona-driven casting) ====================

/**
 * Size bounds of the classroom context a Pi request may carry. The route
 * enforces them (truncating text, dropping what does not fit or does not
 * resolve); client builders use the same numbers so nothing is cut twice.
 * Lengths count characters (code points).
 */
export const PI_REQUEST_BOUNDS = {
  /** Ids (agents, scenes, actions) */
  idMaxChars: 200,
  discussionTopicMaxChars: 500,
  discussionPromptMaxChars: 1000,
  /** A request-sent agent persona (config.agentConfigs[].persona) */
  personaMaxChars: 2000,
  addressedAgentIdsMax: 8,
  /** Turn and learner-turn counts in classPresence */
  presenceCountMax: 9999,
  presenceMomentsMax: 64,
  memoryEntriesMax: 12,
  memoryPointsPerEntryMax: 8,
  /** One speaker's gist in a memory entry */
  memoryGistMaxChars: 60,
  memoryLearnerQuestionMaxChars: 120,
  memoryMissedConceptsMax: 8,
  memoryMissedConceptMaxChars: 80,
  memoryRepeatedQuestionsMax: 5,
  memoryRepeatedQuestionMaxChars: 120,
  memoryAgentNoteMaxChars: 160,
  /** All text in classMemory together; the oldest entries go first when over */
  memoryTotalMaxChars: 1500,
  lectureActionIndexMax: 100_000,
  /** cue_user.prompt as forwarded to the client */
  cuePromptMaxChars: 200,
} as const;

/**
 * The kind of class moment a discussion session is:
 * - 'lecture': a scripted lecture moment (a scene's discussion action) opened
 *   by a student or the assistant, or by the teacher calling on a named student
 * - 'ask-learner': the teacher puts a question (predict, guess, estimate) to
 *   the whole class and the learner, who may answer before the class does
 *   (see LearnerStance)
 * - 'quiz-review': after a graded quiz with wrong answers; the topic is the
 *   client's summary of the missed questions (never the answers)
 */
export type DiscussionMomentKind = 'lecture' | 'ask-learner' | 'quiz-review';

export const DISCUSSION_MOMENT_KINDS: readonly DiscussionMomentKind[] = [
  'lecture',
  'ask-learner',
  'quiz-review',
];

/**
 * The learner's choice on an 'ask-learner' card: answer first, or hear the
 * class first. Applies until the learner has spoken in the session.
 */
export type LearnerStance = 'answer' | 'listen';

export const LEARNER_STANCES: readonly LearnerStance[] = ['answer', 'listen'];

/** Presence facts for one agent across this course's persisted chat sessions */
export interface ClassPresenceAgent {
  /** One of config.agentIds; other entries are dropped */
  agentId: string;
  /**
   * Visible messages this agent spoke in Q&A, discussion and aside sessions
   * (lecture narration and moment cards excluded; interrupted or "..."-only
   * messages excluded). Integer 0..presenceCountMax.
   */
  turns: number;
  /** Scene of the session where the agent last spoke; absent: never spoke */
  lastSceneId?: string;
  /** Learner messages sent since the agent last spoke; absent: never spoke */
  learnerTurnsSince?: number;
}

/**
 * How one lecture moment ended for the learner. The server looks up its
 * opener, topic and scene in storeState.scenes by actionId; unknown ids drop.
 */
export interface ClassMomentOutcome {
  /** The scene's DiscussionAction.id */
  actionId: string;
  outcome: DiscussionOutcome;
}

/**
 * Who has been present in this course so far: facts the director states, not
 * instructions. Built on the client from loaded sessions and lecture badges.
 */
export interface ClassPresence {
  /** At most one entry per agentId, at most config.agentIds.length entries */
  agents: ClassPresenceAgent[];
  /** Oldest first, at most PI_REQUEST_BOUNDS.presenceMomentsMax */
  moments?: ClassMomentOutcome[];
}

export type ClassMemoryEntryKind = 'lecture-moment' | 'qa' | 'discussion' | 'aside';

export const CLASS_MEMORY_ENTRY_KINDS: readonly ClassMemoryEntryKind[] = [
  'lecture-moment',
  'qa',
  'discussion',
  'aside',
];

/** What one speaker said in a memory entry, in a few words */
export interface ClassMemoryPoint {
  /** One of config.agentIds; points of other agents are dropped */
  agentId: string;
  /** At most PI_REQUEST_BOUNDS.memoryGistMaxChars */
  gist: string;
}

/** One earlier exchange of this course */
export interface ClassMemoryEntry {
  kind: ClassMemoryEntryKind;
  /** Scene it happened on; dropped when not in storeState.scenes */
  sceneId?: string;
  /** The learner's question in one sentence, at most memoryLearnerQuestionMaxChars */
  learnerQuestion?: string;
  /** Each speaker's gist, in speaking order, at most memoryPointsPerEntryMax */
  points: ClassMemoryPoint[];
  /** The learner still had an open question when it ended */
  unresolved?: boolean;
}

/** Turns per speaker in the entries too old to keep one by one */
export interface ClassMemoryTally {
  agentId: string;
  turns: number;
}

/** How the learner is doing; given to the teacher and assistant only */
export interface ClassMemoryLearner {
  /** Concepts behind quiz questions answered wrong, without answers or scores */
  missedConcepts?: string[];
  /** Questions the learner asked more than once */
  repeatedQuestions?: string[];
}

/**
 * Reserved (I33): an agent's latest state of mind, at most one per agent,
 * never rewriting the persona. Validated by the route; nothing produces it yet.
 */
export interface AgentStateNote {
  agentId: string;
  /** At most PI_REQUEST_BOUNDS.memoryAgentNoteMaxChars */
  note: string;
}

/**
 * A compact memory of this course's earlier exchanges, built by
 * lib/chat/class-memory.ts. All its text together stays within
 * PI_REQUEST_BOUNDS.memoryTotalMaxChars.
 */
export interface ClassMemory {
  /** Oldest first, at most PI_REQUEST_BOUNDS.memoryEntriesMax */
  entries: ClassMemoryEntry[];
  olderTallies?: ClassMemoryTally[];
  learner?: ClassMemoryLearner;
  agentNotes?: AgentStateNote[];
}

/** Where the lecture stands on one scene */
export interface LectureProgress {
  /** A scene in storeState.scenes; otherwise the progress is dropped */
  sceneId: string;
  /**
   * Index into that scene's actions of the action playing now, or next to
   * play when paused at a boundary. Speech at indexes <= actionIndex counts as
   * said (the current line possibly only half). Integer >= 0.
   */
  actionIndex: number;
}

/**
 * Persisted params of a lecture bubble's discussion badge (a lecture moment
 * and how it ended), the source of ClassPresence.moments.
 */
export interface LectureDiscussionBadgeParams {
  topic: string;
  prompt?: string;
  /** The scene's DiscussionAction.id */
  discussionActionId?: string;
  /** The opener actually used (the teacher for a legacy moment without one) */
  agentId?: string;
  outcome?: DiscussionOutcome;
}

/**
 * Request body for the stateless chat API
 * All state is sent from the client on each request
 */
export interface StatelessChatRequest {
  /** Conversation history (client-maintained) */
  messages: UIMessage<ChatMessageMetadata>[];
  /** Current application state */
  storeState: {
    stage: Stage | null;
    scenes: Scene[];
    /** Thin course map available to the Pi Director before it reads any scene. */
    outlines?: SceneOutline[];
    currentSceneId: string | null;
    mode: StageMode;
    whiteboardOpen: boolean;
    /** Browser-owned manual visibility revision captured for this request. */
    whiteboardManualVisibilityRevision?: number;
    /**
     * Post-submit quiz state for the CURRENT scene, hydrated by the client
     * from localStorage when the active scene is a graded quiz. Lets the
     * agent give targeted feedback on the student's actual answers
     * (correct/incorrect, written response, AI grader comment) instead of
     * guessing. Absent when the student has not submitted yet, or when the
     * active scene is not a quiz.
     */
    quizResults?: {
      sceneId: string;
      answers: Record<string, string | string[]>;
      results: Array<{
        questionId: string;
        correct: boolean | null;
        status: 'correct' | 'incorrect';
        earned: number;
        aiComment?: string;
      }>;
    };
    /**
     * How far the lecture has got on one scene (normally the current one), so
     * the teacher and assistant know what was just said there. Absent when
     * nothing of that scene is known to have been narrated.
     */
    lectureProgress?: LectureProgress;
  };
  /** Optional Pi-only, identity-only reference to one classroom component. */
  elementReference?: ElementReference;
  /** Request-scoped browser evidence, never a tool permission or static definition. */
  interactiveState?: InteractiveStateEvidence;
  /** Agent configuration */
  config: {
    agentIds: string[];
    sessionType?: 'qa' | 'discussion';
    /**
     * Discussion: the opener's own words, verbatim as the learner saw them on
     * the card (the opener says essentially this). Sent on every request of
     * the session. At most PI_REQUEST_BOUNDS.discussionTopicMaxChars.
     */
    discussionTopic?: string;
    /**
     * Discussion: where the teacher wants the moment to go; director-only
     * guidance, never quoted. At most PI_REQUEST_BOUNDS.discussionPromptMaxChars.
     */
    discussionPrompt?: string;
    /**
     * Discussion: who opens the moment. Must be one of agentIds (else dropped).
     * Absent: the director picks the opener (default the teacher).
     */
    triggerAgentId?: string;
    /** Discussion only: the kind of class moment; absent means 'lecture'. */
    momentKind?: DiscussionMomentKind;
    /** Discussion with momentKind 'ask-learner' only: what the learner chose on the card. */
    learnerStance?: LearnerStance;
    /**
     * Agents the learner explicitly addressed in the latest user message
     * (@-mention or "ask them"). Subset of agentIds, unique, at most
     * PI_REQUEST_BOUNDS.addressedAgentIdsMax. Per request; never persisted.
     */
    addressedAgentIds?: string[];
    /** Facts about who has been present in this course so far (statements, no instructions) */
    classPresence?: ClassPresence;
    /** What was said earlier in this course, and how the learner is doing */
    classMemory?: ClassMemory;
    /**
     * The learner allows the teacher to call on them by name with a direct
     * question. Absent or false: nobody singles the learner out by name.
     */
    teacherMayCallOnLearner?: boolean;
    /** Full agent configs for generated (non-default) agents that aren't in the server-side registry */
    agentConfigs?: Array<{
      id: string;
      name: string;
      role: string;
      persona: string;
      avatar: string;
      color: string;
      allowedActions: string[];
      priority: number;
      isGenerated?: boolean;
      boundStageId?: string;
    }>;
    /** Pi PoC: max child agent turns in one server-side loop. */
    piMaxAgentTurns?: number;
    /** Pi PoC: max emitted actions per child agent turn. */
    piMaxActionsPerAgent?: number;
    /** Pi PoC: opt in to whiteboard tools; defaults off to keep the first A/B pass comparable. */
    piEnableWhiteboardTools?: boolean;
    /**
     * The teaching assistant answers on the side while the teacher keeps
     * lecturing: only the listed assistant speaks, text only (no classroom
     * actions or whiteboard), one agent turn, ending with cue_user (never
     * close_session).
     */
    asideToLecture?: boolean;
  };
  /** Accumulated director state from previous per-agent requests */
  directorState?: DirectorState;
  /** Pi-only context for the first request in a newly created live UI session. */
  piSessionBoundary?: PiSessionBoundaryContext;
  /** User profile for personalization */
  userProfile?: {
    nickname?: string;
    bio?: string;
  };
  /**
   * The learner's interface language: built-in agents are named as the
   * learner sees them. Dropped unless one of the supported locales.
   */
  uiLocale?: Locale;
  /** OpenAI-compatible API credentials */
  apiKey: string;
  baseUrl?: string;
  model?: string;
  providerType?: string;
  /**
   * Opt-in: enable provider-side thinking for this request. Default is
   * `{ enabled: false }` (low-latency chat). Eval harness sets this to
   * `{ enabled: true }` when `EVAL_ENABLE_THINKING=1`.
   */
  thinking?: ThinkingConfig;
  /** UI-selected per-model thinking config. Takes precedence over `thinking`. */
  thinkingConfig?: ThinkingConfig;
  /** Toolbar-selected Web Search provider. Resolved server-side independently from the LLM. */
  webSearchProviderId?: WebSearchProviderId;
  /** Selected provider credential only; server-managed credentials remain authoritative. */
  webSearchApiKey?: string;
  /** Selected provider base URL only; validated server-side and ignored for managed providers. */
  webSearchBaseUrl?: string;
  /** Selected Claude Web Search model only. */
  webSearchModelId?: string;
  /** Selected Baidu Web Search sub-sources only. */
  baiduSubSources?: BaiduSubSources;
}

/**
 * Parsed action from structured output
 */
export interface ParsedAction {
  actionId: string;
  actionName: string;
  params: Record<string, unknown>;
}

/** @deprecated Use ParsedAction instead */
export type ParsedToolCall = ParsedAction;

/**
 * Server-Sent Events for stateless chat API
 */
export type StatelessEvent =
  | {
      type: 'agent_start';
      data: {
        messageId: string;
        agentId: string;
        agentName: string;
        agentAvatar?: string;
        agentColor?: string;
        /** The director's reason for casting this speaker, when it gave a valid one */
        castReason?: CastReason;
      };
    }
  | { type: 'agent_end'; data: { messageId: string; agentId: string } }
  | { type: 'text_delta'; data: { content: string; messageId?: string } }
  | {
      type: 'action';
      data: {
        actionId: string;
        actionName: string;
        params: Record<string, unknown>;
        agentId: string;
        messageId?: string;
      };
    }
  | {
      type: 'thinking';
      data: { stage: 'director' | 'agent_loading'; agentId?: string };
    }
  | {
      type: 'whiteboard';
      data:
        | { kind: 'visibility_query'; queryId: string; stageId: string }
        | {
            kind: 'open' | 'close';
            stageId: string;
            manualVisibilityRevision: number;
          }
        | { kind: 'projection'; stageId: string; lastSeq: number };
    }
  | {
      type: 'cue_user';
      data: {
        /** The last agent who spoke in this turn */
        fromAgentId?: string;
        /**
         * Present only when the turn's last line asks the learner a direct
         * question: that question, as the speaker (fromAgentId) put it, at
         * most PI_REQUEST_BOUNDS.cuePromptMaxChars. Absent: a plain hand-back.
         */
        prompt?: string;
      };
    }
  | {
      type: 'done';
      data: {
        totalActions: number;
        totalAgents: number;
        agentHadContent?: boolean;
        cueUserReceived?: boolean;
        sessionClosed?: boolean;
        endReason?: string;
        directorCompaction?: DirectorCompactionTrace;
        directorToolTrace?: DirectorToolTraceEntry[];
        directorState?: DirectorState;
      };
    }
  | { type: 'error'; data: { message: string } };

// ==================== Pi Casting (director) ====================

/**
 * Why the director casts a speaker: call_agent's optional `castReason`. A
 * missing or unknown value is ignored (never fails the call); a valid one is
 * echoed on agent_start and kept in the message metadata.
 */
export const CAST_REASONS = [
  /** Answers the learner's question or request */
  'answers_learner',
  /** The learner (or the teacher) named this agent */
  'addressed',
  /** Opens the class moment with their own line */
  'opens_moment',
  /** A follow-up "why" / "what if" the last answer opened */
  'follow_up',
  /** Voices the confusion their level leads to */
  'voices_confusion',
  /** Clears up a confusion, or a peer's wrong or unsure line */
  'clears_up',
  /** A concrete example or hands-on tip */
  'example_or_tip',
  /** A quick check of understanding */
  'checks_understanding',
  /** Puts a direct question to the learner */
  'asks_learner',
  /** A short peer reaction */
  'reacts',
  /** Closes the moment or leads back to the lesson */
  'wraps_up',
  'other',
] as const;

export type CastReason = (typeof CAST_REASONS)[number];

export function isCastReason(value: unknown): value is CastReason {
  return typeof value === 'string' && (CAST_REASONS as readonly string[]).includes(value);
}

/**
 * The director's casting rules: 'persona' (who each person is decides who
 * speaks) or 'legacy' (the earlier role-order rules), for A/B evals and
 * rollback. Server env OPENMAIC_PI_PERSONA_CASTING ('legacy', '0', 'false' or
 * 'off' selects 'legacy'); default 'persona'.
 */
export type PiCastingMode = 'persona' | 'legacy';

/** What an eval-only child stub learns about one call_agent turn */
export interface PiChildTurnStubInput {
  agentId: string;
  agentName: string;
  role: string;
  instruction: string;
  castReason?: CastReason;
  /** 0-based index of this child turn in the loop */
  turnIndex: number;
  /** Scenes whose read_scene evidence was attached to this delegation */
  evidenceSceneIds: readonly string[];
}

/**
 * Eval-only injection point (runPiDirectorLoop opts.childTurnStub, passed on
 * to buildCallAgentTool): replaces the child LLM run with scripted speech.
 * call_agent still emits agent_start / text_delta / agent_end and records the
 * turn; '' is an empty turn. Never set by the route.
 */
export type PiChildTurnStub = (input: PiChildTurnStubInput) => string | Promise<string>;

// ==================== Persona Upgrade (edit mode) ====================

/** POST: rewrite chosen agents' personas as real people; nothing else changes */
export const PERSONA_UPGRADE_PATH = '/api/generate/persona-upgrade';

/** Request body of PERSONA_UPGRADE_PATH */
export interface PersonaUpgradeRequest {
  stage: {
    /** At most 200 characters */
    name: string;
    /** At most 1000 characters */
    description?: string;
    /** The course's language directive (stage.languageDirective) */
    languageDirective?: string;
  };
  /** In order, at most 40; title at most 160, description at most 400 characters */
  sceneOutlines?: Array<{ title: string; description?: string }>;
  /** The whole current roster, as context: 1..12 agents, unique ids, persona at most 4000 */
  agents: Array<{ id: string; name: string; role: string; persona: string }>;
  /** Whose persona to rewrite: 1..12 unique ids, all in agents */
  targetAgentIds: string[];
}

/**
 * Success body of PERSONA_UPGRADE_PATH (failures use the usual apiError body).
 * Exactly one persona per targetAgentId, in that order; ids, names, roles,
 * avatars and voices are untouched.
 */
export interface PersonaUpgradeResponse {
  success: true;
  personas: Array<{ id: string; persona: string }>;
}
