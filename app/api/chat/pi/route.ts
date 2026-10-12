import { attachInteractiveState } from '@/lib/chat/pi/interactive-state-evidence';
/**
 * Pi Director Chat API Endpoint
 *
 * POST /api/chat/pi - default path for running the in-class multi-agent chain
 * as a single server-side Pi agent loop. The build-time flag can disable this
 * route together with the corresponding client path for legacy rollback.
 */

import { NextRequest } from 'next/server';
import { isProviderKeyRequired } from '@/lib/ai/providers';
import {
  isCoursewareReferenceEnabled,
  isPiChatEnabled,
  isPiNativeChildRuntimeEnabled,
  isPiNativeChildSpotlightEnabled,
} from '@/lib/config/feature-flags';
import { createLogger } from '@/lib/logger';
import {
  getPiEnableWhiteboardTools,
  getPiMaxActionsPerAgent,
  getPiMaxAgentTurns,
  resolveAgentConfigs,
} from '@/lib/chat/pi/config';
import { runPiDirectorLoop } from '@/lib/chat/pi/director-loop';
import type { SendEvent } from '@/lib/chat/pi/types';
import { requestWorkspaceId } from '@/lib/server/model-config/runtime';
import { resolveModel } from '@/lib/server/resolve-model';
import { parseUserStageRoutes } from '@/lib/server/model-routes';
import { apiError } from '@/lib/server/api-response';
import type { ThinkingConfig } from '@/lib/types/provider';
import {
  CLASS_MEMORY_ENTRY_KINDS,
  DISCUSSION_MOMENT_KINDS,
  LEARNER_STANCES,
  PI_REQUEST_BOUNDS,
  type AgentStateNote,
  type ClassMemory,
  type ClassMemoryEntry,
  type ClassMemoryLearner,
  type ClassMemoryPoint,
  type ClassMemoryTally,
  type ClassMomentOutcome,
  type ClassPresence,
  type ClassPresenceAgent,
  type LectureProgress,
  type StatelessChatRequest,
} from '@/lib/types/chat';
import type { DiscussionOutcome } from '@/lib/playback/types';
import { supportedLocales } from '@/lib/i18n/locales';
import { resolveClassroomWebSearchConfig } from '@/lib/server/web-search-config';
import { resolveRequestOwner } from '@/lib/server/identity/resolve';
import {
  attachOwnerCookies,
  invalidOwnerCredentialResponse,
} from '@/lib/server/identity/with-owner';
import type { OwnerPrincipal } from '@/lib/server/identity/types';
import { guardedServerRuntimeStore } from '@/lib/persistence/runtime-tombstone-guard';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { createWhiteboardRuntimeService } from '@/lib/whiteboard/runtime/store';
import { hasNativeWhiteboardAction } from '@/lib/chat/pi/tools/native-whiteboard';
import {
  ELEMENT_REFERENCE_ACCEPTED_HEADER,
  ElementReferenceValidationError,
  resolveElementReference,
} from '@/lib/chat/pi/element-reference';

const log = createLogger('Pi Chat API');

export async function POST(req: NextRequest) {
  if (!isPiChatEnabled()) {
    return apiError('INVALID_REQUEST', 404, 'Pi chat runtime is disabled');
  }

  // Like every owner-resolving route, a request whose credential an owner
  // auth method refuses is refused here, before any model work. With the
  // default anonymous fallback resolution always succeeds, so this only
  // refuses requests under a host method that can reject (an expired token,
  // say) or with the fallback off. Memoized, so the whiteboard branch below
  // reuses this resolution.
  const owner = await resolveRequestOwner(req);
  if (!owner.ok) {
    return invalidOwnerCredentialResponse();
  }
  // Every answer carries the resolution's cookies (the anonymous owner's
  // renewal), errors included; the stream gets them on its headers before
  // its body starts.
  return attachOwnerCookies(await chat(req, owner.principal), owner.setCookies);
}

async function chat(req: NextRequest, principal: OwnerPrincipal): Promise<Response> {
  const encoder = new TextEncoder();
  let chatModel: string | undefined;
  let chatMessageCount: number | undefined;

  try {
    const body: StatelessChatRequest = await req.json();
    chatModel = body.model;
    chatMessageCount = body.messages?.length;

    if (!body.messages || !Array.isArray(body.messages)) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'Missing required field: messages');
    }

    if (!body.storeState) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'Missing required field: storeState');
    }

    if (!body.config || body.config.agentIds == null) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'Missing required field: config.agentIds');
    }

    if (
      (body.elementReference !== undefined || body.interactiveState !== undefined) &&
      !isCoursewareReferenceEnabled()
    ) {
      return apiError('INVALID_REQUEST', 400, 'Courseware references are disabled');
    }

    let elementReference;
    try {
      elementReference = resolveElementReference(body);
    } catch (error) {
      if (error instanceof ElementReferenceValidationError) {
        return apiError(
          'INVALID_REQUEST',
          400,
          error.message,
          undefined,
          body.elementReference?.kind === 'whiteboard_element'
            ? 'whiteboard_reference_changed'
            : undefined,
        );
      }
      throw error;
    }

    let interactiveStateNote;
    try {
      ({ elementReference, stateNote: interactiveStateNote } = attachInteractiveState(
        body,
        elementReference,
      ));
    } catch (error) {
      if (error instanceof ElementReferenceValidationError) {
        return apiError('INVALID_REQUEST', 400, error.message);
      }
      throw error;
    }

    const agentIds = body.config.agentIds;
    if (
      !Array.isArray(agentIds) ||
      agentIds.length === 0 ||
      agentIds.some((id) => typeof id !== 'string' || id.trim().length === 0 || id !== id.trim()) ||
      new Set(agentIds).size !== agentIds.length
    ) {
      return apiError(
        'INVALID_REQUEST',
        400,
        'config.agentIds must be a non-empty array of unique, non-empty strings',
      );
    }

    // Optional classroom context is advisory: what is malformed, oversized or
    // unresolvable is trimmed or dropped, never a reason to refuse the turn
    const adjustedFields = boundClassroomContext(body);
    if (adjustedFields.length > 0) {
      log.warn(`Pi request context adjusted: ${adjustedFields.join(', ')}`);
    }

    const {
      model: languageModel,
      apiKey: resolvedApiKey,
      providerId,
      modelInfo,
      thinkingConfig: resolvedThinkingConfig,
    } = await resolveModel({
      modelString: body.model,
      stage: 'chat-adapter',
      workspaceId: await requestWorkspaceId(req),
      // Honor the classroom-interaction per-stage override the client sends in
      // `x-model-routes`. A routed stage brings its own key and base URL; otherwise the body credentials are used (never x-* headers).
      userRoutes: parseUserStageRoutes(req.headers.get('x-model-routes')),
      apiKey: body.apiKey,
      baseUrl: body.baseUrl,
      providerType: body.providerType,
      // Let resolveModel arbitrate thinking too: a routed chat-adapter's thinking
      // wins, an unrouted one honors this client thinking (see resolve-model.ts).
      thinkingConfig: body.thinkingConfig ?? body.thinking,
    });

    if (isProviderKeyRequired(providerId) && !resolvedApiKey) {
      return apiError('MISSING_API_KEY', 401, 'API Key is required');
    }

    const agentConfigs = resolveAgentConfigs(body);
    const resolvedAgentIds = new Set(agentConfigs.map((agent) => agent.id));
    const unresolvedAgentIds = agentIds.filter((id) => !resolvedAgentIds.has(id));
    if (unresolvedAgentIds.length > 0) {
      return apiError(
        'INVALID_REQUEST',
        400,
        `Unknown classroom agents in config.agentIds: ${unresolvedAgentIds.join(', ')}`,
      );
    }
    if (agentConfigs.length === 0) {
      return apiError(
        'INVALID_REQUEST',
        400,
        `No valid classroom agents found for config.agentIds: ${body.config.agentIds.join(', ')}`,
      );
    }

    const signal = req.signal;
    const abortController = new AbortController();
    signal.addEventListener('abort', () => abortController.abort(), { once: true });

    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();

    const send: SendEvent = async (event) => {
      await writer.write(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
    };

    const thinkingConfig: ThinkingConfig = resolvedThinkingConfig ?? {
      mode: 'disabled',
      enabled: false,
    };

    const maxAgentTurns = getPiMaxAgentTurns(body);
    const maxActionsPerAgent = getPiMaxActionsPerAgent(body);
    // Never in an aside to the lecture: the assistant answers in text only
    const enableWhiteboardTools = getPiEnableWhiteboardTools(body);
    const childRuntimeMode = isPiNativeChildRuntimeEnabled() ? 'native' : 'legacy';
    const enableNativeChildSpotlight = isPiNativeChildSpotlightEnabled();
    const requestStartStageId = body.storeState.stage?.id;
    const validRequestStartStageId =
      typeof requestStartStageId === 'string' &&
      requestStartStageId.length > 0 &&
      requestStartStageId === requestStartStageId.trim()
        ? requestStartStageId
        : undefined;
    const nativeWhiteboardRequested = agentConfigs.some((agent) =>
      hasNativeWhiteboardAction(agent.allowedActions),
    );
    let nativeWhiteboardService: ReturnType<typeof createWhiteboardRuntimeService> | undefined;
    let nativeWhiteboardLearnerKey: string | undefined;
    if (
      childRuntimeMode === 'native' &&
      enableWhiteboardTools &&
      nativeWhiteboardRequested &&
      validRequestStartStageId &&
      process.env.DATABASE_URL
    ) {
      // The runtime learner key is the request owner, exactly as on
      // /api/persistence/runtime/*; nothing the client sends chooses it.
      const learnerKey = principal.ownerId;
      try {
        const provider = await getServerPersistenceProvider(process.env.DATABASE_URL);
        nativeWhiteboardLearnerKey = learnerKey;
        nativeWhiteboardService = createWhiteboardRuntimeService({
          // Guarded like /api/persistence/runtime/*: a deleted course takes
          // no new runtime from the whiteboard either.
          store: guardedServerRuntimeStore(provider.runtimeStore, provider.pool),
          resolveLearnerKey: () => learnerKey,
        });
      } catch {
        log.warn('Native whiteboard capability unavailable: persistence initialization failed');
      }
    }
    let nativeWebSearchConfig: Awaited<ReturnType<typeof resolveClassroomWebSearchConfig>>;
    try {
      nativeWebSearchConfig =
        childRuntimeMode === 'native'
          ? await resolveClassroomWebSearchConfig(await requestWorkspaceId(req), {
              webSearchProviderId: body.webSearchProviderId,
              webSearchApiKey: body.webSearchApiKey,
              webSearchBaseUrl: body.webSearchBaseUrl,
              webSearchModelId: body.webSearchModelId,
              baiduSubSources: body.baiduSubSources,
            })
          : undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid Web Search configuration';
      return apiError('INVALID_REQUEST', 400, message);
    }

    log.info(
      `Pi request agents=${body.config.agentIds.join(', ')} messages=${body.messages.length} maxAgentTurns=${maxAgentTurns}`,
    );

    (async () => {
      let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
      const startHeartbeat = () => {
        heartbeatTimer = setInterval(() => {
          writer.write(encoder.encode(`:heartbeat\n\n`)).catch(() => stopHeartbeat());
        }, 15_000);
      };
      const stopHeartbeat = () => {
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
        }
      };

      try {
        startHeartbeat();

        await runPiDirectorLoop({
          body,
          elementReference,
          interactiveStateNote,
          agentConfigs,
          send,
          languageModel,
          thinkingConfig,
          maxOutputTokens: modelInfo?.outputWindow,
          contextWindow: modelInfo?.contextWindow,
          abortSignal: abortController.signal,
          signal,
          maxAgentTurns,
          maxActionsPerAgent,
          enableWhiteboardTools,
          childRuntimeMode,
          enableNativeChildSpotlight,
          nativeWebSearchConfig,
          nativeWhiteboardService,
          nativeWhiteboardStageId: nativeWhiteboardService ? validRequestStartStageId : undefined,
          nativeWhiteboardLearnerKey,
          requestStartManualVisibilityRevision:
            Number.isSafeInteger(body.storeState.whiteboardManualVisibilityRevision) &&
            (body.storeState.whiteboardManualVisibilityRevision ?? -1) >= 0
              ? body.storeState.whiteboardManualVisibilityRevision
              : 0,
        });

        if (signal.aborted) {
          stopHeartbeat();
          await writer.close();
          return;
        }

        stopHeartbeat();
        await writer.close();
      } catch (error) {
        stopHeartbeat();

        if (signal.aborted) {
          try {
            await writer.close();
          } catch {
            /* already closed */
          }
          return;
        }

        log.error('Pi chat stream error:', error);
        try {
          await send({
            type: 'error',
            data: { message: error instanceof Error ? error.message : String(error) },
          });
          await writer.close();
        } catch {
          /* writer may already be closed */
        }
      }
    })();

    return new Response(readable, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        ...(elementReference ? { [ELEMENT_REFERENCE_ACCEPTED_HEADER]: '1' } : {}),
      },
    });
  } catch (error) {
    log.error(
      `Pi chat request failed [model=${chatModel ?? 'unknown'}, messages=${chatMessageCount ?? 0}]:`,
      error,
    );
    return apiError(
      'INTERNAL_ERROR',
      500,
      error instanceof Error ? error.message : 'Failed to process request',
    );
  }
}

// ==================== Classroom context bounds ====================

const DISCUSSION_OUTCOMES: readonly DiscussionOutcome[] = [
  'joined',
  'skipped',
  'auto_skipped',
  'not_shown',
];
const SUPPORTED_LOCALE_CODES: readonly string[] = supportedLocales.map((locale) => locale.code);

type Bag = Record<string, unknown>;

function isBag(value: unknown): value is Bag {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Trimmed text cut to `maxChars` code points; undefined when not a non-empty string */
function boundedText(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!text) return undefined;
  const chars = Array.from(text);
  return chars.length > maxChars ? chars.slice(0, maxChars).join('') : text;
}

/** JSON with object keys sorted, so a client's key order never reads as a change */
function canonicalJson(value: unknown): string | undefined {
  return JSON.stringify(value, (_key, item: unknown) =>
    isBag(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : item,
  );
}

function textLength(value: string | undefined): number {
  return value ? Array.from(value).length : 0;
}

function isBoundedId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= PI_REQUEST_BOUNDS.idMaxChars &&
    value === value.trim()
  );
}

/** A non-negative integer, clamped to `max`; undefined otherwise */
function boundedCount(value: unknown, max: number): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? Math.min(value, max)
    : undefined;
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value);
}

/** Scene ids and discussion-action ids of this request's stage snapshot */
function indexStageSnapshot(storeState: unknown): {
  sceneIds: Set<string>;
  discussionActionIds: Set<string>;
} {
  const sceneIds = new Set<string>();
  const discussionActionIds = new Set<string>();
  const scenes = isBag(storeState) && Array.isArray(storeState.scenes) ? storeState.scenes : [];
  for (const scene of scenes) {
    if (!isBag(scene)) continue;
    if (typeof scene.id === 'string') sceneIds.add(scene.id);
    if (!Array.isArray(scene.actions)) continue;
    for (const action of scene.actions) {
      if (isBag(action) && action.type === 'discussion' && typeof action.id === 'string') {
        discussionActionIds.add(action.id);
      }
    }
  }
  return { sceneIds, discussionActionIds };
}

/** Ids of the class on this request's stage snapshot: generated members and stage agentIds */
function stageRosterIds(storeState: unknown): Set<string> {
  const ids = new Set<string>();
  const stage = isBag(storeState) && isBag(storeState.stage) ? storeState.stage : undefined;
  if (!stage) return ids;
  for (const member of Array.isArray(stage.generatedAgentConfigs)
    ? stage.generatedAgentConfigs
    : []) {
    if (isBag(member) && isBoundedId(member.id)) ids.add(member.id);
  }
  for (const id of Array.isArray(stage.agentIds) ? stage.agentIds : []) {
    if (isBoundedId(id)) ids.add(id);
  }
  return ids;
}

/**
 * Enforce PI_REQUEST_BOUNDS on the optional persona and classroom context of
 * a Pi request, in place: text is trimmed and cut to length, ids must resolve
 * to this request's agents and stage, and anything malformed is dropped.
 * Returns the paths it changed, for one log line.
 */
function boundClassroomContext(body: StatelessChatRequest): string[] {
  const adjusted: string[] = [];
  const config = body.config as StatelessChatRequest['config'] & Bag;
  const agentIds = new Set(config.agentIds);
  const stage = indexStageSnapshot(body.storeState);

  // Personas arrive as data and may be pasted, shared or very long
  if (Array.isArray(config.agentConfigs)) {
    config.agentConfigs.forEach((agent, index) => {
      if (!isBag(agent) || typeof agent.persona !== 'string') return;
      const persona = Array.from(agent.persona);
      if (persona.length <= PI_REQUEST_BOUNDS.personaMaxChars) return;
      agent.persona = persona.slice(0, PI_REQUEST_BOUNDS.personaMaxChars).join('');
      adjusted.push(`config.agentConfigs[${index}].persona`);
    });
  }

  const textFields = [
    ['discussionTopic', PI_REQUEST_BOUNDS.discussionTopicMaxChars],
    ['discussionPrompt', PI_REQUEST_BOUNDS.discussionPromptMaxChars],
  ] as const;
  for (const [field, maxChars] of textFields) {
    if (config[field] === undefined) continue;
    const text = boundedText(config[field], maxChars);
    if (text !== config[field]) adjusted.push(`config.${field}`);
    if (text === undefined) delete config[field];
    else config[field] = text;
  }

  if (
    config.triggerAgentId !== undefined &&
    !(typeof config.triggerAgentId === 'string' && agentIds.has(config.triggerAgentId))
  ) {
    delete config.triggerAgentId;
    adjusted.push('config.triggerAgentId');
  }

  if (
    config.momentKind !== undefined &&
    !(config.sessionType === 'discussion' && isOneOf(config.momentKind, DISCUSSION_MOMENT_KINDS))
  ) {
    delete config.momentKind;
    adjusted.push('config.momentKind');
  }

  if (
    config.learnerStance !== undefined &&
    !(config.momentKind === 'ask-learner' && isOneOf(config.learnerStance, LEARNER_STANCES))
  ) {
    delete config.learnerStance;
    adjusted.push('config.learnerStance');
  }

  if (config.addressedAgentIds !== undefined) {
    const raw: unknown[] = Array.isArray(config.addressedAgentIds) ? config.addressedAgentIds : [];
    const addressed = [
      ...new Set(raw.filter((id): id is string => typeof id === 'string' && agentIds.has(id))),
    ].slice(0, PI_REQUEST_BOUNDS.addressedAgentIdsMax);
    if (addressed.length !== raw.length || !Array.isArray(config.addressedAgentIds)) {
      adjusted.push('config.addressedAgentIds');
    }
    if (addressed.length > 0) config.addressedAgentIds = addressed;
    else delete config.addressedAgentIds;
  }

  if (
    config.teacherMayCallOnLearner !== undefined &&
    typeof config.teacherMayCallOnLearner !== 'boolean'
  ) {
    delete config.teacherMayCallOnLearner;
    adjusted.push('config.teacherMayCallOnLearner');
  }

  if (config.classPresence !== undefined) {
    const presence = boundClassPresence(config.classPresence, agentIds, stage);
    if (canonicalJson(presence) !== canonicalJson(config.classPresence)) {
      adjusted.push('config.classPresence');
    }
    if (presence) config.classPresence = presence;
    else delete config.classPresence;
  }

  if (config.classMemory !== undefined) {
    // An aside requests only the assistant, but its memory may still name the
    // rest of the class (what the teacher or a classmate said earlier)
    const memoryAgentIds =
      config.asideToLecture === true
        ? new Set([...agentIds, ...stageRosterIds(body.storeState)])
        : agentIds;
    const memory = boundClassMemory(config.classMemory, memoryAgentIds, stage.sceneIds);
    if (canonicalJson(memory) !== canonicalJson(config.classMemory)) {
      adjusted.push('config.classMemory');
    }
    if (memory) config.classMemory = memory;
    else delete config.classMemory;
  }

  const storeState = body.storeState as StatelessChatRequest['storeState'] & Bag;
  if (storeState.lectureProgress !== undefined) {
    const progress = boundLectureProgress(storeState.lectureProgress, stage.sceneIds);
    if (canonicalJson(progress) !== canonicalJson(storeState.lectureProgress)) {
      adjusted.push('storeState.lectureProgress');
    }
    if (progress) storeState.lectureProgress = progress;
    else delete storeState.lectureProgress;
  }

  if (body.uiLocale !== undefined && !isOneOf(body.uiLocale, SUPPORTED_LOCALE_CODES)) {
    delete body.uiLocale;
    adjusted.push('uiLocale');
  }

  return adjusted;
}

function boundClassPresence(
  value: unknown,
  agentIds: ReadonlySet<string>,
  stage: { sceneIds: ReadonlySet<string>; discussionActionIds: ReadonlySet<string> },
): ClassPresence | undefined {
  if (!isBag(value)) return undefined;

  const agents: ClassPresenceAgent[] = [];
  const seenAgents = new Set<string>();
  for (const entry of Array.isArray(value.agents) ? value.agents : []) {
    if (!isBag(entry) || typeof entry.agentId !== 'string') continue;
    if (!agentIds.has(entry.agentId) || seenAgents.has(entry.agentId)) continue;
    const turns = boundedCount(entry.turns, PI_REQUEST_BOUNDS.presenceCountMax);
    if (turns === undefined) continue;
    seenAgents.add(entry.agentId);
    const learnerTurnsSince = boundedCount(
      entry.learnerTurnsSince,
      PI_REQUEST_BOUNDS.presenceCountMax,
    );
    agents.push({
      agentId: entry.agentId,
      turns,
      ...(isBoundedId(entry.lastSceneId) && stage.sceneIds.has(entry.lastSceneId)
        ? { lastSceneId: entry.lastSceneId }
        : {}),
      ...(learnerTurnsSince === undefined ? {} : { learnerTurnsSince }),
    });
  }

  // A replayed moment keeps only its latest outcome, at its latest position
  const latestOutcome = new Map<string, ClassMomentOutcome>();
  for (const entry of Array.isArray(value.moments) ? value.moments : []) {
    if (!isBag(entry) || !isBoundedId(entry.actionId)) continue;
    if (!stage.discussionActionIds.has(entry.actionId)) continue;
    if (!isOneOf(entry.outcome, DISCUSSION_OUTCOMES)) continue;
    latestOutcome.delete(entry.actionId);
    latestOutcome.set(entry.actionId, { actionId: entry.actionId, outcome: entry.outcome });
  }
  const moments = [...latestOutcome.values()].slice(-PI_REQUEST_BOUNDS.presenceMomentsMax);

  if (agents.length === 0 && moments.length === 0) return undefined;
  return { agents, ...(moments.length > 0 ? { moments } : {}) };
}

function boundClassMemory(
  value: unknown,
  agentIds: ReadonlySet<string>,
  sceneIds: ReadonlySet<string>,
): ClassMemory | undefined {
  if (!isBag(value)) return undefined;

  const entries: ClassMemoryEntry[] = [];
  for (const raw of Array.isArray(value.entries) ? value.entries : []) {
    if (!isBag(raw) || !isOneOf(raw.kind, CLASS_MEMORY_ENTRY_KINDS)) continue;
    const points: ClassMemoryPoint[] = [];
    for (const point of Array.isArray(raw.points) ? raw.points : []) {
      if (points.length >= PI_REQUEST_BOUNDS.memoryPointsPerEntryMax) break;
      if (!isBag(point) || typeof point.agentId !== 'string' || !agentIds.has(point.agentId)) {
        continue;
      }
      const gist = boundedText(point.gist, PI_REQUEST_BOUNDS.memoryGistMaxChars);
      if (gist) points.push({ agentId: point.agentId, gist });
    }
    const learnerQuestion = boundedText(
      raw.learnerQuestion,
      PI_REQUEST_BOUNDS.memoryLearnerQuestionMaxChars,
    );
    if (points.length === 0 && !learnerQuestion) continue;
    entries.push({
      kind: raw.kind,
      ...(isBoundedId(raw.sceneId) && sceneIds.has(raw.sceneId) ? { sceneId: raw.sceneId } : {}),
      ...(learnerQuestion ? { learnerQuestion } : {}),
      points,
      ...(typeof raw.unresolved === 'boolean' ? { unresolved: raw.unresolved } : {}),
    });
  }
  // The newest entries are the ones worth keeping
  entries.splice(0, Math.max(0, entries.length - PI_REQUEST_BOUNDS.memoryEntriesMax));

  const olderTallies: ClassMemoryTally[] = [];
  for (const raw of Array.isArray(value.olderTallies) ? value.olderTallies : []) {
    if (!isBag(raw) || typeof raw.agentId !== 'string' || !agentIds.has(raw.agentId)) continue;
    if (olderTallies.some((tally) => tally.agentId === raw.agentId)) continue;
    const turns = boundedCount(raw.turns, PI_REQUEST_BOUNDS.presenceCountMax);
    if (turns !== undefined && turns > 0) olderTallies.push({ agentId: raw.agentId, turns });
  }

  const boundedList = (list: unknown, maxItems: number, maxChars: number): string[] =>
    (Array.isArray(list) ? list : [])
      .map((item) => boundedText(item, maxChars))
      .filter((item): item is string => Boolean(item))
      .slice(0, maxItems);
  const rawLearner = isBag(value.learner) ? value.learner : {};
  const missedConcepts = boundedList(
    rawLearner.missedConcepts,
    PI_REQUEST_BOUNDS.memoryMissedConceptsMax,
    PI_REQUEST_BOUNDS.memoryMissedConceptMaxChars,
  );
  const repeatedQuestions = boundedList(
    rawLearner.repeatedQuestions,
    PI_REQUEST_BOUNDS.memoryRepeatedQuestionsMax,
    PI_REQUEST_BOUNDS.memoryRepeatedQuestionMaxChars,
  );

  const agentNotes: AgentStateNote[] = [];
  for (const raw of Array.isArray(value.agentNotes) ? value.agentNotes : []) {
    if (!isBag(raw) || typeof raw.agentId !== 'string' || !agentIds.has(raw.agentId)) continue;
    if (agentNotes.some((note) => note.agentId === raw.agentId)) continue;
    const note = boundedText(raw.note, PI_REQUEST_BOUNDS.memoryAgentNoteMaxChars);
    if (note) agentNotes.push({ agentId: raw.agentId, note });
  }

  // One budget for all the text: the oldest entries go first, then the
  // learner's lists from their ends, then the notes
  const entryLength = (entry: ClassMemoryEntry) =>
    textLength(entry.learnerQuestion) +
    entry.points.reduce((sum, point) => sum + textLength(point.gist), 0);
  const listLength = (list: string[]) => list.reduce((sum, item) => sum + textLength(item), 0);
  const totalLength = () =>
    entries.reduce((sum, entry) => sum + entryLength(entry), 0) +
    listLength(missedConcepts) +
    listLength(repeatedQuestions) +
    agentNotes.reduce((sum, note) => sum + textLength(note.note), 0);
  const overBudget = () => totalLength() > PI_REQUEST_BOUNDS.memoryTotalMaxChars;
  while (overBudget() && entries.length > 0) entries.shift();
  while (overBudget() && repeatedQuestions.length > 0) repeatedQuestions.pop();
  while (overBudget() && missedConcepts.length > 0) missedConcepts.pop();
  while (overBudget() && agentNotes.length > 0) agentNotes.pop();

  const learner: ClassMemoryLearner = {
    ...(missedConcepts.length > 0 ? { missedConcepts } : {}),
    ...(repeatedQuestions.length > 0 ? { repeatedQuestions } : {}),
  };
  const hasLearner = Object.keys(learner).length > 0;
  if (entries.length === 0 && olderTallies.length === 0 && !hasLearner && agentNotes.length === 0) {
    return undefined;
  }
  return {
    entries,
    ...(olderTallies.length > 0 ? { olderTallies } : {}),
    ...(hasLearner ? { learner } : {}),
    ...(agentNotes.length > 0 ? { agentNotes } : {}),
  };
}

function boundLectureProgress(
  value: unknown,
  sceneIds: ReadonlySet<string>,
): LectureProgress | undefined {
  if (!isBag(value) || !isBoundedId(value.sceneId) || !sceneIds.has(value.sceneId)) {
    return undefined;
  }
  const actionIndex = boundedCount(value.actionIndex, PI_REQUEST_BOUNDS.lectureActionIndexMax);
  return actionIndex === undefined ? undefined : { sceneId: value.sceneId, actionIndex };
}
