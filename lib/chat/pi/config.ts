import { useAgentRegistry } from '@/lib/orchestration/registry/store';
import type { AgentConfig } from '@/lib/orchestration/registry/types';
import type { StatelessChatRequest } from '@/lib/types/chat';
import { withLocalizedBuiltInName, withPromptName } from './agent-names';

const DEFAULT_PI_MAX_AGENT_TURNS = 6;
const MAX_PI_MAX_AGENT_TURNS = 6;
const DEFAULT_PI_MAX_ACTIONS_PER_AGENT = 8;
const MAX_PI_MAX_ACTIONS_PER_AGENT = 8;
/** An aside is one answer on the side (the assistant's, or a named classmate's): a single agent turn */
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
    .filter((agent): agent is AgentConfig => Boolean(agent))
    // Built-in agents go by the name the learner sees on screen, and every
    // name is shown to the prompts as a plain one-line name
    .map((agent) => withPromptName(withLocalizedBuiltInName(agent, body.uiLocale)));
  // An aside must not touch the stage the lecture is using: no slide,
  // whiteboard or media actions, whatever the agent may do otherwise
  return isAsideToLecture(body)
    ? agents.map((agent) => ({ ...agent, allowedActions: [] }))
    : agents;
}

/** One person of the class as the prompts introduce them to each other */
export type ClassRosterMember = Pick<AgentConfig, 'id' | 'name' | 'role' | 'persona'>;

/**
 * Everyone in this class, for the agents to know each other by name. The
 * request's agents are the class, except in an aside, which sends only the
 * assistant: there the rest comes from the stage roster (a generated
 * classroom's `generatedAgentConfigs`, else a preset classroom's `agentIds`
 * from the registry). Request agents keep their place and their config.
 */
export function resolveClassRoster(
  body: StatelessChatRequest,
  agents: readonly ClassRosterMember[],
): ClassRosterMember[] {
  const roster: ClassRosterMember[] = agents.map(({ id, name, role, persona }) => ({
    id,
    name,
    role,
    persona,
  }));
  if (!isAsideToLecture(body)) return roster;

  const stage = body.storeState?.stage;
  const known = new Set(roster.map((member) => member.id));
  const add = (member: ClassRosterMember | undefined) => {
    if (!member || typeof member.id !== 'string' || known.has(member.id)) return;
    if (typeof member.name !== 'string' || !member.name.trim()) return;
    known.add(member.id);
    const named = withPromptName({
      ...withLocalizedBuiltInName(member, body.uiLocale),
      role: typeof member.role === 'string' ? member.role : '',
    });
    roster.push({
      id: named.id,
      name: named.name,
      role: named.role,
      persona: typeof named.persona === 'string' ? named.persona : '',
    });
  };
  const generated = Array.isArray(stage?.generatedAgentConfigs) ? stage.generatedAgentConfigs : [];
  if (generated.length > 0) {
    for (const member of generated) add(member);
  } else if (Array.isArray(stage?.agentIds)) {
    const registry = useAgentRegistry.getState();
    for (const id of stage.agentIds) {
      if (typeof id === 'string') add(registry.getAgent(id));
    }
  }
  return roster;
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
