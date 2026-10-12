import { useAgentRegistry } from '@/lib/orchestration/registry/store';
import type { AgentConfig } from '@/lib/orchestration/registry/types';
import type { StatelessChatRequest } from '@/lib/types/chat';

const DEFAULT_PI_MAX_AGENT_TURNS = 6;
const MAX_PI_MAX_AGENT_TURNS = 6;
const DEFAULT_PI_MAX_ACTIONS_PER_AGENT = 8;
const MAX_PI_MAX_ACTIONS_PER_AGENT = 8;
/** An aside is one assistant answer: a single agent turn */
export const ASIDE_MAX_AGENT_TURNS = 1;

/**
 * The teaching assistant answers on the side while the teacher keeps
 * lecturing (`config.asideToLecture`): text only, one turn, no closing.
 */
export function isAsideToLecture(body: Pick<StatelessChatRequest, 'config'>): boolean {
  return body.config?.asideToLecture === true;
}

export function resolveAgentConfigs(body: StatelessChatRequest): AgentConfig[] {
  const overrides = new Map<string, AgentConfig>();
  for (const cfg of body.config.agentConfigs ?? []) {
    overrides.set(cfg.id, {
      ...cfg,
      isDefault: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  const registry = useAgentRegistry.getState();
  const agents = body.config.agentIds
    .map((id) => overrides.get(id) ?? registry.getAgent(id))
    .filter((agent): agent is AgentConfig => Boolean(agent));
  // An aside must not touch the stage the lecture is using: no slide,
  // whiteboard or media actions, whatever the agent may do otherwise
  return isAsideToLecture(body)
    ? agents.map((agent) => ({ ...agent, allowedActions: [] }))
    : agents;
}

export function getPiMaxAgentTurns(body: StatelessChatRequest): number {
  if (isAsideToLecture(body)) return ASIDE_MAX_AGENT_TURNS;
  return clampPositiveInteger(
    body.config.piMaxAgentTurns,
    DEFAULT_PI_MAX_AGENT_TURNS,
    MAX_PI_MAX_AGENT_TURNS,
  );
}

/** Whiteboard tools for this request: never in an aside, else only when asked for */
export function getPiEnableWhiteboardTools(body: StatelessChatRequest): boolean {
  return !isAsideToLecture(body) && body.config.piEnableWhiteboardTools === true;
}

export function getPiMaxActionsPerAgent(body: StatelessChatRequest): number {
  return clampPositiveInteger(
    body.config.piMaxActionsPerAgent,
    DEFAULT_PI_MAX_ACTIONS_PER_AGENT,
    MAX_PI_MAX_ACTIONS_PER_AGENT,
  );
}

function clampPositiveInteger(value: number | undefined, fallback: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(value as number)));
}
