/**
 * The `pi.casting` log line (I20): one structured record per director loop
 * of who was cast to speak, why (castReason), how the turn ended and what it
 * cost, built from the loop's agent responses and tool trace. For offline
 * observation only (non-teacher share, role coverage, how turns end): it sets
 * no targets and changes nothing in the loop. Ids, roles and counts only; no
 * speech or learner text.
 */
import type { AgentConfig } from '@/lib/orchestration/registry/types';
import type { AgentTurnSummary } from '@/lib/orchestration/types';
import type { CastReason, PiCastingMode, StatelessChatRequest } from '@/lib/types/chat';
import type { DirectorToolTraceEntry } from './types';

/** Token usage of LLM calls, as Pi records it on assistant messages */
export interface ChildTurnUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** What the casting log records about one child turn, beside its summary */
export interface ChildTurnMeta {
  role: string;
  castReason?: CastReason;
  /** Characters (code points) of the visible speech */
  chars: number;
  /** From agent_start to agent_end */
  durationMs: number;
  /** Absent when the turn ran no LLM through a Pi agent (a stub, the native runtime) */
  usage?: ChildTurnUsage;
}

/** Sum of the usage on the assistant messages of a Pi agent run; undefined when none has any */
export function sumAssistantUsage(messages: unknown): ChildTurnUsage | undefined {
  if (!Array.isArray(messages)) return undefined;
  let found = false;
  const total: ChildTurnUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const message of messages) {
    const candidate = message as { role?: string; usage?: Partial<ChildTurnUsage> } | null;
    if (candidate?.role !== 'assistant' || !candidate.usage) continue;
    found = true;
    total.input += Number(candidate.usage.input) || 0;
    total.output += Number(candidate.usage.output) || 0;
    total.cacheRead += Number(candidate.usage.cacheRead) || 0;
    total.cacheWrite += Number(candidate.usage.cacheWrite) || 0;
  }
  return found ? total : undefined;
}

/** How the loop handed the turn back */
export type CastingTerminal = 'cue_user' | 'close_session' | 'fallback_cue' | 'none';

export interface CastingLogInput {
  castingMode: PiCastingMode;
  body: StatelessChatRequest;
  agents: readonly Pick<AgentConfig, 'id' | 'role'>[];
  turns: ReadonlyArray<{ summary: AgentTurnSummary; meta?: ChildTurnMeta }>;
  terminal: CastingTerminal;
  /** cue_user carried a question for the learner */
  cuePrompt: boolean;
  endReason?: string;
  /** The once-per-turn reminder after a student's last word fired */
  studentLastWordNudged: boolean;
  /** How a turn ending on a student's line was closed, when it did */
  studentLastWordEnd?: string;
  /** The student whose line was the last word, when it was */
  studentLastWordAgentId?: string;
  toolTrace: readonly DirectorToolTraceEntry[];
  directorUsage?: ChildTurnUsage;
}

export interface CastingLogTurn {
  agentId: string;
  role: string;
  chars: number;
  durationMs?: number;
  castReason?: CastReason;
  actions: number;
}

export interface CastingLog {
  castingMode: PiCastingMode;
  sessionType: string;
  aside: boolean;
  momentKind?: string;
  /** Agents the learner addressed by name in the latest message */
  addressed: string[];
  roles: Record<string, string>;
  turns: CastingLogTurn[];
  terminal: CastingTerminal;
  cuePrompt: boolean;
  endReason?: string;
  studentLastWord: { nudged: boolean; endedBy?: string; agentId?: string };
  toolCalls: number;
  toolCounts: Record<string, number>;
  /** Tool calls the runtime refused, by reason (turn limit, invalid agent, ...) */
  skipped: Record<string, number>;
  usage: {
    director?: ChildTurnUsage;
    byRole: Record<string, ChildTurnUsage & { turns: number }>;
  };
}

function addUsage(target: ChildTurnUsage, usage: ChildTurnUsage): void {
  target.input += usage.input;
  target.output += usage.output;
  target.cacheRead += usage.cacheRead;
  target.cacheWrite += usage.cacheWrite;
}

export function buildCastingLog(input: CastingLogInput): CastingLog {
  const roles = Object.fromEntries(input.agents.map((agent) => [agent.id, agent.role]));
  const turns = input.turns.map(
    ({ summary, meta }): CastingLogTurn => ({
      agentId: summary.agentId,
      role: meta?.role ?? roles[summary.agentId] ?? 'unknown',
      chars: meta?.chars ?? Array.from(summary.contentPreview).length,
      ...(meta ? { durationMs: meta.durationMs } : {}),
      ...(meta?.castReason ? { castReason: meta.castReason } : {}),
      actions: summary.actionCount,
    }),
  );

  const toolCounts: Record<string, number> = {};
  const skipped: Record<string, number> = {};
  for (const entry of input.toolTrace) {
    toolCounts[entry.toolName] = (toolCounts[entry.toolName] ?? 0) + 1;
    const details = entry.details as { skipped?: boolean; reason?: unknown } | undefined;
    if (details?.skipped && typeof details.reason === 'string') {
      const key = `${entry.toolName}:${details.reason}`;
      skipped[key] = (skipped[key] ?? 0) + 1;
    }
  }

  const byRole: CastingLog['usage']['byRole'] = {};
  for (const { meta } of input.turns) {
    if (!meta) continue;
    const bucket = (byRole[meta.role] ??= {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      turns: 0,
    });
    bucket.turns += 1;
    if (meta.usage) addUsage(bucket, meta.usage);
  }

  return {
    castingMode: input.castingMode,
    sessionType: input.body.config.sessionType ?? 'qa',
    aside: input.body.config.asideToLecture === true,
    // A discussion without a momentKind is a lecture moment
    ...(input.body.config.sessionType === 'discussion'
      ? { momentKind: input.body.config.momentKind ?? 'lecture' }
      : {}),
    addressed: [...(input.body.config.addressedAgentIds ?? [])],
    roles,
    turns,
    terminal: input.terminal,
    cuePrompt: input.cuePrompt,
    ...(input.endReason ? { endReason: input.endReason } : {}),
    studentLastWord: {
      nudged: input.studentLastWordNudged,
      ...(input.studentLastWordEnd ? { endedBy: input.studentLastWordEnd } : {}),
      ...(input.studentLastWordEnd && input.studentLastWordAgentId
        ? { agentId: input.studentLastWordAgentId }
        : {}),
    },
    toolCalls: input.toolTrace.length,
    toolCounts,
    skipped,
    usage: {
      ...(input.directorUsage ? { director: input.directorUsage } : {}),
      byRole,
    },
  };
}
