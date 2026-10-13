'use client';

import { sampleInteractiveState } from '@/lib/interactive/chat-observation';

import { useState, useCallback, useRef, useEffect } from 'react';
import {
  nextChatUpdatedAt,
  withChatSegmentReveal,
  withChatSessionStatus,
  type ChatSession,
  type SessionType,
  type SessionStatus,
  type ChatMessageMetadata,
  type DirectorState,
  type PiSessionBoundaryContext,
  type StatelessEvent,
  type ElementReference,
  type SessionConfig,
  type DiscussionMomentKind,
  type LearnerStance,
  type LectureDiscussionBadgeParams,
  type LectureProgress,
  type CastReason,
  PI_REQUEST_BOUNDS,
  isCastReason,
} from '@/lib/types/chat';
import type { Locale } from '@/lib/i18n/types';
import { supportedLocales } from '@/lib/i18n/locales';
import type { DiscussionOutcome } from '@/lib/playback/types';
import {
  buildClassPresence,
  upsertLectureMomentBadge,
  withRequestMessages,
} from '@/lib/chat/class-presence';
import { buildClassMemory, loadQuizMisses, type QuizMissRecord } from '@/lib/chat/class-memory';
import { mentionRoster, resolveAddressedAgentIds } from '@/lib/chat/agent-mention';
import type { DiscussionRequest } from '@/lib/types/roundtable';
import type { Action } from '@/lib/types/action';
import type { Stage } from '@/lib/types/stage';
import type { UIMessage } from 'ai';
import { useStageStore } from '@/lib/store';
import { useCanvasStore } from '@/lib/store/canvas';
import { useSettingsStore } from '@/lib/store/settings';
import { useUserProfileStore } from '@/lib/store/user-profile';
import { useAgentRegistry } from '@/lib/orchestration/registry/store';
import type { AgentConfig } from '@/lib/orchestration/registry/types';
import { pickClassroomTeacher } from '@/lib/orchestration/registry/agent-selection';
import { useI18n } from '@/lib/hooks/use-i18n';
import { classroomChatUsable, loadModelCapabilities } from '@/lib/model-settings/capabilities';
import { USER_AVATAR } from '@/lib/types/roundtable';
import { StreamBuffer } from '@/lib/buffer/stream-buffer';
import type { AgentStartItem, ActionItem } from '@/lib/buffer/stream-buffer';
import { runAgentLoop, type AgentLoopStoreState } from '@/lib/chat/agent-loop';
import { ActionEngine } from '@/lib/action/engine';
import {
  buildQuizResultsForStoreState,
  didActiveSceneRemainUnchanged,
} from '@/lib/chat/quiz-results-for-store-state';
import { toast } from 'sonner';
import { createLogger } from '@/lib/logger';
import { isPiChatEnabled } from '@/lib/config/feature-flags';
import type { CleanupSource } from '@/lib/playback/auto-resume';
import { nanoid } from 'nanoid';
import { isWhiteboardReferenceAvailable } from '@/lib/whiteboard/element-reference';
import { refreshWhiteboardRuntimeProjection } from '@/lib/whiteboard/runtime/browser-projection';

const log = createLogger('ChatSessions');
const SOFT_CLOSE_TIMEOUT_MS = 15_000;

export interface SoftCloseRegistration {
  token: string;
  deadline: number;
  timer: ReturnType<typeof setTimeout>;
  endReason?: string;
  directorState?: DirectorState;
}

export function takeSoftCloseRegistration(
  registrations: Map<string, SoftCloseRegistration>,
  sessionId: string,
  expectedToken?: string,
): SoftCloseRegistration | undefined {
  const registration = registrations.get(sessionId);
  if (!registration || (expectedToken && registration.token !== expectedToken)) return undefined;
  registrations.delete(sessionId);
  clearTimeout(registration.timer);
  return registration;
}

/** Context used by playback cleanup and optional lecture auto-resume. */
export interface SessionCleanupPayload {
  sessionId: string;
  endReason?: string;
  source: CleanupSource;
}

export interface EndSessionOptions {
  source?: CleanupSource;
}

export const MANUAL_STOP_END_OPTIONS: EndSessionOptions = { source: 'manual_stop' };

export interface PreviousLiveSessionContext {
  endSource?: CleanupSource;
  sceneId?: string;
}

export function createPreviousLiveSessionContext(
  session: Pick<ChatSession, 'sceneId'>,
  currentSceneId: string | null | undefined,
  endSource?: CleanupSource,
): PreviousLiveSessionContext {
  return {
    endSource,
    sceneId: session.sceneId ?? currentSceneId ?? undefined,
  };
}

export function createPiSessionBoundaryContext(
  previous: PreviousLiveSessionContext | undefined,
  currentSceneId: string | null | undefined,
): PiSessionBoundaryContext {
  return {
    isFirstRequestInLiveSession: true,
    previousEndSource: previous?.endSource,
    sameSceneAsPrevious:
      previous?.sceneId && currentSceneId ? previous.sceneId === currentSceneId : undefined,
  };
}

export function getPiSessionBoundaryContext(
  contexts: Map<string, PiSessionBoundaryContext>,
  sessionId: string,
): PiSessionBoundaryContext | undefined {
  return contexts.get(sessionId);
}

export function consumePiSessionBoundaryContext(
  contexts: Map<string, PiSessionBoundaryContext>,
  sessionId: string,
  expected: PiSessionBoundaryContext,
): boolean {
  if (contexts.get(sessionId) !== expected) return false;
  return contexts.delete(sessionId);
}

interface UseChatSessionsOptions {
  onLiveSpeech?: (text: string | null, agentId?: string | null) => void;
  onSpeechProgress?: (ratio: number | null) => void;
  onThinking?: (state: { stage: string; agentId?: string } | null) => void;
  onCueUser?: (fromAgentId?: string, prompt?: string) => void;
  onActiveBubble?: (messageId: string | null) => void;
  onLiveSessionError?: () => void;
  /** Called immediately when the server semantically closes a QA/Discussion session. */
  onSoftCloseSession?: (payload: SessionCleanupPayload) => void;
  /** Called when a QA/Discussion session completes naturally (director end). */
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
   * The teaching assistant's aside (it answers in the chat while the lecture
   * keeps playing) reports on its own channel: its live text and speaker, and
   * its thinking. It never reaches the lecture-facing callbacks above (live
   * speech, thinking, cue, active bubble, TTS, stop / error cleanup).
   */
  onAsideLiveSpeech?: (text: string | null, agentId?: string | null) => void;
  onAsideThinking?: (state: { stage: string; agentId?: string } | null) => void;
  /**
   * Where the lecture stands on the current scene (the playback cursor), read
   * as each Pi request leaves: the teacher and assistant hear what was just
   * said there (I14). Null or absent when playback has not started there.
   */
  getLectureProgress?: () => LectureProgress | null | undefined;
}

export type ChatRequestTemplate = {
  messages: UIMessage<ChatMessageMetadata>[];
  config: {
    agentIds: string[];
    sessionType?: string;
    agentConfigs?: Record<string, unknown>[];
    piEnableWhiteboardTools?: boolean;
    [key: string]: unknown;
  };
  userProfile?: { nickname?: string; bio?: string };
  directorState?: DirectorState;
  piSessionBoundary?: PiSessionBoundaryContext;
  elementReference?: ElementReference;
  /** Pi: the learner's interface language (built-in agents go by the names shown) */
  uiLocale?: Locale;
};

export interface ChatMessageSendOptions {
  elementReference?: ElementReference;
  onResponseAccepted?: (response: Response) => void;
}

/** A question for the teaching assistant's aside */
export interface AsideMessageSendOptions extends ChatMessageSendOptions {
  /** The assistant that answers (the only agent in the request) */
  agentId: string;
}

/** The aside's request limits: the assistant alone, one turn, text only */
export const ASIDE_PI_MAX_AGENT_TURNS = 1;

/**
 * A teaching-assistant aside: the assistant answered in the chat while the
 * teacher kept lecturing. Still a 'qa' session, marked in its config.
 */
export function isAsideSession(session: Pick<ChatSession, 'config'>): boolean {
  return session.config?.aside === true;
}

/**
 * An open Q&A / discussion that is not an aside: the session the lecture-facing
 * controls (stop, pause / resume, soft close) act on.
 */
export function isOpenMainLiveSession(
  session: Pick<ChatSession, 'type' | 'status' | 'config'>,
): boolean {
  return isOpenLiveSession(session) && !isAsideSession(session);
}

/** The assistant as the server should run it in an aside: no classroom actions at all */
export function toTextOnlyAgentConfig(
  agent: AgentConfig | undefined,
): Record<string, unknown> | undefined {
  if (!agent) return undefined;
  const { createdAt: _c, updatedAt: _u, isDefault: _d, ...rest } = agent;
  return { ...rest, allowedActions: [] };
}

/**
 * The aside's request: only the assistant (`agentIds: [assistant]`, its config
 * sent with no actions so neither runtime can touch the stage), one agent
 * turn, no whiteboard tools, and `asideToLecture` so the director has the
 * assistant answer and cue the learner instead of closing.
 */
export function buildAsideRequestTemplate({
  messages,
  agentId,
  agent,
  userProfile,
  directorState,
  elementReference,
  addressedAgentIds,
}: {
  messages: UIMessage<ChatMessageMetadata>[];
  agentId: string;
  agent?: AgentConfig;
  userProfile?: { nickname?: string; bio?: string };
  directorState?: DirectorState;
  elementReference?: ElementReference;
  /** The latest message named the assistant (@): it answers as the one addressed */
  addressedAgentIds?: string[];
}): ChatRequestTemplate {
  const agentConfig = toTextOnlyAgentConfig(agent);
  return {
    messages,
    config: {
      agentIds: [agentId],
      sessionType: 'qa',
      ...(agentConfig ? { agentConfigs: [agentConfig] } : {}),
      piMaxAgentTurns: ASIDE_PI_MAX_AGENT_TURNS,
      piEnableWhiteboardTools: false,
      asideToLecture: true,
      ...(addressedAgentIds?.length ? { addressedAgentIds } : {}),
    },
    userProfile,
    directorState,
    ...(elementReference ? { elementReference } : {}),
  };
}

/** A streamed answer cut short: its last text gets "..." and the interrupted mark */
export function markLastAssistantInterrupted(
  messages: UIMessage<ChatMessageMetadata>[],
): UIMessage<ChatMessageMetadata>[] {
  const next = [...messages];
  for (let i = next.length - 1; i >= 0; i--) {
    if (next[i].role !== 'assistant') continue;
    const parts = [...next[i].parts];
    let appended = false;
    for (let j = parts.length - 1; j >= 0; j--) {
      if (parts[j].type === 'text') {
        const textPart = parts[j] as { type: 'text'; text: string };
        parts[j] = {
          type: 'text',
          text: (textPart.text || '') + '...',
        } as UIMessage<ChatMessageMetadata>['parts'][number];
        appended = true;
        break;
      }
    }
    if (!appended) {
      parts.push({ type: 'text', text: '...' } as UIMessage<ChatMessageMetadata>['parts'][number]);
    }
    next[i] = { ...next[i], parts, metadata: { ...next[i].metadata, interrupted: true } };
    return next;
  }
  return messages;
}

/**
 * One fresh store-state snapshot for an outgoing chat request. Quiz results
 * come from the async RuntimeStore read; the before/after scene compare drops
 * them when a scene transition raced the read (a stale scene's results must
 * not leak into the next scene's request).
 */
async function buildFreshAgentLoopStoreState(): Promise<AgentLoopStoreState> {
  const stateBeforeQuizRead = useStageStore.getState();
  const quizResults = await buildQuizResultsForStoreState(
    stateBeforeQuizRead.scenes,
    stateBeforeQuizRead.currentSceneId,
  );
  const freshState = useStageStore.getState();
  return {
    stage: freshState.stage,
    scenes: freshState.scenes,
    outlines: freshState.outlines,
    currentSceneId: freshState.currentSceneId,
    mode: freshState.mode,
    whiteboardOpen: useCanvasStore.getState().whiteboardOpen,
    whiteboardManualVisibilityRevision:
      useCanvasStore.getState().whiteboardManualVisibilityRevision,
    quizResults: didActiveSceneRemainUnchanged(
      stateBeforeQuizRead.scenes,
      stateBeforeQuizRead.currentSceneId,
      freshState.scenes,
      freshState.currentSceneId,
    )
      ? quizResults
      : undefined,
  };
}

export function withPiInclassWhiteboardTools<T extends ChatRequestTemplate>(requestTemplate: T): T {
  return {
    ...requestTemplate,
    config: {
      ...requestTemplate.config,
      piEnableWhiteboardTools: true,
    },
  };
}

export function shouldAwaitPresentationAction(actionName: string): boolean {
  return actionName.startsWith('wb_');
}

type LectureVisualAction = Extract<Action, { type: 'spotlight' | 'laser' | 'discussion' }>;

/**
 * Persist params for lecture action badges. Omit optional members JSON would
 * drop as undefined. A discussion badge is a LectureDiscussionBadgeParams:
 * the moment's id, and — once known — the opener actually used and how the
 * moment ended (`moment`).
 */
export function lectureActionPersistParams(
  action: LectureVisualAction,
  moment: { agentId?: string; outcome?: DiscussionOutcome } = {},
): Record<string, unknown> {
  if (action.type === 'spotlight') {
    return {
      elementId: action.elementId,
      ...(action.dimOpacity === undefined ? {} : { dimOpacity: action.dimOpacity }),
    };
  }
  if (action.type === 'laser') {
    return { elementId: action.elementId };
  }
  return { ...lectureMomentBadgeParams(action, moment) };
}

/** A lecture moment's badge: the moment, its opener and (once known) its outcome */
export function lectureMomentBadgeParams(
  action: Extract<Action, { type: 'discussion' }>,
  moment: { agentId?: string; outcome?: DiscussionOutcome } = {},
): LectureDiscussionBadgeParams {
  const agentId = moment.agentId ?? action.agentId;
  return {
    topic: action.topic,
    ...(action.prompt === undefined ? {} : { prompt: action.prompt }),
    ...(action.id ? { discussionActionId: action.id } : {}),
    ...(agentId ? { agentId } : {}),
    ...(moment.outcome ? { outcome: moment.outcome } : {}),
  };
}

/**
 * A request's config with the course's class presence (I06) for the
 * requested agents: who spoke how often and where, and how the lecture
 * moments ended. `sessions` are the loaded ones; the request's own messages
 * replace (or add) its session's, which the list may not show yet.
 */
export function withClassPresence<T extends ChatRequestTemplate>(
  requestTemplate: T,
  sessions: readonly ChatSession[],
  request: { sessionId: string; type: SessionType; sceneId?: string },
): T {
  const classPresence = buildClassPresence({
    sessions: withRequestMessages(sessions, { ...request, messages: requestTemplate.messages }),
    agentIds: requestTemplate.config.agentIds,
  });
  if (!classPresence) return requestTemplate;
  return { ...requestTemplate, config: { ...requestTemplate.config, classPresence } };
}

/**
 * A request's config with the course's class memory (I13): what was said in
 * the earlier sessions (not this one: its messages travel with the request),
 * and the learner's missed quiz concepts and repeated questions — this
 * request's own question included.
 */
export function withClassMemory<T extends ChatRequestTemplate>(
  requestTemplate: T,
  sessions: readonly ChatSession[],
  request: { sessionId: string; type: SessionType; sceneId?: string },
  course: {
    quizMisses?: readonly QuizMissRecord[];
    scenes?: readonly { id: string }[];
    /**
     * Whose lines to remember, when not just the requested agents: an aside
     * requests only the assistant, yet what the teacher and classmates said
     * earlier still concerns it
     */
    classAgentIds?: readonly string[];
  } = {},
): T {
  const classMemory = buildClassMemory({
    sessions: withRequestMessages(sessions, { ...request, messages: requestTemplate.messages }),
    agentIds: course.classAgentIds
      ? [...new Set([...requestTemplate.config.agentIds, ...course.classAgentIds])]
      : requestTemplate.config.agentIds,
    excludeSessionId: request.sessionId,
    quizMisses: course.quizMisses,
    sceneIds: course.scenes ? new Set(course.scenes.map((scene) => scene.id)) : undefined,
  });
  if (!classMemory) return requestTemplate;
  return { ...requestTemplate, config: { ...requestTemplate.config, classMemory } };
}

/**
 * The store state with how far the lecture got on its current scene (I14):
 * only progress on that very scene, as a whole index within the route's
 * bound; anything else is left out.
 */
export function withLectureProgress<S extends AgentLoopStoreState>(
  storeState: S,
  progress: LectureProgress | null | undefined,
): S {
  if (
    !progress ||
    !storeState.currentSceneId ||
    progress.sceneId !== storeState.currentSceneId ||
    !Number.isSafeInteger(progress.actionIndex) ||
    progress.actionIndex < 0
  ) {
    return storeState;
  }
  return {
    ...storeState,
    lectureProgress: {
      sceneId: progress.sceneId,
      actionIndex: Math.min(progress.actionIndex, PI_REQUEST_BOUNDS.lectureActionIndexMax),
    },
  };
}

/**
 * A Pi request in the learner's interface language (I22): built-in agents
 * are named as the learner sees them. Only a supported locale is sent.
 */
export function withUiLocale<T extends ChatRequestTemplate>(
  requestTemplate: T,
  locale: string | undefined,
): T {
  const known = supportedLocales.find((entry) => entry.code === locale);
  return known ? { ...requestTemplate, uiLocale: known.code } : requestTemplate;
}

/**
 * Whom the learner's message addresses by name (I23): `@` + a roster name,
 * under the registry's name or the one the interface shows. Per request,
 * never kept in the session; empty when nobody is named.
 */
export function addressedAgentIdsOf(
  content: string,
  agentIds: readonly string[],
  t: (key: string) => string,
): string[] {
  const registry = useAgentRegistry.getState();
  return resolveAddressedAgentIds(
    content,
    mentionRoster(agentIds, (id) => registry.getAgent(id), t),
  );
}

/**
 * The assistant message an agent_start opens: its speaker (the registry's
 * name and avatar first) and, when the director said why it cast them, the
 * reason (I20), kept for offline casting stats.
 */
export function agentStartMessage(
  data: Pick<AgentStartItem, 'messageId' | 'agentId' | 'agentName' | 'avatar'>,
  agentConfig: Pick<AgentConfig, 'name' | 'avatar'> | undefined,
  now: number,
  castReason?: CastReason,
): UIMessage<ChatMessageMetadata> {
  return {
    id: data.messageId,
    role: 'assistant',
    parts: [],
    metadata: {
      senderName: agentConfig?.name || data.agentName,
      senderAvatar: data.avatar || agentConfig?.avatar,
      originalRole: 'agent',
      agentId: data.agentId,
      createdAt: now,
      ...(castReason ? { castReason } : {}),
    },
  };
}

/**
 * A discussion text trimmed and cut (by characters) to the Pi route's bound,
 * so the route has nothing left to cut. Undefined when empty.
 */
function boundedDiscussionText(value: string | undefined, maxChars: number): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return Array.from(trimmed).slice(0, maxChars).join('').trimEnd() || undefined;
}

/** How a discussion's moment opened: kept in the session config, sent on every request */
export type DiscussionMomentFields = Pick<
  SessionConfig,
  'discussionTopic' | 'discussionPrompt' | 'triggerAgentId' | 'momentKind' | 'learnerStance'
>;

/**
 * The moment fields of a discussion: the opener's own words (`topic`, as the
 * card showed them), the teacher's intent (`prompt`, director-only) and who
 * opened it. Empty values are left out.
 */
export function buildDiscussionMomentFields(input: {
  topic?: string;
  prompt?: string;
  triggerAgentId?: string;
  momentKind?: DiscussionMomentKind;
  learnerStance?: LearnerStance;
}): DiscussionMomentFields {
  const discussionTopic = boundedDiscussionText(
    input.topic,
    PI_REQUEST_BOUNDS.discussionTopicMaxChars,
  );
  const discussionPrompt = boundedDiscussionText(
    input.prompt,
    PI_REQUEST_BOUNDS.discussionPromptMaxChars,
  );
  return {
    ...(discussionTopic ? { discussionTopic } : {}),
    ...(discussionPrompt ? { discussionPrompt } : {}),
    ...(input.triggerAgentId ? { triggerAgentId: input.triggerAgentId } : {}),
    ...(input.momentKind ? { momentKind: input.momentKind } : {}),
    ...(input.learnerStance ? { learnerStance: input.learnerStance } : {}),
  };
}

/**
 * A class moment to open: a lecture moment (its opener and words, and for a
 * teacher's whole-class question what the learner chose on its card), or a
 * quiz review (no opener: the director picks one).
 */
export type ClassMomentRequest = DiscussionRequest;

/**
 * The moment fields a follow-up or retry of this session sends: a
 * discussion's, copied from its config (a discussion persisted before the
 * config kept its topic falls back to its title, which is the topic), so the
 * server still knows how the moment opened. Nothing for Q&A.
 */
export function discussionRequestFields(
  session: Pick<ChatSession, 'type' | 'title' | 'config'> | undefined,
): DiscussionMomentFields {
  if (!session || session.type !== 'discussion') return {};
  const { config } = session;
  return buildDiscussionMomentFields({
    topic: config.discussionTopic ?? session.title,
    prompt: config.discussionPrompt,
    triggerAgentId: config.triggerAgentId,
    momentKind: config.momentKind,
    learnerStance: config.learnerStance,
  });
}

const DISCUSSION_MOMENT_FIELD_KEYS = [
  'discussionTopic',
  'discussionPrompt',
  'triggerAgentId',
  'momentKind',
  'learnerStance',
] as const satisfies readonly (keyof DiscussionMomentFields)[];

/**
 * The config the classic (non-Pi) loop sends. Its director dispatches the
 * trigger agent unasked on a loop's first turn and frames any request with a
 * topic as a freshly opened discussion, so the moment fields go only with the
 * request that opens it (no assistant message yet). On a follow-up or resume
 * the classic director chooses who speaks, as it always did.
 */
export function classicLoopConfig(
  config: ChatRequestTemplate['config'],
  messages: readonly Pick<UIMessage, 'role'>[],
): ChatRequestTemplate['config'] {
  if (!messages.some((message) => message.role === 'assistant')) return config;
  const followUp = { ...config };
  for (const key of DISCUSSION_MOMENT_FIELD_KEYS) delete followUp[key];
  return followUp;
}

export async function retireLiveRequestResources<
  T extends { shutdown(): void; waitForCurrentAction?(): Promise<void> },
>(
  controller: AbortController | null,
  sessionId: string | null,
  buffers: Map<string, T>,
): Promise<void> {
  controller?.abort();
  if (!sessionId) return;
  const buffer = buffers.get(sessionId);
  buffer?.shutdown();
  buffers.delete(sessionId);
  await buffer?.waitForCurrentAction?.();
}

type StatelessStreamConsumerFactory = (
  sessionId: string,
  controller: AbortController,
  sessionType: SessionType,
) => {
  onEvent: (event: StatelessEvent) => void;
  onIterationEnd: () => Promise<{
    directorState: DirectorState | undefined;
    totalAgents: number;
    agentHadContent: boolean;
    cueUserReceived?: boolean;
    sessionClosed?: boolean;
    endReason?: string;
  } | null>;
};

export function normalizeStoredSessionsForRestore(sessions: ChatSession[]): ChatSession[] {
  return sessions.map((session) => {
    if (session.status === 'active') {
      return {
        ...withChatSessionStatus(session, 'interrupted'),
        softCloseDeadline: undefined,
      };
    }
    if (session.status === 'soft-closing') {
      return {
        ...withChatSessionStatus(session, 'completed'),
        softCloseDeadline: undefined,
      };
    }
    return session.softCloseDeadline ? { ...session, softCloseDeadline: undefined } : session;
  });
}

function isLiveSessionType(session: Pick<ChatSession, 'type'>): boolean {
  return session.type === 'qa' || session.type === 'discussion';
}

export function isOpenLiveSession(session: Pick<ChatSession, 'type' | 'status'>): boolean {
  return (
    isLiveSessionType(session) && (session.status === 'active' || session.status === 'soft-closing')
  );
}

export function resumeSoftClosingSessionForFollowUp(
  session: ChatSession,
  userMessage: UIMessage<ChatMessageMetadata>,
  now: number,
): ChatSession {
  return {
    ...session,
    messages: [...session.messages, userMessage],
    status: 'active' as SessionStatus,
    endReason: undefined,
    softCloseDeadline: undefined,
    updatedAt: nextChatUpdatedAt(session, now),
  };
}

export function resumeSoftClosingSessionWithoutMessage(
  session: ChatSession,
  now: number,
): ChatSession | undefined {
  if (session.status !== 'soft-closing') return undefined;
  return {
    ...session,
    status: 'active',
    endReason: undefined,
    softCloseDeadline: undefined,
    updatedAt: nextChatUpdatedAt(session, now),
  };
}

export type PiSingleRequestOutcome =
  | { type: 'error'; messageKey: 'chat.error.streamInterrupted' }
  | { type: 'soft_closing'; endReason?: string; directorState?: DirectorState }
  | { type: 'cue_user'; directorState?: DirectorState }
  | { type: 'completed'; directorState?: DirectorState };

export function getPiSingleRequestOutcome(
  doneData: Awaited<ReturnType<ReturnType<StatelessStreamConsumerFactory>['onIterationEnd']>>,
): PiSingleRequestOutcome {
  if (!doneData) {
    return { type: 'error', messageKey: 'chat.error.streamInterrupted' };
  }
  if (doneData.sessionClosed) {
    return {
      type: 'soft_closing',
      endReason: doneData.endReason,
      directorState: doneData.directorState,
    };
  }
  if (doneData.totalAgents === 0 || doneData.agentHadContent === false) {
    return { type: 'error', messageKey: 'chat.error.streamInterrupted' };
  }
  if (doneData.cueUserReceived) {
    return { type: 'cue_user', directorState: doneData.directorState };
  }
  return { type: 'completed', directorState: doneData.directorState };
}

/**
 * POST /api/chat (the stateless agent loop). The server resolves the model
 * from the workspace's model settings.
 */
export function fetchStatelessChat(
  body: Record<string, unknown>,
  signal: AbortSignal,
): Promise<Response> {
  return fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
}

export async function runPiSingleRequest(
  sessionId: string,
  requestTemplate: ChatRequestTemplate & { storeState: AgentLoopStoreState },
  controller: AbortController,
  sessionType: SessionType,
  createConsumer: StatelessStreamConsumerFactory,
  clearLiveSessionAfterError: (sessionId: string, message: string) => void,
  enterSoftClosing: (
    sessionId: string,
    data: { endReason?: string; directorState?: DirectorState },
  ) => void,
  markSessionCompleted: (
    sessionId: string,
    data?: { endReason?: string; directorState?: DirectorState; source?: CleanupSource },
  ) => void,
  storeDirectorState: (sessionId: string, directorState?: DirectorState) => void,
  onStopSessionRef: { current?: ((payload: SessionCleanupPayload) => void) | undefined },
  t: (key: string) => string,
  onResponseAccepted?: (response: Response) => void,
): Promise<void> {
  const consumer = createConsumer(sessionId, controller, sessionType);
  // Every send re-samples the current Scene, including a follow-up with no reference.
  const interactiveState = await sampleInteractiveState(
    requestTemplate.storeState,
    controller.signal,
  );
  if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
  const reference = requestTemplate.elementReference;
  if (reference?.kind === 'whiteboard_element') {
    const canvas = useCanvasStore.getState();
    // Check the snapshot POSTed below; a runtime projection disables referencing.
    if (
      canvas.whiteboardClearing ||
      !isWhiteboardReferenceAvailable(
        reference,
        requestTemplate.storeState.stage as Stage | null,
        canvas.runtimeWhiteboardProjection,
      )
    ) {
      throw new Error(t('chat.elementReference.whiteboardChanged'));
    }
  }
  const response = await fetch('/api/chat/pi', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...requestTemplate, ...(interactiveState ? { interactiveState } : {}) }),
    signal: controller.signal,
  });

  if (!response.ok) {
    if (reference?.kind === 'whiteboard_element') {
      const errorBody = await response.json().catch(() => null);
      if (errorBody?.reason === 'whiteboard_reference_changed') {
        throw new Error(t('chat.elementReference.whiteboardChanged'));
      }
    }
    throw new Error(`Pi chat request failed: ${response.status}`);
  }
  if (!response.body) {
    throw new Error('Pi chat response body is empty');
  }
  onResponseAccepted?.(response);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let sseBuffer = '';
  let sawDoneEvent = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      sseBuffer += decoder.decode(value, { stream: true });
      const parts = sseBuffer.split('\n\n');
      sseBuffer = parts.pop() || '';

      for (const part of parts) {
        if (!part.trim() || part.startsWith(':')) continue;
        const dataLine = part.split('\n').find((line) => line.startsWith('data: '));
        if (!dataLine) continue;
        const event = JSON.parse(dataLine.slice(6)) as StatelessEvent;
        if (event.type === 'error') {
          if (controller.signal.aborted) return;
          // A reported service failure belongs in the session, not the dev error overlay.
          log.warn('[Pi] Chat service error:', event.data.message);
          clearLiveSessionAfterError(
            sessionId,
            /\boverload(?:ed)?\b/i.test(event.data.message)
              ? t('chat.error.modelBusy')
              : event.data.message,
          );
          onStopSessionRef.current?.({ sessionId, source: 'error' });
          await reader.cancel().catch(() => undefined);
          return;
        }
        if (event.type === 'done') sawDoneEvent = true;
        consumer.onEvent(event);
      }
    }
  } finally {
    reader.releaseLock();
  }

  const doneData = sawDoneEvent ? await consumer.onIterationEnd() : null;

  if (controller.signal.aborted) return;

  const outcome = getPiSingleRequestOutcome(doneData);
  if (outcome.type === 'error') {
    clearLiveSessionAfterError(sessionId, t(outcome.messageKey));
    onStopSessionRef.current?.({ sessionId, source: 'error' });
    return;
  }

  if (outcome.type === 'soft_closing') {
    enterSoftClosing(sessionId, {
      endReason: outcome.endReason,
      directorState: outcome.directorState,
    });
    return;
  }

  if (outcome.type === 'cue_user') {
    storeDirectorState(sessionId, outcome.directorState);
    return;
  }

  // The Pi endpoint owns the whole server-side loop; one successful done closes
  // this classroom turn instead of asking the frontend to POST another turn.
  markSessionCompleted(sessionId, {
    directorState: outcome.directorState,
    source: 'turn_complete',
  });
  onStopSessionRef.current?.({ sessionId, source: 'turn_complete' });
}

export async function respondToWhiteboardVisibilityQuery(
  data: Extract<StatelessEvent, { type: 'whiteboard' }>['data'] & {
    kind: 'visibility_query';
  },
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted || useStageStore.getState().stage?.id !== data.stageId) return;
  const visibility = useCanvasStore.getState().whiteboardOpen ? 'open' : 'closed';
  const response = await fetch('/api/chat/pi/whiteboard-visibility', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      queryId: data.queryId,
      stageId: data.stageId,
      visibility,
    }),
    signal,
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`Whiteboard visibility response failed: ${response.status}`);
  }
}

export function consumePiWhiteboardEvent(
  data: Extract<StatelessEvent, { type: 'whiteboard' }>['data'],
  signal: AbortSignal,
): void {
  if (signal.aborted || useStageStore.getState().stage?.id !== data.stageId) return;
  if (data.kind === 'visibility_query') {
    void respondToWhiteboardVisibilityQuery(data, signal).catch((error) => {
      if (!signal.aborted) log.warn('Whiteboard visibility response failed', error);
    });
    return;
  }
  if (data.kind === 'projection') {
    void refreshWhiteboardRuntimeProjection(data.stageId, data.lastSeq);
    return;
  }
  const canvas = useCanvasStore.getState();
  if (canvas.whiteboardManualVisibilityRevision !== data.manualVisibilityRevision) return;
  canvas.setWhiteboardOpen(data.kind === 'open');
}

export function useChatSessions(options: UseChatSessionsOptions = {}) {
  const onLiveSpeechRef = useRef(options.onLiveSpeech);
  const onSpeechProgressRef = useRef(options.onSpeechProgress);
  const onThinkingRef = useRef(options.onThinking);
  const onCueUserRef = useRef(options.onCueUser);
  const onActiveBubbleRef = useRef(options.onActiveBubble);
  const onLiveSessionErrorRef = useRef(options.onLiveSessionError);
  const onSoftCloseSessionRef = useRef(options.onSoftCloseSession);
  const onStopSessionRef = useRef(options.onStopSession);
  const onSegmentSealedRef = useRef(options.onSegmentSealed);
  const shouldHoldAfterRevealRef = useRef(options.shouldHoldAfterReveal);
  const onAsideLiveSpeechRef = useRef(options.onAsideLiveSpeech);
  const onAsideThinkingRef = useRef(options.onAsideThinking);
  const getLectureProgressRef = useRef(options.getLectureProgress);
  useEffect(() => {
    onLiveSpeechRef.current = options.onLiveSpeech;
    onSpeechProgressRef.current = options.onSpeechProgress;
    onThinkingRef.current = options.onThinking;
    onCueUserRef.current = options.onCueUser;
    onActiveBubbleRef.current = options.onActiveBubble;
    onLiveSessionErrorRef.current = options.onLiveSessionError;
    onSoftCloseSessionRef.current = options.onSoftCloseSession;
    onStopSessionRef.current = options.onStopSession;
    onSegmentSealedRef.current = options.onSegmentSealed;
    shouldHoldAfterRevealRef.current = options.shouldHoldAfterReveal;
    onAsideLiveSpeechRef.current = options.onAsideLiveSpeech;
    onAsideThinkingRef.current = options.onAsideThinking;
    getLectureProgressRef.current = options.getLectureProgress;
  }, [
    options.onLiveSpeech,
    options.onSpeechProgress,
    options.onThinking,
    options.onCueUser,
    options.onActiveBubble,
    options.onLiveSessionError,
    options.onSoftCloseSession,
    options.onStopSession,
    options.onSegmentSealed,
    options.shouldHoldAfterReveal,
    options.onAsideLiveSpeech,
    options.onAsideThinking,
    options.getLectureProgress,
  ]);
  const { t, locale } = useI18n();
  // The interface language each Pi request is sent in (read as it leaves)
  const localeRef = useRef<string | undefined>(locale);
  useEffect(() => {
    localeRef.current = locale;
  }, [locale]);
  // Why the director cast each speaker, from agent_start until its message
  // opens (the buffer reveals it later)
  const castReasonsRef = useRef<Map<string, CastReason>>(new Map());

  // Track current stageId for data isolation
  const stageId = useStageStore((s) => s.stage?.id);
  const stageIdRef = useRef(stageId);
  const currentSceneId = useStageStore((s) => s.currentSceneId);
  const currentSceneIdRef = useRef(currentSceneId);

  const [sessions, setSessions] = useState<ChatSession[]>(() => {
    // Restore sessions from store (loaded from IndexedDB)
    const stored = useStageStore.getState().chats;
    return normalizeStoredSessionsForRestore(stored);
  });
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const streamingSessionIdRef = useRef<string | null>(null);
  const softCloseRegistrationsRef = useRef<Map<string, SoftCloseRegistration>>(new Map());
  const softCloseLifecycleRef = useRef<Map<string, 'soft-closing' | 'active' | 'completed'>>(
    new Map(),
  );
  const sessionsRef = useRef<ChatSession[]>(sessions);
  // The teaching assistant's aside: its own session, request and streaming
  // flag, never the lecture's activeSessionId or the shared abort controller
  const [asideSessionId, setAsideSessionIdState] = useState<string | null>(null);
  const asideSessionIdRef = useRef<string | null>(null);
  const setAsideSessionId = useCallback((sessionId: string | null) => {
    asideSessionIdRef.current = sessionId;
    setAsideSessionIdState(sessionId);
  }, []);
  const [isAsideStreaming, setIsAsideStreaming] = useState(false);
  const asideAbortRef = useRef<AbortController | null>(null);
  const previousLiveSessionRef = useRef<PreviousLiveSessionContext | undefined>(undefined);
  const piSessionBoundariesRef = useRef<Map<string, PiSessionBoundaryContext>>(new Map());
  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  // Per-loop-iteration state — tracks done event data and cue_user for the agent loop
  const loopDoneDataRef = useRef<{
    directorState?: DirectorState;
    totalAgents: number;
    agentHadContent?: boolean;
    cueUserReceived: boolean;
    sessionClosed?: boolean;
    endReason?: string;
  } | null>(null);
  // The aside's own iteration state (never shared with a Q&A / discussion turn)
  const asideLoopDoneDataRef = useRef<typeof loopDoneDataRef.current>(null);

  // Reload sessions when stage changes (course switch)
  // This synchronous setState is intentional: it resets derived state from
  // an external store (IndexedDB) when the stageId dependency changes.
  useEffect(() => {
    if (stageId === stageIdRef.current) return;
    stageIdRef.current = stageId;
    softCloseRegistrationsRef.current.forEach(({ timer }) => clearTimeout(timer));
    softCloseRegistrationsRef.current.clear();
    softCloseLifecycleRef.current.clear();
    // Stage changed — reload sessions from store (already populated by loadFromStorage)
    const stored = useStageStore.getState().chats;
    setSessions(normalizeStoredSessionsForRestore(stored));
    setActiveSessionId(null);
    asideAbortRef.current?.abort();
    asideAbortRef.current = null;
    setAsideSessionId(null);
    setIsAsideStreaming(false);
    previousLiveSessionRef.current = undefined;
    piSessionBoundariesRef.current.clear();
  }, [setAsideSessionId, stageId]);

  useEffect(() => {
    if (currentSceneId === currentSceneIdRef.current) return;
    currentSceneIdRef.current = currentSceneId;
  }, [currentSceneId]);

  const registerFirstPiRequest = useCallback((sessionId: string) => {
    piSessionBoundariesRef.current.set(
      sessionId,
      createPiSessionBoundaryContext(previousLiveSessionRef.current, currentSceneIdRef.current),
    );
  }, []);

  const getFirstPiRequestContext = useCallback((sessionId: string) => {
    return getPiSessionBoundaryContext(piSessionBoundariesRef.current, sessionId);
  }, []);

  // Sync sessions back to store for persistence (debounced via store's debouncedSave)
  // Guard: only write to the currently active stage
  useEffect(() => {
    if (stageIdRef.current && stageIdRef.current === useStageStore.getState().stage?.id) {
      useStageStore.getState().setChats(sessions);
    }
  }, [sessions]);

  // StreamBuffer instances per session (SSE + lecture share the same buffer model)
  const buffersRef = useRef<Map<string, StreamBuffer>>(new Map());
  const pendingRetirementRef = useRef<Promise<void>>(Promise.resolve());

  const retireActiveLiveRequest = useCallback(
    (fallbackSessionId?: string | null): string | null => {
      const interruptedSessionId = streamingSessionIdRef.current ?? fallbackSessionId ?? null;
      const previousRetirement = pendingRetirementRef.current;
      const retirement = retireLiveRequestResources(
        abortControllerRef.current,
        interruptedSessionId,
        buffersRef.current,
      );
      pendingRetirementRef.current = Promise.all([previousRetirement, retirement]).then(
        () => undefined,
      );
      abortControllerRef.current = null;
      streamingSessionIdRef.current = null;
      setIsStreaming(false);
      return interruptedSessionId;
    },
    [],
  );

  // Abort active stream and destroy buffers on unmount
  useEffect(() => {
    const buffers = buffersRef.current;
    const softCloseRegistrations = softCloseRegistrationsRef.current;
    const softCloseLifecycle = softCloseLifecycleRef.current;
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
      asideAbortRef.current?.abort();
      asideAbortRef.current = null;
      softCloseRegistrations.forEach(({ timer }) => clearTimeout(timer));
      softCloseRegistrations.clear();
      softCloseLifecycle.clear();
      buffers.forEach((buf) => buf.shutdown());
      buffers.clear();
    };
  }, []);

  const claimSoftCloseRegistration = useCallback(
    (sessionId: string, expectedToken?: string): SoftCloseRegistration | undefined => {
      return takeSoftCloseRegistration(softCloseRegistrationsRef.current, sessionId, expectedToken);
    },
    [],
  );

  const clearSoftCloseRegistration = useCallback(
    (sessionId: string): boolean => {
      return Boolean(claimSoftCloseRegistration(sessionId));
    },
    [claimSoftCloseRegistration],
  );

  const markSessionCompleted = useCallback(
    (
      sessionId: string,
      data?: { endReason?: string; directorState?: DirectorState; source?: CleanupSource },
    ) => {
      const session = sessionsRef.current.find((candidate) => candidate.id === sessionId);
      if (session && isLiveSessionType(session)) {
        previousLiveSessionRef.current = createPreviousLiveSessionContext(
          session,
          currentSceneIdRef.current,
          data?.source,
        );
      }
      piSessionBoundariesRef.current.delete(sessionId);
      setSessions((prev) =>
        prev.map((s) =>
          s.id === sessionId
            ? {
                ...s,
                status: 'completed' as SessionStatus,
                updatedAt: Date.now(),
                endReason: data?.endReason ?? s.endReason,
                softCloseDeadline: undefined,
                directorState: data?.directorState ?? s.directorState,
              }
            : s,
        ),
      );
    },
    [],
  );

  const finishSoftCloseTimeout = useCallback(
    (sessionId: string, expectedToken?: string): boolean => {
      const registration = claimSoftCloseRegistration(sessionId, expectedToken);
      if (!registration || softCloseLifecycleRef.current.get(sessionId) !== 'soft-closing') {
        return false;
      }
      softCloseLifecycleRef.current.set(sessionId, 'completed');

      const retirement = retireLiveRequestResources(null, sessionId, buffersRef.current);
      pendingRetirementRef.current = Promise.all([pendingRetirementRef.current, retirement]).then(
        () => undefined,
      );
      markSessionCompleted(sessionId, {
        endReason: registration.endReason,
        directorState: registration.directorState,
        source: 'soft_close_timeout',
      });
      onStopSessionRef.current?.({
        sessionId,
        endReason: registration.endReason,
        source: 'soft_close_timeout',
      });
      return true;
    },
    [claimSoftCloseRegistration, markSessionCompleted],
  );

  const storeDirectorState = useCallback((sessionId: string, directorState?: DirectorState) => {
    if (!directorState) return;
    setSessions((prev) =>
      prev.map((s) =>
        s.id === sessionId
          ? {
              ...s,
              directorState,
              updatedAt: nextChatUpdatedAt(s),
            }
          : s,
      ),
    );
  }, []);

  const enterSoftClosing = useCallback(
    (sessionId: string, data: { endReason?: string; directorState?: DirectorState }) => {
      clearSoftCloseRegistration(sessionId);
      const token = nanoid();
      const deadline = Date.now() + SOFT_CLOSE_TIMEOUT_MS;
      softCloseLifecycleRef.current.set(sessionId, 'soft-closing');
      // Entering the soft-closing window is NOT the timeout — only the 15s timer
      // firing below counts as soft_close_timeout (the auto-resume trigger).
      onSoftCloseSessionRef.current?.({
        sessionId,
        endReason: data.endReason,
        source: 'soft_close_enter',
      });
      setSessions((prev) =>
        prev.map((s) =>
          s.id === sessionId
            ? {
                ...s,
                status: 'soft-closing' as SessionStatus,
                updatedAt: Date.now(),
                endReason: data.endReason ?? s.endReason,
                softCloseDeadline: deadline,
                directorState: data.directorState ?? s.directorState,
              }
            : s,
        ),
      );

      const timer = setTimeout(() => {
        finishSoftCloseTimeout(sessionId, token);
      }, SOFT_CLOSE_TIMEOUT_MS);

      softCloseRegistrationsRef.current.set(sessionId, {
        token,
        deadline,
        timer,
        endReason: data.endReason,
        directorState: data.directorState,
      });
    },
    [clearSoftCloseRegistration, finishSoftCloseTimeout],
  );

  useEffect(() => {
    const reconcileExpiredSoftClose = () => {
      if (document.visibilityState !== 'visible') return;
      const now = Date.now();
      for (const [sessionId, registration] of softCloseRegistrationsRef.current) {
        if (now >= registration.deadline) {
          finishSoftCloseTimeout(sessionId, registration.token);
        }
      }
    };
    document.addEventListener('visibilitychange', reconcileExpiredSoftClose);
    return () => document.removeEventListener('visibilitychange', reconcileExpiredSoftClose);
  }, [finishSoftCloseTimeout]);

  // Session-scoped "paused intent" — survives buffer recreation across turns.
  // When true, newly created discussion/QA buffers are immediately paused.
  const livePausedRef = useRef(false);

  const clearLiveSessionAfterError = useCallback(
    (sessionId: string, message: string) => {
      const now = Date.now();
      const errorMessageId = `error-${now}`;
      const session = sessionsRef.current.find((candidate) => candidate.id === sessionId);
      if (session && isLiveSessionType(session)) {
        previousLiveSessionRef.current = createPreviousLiveSessionContext(
          session,
          currentSceneIdRef.current,
          'error',
        );
      }

      if (streamingSessionIdRef.current === sessionId) {
        retireActiveLiveRequest(sessionId);
      } else {
        const retirement = retireLiveRequestResources(null, sessionId, buffersRef.current);
        pendingRetirementRef.current = Promise.all([pendingRetirementRef.current, retirement]).then(
          () => undefined,
        );
      }

      setSessions((prev) =>
        prev.map((s) =>
          s.id === sessionId
            ? {
                ...s,
                status: 'error' as SessionStatus,
                softCloseDeadline: undefined,
                updatedAt: nextChatUpdatedAt(s, now),
                messages: [
                  ...s.messages,
                  {
                    id: errorMessageId,
                    role: 'assistant' as const,
                    parts: [{ type: 'text', text: message }],
                    metadata: {
                      senderName: 'System',
                      originalRole: 'agent' as const,
                      createdAt: now,
                    },
                  },
                ],
              }
            : s,
        ),
      );

      onActiveBubbleRef.current?.(null);
      if (onLiveSessionErrorRef.current) {
        onLiveSessionErrorRef.current();
      } else {
        onSpeechProgressRef.current?.(null);
        onThinkingRef.current?.(null);
        onLiveSpeechRef.current?.(null, null);
      }
    },
    [retireActiveLiveRequest],
  );

  // Tracks the single message ID per lecture session
  const lectureMessageIds = useRef<Map<string, string>>(new Map());

  // Tracks last action index per lecture session (avoids stale closure reads)
  const lectureLastActionIndexRef = useRef<Map<string, number>>(new Map());

  // Tracks the narrator (the classroom's teacher) per lecture session
  const lectureAgentIdsRef = useRef<Map<string, string>>(new Map());

  /**
   * Create a StreamBuffer for a session and wire its callbacks to React state.
   * Returns the buffer instance (also stored in buffersRef).
   *
   * The aside channel (the assistant answering while the lecture plays) only
   * reveals text: no classroom actions, no TTS segments or holds, no paused
   * intent inherited from the lecture-facing Q&A, and its live text, thinking
   * and done data go to its own callbacks and ref.
   */
  const createBufferForSession = useCallback(
    (sessionId: string, type?: SessionType, channel: 'main' | 'aside' = 'main'): StreamBuffer => {
      const aside = channel === 'aside';
      const doneDataRef = aside ? asideLoopDoneDataRef : loopDoneDataRef;
      // Dispose previous buffer if any
      // Shutdown (not dispose) — avoids stale onLiveSpeech(null,null) callback
      const prev = buffersRef.current.get(sessionId);
      if (prev) prev.shutdown();

      // For discussion/QA sessions, add pacing delays so fast models don't
      // rush through text and actions. Lecture pacing is handled by PlaybackEngine.
      const pacingOptions = type === 'lecture' ? {} : { postTextDelayMs: 1200, actionDelayMs: 800 };

      const buffer = new StreamBuffer(
        {
          onAgentStart(data: AgentStartItem) {
            const now = Date.now();
            const agentConfig = useAgentRegistry.getState().getAgent(data.agentId);
            const castReason = castReasonsRef.current.get(data.messageId);
            castReasonsRef.current.delete(data.messageId);
            const newMsg = agentStartMessage(data, agentConfig, now, castReason);
            setSessions((prev) =>
              prev.map((s) =>
                s.id === sessionId
                  ? {
                      ...s,
                      messages: [...s.messages, newMsg],
                      updatedAt: nextChatUpdatedAt(s, now),
                    }
                  : s,
              ),
            );
            // The active bubble is the lecture-facing highlight
            if (!aside) onActiveBubbleRef.current?.(data.messageId);
          },

          onAgentEnd() {
            // Remove empty assistant messages (agent started but produced no content)
            setSessions((prev) =>
              prev.map((s) => {
                if (s.id !== sessionId) return s;
                const msgs = s.messages.filter(
                  (m) => !(m.role === 'assistant' && m.parts.length === 0),
                );
                return msgs.length !== s.messages.length
                  ? { ...s, messages: msgs, updatedAt: nextChatUpdatedAt(s) }
                  : s;
              }),
            );
          },

          onTextReveal(
            messageId: string,
            partId: string,
            revealedText: string,
            isComplete: boolean,
          ) {
            setSessions((prev) =>
              prev.map((s) => {
                if (s.id !== sessionId) return s;
                const revealed = {
                  ...s,
                  messages: s.messages.map((m) => {
                    if (m.id !== messageId) return m;
                    const parts = [...m.parts];
                    // Match by _partId (supports multiple text parts per message, e.g. lecture)
                    const existingIdx = parts.findIndex(
                      (p) => (p as unknown as Record<string, unknown>)._partId === partId,
                    );
                    if (existingIdx >= 0) {
                      parts[existingIdx] = {
                        type: 'text',
                        text: revealedText,
                        _partId: partId,
                      } as UIMessage<ChatMessageMetadata>['parts'][number];
                    } else {
                      parts.push({
                        type: 'text',
                        text: revealedText,
                        _partId: partId,
                      } as UIMessage<ChatMessageMetadata>['parts'][number]);
                    }
                    return { ...m, parts };
                  }),
                  // Don't update updatedAt on every tick — avoids thrashing persistence sync
                };
                return withChatSegmentReveal(revealed, isComplete);
              }),
            );
          },

          async onActionReady(messageId: string, data: ActionItem, signal: AbortSignal) {
            // An aside never touches the stage the lecture is using
            if (aside) return;
            const actionPart = {
              type: `action-${data.actionName}`,
              actionId: data.actionId,
              actionName: data.actionName,
              input: data.params,
              state: 'result',
              output: { success: true },
            } as unknown as UIMessage<ChatMessageMetadata>['parts'][number];
            setSessions((prev) =>
              prev.map((s) => {
                if (s.id !== sessionId) return s;
                return {
                  ...s,
                  messages: s.messages.map((m) =>
                    m.id === messageId ? { ...m, parts: [...m.parts, actionPart] } : m,
                  ),
                  updatedAt: nextChatUpdatedAt(s),
                };
              }),
            );

            // Whiteboard effects mutate shared stage state after animation delays,
            // so keep them ordered. Long-running media playback stays interruptible.
            try {
              const actionEngine = new ActionEngine(useStageStore);
              const action = {
                id: data.actionId,
                type: data.actionName,
                ...data.params,
              } as Action;
              const execution = actionEngine.execute(action, { signal, agentId: data.agentId });
              if (shouldAwaitPresentationAction(data.actionName)) {
                await execution;
              } else {
                void execution.catch((err) => log.warn('[Buffer] Action execution error:', err));
              }
            } catch (err) {
              log.warn('[Buffer] Action execution error:', err);
            }
          },

          onLiveSpeech(text: string | null, agentId: string | null) {
            // Lecture sessions: roundtable text is managed by PlaybackEngine → setLectureSpeech
            // in stage.tsx. Buffer only drives chat area pacing for lectures.
            if (type === 'lecture') return;
            if (aside) {
              onAsideLiveSpeechRef.current?.(text, agentId);
              return;
            }
            onLiveSpeechRef.current?.(text, agentId);
          },

          onSpeechProgress(ratio: number | null) {
            if (aside) return;
            onSpeechProgressRef.current?.(ratio);
          },

          onThinking(data: { stage: string; agentId?: string } | null) {
            if (aside) {
              onAsideThinkingRef.current?.(data);
              return;
            }
            onThinkingRef.current?.(data);
          },

          onCueUser(fromAgentId?: string, prompt?: string) {
            // Track cue_user for agent loop
            if (doneDataRef.current) {
              doneDataRef.current.cueUserReceived = true;
            } else {
              doneDataRef.current = {
                totalAgents: 0,
                cueUserReceived: true,
              };
            }
            // The learner's cue is lecture-facing (it reveals the composer as
            // the floor): the aside just waits for a follow-up
            if (aside) return;
            onCueUserRef.current?.(fromAgentId, prompt);
          },

          onDone(data: {
            totalActions: number;
            totalAgents: number;
            agentHadContent?: boolean;
            cueUserReceived?: boolean;
            sessionClosed?: boolean;
            endReason?: string;
            directorState?: DirectorState;
          }) {
            // Store done data for agent loop consumption
            doneDataRef.current = {
              directorState: data.directorState,
              totalAgents: data.totalAgents,
              agentHadContent: data.agentHadContent ?? true,
              cueUserReceived:
                data.cueUserReceived ?? doneDataRef.current?.cueUserReceived ?? false,
              sessionClosed: data.sessionClosed,
              endReason: data.endReason,
            };
            // Session completion is handled by runAgentLoopFn, not here
            // (Lectures don't use the agent loop and complete via endSession)
          },

          onError(message: string) {
            log.error('[Buffer] Stream error:', message);
          },

          onSegmentSealed(
            messageId: string,
            partId: string,
            fullText: string,
            agentId: string | null,
          ) {
            // Text only: an aside's answer is never spoken over the lecture
            if (aside) return;
            onSegmentSealedRef.current?.(messageId, partId, fullText, agentId);
          },

          shouldHoldAfterReveal() {
            if (aside) return false as const;
            return shouldHoldAfterRevealRef.current?.() ?? (false as const);
          },
        },
        pacingOptions,
      );

      buffersRef.current.set(sessionId, buffer);
      buffer.start();

      // Inherit paused intent for discussion/QA sessions so new-turn buffers
      // don't start revealing text while the user has paused reading.
      if (type !== 'lecture' && !aside && livePausedRef.current) {
        buffer.pause();
      }

      return buffer;
    },
    [],
  );

  const createStatelessStreamConsumer = useCallback(
    (
      sessionId: string,
      controller: AbortController,
      sessionType: SessionType,
      channel: 'main' | 'aside' = 'main',
    ) => {
      const aside = channel === 'aside';
      const doneDataRef = aside ? asideLoopDoneDataRef : loopDoneDataRef;
      let currentBuffer: StreamBuffer | null = null;
      let currentMessageId: string | null = null;

      const onEvent = (event: StatelessEvent) => {
        if (event.type === 'whiteboard') {
          // An aside leaves the board (and its visibility) to the lecture
          if (!aside) consumePiWhiteboardEvent(event.data, controller.signal);
          return;
        }
        // Text only: a stray classroom action is dropped, never shown or run
        if (aside && event.type === 'action') return;
        if (!currentBuffer) {
          currentBuffer = createBufferForSession(sessionId, sessionType, channel);
        }

        switch (event.type) {
          case 'agent_start': {
            const { messageId, agentId, agentName, agentAvatar, agentColor, castReason } =
              event.data;
            currentMessageId = messageId;
            // Kept until the buffer opens the message (stats only; I20)
            if (isCastReason(castReason)) castReasonsRef.current.set(messageId, castReason);
            currentBuffer.pushAgentStart({
              messageId,
              agentId,
              agentName,
              avatar: agentAvatar,
              color: agentColor,
            });
            break;
          }
          case 'agent_end': {
            currentBuffer.pushAgentEnd({
              messageId: event.data.messageId,
              agentId: event.data.agentId,
            });
            break;
          }
          case 'text_delta': {
            const targetId = event.data.messageId ?? currentMessageId;
            if (!targetId) break;
            currentBuffer.pushText(targetId, event.data.content);
            break;
          }
          case 'action': {
            const targetId = event.data.messageId ?? currentMessageId;
            if (!targetId) break;
            if (controller.signal.aborted) break;
            currentBuffer.pushAction({
              actionId: event.data.actionId,
              actionName: event.data.actionName,
              params: event.data.params,
              messageId: targetId,
              agentId: event.data.agentId,
            });
            break;
          }
          case 'thinking':
            currentBuffer.pushThinking(event.data);
            break;
          case 'cue_user':
            currentBuffer.pushCueUser(event.data);
            break;
          case 'done':
            currentBuffer.pushDone(event.data);
            break;
          case 'error':
            currentBuffer.pushError(event.data.message);
            throw new Error(event.data.message);
        }
      };

      const onIterationEnd = async () => {
        if (!currentBuffer) return null;

        try {
          await currentBuffer.waitUntilDrained();
        } catch {
          currentBuffer = null;
          return null;
        }

        currentBuffer = null;

        const doneData = doneDataRef.current;
        doneDataRef.current = null;

        if (!doneData) return null;
        return {
          directorState: doneData.directorState,
          totalAgents: doneData.totalAgents,
          agentHadContent: doneData.agentHadContent ?? true,
          cueUserReceived: doneData.cueUserReceived,
          sessionClosed: doneData.sessionClosed,
          endReason: doneData.endReason,
        };
      };

      return { onEvent, onIterationEnd };
    },
    [createBufferForSession],
  );

  /**
   * Frontend-driven agent loop. Delegates to the shared runAgentLoop
   * from lib/chat/agent-loop.ts, wiring StreamBuffer for UI pacing.
   *
   * Each iteration: POST /api/chat → process SSE → wait for buffer drain → check outcome.
   */
  const runAgentLoopFn = useCallback(
    async (
      sessionId: string,
      requestTemplate: ChatRequestTemplate,
      controller: AbortController,
      sessionType: SessionType,
      onElementReferenceResponseAccepted?: (response: Response) => void,
    ): Promise<void> => {
      // Attach full configs for generated (non-default) agents so the server can use them.
      // The server-side registry only has default agents; generated agents exist only client-side.
      const generatedConfigs = requestTemplate.config.agentIds
        .filter((id: string) => !id.startsWith('default-'))
        .map((id: string) => useAgentRegistry.getState().getAgent(id))
        .filter((agent): agent is NonNullable<typeof agent> => Boolean(agent))
        .map(({ createdAt: _c, updatedAt: _u, isDefault: _d, ...rest }) => rest);
      if (generatedConfigs.length > 0) {
        requestTemplate.config.agentConfigs = generatedConfigs;
      }

      if (isPiChatEnabled()) {
        // Pi bypasses runAgentLoop's per-iteration getStoreState, so its single
        // request needs the snapshot built here — /api/chat/pi rejects bodies
        // without storeState.
        const [freshState, quizMisses] = await Promise.all([
          buildFreshAgentLoopStoreState(),
          loadQuizMisses(useStageStore.getState().scenes),
        ]);
        // What was just said on this page, read as the request leaves (I14)
        const storeState = withLectureProgress(freshState, getLectureProgressRef.current?.());
        const firstRequestContext = getFirstPiRequestContext(sessionId);
        // Who has been present in this course so far, and what was said
        // earlier (I06, I13), read as the request leaves
        const classRequest = {
          sessionId,
          type: sessionType,
          sceneId: currentSceneIdRef.current ?? undefined,
        };
        const classTemplate = withClassMemory(
          withClassPresence(requestTemplate, sessionsRef.current, classRequest),
          sessionsRef.current,
          classRequest,
          { quizMisses, scenes: freshState.scenes as { id: string }[] },
        );
        // Off by default: nobody singles the learner out by name (I10.5)
        const presentTemplate = useSettingsStore.getState().teacherMayCallOnLearner
          ? {
              ...classTemplate,
              config: { ...classTemplate.config, teacherMayCallOnLearner: true },
            }
          : classTemplate;
        // Built-in agents are named in the learner's interface language (I22)
        const piRequestTemplate = withUiLocale(
          firstRequestContext
            ? { ...presentTemplate, storeState, piSessionBoundary: firstRequestContext }
            : { ...presentTemplate, storeState },
          localeRef.current,
        );
        // Web search is the workspace's webSearch slot, resolved on the server.
        await runPiSingleRequest(
          sessionId,
          withPiInclassWhiteboardTools(piRequestTemplate),
          controller,
          sessionType,
          createStatelessStreamConsumer,
          clearLiveSessionAfterError,
          enterSoftClosing,
          markSessionCompleted,
          storeDirectorState,
          onStopSessionRef,
          t,
          firstRequestContext || onElementReferenceResponseAccepted
            ? (response) => {
                if (firstRequestContext) {
                  consumePiSessionBoundaryContext(
                    piSessionBoundariesRef.current,
                    sessionId,
                    firstRequestContext,
                  );
                }
                onElementReferenceResponseAccepted?.(response);
              }
            : undefined,
        );
        return;
      }

      const streamConsumer = createStatelessStreamConsumer(sessionId, controller, sessionType);

      const outcome = await runAgentLoop(
        {
          config: classicLoopConfig(requestTemplate.config, requestTemplate.messages),
          userProfile: requestTemplate.userProfile,
        },
        {
          getStoreState: buildFreshAgentLoopStoreState,

          getMessages: () => {
            const currentSession = sessionsRef.current.find((s) => s.id === sessionId);
            return currentSession?.messages ?? requestTemplate.messages;
          },

          fetchChat: (body, signal) => fetchStatelessChat(body, signal),

          onEvent: streamConsumer.onEvent,
          onIterationEnd: streamConsumer.onIterationEnd,
        },
        controller.signal,
      );

      // Handle loop completion (UI-specific). Map each outcome.reason to a
      // distinct session state — don't conflate error paths with completion.
      if (!controller.signal.aborted) {
        switch (outcome.reason) {
          case 'cue_user':
            // Session stays active; UI waits for the next user message.
            break;
          case 'end':
            setSessions((prev) =>
              prev.map((s) =>
                s.id === sessionId
                  ? {
                      ...s,
                      status: 'completed' as SessionStatus,
                      updatedAt: nextChatUpdatedAt(s),
                    }
                  : s,
              ),
            );
            onStopSessionRef.current?.({ sessionId, source: 'turn_complete' });
            break;
          case 'empty_turns':
            clearLiveSessionAfterError(sessionId, t('chat.error.emptyAgentResponses'));
            onStopSessionRef.current?.({ sessionId, source: 'error' });
            break;
          case 'no_done':
            clearLiveSessionAfterError(sessionId, t('chat.error.streamInterrupted'));
            onStopSessionRef.current?.({ sessionId, source: 'error' });
            break;
          case 'aborted':
            // Already handled elsewhere via abort signal.
            break;
        }
      }
    },
    [
      clearLiveSessionAfterError,
      createStatelessStreamConsumer,
      enterSoftClosing,
      markSessionCompleted,
      storeDirectorState,
      t,
      getFirstPiRequestContext,
    ],
  );

  /**
   * Create a new chat session
   */
  const createSession = useCallback(
    async (type: SessionType, title: string): Promise<string> => {
      const sessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const now = Date.now();

      if (type === 'qa' || type === 'discussion') registerFirstPiRequest(sessionId);
      const newSession: ChatSession = {
        id: sessionId,
        type,
        title,
        status: 'active',
        messages: [],
        config: {
          agentIds: ['default-1'],
          defaultAgentId: 'default-1',
        },
        toolCalls: [],
        pendingToolCalls: [],
        sceneId: currentSceneIdRef.current ?? undefined,
        createdAt: now,
        updatedAt: now,
      };

      setSessions((prev) => [...prev, newSession]);
      setActiveSessionId(sessionId);

      log.info(`[ChatArea] Created session: ${sessionId} (${type})`);
      return sessionId;
    },
    [registerFirstPiRequest],
  );

  /**
   * End a chat session.
   * For QA/Discussion sessions with active streaming, appends "..." + interrupted marker.
   */
  const endSession = useCallback(
    async (sessionId: string, options: EndSessionOptions = {}): Promise<void> => {
      log.info(`[ChatArea] Ending session: ${sessionId}`);
      clearSoftCloseRegistration(sessionId);
      softCloseLifecycleRef.current.set(sessionId, 'completed');
      livePausedRef.current = false;

      const session = sessionsRef.current.find((s) => s.id === sessionId);
      const isLiveSession = session && (session.type === 'qa' || session.type === 'discussion');
      const wasStreaming = !!(
        abortControllerRef.current && streamingSessionIdRef.current === sessionId
      );

      // Retire presentation work before callers start another session. An action
      // already inside ActionEngine cannot be cancelled, so wait for it to settle.
      if (wasStreaming) {
        retireActiveLiveRequest(sessionId);
      } else {
        const retirement = retireLiveRequestResources(null, sessionId, buffersRef.current);
        pendingRetirementRef.current = Promise.all([pendingRetirementRef.current, retirement]).then(
          () => undefined,
        );
      }
      await pendingRetirementRef.current;
      piSessionBoundariesRef.current.delete(sessionId);
      if (isLiveSession && session) {
        previousLiveSessionRef.current = createPreviousLiveSessionContext(
          session,
          currentSceneIdRef.current,
          options.source,
        );
      }
      lectureMessageIds.current.delete(sessionId);
      lectureLastActionIndexRef.current.delete(sessionId);
      lectureAgentIdsRef.current.delete(sessionId);

      if (isLiveSession && wasStreaming) {
        // Append "..." + interrupted marker to last assistant message
        setSessions((prev) =>
          prev.map((s) => {
            if (s.id !== sessionId) return s;
            const messages = [...s.messages];
            for (let i = messages.length - 1; i >= 0; i--) {
              if (messages[i].role === 'assistant') {
                const parts = [...messages[i].parts];
                let appended = false;
                for (let j = parts.length - 1; j >= 0; j--) {
                  if (parts[j].type === 'text') {
                    const textPart = parts[j] as { type: 'text'; text: string };
                    parts[j] = {
                      type: 'text',
                      text: (textPart.text || '') + '...',
                    } as UIMessage<ChatMessageMetadata>['parts'][number];
                    appended = true;
                    break;
                  }
                }
                if (!appended) {
                  parts.push({
                    type: 'text',
                    text: '...',
                  } as UIMessage<ChatMessageMetadata>['parts'][number]);
                }
                messages[i] = {
                  ...messages[i],
                  parts,
                  metadata: { ...messages[i].metadata, interrupted: true },
                };
                break;
              }
            }
            return {
              ...withChatSessionStatus(s, 'completed'),
              messages,
              softCloseDeadline: undefined,
            };
          }),
        );
        // Clear roundtable state via callbacks
        onLiveSpeechRef.current?.(null, null);
        onThinkingRef.current?.(null);
      } else {
        setSessions((prev) =>
          prev.map((s) =>
            s.id === sessionId
              ? {
                  ...withChatSessionStatus(s, 'completed'),
                  softCloseDeadline: undefined,
                }
              : s,
          ),
        );
      }

      if (activeSessionId === sessionId) {
        setActiveSessionId(null);
      }
    },
    [activeSessionId, clearSoftCloseRegistration, retireActiveLiveRequest],
  );

  /**
   * The aside failed: its error shows in the session, which closes (status
   * 'error'), and only the aside's own state resets. Never the lecture-facing
   * error path (onLiveSessionError → the engine's discussion error handling).
   */
  const clearAsideAfterError = useCallback(
    (sessionId: string, message: string) => {
      const now = Date.now();
      if (asideSessionIdRef.current === sessionId) {
        const controller = asideAbortRef.current;
        asideAbortRef.current = null;
        void retireLiveRequestResources(controller, sessionId, buffersRef.current);
        setAsideSessionId(null);
        setIsAsideStreaming(false);
      } else {
        void retireLiveRequestResources(null, sessionId, buffersRef.current);
      }
      setSessions((prev) =>
        prev.map((s) =>
          s.id === sessionId
            ? {
                ...s,
                status: 'error' as SessionStatus,
                softCloseDeadline: undefined,
                updatedAt: nextChatUpdatedAt(s, now),
                messages: [
                  ...s.messages,
                  {
                    id: `error-${now}`,
                    role: 'assistant' as const,
                    parts: [{ type: 'text', text: message }],
                    metadata: {
                      senderName: 'System',
                      originalRole: 'agent' as const,
                      createdAt: now,
                    },
                  },
                ],
              }
            : s,
        ),
      );
      onAsideThinkingRef.current?.(null);
      onAsideLiveSpeechRef.current?.(null, null);
    },
    [setAsideSessionId],
  );

  /**
   * End the aside (scene switch, leaving playback, a discussion or a Q&A with
   * the teacher taking over): it is marked completed and keeps its messages;
   * an answer still streaming keeps its text with "...". Only the aside's own
   * request and buffer are retired — the lecture and any other session are
   * left alone, and no stop / cleanup callback runs.
   */
  const endAsideSession = useCallback(async (): Promise<void> => {
    const sessionId = asideSessionIdRef.current;
    const controller = asideAbortRef.current;
    asideAbortRef.current = null;
    setAsideSessionId(null);
    setIsAsideStreaming(false);
    if (!sessionId) {
      controller?.abort();
      return;
    }
    log.info(`[ChatArea] Ending aside session: ${sessionId}`);
    const wasStreaming = !!controller;
    await retireLiveRequestResources(controller, sessionId, buffersRef.current);
    setSessions((prev) =>
      prev.map((s) => {
        if (s.id !== sessionId || !isOpenLiveSession(s)) return s;
        return {
          ...withChatSessionStatus(s, 'completed'),
          messages: wasStreaming ? markLastAssistantInterrupted(s.messages) : s.messages,
          softCloseDeadline: undefined,
        };
      }),
    );
    onAsideThinkingRef.current?.(null);
    onAsideLiveSpeechRef.current?.(null, null);
  }, [setAsideSessionId]);

  /**
   * One aside turn: Pi's single request, or the classic agent loop. Its
   * outcome only settles the aside — a cue, a completion or even a close
   * keeps the session open for follow-ups; an error closes it — and never
   * reaches the lecture-facing stop / cleanup callbacks.
   */
  const runAsideRequest = useCallback(
    async (
      sessionId: string,
      requestTemplate: ChatRequestTemplate,
      controller: AbortController,
      onResponseAccepted?: (response: Response) => void,
    ): Promise<void> => {
      const createAsideConsumer: StatelessStreamConsumerFactory = (id, abort, type) =>
        createStatelessStreamConsumer(id, abort, type, 'aside');
      const keepOpen = (id: string, data?: { directorState?: DirectorState }) =>
        storeDirectorState(id, data?.directorState);

      if (isPiChatEnabled()) {
        const [freshState, quizMisses] = await Promise.all([
          buildFreshAgentLoopStoreState(),
          loadQuizMisses(useStageStore.getState().scenes),
        ]);
        // The assistant explains along the teacher's line of the moment (I14)
        const storeState = withLectureProgress(freshState, getLectureProgressRef.current?.());
        const classRequest = {
          sessionId,
          type: 'qa' as const,
          sceneId: currentSceneIdRef.current ?? undefined,
        };
        const presentTemplate = withClassMemory(
          withClassPresence(requestTemplate, sessionsRef.current, classRequest),
          sessionsRef.current,
          classRequest,
          {
            quizMisses,
            scenes: freshState.scenes as { id: string }[],
            classAgentIds: useSettingsStore.getState().selectedAgentIds ?? [],
          },
        );
        await runPiSingleRequest(
          sessionId,
          withUiLocale({ ...presentTemplate, storeState }, localeRef.current),
          controller,
          'qa',
          createAsideConsumer,
          clearAsideAfterError,
          keepOpen,
          keepOpen,
          storeDirectorState,
          // The aside settles on its own: nothing lecture-facing is told it stopped
          { current: undefined },
          t,
          onResponseAccepted,
        );
        return;
      }

      const streamConsumer = createStatelessStreamConsumer(sessionId, controller, 'qa', 'aside');
      const outcome = await runAgentLoop(
        { config: requestTemplate.config, userProfile: requestTemplate.userProfile },
        {
          getStoreState: buildFreshAgentLoopStoreState,
          getMessages: () =>
            sessionsRef.current.find((s) => s.id === sessionId)?.messages ??
            requestTemplate.messages,
          fetchChat: (body, signal) => fetchStatelessChat(body, signal),
          onEvent: streamConsumer.onEvent,
          onIterationEnd: streamConsumer.onIterationEnd,
        },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      if (outcome.reason === 'empty_turns') {
        clearAsideAfterError(sessionId, t('chat.error.emptyAgentResponses'));
      } else if (outcome.reason === 'no_done') {
        clearAsideAfterError(sessionId, t('chat.error.streamInterrupted'));
      } else {
        keepOpen(sessionId, { directorState: outcome.directorState });
      }
    },
    [clearAsideAfterError, createStatelessStreamConsumer, storeDirectorState, t],
  );

  /**
   * Ask the teaching assistant on the side while the lecture keeps playing.
   * The first question opens an aside session (a 'qa' session marked
   * `config.aside`); follow-ups append to it until it ends. It has its own
   * request controller and streaming flag: the lecture's session, the shared
   * abort controller and any Q&A / discussion are never touched, and the
   * answer is text only (no actions, no TTS).
   */
  const sendAsideMessage = useCallback(
    async (content: string, options: AsideMessageSendOptions): Promise<void> => {
      const { agentId } = options;
      // A follow-up while the previous answer still streams interrupts it
      const previous = asideAbortRef.current;
      if (previous) {
        asideAbortRef.current = null;
        const interruptedId = asideSessionIdRef.current;
        await retireLiveRequestResources(previous, interruptedId, buffersRef.current);
        if (interruptedId) {
          setSessions((prev) =>
            prev.map((s) =>
              s.id === interruptedId
                ? {
                    ...s,
                    messages: markLastAssistantInterrupted(s.messages),
                    updatedAt: nextChatUpdatedAt(s),
                  }
                : s,
            ),
          );
        }
      }

      const controller = new AbortController();
      asideAbortRef.current = controller;
      setIsAsideStreaming(true);

      let sessionId: string | null = null;
      try {
        if (!classroomChatUsable(await loadModelCapabilities())) {
          toast.error(t('settings.modelNotConfigured'));
          return;
        }
        // Ended meanwhile (a scene switch, leaving playback)
        if (controller.signal.aborted) return;

        const now = Date.now();
        const userMessage: UIMessage<ChatMessageMetadata> = {
          id: `user-${now}`,
          role: 'user',
          parts: [{ type: 'text', text: content }],
          metadata: {
            senderName: t('common.you'),
            senderAvatar: USER_AVATAR,
            originalRole: 'user',
            createdAt: now,
          },
        };

        const existing = asideSessionIdRef.current
          ? sessionsRef.current.find((s) => s.id === asideSessionIdRef.current)
          : undefined;
        let messages: UIMessage<ChatMessageMetadata>[];
        let directorState: DirectorState | undefined;
        if (existing && isOpenLiveSession(existing)) {
          sessionId = existing.id;
          messages = [...existing.messages, userMessage];
          directorState = existing.directorState;
          const followUpId = existing.id;
          setSessions((prev) =>
            prev.map((s) =>
              s.id === followUpId
                ? {
                    ...s,
                    messages: [...s.messages, userMessage],
                    updatedAt: nextChatUpdatedAt(s, now),
                  }
                : s,
            ),
          );
        } else {
          sessionId = `session-${now}-${Math.random().toString(36).slice(2)}`;
          messages = [userMessage];
          const newSession: ChatSession = {
            id: sessionId,
            type: 'qa',
            title: 'Q&A',
            status: 'active',
            messages,
            config: { agentIds: [agentId], defaultAgentId: agentId, aside: true },
            toolCalls: [],
            pendingToolCalls: [],
            sceneId: currentSceneIdRef.current ?? undefined,
            createdAt: now,
            updatedAt: now,
          };
          setSessions((prev) => [...prev, newSession]);
          setAsideSessionId(sessionId);
          log.info(`[ChatArea] Created aside session: ${sessionId}`);
        }

        const userProfileState = useUserProfileStore.getState();
        const requestTemplate = buildAsideRequestTemplate({
          messages,
          agentId,
          agent: useAgentRegistry.getState().getAgent(agentId),
          userProfile: {
            nickname: userProfileState.nickname || undefined,
            bio: userProfileState.bio || undefined,
          },
          directorState,
          elementReference: options.elementReference,
          addressedAgentIds: addressedAgentIdsOf(content, [agentId], t),
        });
        await runAsideRequest(sessionId, requestTemplate, controller, options.onResponseAccepted);
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          log.info('[ChatArea] Aside request aborted');
          return;
        }
        if (controller.signal.aborted) return;
        log.error('[ChatArea] Aside error:', error);
        if (sessionId) {
          clearAsideAfterError(
            sessionId,
            `Error: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      } finally {
        if (asideAbortRef.current === controller) {
          asideAbortRef.current = null;
          setIsAsideStreaming(false);
        }
      }
    },
    [clearAsideAfterError, runAsideRequest, setAsideSessionId, t],
  );

  const continueSoftClosingSession = useCallback(
    (sessionId: string): boolean => {
      if (
        softCloseLifecycleRef.current.get(sessionId) !== 'soft-closing' ||
        !claimSoftCloseRegistration(sessionId)
      ) {
        return false;
      }
      softCloseLifecycleRef.current.set(sessionId, 'active');
      const now = Date.now();
      setSessions((prev) =>
        prev.map((session) =>
          session.id === sessionId
            ? (resumeSoftClosingSessionWithoutMessage(session, now) ?? session)
            : session,
        ),
      );
      return true;
    },
    [claimSoftCloseRegistration],
  );

  const confirmSoftClosingSession = useCallback(
    async (sessionId: string): Promise<SessionCleanupPayload | undefined> => {
      const registration = claimSoftCloseRegistration(sessionId);
      if (!registration || softCloseLifecycleRef.current.get(sessionId) !== 'soft-closing') {
        return undefined;
      }
      softCloseLifecycleRef.current.set(sessionId, 'completed');
      const payload: SessionCleanupPayload = {
        sessionId,
        endReason: registration.endReason,
        source: 'soft_close_confirmed',
      };
      await endSession(sessionId, { source: 'soft_close_confirmed' });
      return payload;
    },
    [claimSoftCloseRegistration, endSession],
  );

  /**
   * End the currently active QA/Discussion session (if any), and the
   * assistant's aside (a scene switch or leaving playback ends both).
   */
  const endActiveSession = useCallback(
    async (options: EndSessionOptions = {}): Promise<void> => {
      const active = sessionsRef.current.find(isOpenMainLiveSession);
      await Promise.all([
        active ? endSession(active.id, options) : undefined,
        asideSessionIdRef.current || asideAbortRef.current ? endAsideSession() : undefined,
      ]);
    },
    [endAsideSession, endSession],
  );

  /**
   * Soft-pause the active QA/Discussion session.
   * Aborts SSE and appends "..." + interrupted marker, but keeps session 'active'
   * so the user can continue speaking in the same topic.
   */
  const softPauseSession = useCallback(
    async (sessionId: string): Promise<void> => {
      livePausedRef.current = false;
      const session = sessionsRef.current.find((s) => s.id === sessionId);
      if (!session) return;
      const isLiveSession = session.type === 'qa' || session.type === 'discussion';
      if (!isLiveSession || session.status !== 'active') return;

      const wasStreaming = !!(
        abortControllerRef.current && streamingSessionIdRef.current === sessionId
      );

      if (wasStreaming) {
        retireActiveLiveRequest(sessionId);
      } else {
        const retirement = retireLiveRequestResources(null, sessionId, buffersRef.current);
        pendingRetirementRef.current = Promise.all([pendingRetirementRef.current, retirement]).then(
          () => undefined,
        );
      }
      await pendingRetirementRef.current;

      if (wasStreaming) {
        // Append "..." + interrupted marker to last assistant message, keep status 'active'
        setSessions((prev) =>
          prev.map((s) => {
            if (s.id !== sessionId) return s;
            const messages = [...s.messages];
            for (let i = messages.length - 1; i >= 0; i--) {
              if (messages[i].role === 'assistant') {
                const parts = [...messages[i].parts];
                let appended = false;
                for (let j = parts.length - 1; j >= 0; j--) {
                  if (parts[j].type === 'text') {
                    const textPart = parts[j] as { type: 'text'; text: string };
                    parts[j] = {
                      type: 'text',
                      text: (textPart.text || '') + '...',
                    } as UIMessage<ChatMessageMetadata>['parts'][number];
                    appended = true;
                    break;
                  }
                }
                if (!appended) {
                  parts.push({
                    type: 'text',
                    text: '...',
                  } as UIMessage<ChatMessageMetadata>['parts'][number]);
                }
                messages[i] = {
                  ...messages[i],
                  parts,
                  metadata: { ...messages[i].metadata, interrupted: true },
                };
                break;
              }
            }
            // Keep status 'active' — session continues when user speaks
            return { ...s, messages, updatedAt: nextChatUpdatedAt(s) };
          }),
        );
        // Note: Do NOT call onLiveSpeech/onThinking here.
        // Caller (doSoftPause) manages roundtable state to keep the interrupted bubble visible.
      }

      log.info(`[ChatArea] Soft-paused session: ${sessionId}`);
    },
    [retireActiveLiveRequest],
  );

  /**
   * Soft-pause the currently active QA/Discussion session (if any).
   */
  const softPauseActiveSession = useCallback(async (): Promise<void> => {
    const active = sessionsRef.current.find(isOpenMainLiveSession);
    if (active) {
      await softPauseSession(active.id);
    }
  }, [softPauseSession]);

  /**
   * Resume a soft-paused session by re-calling /chat with existing messages.
   * The director will pick the next agent to continue the topic.
   */
  const resumeSession = useCallback(
    async (sessionId: string): Promise<void> => {
      const session = sessionsRef.current.find((s) => s.id === sessionId);
      if (!session || session.status !== 'active') return;

      await pendingRetirementRef.current;

      const controller = new AbortController();
      abortControllerRef.current = controller;
      streamingSessionIdRef.current = sessionId;
      setIsStreaming(true);

      try {
        log.info(`[ChatArea] Resuming session: ${sessionId}`);

        const userProfileState = useUserProfileStore.getState();

        const agentIds =
          useSettingsStore.getState().selectedAgentIds?.length > 0
            ? useSettingsStore.getState().selectedAgentIds
            : session.config.agentIds;

        await runAgentLoopFn(
          sessionId,
          {
            messages: session.messages,
            config: {
              agentIds,
              sessionType: session.type,
              ...discussionRequestFields(session),
            },
            userProfile: {
              nickname: userProfileState.nickname || undefined,
              bio: userProfileState.bio || undefined,
            },
            directorState: session.directorState,
          },
          controller,
          session.type,
        );
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          log.info('[ChatArea] Resume aborted');
          return;
        }
        log.error('[ChatArea] Resume error:', error);
        clearLiveSessionAfterError(
          sessionId,
          `Error: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        if (abortControllerRef.current === controller) {
          abortControllerRef.current = null;
          streamingSessionIdRef.current = null;
          setIsStreaming(false);
        }
      }
    },
    [clearLiveSessionAfterError, runAgentLoopFn],
  );

  /**
   * Resume the currently active soft-paused session (if any).
   */
  const resumeActiveSession = useCallback(async (): Promise<void> => {
    const active = sessionsRef.current.find(isOpenMainLiveSession);
    if (active) {
      await resumeSession(active.id);
    }
  }, [resumeSession]);

  /**
   * Send a message to the active session
   */
  const sendMessage = useCallback(
    async (content: string, options: ChatMessageSendOptions = {}): Promise<void> => {
      let sessionId = activeSessionId;

      // Interrupt active generation: abort stream and append "..." to the last agent message
      if (abortControllerRef.current) {
        const interruptedSessionId = retireActiveLiveRequest(sessionId);
        const interruptedMessageSessionId = interruptedSessionId ?? sessionId;

        if (interruptedMessageSessionId) {
          setSessions((prev) =>
            prev.map((s) => {
              if (s.id !== interruptedMessageSessionId) return s;
              const messages = [...s.messages];
              for (let i = messages.length - 1; i >= 0; i--) {
                if (messages[i].role === 'assistant') {
                  const parts = [...messages[i].parts];
                  for (let j = parts.length - 1; j >= 0; j--) {
                    if (parts[j].type === 'text') {
                      const textPart = parts[j] as {
                        type: 'text';
                        text: string;
                      };
                      parts[j] = {
                        type: 'text',
                        text: (textPart.text || '') + '...',
                      } as UIMessage<ChatMessageMetadata>['parts'][number];
                      messages[i] = { ...messages[i], parts };
                      return { ...s, messages, updatedAt: nextChatUpdatedAt(s) };
                    }
                  }
                  break;
                }
              }
              return s;
            }),
          );
        }
      }

      // An interrupted action may still be finishing a delayed state mutation.
      // Capture the next request only after that mutation has settled.
      await pendingRetirementRef.current;

      // The teacher takes over: an open aside ends first (its messages stay)
      if (asideSessionIdRef.current || asideAbortRef.current) await endAsideSession();

      // Validate model configuration before sending: chat resolves the
      // workspace's classroom slot (assigned there or inherited).
      if (!classroomChatUsable(await loadModelCapabilities())) {
        toast.error(t('settings.modelNotConfigured'));
        return;
      }

      // Create a new session when there's no active QA session to append to.
      // A completed session should NOT be reused — start a fresh one instead.
      const activeSession = sessionsRef.current.find((s) => s.id === sessionId);
      const needNewSession =
        !sessionId || activeSession?.type === 'lecture' || activeSession?.status === 'completed';

      if (needNewSession) {
        // End all active QA/Discussion sessions before creating new one
        const activeQAOrDiscussion = sessionsRef.current.filter(isOpenMainLiveSession);
        for (const session of activeQAOrDiscussion) {
          await endSession(session.id);
        }
        sessionId = await createSession('qa', 'Q&A');
      } else if (sessionId && activeSession?.status === 'soft-closing') {
        if (claimSoftCloseRegistration(sessionId)) {
          softCloseLifecycleRef.current.set(sessionId, 'active');
        } else {
          const lifecycle = softCloseLifecycleRef.current.get(sessionId);
          if (lifecycle === 'completed') {
            sessionId = await createSession('qa', 'Q&A');
          } else if (lifecycle !== 'active') {
            return;
          }
        }
      }

      const controller = new AbortController();
      abortControllerRef.current = controller;
      streamingSessionIdRef.current = sessionId;
      setIsStreaming(true);

      const now = Date.now();
      const userMessageId = `user-${now}`;

      // Read all selected agent IDs from settings store
      const settingsState = useSettingsStore.getState();
      const agentIds: string[] =
        settingsState.selectedAgentIds?.length > 0 ? settingsState.selectedAgentIds : ['default-1'];

      const userMessage: UIMessage<ChatMessageMetadata> = {
        id: userMessageId,
        role: 'user',
        parts: [{ type: 'text', text: content }],
        metadata: {
          senderName: t('common.you'),
          senderAvatar: USER_AVATAR,
          originalRole: 'user',
          createdAt: now,
        },
      };

      // Read current session data from ref (avoids stale closure AND keeps updater pure)
      const existingSession = sessionsRef.current.find((s) => s.id === sessionId);
      const sessionMessages: UIMessage<ChatMessageMetadata>[] = existingSession
        ? [...existingSession.messages, userMessage]
        : [userMessage];
      const sessionType: SessionType = existingSession?.type || 'qa';

      // Pure updater — no side effects
      setSessions((prev) => {
        const exists = prev.some((s) => s.id === sessionId);
        if (exists) {
          return prev.map((s) =>
            s.id === sessionId ? resumeSoftClosingSessionForFollowUp(s, userMessage, now) : s,
          );
        } else {
          const newSession: ChatSession = {
            id: sessionId!,
            type: 'qa',
            title: 'Q&A',
            status: 'active',
            messages: [userMessage],
            config: {
              agentIds,
              defaultAgentId: agentIds[0],
            },
            toolCalls: [],
            pendingToolCalls: [],
            sceneId: currentSceneIdRef.current ?? undefined,
            createdAt: now,
            updatedAt: now,
          };
          return [...prev, newSession];
        }
      });

      try {
        log.info(
          `[ChatArea] Sending message: "${content.slice(0, 50)}..." agents: ${agentIds.join(', ')}`,
        );

        const userProfileState = useUserProfileStore.getState();
        // Whom this message names (@): they answer first, in character (I23)
        const addressedAgentIds = addressedAgentIdsOf(content, agentIds, t);

        await runAgentLoopFn(
          sessionId!,
          {
            messages: sessionMessages,
            config: {
              agentIds,
              sessionType,
              ...discussionRequestFields(existingSession),
              ...(addressedAgentIds.length > 0 ? { addressedAgentIds } : {}),
            },
            userProfile: {
              nickname: userProfileState.nickname || undefined,
              bio: userProfileState.bio || undefined,
            },
            directorState: existingSession?.directorState,
            ...(options.elementReference ? { elementReference: options.elementReference } : {}),
          },
          controller,
          sessionType,
          options.onResponseAccepted,
        );
      } catch (error) {
        // Ignore AbortError — it's intentional (user interrupted)
        if (error instanceof DOMException && error.name === 'AbortError') {
          log.info('[ChatArea] Request aborted by user');
          return;
        }

        log.error('[ChatArea] Error:', error);
        clearLiveSessionAfterError(
          sessionId!,
          `Error: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        // Only clean up if this is still the active controller (avoid race with interrupt)
        if (abortControllerRef.current === controller) {
          abortControllerRef.current = null;
          streamingSessionIdRef.current = null;
          setIsStreaming(false);
        }
      }
    },
    [
      activeSessionId,
      clearLiveSessionAfterError,
      createSession,
      endAsideSession,
      endSession,
      claimSoftCloseRegistration,
      retireActiveLiveRequest,
      runAgentLoopFn,
      t,
    ],
  );

  /**
   * Start a discussion with agent speaking first
   */
  const startDiscussion = useCallback(
    async (request: ClassMomentRequest): Promise<void> => {
      log.info(`[ChatArea] Starting discussion: "${request.topic}"`);
      // Explicitly clear buffer-pause intent (also cleared transitively via endSession,
      // but being explicit guards against future refactors)
      livePausedRef.current = false;

      // Validate model configuration before starting discussion: it resolves
      // the workspace's classroom slot (assigned there or inherited).
      if (!classroomChatUsable(await loadModelCapabilities())) {
        toast.error(t('settings.modelNotConfigured'));
        // The card already handed the engine over to the moment: undo that, so
        // the lecture is back where it was rather than stuck in a discussion
        // that never starts
        if (onLiveSessionErrorRef.current) {
          onLiveSessionErrorRef.current();
        } else {
          onThinkingRef.current?.(null);
        }
        return;
      }

      // A teacher discussion takes over: an open aside ends first
      if (asideSessionIdRef.current || asideAbortRef.current) await endAsideSession();

      // Auto-end previous active QA/Discussion sessions to ensure only one is active
      const activeQAOrDiscussion = sessionsRef.current.filter(isOpenMainLiveSession);
      for (const session of activeQAOrDiscussion) {
        await endSession(session.id);
      }

      const sessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const now = Date.now();
      registerFirstPiRequest(sessionId);

      // Read all selected agent IDs from settings store
      const settingsState = useSettingsStore.getState();
      const selectedAgentIds: string[] =
        settingsState.selectedAgentIds?.length > 0 ? [...settingsState.selectedAgentIds] : [];
      // The moment's opener: its own agent; a legacy moment without one is
      // opened by the classroom's teacher, never a student picked at random.
      // A quiz review names none: the director picks who opens it.
      const registry = useAgentRegistry.getState();
      const isQuizReview = request.momentKind === 'quiz-review';
      const agentId =
        request.agentId ||
        (isQuizReview
          ? undefined
          : pickClassroomTeacher(selectedAgentIds, (id) => registry.getAgent(id))?.id ||
            (selectedAgentIds.length === 0 ? 'default-1' : undefined));
      const agentIds = selectedAgentIds.length > 0 ? selectedAgentIds : [agentId ?? 'default-1'];
      // Ensure the trigger agent is included
      if (agentId && !agentIds.includes(agentId)) {
        agentIds.unshift(agentId);
      }
      const moment = buildDiscussionMomentFields({
        topic: request.topic,
        prompt: request.prompt,
        triggerAgentId: agentId,
        momentKind: request.momentKind,
        // The learner's choice belongs to a teacher's whole-class question only
        learnerStance: request.momentKind === 'ask-learner' ? request.learnerStance : undefined,
      });

      // No pre-created assistant message — agent_start events create them dynamically
      const newSession: ChatSession = {
        id: sessionId,
        type: 'discussion',
        title: request.topic,
        status: 'active',
        messages: [],
        config: {
          agentIds,
          ...moment,
        },
        toolCalls: [],
        pendingToolCalls: [],
        sceneId: currentSceneIdRef.current ?? undefined,
        createdAt: now,
        updatedAt: now,
      };

      setSessions((prev) => [...prev, newSession]);
      setActiveSessionId(sessionId);

      const controller = new AbortController();
      abortControllerRef.current = controller;
      streamingSessionIdRef.current = sessionId;
      setIsStreaming(true);

      try {
        const userProfileState = useUserProfileStore.getState();

        await runAgentLoopFn(
          sessionId,
          {
            messages: [],
            config: {
              agentIds,
              sessionType: 'discussion',
              ...moment,
            },
            userProfile: {
              nickname: userProfileState.nickname || undefined,
              bio: userProfileState.bio || undefined,
            },
          },
          controller,
          'discussion',
        );
      } catch (error) {
        // Ignore AbortError — it's intentional (user interrupted)
        if (error instanceof DOMException && error.name === 'AbortError') {
          log.info('[ChatArea] Discussion aborted by user');
          return;
        }

        log.error('[ChatArea] Discussion error:', error);
        clearLiveSessionAfterError(
          sessionId,
          `Error starting discussion: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        // Only clean up if this is still the active controller (avoid race with interrupt)
        if (abortControllerRef.current === controller) {
          abortControllerRef.current = null;
          streamingSessionIdRef.current = null;
          setIsStreaming(false);
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- t is stable from i18n context
    [
      clearLiveSessionAfterError,
      endAsideSession,
      endSession,
      registerFirstPiRequest,
      runAgentLoopFn,
    ],
  );

  /**
   * Handle interruption
   */
  const handleInterrupt = useCallback(() => {
    if (!abortControllerRef.current) return;

    log.info('[ChatArea] Interrupting active request');
    retireActiveLiveRequest(activeSessionId);
  }, [activeSessionId, retireActiveLiveRequest]);

  /**
   * Start a lecture session for a scene.
   * Creates a single assistant message that all actions will be appended to.
   * Deduplicates: returns existing active lecture session for the same sceneId if found.
   */
  const startLecture = useCallback(
    async (sceneId: string): Promise<string> => {
      // Check for existing lecture session with same sceneId (active or completed)
      const existing = sessions.find(
        (s) =>
          s.type === 'lecture' &&
          s.sceneId === sceneId &&
          (s.status === 'active' || s.status === 'completed'),
      );
      if (existing) {
        // Its narrator stays whoever it was created with (a lecture persisted
        // before lectures named the classroom's teacher keeps default-1)
        lectureAgentIdsRef.current.set(
          existing.id,
          existing.config.agentIds[0] ?? existing.messages[0]?.metadata?.agentId ?? 'default-1',
        );
        // Reactivate a completed session so the chat panel shows it as active again.
        // Actions won't be re-appended because lastActionIndex already covers them.
        if (existing.status === 'completed') {
          setSessions((prev) =>
            prev.map((s) => (s.id === existing.id ? withChatSessionStatus(s, 'active') : s)),
          );
          // Restore lecture tracking refs (cleared by endSession)
          const messageId = existing.messages[0]?.id;
          if (messageId) {
            lectureMessageIds.current.set(existing.id, messageId);
          }
          if (existing.lastActionIndex !== undefined) {
            lectureLastActionIndexRef.current.set(existing.id, existing.lastActionIndex);
          }
        }
        setActiveSessionId(existing.id);
        return existing.id;
      }

      const sessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const now = Date.now();
      const messageId = `lecture-msg-${now}`;

      const scene = useStageStore.getState().scenes.find((s) => s.id === sceneId);
      const title = scene?.title || t('chat.lecture');

      // The lecture's narrator: the classroom's teacher, as the participants
      // block and the playback engine name them; the default teacher only
      // when no selected agent resolves
      const registry = useAgentRegistry.getState();
      const teacher = pickClassroomTeacher(
        useSettingsStore.getState().selectedAgentIds ?? [],
        (id) => registry.getAgent(id),
      );
      const lectureAgentId = teacher?.id ?? 'default-1';
      const agentConfig = teacher ?? registry.getAgent('default-1');
      const i18nNameKey = `settings.agentNames.${lectureAgentId}`;
      const i18nName = t(i18nNameKey);
      const senderName =
        (i18nName !== i18nNameKey ? i18nName : agentConfig?.name) ||
        t('settings.agentNames.default-1');

      // Create session with a single assistant message (all actions append parts here)
      const lectureMessage: UIMessage<ChatMessageMetadata> = {
        id: messageId,
        role: 'assistant',
        parts: [],
        metadata: {
          senderName,
          senderAvatar: agentConfig?.avatar,
          originalRole: 'teacher',
          agentId: lectureAgentId,
          createdAt: now,
        },
      };

      const newSession: ChatSession = {
        id: sessionId,
        type: 'lecture',
        title,
        status: 'active',
        messages: [lectureMessage],
        config: {
          agentIds: [lectureAgentId],
        },
        toolCalls: [],
        pendingToolCalls: [],
        sceneId,
        lastActionIndex: -1,
        createdAt: now,
        updatedAt: now,
      };

      lectureMessageIds.current.set(sessionId, messageId);
      lectureAgentIdsRef.current.set(sessionId, lectureAgentId);

      setSessions((prev) => [...prev, newSession]);
      setActiveSessionId(sessionId);

      log.info(`[ChatArea] Created lecture session: ${sessionId} for scene ${sceneId}`);
      return sessionId;
    },
    [sessions, t],
  );

  /**
   * Add a lecture action to the single message bubble via StreamBuffer.
   * Speech → pushText + sealText (buffer handles pacing).
   * Spotlight/laser/discussion → pushAction (badge appears after preceding text is revealed).
   */
  const addLectureMessage = useCallback(
    (sessionId: string, action: Action, actionIndex: number) => {
      const messageId = lectureMessageIds.current.get(sessionId);
      if (!messageId) return;

      // Skip if this action was already appended in a previous run
      const lastIndex = lectureLastActionIndexRef.current.get(sessionId) ?? -1;
      if (actionIndex <= lastIndex) return;
      lectureLastActionIndexRef.current.set(sessionId, actionIndex);

      // Update lastActionIndex in session
      setSessions((prev) =>
        prev.map((s) =>
          s.id === sessionId
            ? { ...s, lastActionIndex: actionIndex, updatedAt: nextChatUpdatedAt(s) }
            : s,
        ),
      );

      // Get or create buffer for this lecture session
      let buffer = buffersRef.current.get(sessionId);
      if (!buffer || buffer.disposed) {
        buffer = createBufferForSession(sessionId, 'lecture');
      }
      const lectureAgentId = lectureAgentIdsRef.current.get(sessionId) ?? 'default-1';

      if (action.type === 'speech') {
        buffer.pushText(messageId, action.text, lectureAgentId);
        buffer.sealText(messageId);
      } else if (
        action.type === 'spotlight' ||
        action.type === 'laser' ||
        action.type === 'discussion'
      ) {
        const now = Date.now();
        buffer.pushAction({
          messageId,
          actionId: `${action.type}-${now}`,
          actionName: action.type,
          params: lectureActionPersistParams(action),
          agentId: lectureAgentId,
        });
      }
    },
    [createBufferForSession],
  );

  /**
   * Record how a lecture moment ended (I06) as a discussion badge on its
   * page's lecture bubble: written directly (no reveal pacing — the badge is
   * a fact, not narration), replacing an earlier badge of the same moment.
   * The page's lecture session that is playing, else its latest one; nothing
   * is written when the page has none (never lectured).
   */
  const recordLectureMoment = useCallback(
    (
      sceneId: string,
      action: Extract<Action, { type: 'discussion' }>,
      moment: { agentId?: string; outcome: DiscussionOutcome },
    ) => {
      if (!action.id) return;
      const badge = {
        ...lectureMomentBadgeParams(action, moment),
        discussionActionId: action.id,
      };
      const now = Date.now();
      // Looked up in the updater: a lecture session created a moment ago is
      // already there, even before the session list re-renders
      setSessions((prev) => {
        const lectures = prev.filter(
          (s) => s.type === 'lecture' && s.sceneId === sceneId && s.messages.length > 0,
        );
        const target =
          lectures.find((s) => lectureMessageIds.current.has(s.id)) ??
          [...lectures].sort((a, b) => b.createdAt - a.createdAt)[0];
        if (!target) return prev;
        const messageId = lectureMessageIds.current.get(target.id) ?? target.messages[0].id;
        return prev.map((s) =>
          s.id === target.id
            ? {
                ...s,
                messages: s.messages.map((m) =>
                  m.id === messageId
                    ? { ...m, parts: upsertLectureMomentBadge(m.parts, badge, now) }
                    : m,
                ),
                updatedAt: nextChatUpdatedAt(s, now),
              }
            : s,
        );
      });
    },
    [],
  );

  // Derive active session type for external consumers
  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const activeSessionType = activeSession?.type ?? null;

  const getLectureMessageId = useCallback((sessionId: string): string | null => {
    return lectureMessageIds.current.get(sessionId) ?? null;
  }, []);

  /** Pause the buffer for a session (lecture pause support). */
  const pauseBuffer = useCallback((sessionId: string) => {
    const buf = buffersRef.current.get(sessionId);
    if (buf) buf.pause();
  }, []);

  /** Resume the buffer for a session. */
  const resumeBuffer = useCallback((sessionId: string) => {
    const buf = buffersRef.current.get(sessionId);
    if (buf) buf.resume();
  }, []);

  /** Pause the active live (QA/Discussion) buffer and set sticky intent. Returns true if paused. */
  const pauseActiveLiveBuffer = useCallback((): boolean => {
    const active = sessionsRef.current.find(isOpenMainLiveSession);
    if (!active) return false;
    const buf = buffersRef.current.get(active.id);
    if (!buf || buf.disposed) return false;
    livePausedRef.current = true;
    buf.pause();
    log.info('[ChatArea] Buffer-paused discussion:', active.id);
    return true;
  }, []);

  /** Resume the active live (QA/Discussion) buffer and clear sticky intent. */
  const resumeActiveLiveBuffer = useCallback(() => {
    const active = sessionsRef.current.find(isOpenMainLiveSession);
    if (!active) return;
    livePausedRef.current = false;
    const buf = buffersRef.current.get(active.id);
    if (buf) buf.resume();
    log.info('[ChatArea] Buffer-resumed discussion:', active.id);
  }, []);

  return {
    sessions,
    activeSessionId,
    activeSessionType,
    isStreaming,
    asideSessionId,
    isAsideStreaming,
    sendAsideMessage,
    endAsideSession,
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
    handleInterrupt,
    getLectureMessageId,
    pauseBuffer,
    resumeBuffer,
    pauseActiveLiveBuffer,
    resumeActiveLiveBuffer,
  };
}
