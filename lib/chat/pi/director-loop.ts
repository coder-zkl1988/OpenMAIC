import { convertToLlm, type AgentTool } from '@earendil-works/pi-agent-core';
import type { LanguageModel } from 'ai';
import { buildAgent } from '@/lib/agent/runtime/build-agent';
import { createCallLlmStreamFn } from '@/lib/agent/runtime/stream-fn';
import { getPiCastingMode } from '@/lib/config/feature-flags';
import { createLogger } from '@/lib/logger';
import type { AgentConfig } from '@/lib/orchestration/registry/types';
import type { AgentTurnSummary, WhiteboardActionRecord } from '@/lib/orchestration/types';
import type {
  PiCastingMode,
  PiChildTurnStub,
  StatelessChatRequest,
  StatelessEvent,
} from '@/lib/types/chat';
import type { ThinkingConfig } from '@/lib/types/provider';
import { buildDirectorPrompt, buildUserPrompt, toHistoryMessages } from './prompts';
import { isAsideToLecture } from './config';
import {
  buildCastingLog,
  sumAssistantUsage,
  type CastingTerminal,
  type ChildTurnMeta,
} from './casting-log';
import { PI_PROMPT_CACHE_OPTIONS } from './prompt-cache';
import { createDirectorCompactionRuntime } from './director-compaction';
import type { DirectorToolTraceEntry, SendEvent } from './types';
import type { ChildRuntimeMode } from './child-runtime';
import { buildCallAgentTool } from './tools/call-agent';
import { buildCloseSessionTool } from './tools/close-session';
import { buildCueUserTool } from './tools/cue-user';
import {
  buildReadSceneTool,
  type DirectorSceneEvidenceMetadata,
  type DirectorSceneEvidencePacket,
} from './tools/read-scene';
import type { NativeWebSearchConfig } from './tools/web-search';
import type { WhiteboardRuntimeService } from '@/lib/whiteboard/runtime/store';
import type { ResolvedElementReference } from './element-reference';

const log = createLogger('Pi Director');

function formatSceneEvidenceForDelegation(evidence: DirectorSceneEvidencePacket[]): string {
  return evidence.map((packet) => packet.content).join('\n\n');
}

function toSceneEvidenceMetadata(
  packet: DirectorSceneEvidencePacket,
): DirectorSceneEvidenceMetadata {
  return {
    sceneId: packet.details.sceneId,
    title: packet.details.title,
    sceneType: packet.details.sceneType,
    order: packet.details.order,
    revision: packet.details.revision,
    source: packet.details.source,
  };
}

/** How a turn that ended on a student's line was closed (for casting metrics) */
type StudentLastWordEnd = 'cue_user' | 'close_session' | 'fallback_cue';

/**
 * The reminder the director gets once per turn when a student had the last
 * word: a student's wrong or open idea should be taken up by the teacher or
 * assistant, unless the student was asking the learner a question.
 */
function buildStudentLastWordNudge(
  studentName: string,
  tool: 'cue_user' | 'close_session',
  prompt?: string,
): string {
  return [
    `The last line of this turn came from ${studentName}, a student.`,
    `If it may be wrong or leaves something open, call the teacher or teaching assistant to take it up first, in their own way.`,
    tool === 'cue_user'
      ? `If ${studentName} was asking the learner a question, call cue_user again${prompt ? '' : ' with that question as its prompt'}.`
      : 'If the moment is really over, call close_session again.',
  ].join(' ');
}

export async function runPiDirectorLoop(opts: {
  body: StatelessChatRequest;
  elementReference?: ResolvedElementReference;
  /** Area state for the current Scene when it travels without a component reference. */
  interactiveStateNote?: string;
  agentConfigs: AgentConfig[];
  send: SendEvent;
  languageModel: LanguageModel;
  thinkingConfig: ThinkingConfig;
  maxOutputTokens?: number;
  contextWindow?: number;
  abortSignal: AbortSignal;
  signal: AbortSignal;
  maxAgentTurns: number;
  maxActionsPerAgent: number;
  enableWhiteboardTools: boolean;
  childRuntimeMode?: ChildRuntimeMode;
  enableNativeChildSpotlight?: boolean;
  nativeWebSearchConfig?: NativeWebSearchConfig;
  nativeWhiteboardService?: WhiteboardRuntimeService;
  nativeWhiteboardStageId?: string;
  nativeWhiteboardLearnerKey?: string;
  requestStartManualVisibilityRevision?: number;
  /** The director's casting rules; default from OPENMAIC_PI_PERSONA_CASTING */
  castingMode?: PiCastingMode;
  /**
   * Eval-only (eval/pi-casting): scripted child speech instead of child LLM
   * runs. The route never sets it, and nothing in the request can.
   */
  childTurnStub?: PiChildTurnStub;
}): Promise<void> {
  const castingMode = opts.castingMode ?? getPiCastingMode();
  // 'legacy' rolls back the persona turn mechanics too (the student-last-word
  // reminder, the closing turn past the limit, a student handing back with a
  // question), so the A/B baseline is the earlier loop
  const personaMechanics = castingMode === 'persona';
  let totalAgents = 0;
  let totalActions = 0;
  let agentHadContent = false;
  let userCued = false;
  let sessionClosed = false;
  let endReason: string | undefined;
  let terminal: CastingTerminal = 'none';
  let cuePrompt = false;
  let directorToolCalls = 0;
  // A student's wrong or open line should not end the turn: the first
  // cue_user / close_session after one gets a reminder, once per turn
  let studentLastWordNudged = false;
  let studentLastWordEnd: StudentLastWordEnd | undefined;
  const pendingSceneEvidence = new Map<string, DirectorSceneEvidencePacket>();
  // Request-scoped read-only evidence. `metadata` exists only when a component was
  // referenced; area state alone carries content without any element identity.
  const elementReferenceEvidence =
    opts.elementReference || opts.interactiveStateNote
      ? Object.freeze({
          content: [opts.elementReference?.childEvidence, opts.interactiveStateNote]
            .filter(Boolean)
            .join('\n\n'),
          ...(opts.elementReference ? { metadata: opts.elementReference.evidence } : {}),
        })
      : undefined;
  const directorToolTrace: DirectorToolTraceEntry[] = [];
  // The assistant answers on the side while the teacher keeps lecturing
  const asideToLecture = isAsideToLecture(opts.body);
  const maxDirectorToolCalls = Math.max(opts.maxAgentTurns * 3, opts.maxAgentTurns + 3);
  const piAgentResponses: AgentTurnSummary[] = [];
  // The casting log's view of each child turn: role, castReason, length, cost
  const childTurnMetas: Array<ChildTurnMeta | undefined> = [];
  let pendingTurnMeta: ChildTurnMeta | undefined;
  const piWhiteboardLedger: WhiteboardActionRecord[] = [];
  const requestStartCurrentScene = (() => {
    const sceneId = opts.body.storeState.currentSceneId;
    const scene = sceneId
      ? opts.body.storeState.scenes.find((candidate) => candidate.id === sceneId)
      : undefined;
    if (!scene) return undefined;
    const elementIds =
      scene.content.type === 'slide'
        ? scene.content.canvas.elements
            .map((element) => element.id)
            .filter((id): id is string => typeof id === 'string' && id.length > 0)
        : [];
    return Object.freeze({
      sceneId: scene.id,
      sceneType: scene.content.type,
      elementIds: Object.freeze(elementIds),
    });
  })();
  const getAgentTurnCount = (): number => piAgentResponses.length;
  const isTeachingSubstantiveTurn = (summary: AgentTurnSummary): boolean => {
    const agent = opts.agentConfigs.find((candidate) => candidate.id === summary.agentId);
    return (
      (agent?.role === 'teacher' || agent?.role === 'assistant') &&
      (summary.contentPreview.trim().length > 0 || summary.actionCount > 0)
    );
  };
  const hasTeachingSubstantiveTurn = (): boolean =>
    piAgentResponses.some(isTeachingSubstantiveTurn);
  const hasVisibleAgentTurn = (): boolean =>
    piAgentResponses.some((summary) => summary.contentPreview.trim().length > 0);
  const hasAgentContent = (): boolean =>
    piAgentResponses.some(
      (summary) => summary.contentPreview.trim().length > 0 || summary.actionCount > 0,
    );
  /** The student who spoke this loop's last visible line, if a student did (never in an aside) */
  const getStudentLastWord = (): AgentTurnSummary | undefined => {
    if (asideToLecture) return undefined;
    const lastVisible = piAgentResponses.findLast(
      (summary) => summary.contentPreview.trim().length > 0,
    );
    if (!lastVisible) return undefined;
    const agent = opts.agentConfigs.find((candidate) => candidate.id === lastVisible.agentId);
    return agent?.role === 'student' ? lastVisible : undefined;
  };
  const takeStudentLastWordNudge = (
    tool: 'cue_user' | 'close_session',
    prompt?: string,
  ): string | undefined => {
    if (!personaMechanics || studentLastWordNudged) return undefined;
    const student = getStudentLastWord();
    if (!student) return undefined;
    studentLastWordNudged = true;
    return buildStudentLastWordNudge(student.agentName, tool, prompt);
  };
  const cueUser = async (
    data: Extract<StatelessEvent, { type: 'cue_user' }>['data'],
    source: 'cue_user' | 'fallback_cue' = 'cue_user',
  ): Promise<boolean> => {
    if (userCued) return false;
    userCued = true;
    terminal = source;
    cuePrompt = Boolean(data.prompt);
    if (getStudentLastWord()) studentLastWordEnd = source;
    await opts.send({ type: 'cue_user', data });
    return true;
  };
  const closeSession = async (data: { endReason?: string }): Promise<boolean> => {
    if (sessionClosed || userCued) return false;
    sessionClosed = true;
    terminal = 'close_session';
    endReason = data.endReason;
    if (getStudentLastWord()) studentLastWordEnd = 'close_session';
    return true;
  };

  const streamFn = createCallLlmStreamFn({
    languageModel: opts.languageModel,
    maxOutputTokens: opts.maxOutputTokens,
    thinkingConfig: opts.thinkingConfig,
    source: 'pi-chat-director',
    abortSignal: opts.abortSignal,
    ...PI_PROMPT_CACHE_OPTIONS,
  });
  const compactionRuntime = createDirectorCompactionRuntime({
    streamFn,
    contextWindow: opts.contextWindow,
    maxOutputTokens: opts.maxOutputTokens,
  });

  const tools: AgentTool[] = [
    buildReadSceneTool({
      body: opts.body,
      onEvidence: (evidence) => {
        pendingSceneEvidence.set(evidence.details.sceneId, evidence);
      },
    }),
    buildCallAgentTool({
      body: opts.body,
      agentConfigs: opts.agentConfigs,
      send: opts.send,
      languageModel: opts.languageModel,
      onAgentTurnMeta: (turn) => {
        pendingTurnMeta = turn;
      },
      onAgentDone: (summary) => {
        totalAgents += 1;
        if (summary.contentPreview || summary.actionCount > 0) agentHadContent = true;
        piAgentResponses.push(summary);
        childTurnMetas.push(pendingTurnMeta);
        pendingTurnMeta = undefined;
      },
      onActionDone: (record) => {
        totalActions += 1;
        if (record) piWhiteboardLedger.push(record);
      },
      thinkingConfig: opts.thinkingConfig,
      maxOutputTokens: opts.maxOutputTokens,
      abortSignal: opts.abortSignal,
      maxAgentTurns: opts.maxAgentTurns,
      getAgentTurnCount,
      getAgentResponses: () => [
        ...(opts.body.directorState?.agentResponses ?? []),
        ...piAgentResponses,
      ],
      // storeState is already the request-start whiteboard snapshot, so replay
      // only mutations produced during this request in child-agent prompts.
      getWhiteboardLedger: () => piWhiteboardLedger,
      maxActionsPerAgent: opts.maxActionsPerAgent,
      enableWhiteboardTools: opts.enableWhiteboardTools,
      childRuntimeMode: opts.childRuntimeMode ?? 'legacy',
      enableNativeChildSpotlight: opts.enableNativeChildSpotlight === true,
      nativeWebSearchConfig: opts.nativeWebSearchConfig,
      nativeWhiteboardService: opts.nativeWhiteboardService,
      nativeWhiteboardStageId: opts.nativeWhiteboardStageId,
      nativeWhiteboardLearnerKey: opts.nativeWhiteboardLearnerKey,
      requestStartManualVisibilityRevision: opts.requestStartManualVisibilityRevision ?? 0,
      requestStartCurrentScene,
      isUserCued: () => userCued,
      isSessionClosed: () => sessionClosed,
      getStudentLastWord,
      castingMode,
      takeSceneEvidence: (accept) => {
        const packets = [...pendingSceneEvidence.values()].filter(
          (packet) => !accept || accept(toSceneEvidenceMetadata(packet)),
        );
        if (packets.length === 0) return undefined;
        for (const packet of packets) pendingSceneEvidence.delete(packet.details.sceneId);
        return {
          content: formatSceneEvidenceForDelegation(packets),
          metadata: packets.map(toSceneEvidenceMetadata),
        };
      },
      peekSceneEvidence: () => [...pendingSceneEvidence.values()].map(toSceneEvidenceMetadata),
      elementReferenceEvidence,
      childTurnStub: opts.childTurnStub,
    }),
    // An aside to the lecture stays open for follow-ups: it has no close_session
    ...(asideToLecture
      ? []
      : [
          buildCloseSessionTool({
            closeSession,
            canCloseSession: hasVisibleAgentTurn,
            isUserCued: () => userCued,
            takeLastWordNudge: () => takeStudentLastWordNudge('close_session'),
          }),
        ]),
    buildCueUserTool({
      cueUser: (data) => cueUser(data),
      getLastAgentId: () => piAgentResponses.at(-1)?.agentId,
      // A student whose last line asks the learner a direct question may hand
      // the turn back (with that question as the prompt), teacher or not
      canCueUser: (prompt) =>
        hasTeachingSubstantiveTurn() ||
        (personaMechanics && prompt !== undefined && Boolean(getStudentLastWord())),
      cueUserSkipReason: 'no_substantive_teaching_turn',
      isSessionClosed: () => sessionClosed,
      takeLastWordNudge: (prompt) => takeStudentLastWordNudge('cue_user', prompt),
    }),
  ];

  const director = buildAgent({
    streamFn,
    systemPrompt: buildDirectorPrompt(opts.body, opts.agentConfigs, opts.maxAgentTurns, {
      castingMode,
    }),
    tools,
    allowedToolNames: new Set(tools.map((tool) => tool.name)),
    // Every agent line is labelled with its speaker, so the director knows
    // across turns who said what
    history: toHistoryMessages(opts.body.messages, null, { agents: opts.agentConfigs }),
    transformContext: compactionRuntime.transformContext,
    convertToLlm,
    afterToolCall: (context) => {
      directorToolCalls += 1;
      const evidenceStatus =
        context.toolCall.name === 'read_scene'
          ? (context.result.details as { status?: string } | undefined)?.status
          : undefined;
      const evidenceError = evidenceStatus !== undefined && evidenceStatus !== 'ok';
      const isError = context.isError || evidenceError;
      const resultPreview = context.result.content
        .map((content) => (content.type === 'text' ? content.text : '[image]'))
        .join('\n')
        .slice(0, 800);
      directorToolTrace.push({
        sequence: directorToolCalls,
        toolName: context.toolCall.name,
        args: context.args,
        isError,
        resultPreview,
        details: context.result.details,
      });
      const terminate = sessionClosed || userCued || directorToolCalls >= maxDirectorToolCalls;
      if (!terminate && !evidenceError) return undefined;
      return {
        ...(terminate ? { terminate: true } : {}),
        ...(evidenceError ? { isError: true } : {}),
      };
    },
  });

  try {
    const directorEvidence = [opts.elementReference?.directorSummary, opts.interactiveStateNote]
      .filter(Boolean)
      .join('\n');
    await director.prompt(
      buildUserPrompt(opts.body, directorEvidence || undefined, opts.agentConfigs),
    );
    await director.waitForIdle();
  } finally {
    compactionRuntime.dispose();
  }

  if (opts.signal.aborted) return;

  // Pi settles provider failures in state rather than rejecting prompt(). Let
  // the route log and stream the actual reason instead of emitting a normal done.
  if (director.state.errorMessage) throw new Error(director.state.errorMessage);

  if (!sessionClosed && !userCued && hasAgentContent()) {
    // The automatic hand-back passes no gate; it only records a student last word
    await cueUser({ fromAgentId: piAgentResponses.at(-1)?.agentId }, 'fallback_cue');
  }
  log.info(
    `pi.casting ${JSON.stringify(
      buildCastingLog({
        castingMode,
        body: opts.body,
        agents: opts.agentConfigs,
        turns: piAgentResponses.map((summary, index) => ({
          summary,
          meta: childTurnMetas[index],
        })),
        terminal,
        cuePrompt,
        endReason,
        studentLastWordNudged,
        studentLastWordEnd,
        studentLastWordAgentId: getStudentLastWord()?.agentId,
        toolTrace: directorToolTrace,
        directorUsage: sumAssistantUsage(director.state?.messages),
      }),
    )}`,
  );

  await opts.send({
    type: 'done',
    data: {
      totalActions,
      totalAgents,
      agentHadContent,
      cueUserReceived: userCued,
      sessionClosed,
      endReason,
      directorCompaction: compactionRuntime.getTrace(),
      directorToolTrace,
      directorState: {
        turnCount: getAgentTurnCount(),
        agentResponses: [...(opts.body.directorState?.agentResponses ?? []), ...piAgentResponses],
        // Return only this turn's whiteboard mutations. The cross-turn board
        // state is carried by storeState's request-start snapshot, and Pi child
        // prompts replay only the current-turn ledger (see getWhiteboardLedger
        // above), so persisting the historical ledger just inflated session
        // state and follow-up payloads without being read back.
        whiteboardLedger: piWhiteboardLedger,
      },
    },
  });
}
