import { produce } from 'immer';
import type { GeneratedAgentConfig, Scene } from '@/lib/types/stage';
import type { Action } from '@/lib/types/action';
import { AGENT_DEFAULT_AVATARS, AGENT_COLOR_PALETTE } from '@/lib/constants/agent-defaults';

// Cap undo history so long editing sessions don't grow memory unbounded.
export const MAX_HISTORY = 50;

export type AgentRoster = GeneratedAgentConfig[];

export interface AgentConfigPatch {
  name?: string;
  role?: string;
  persona?: string;
  avatar?: string;
}

export type AgentEditOperation =
  | { type: 'agent.add'; agent: GeneratedAgentConfig }
  | { type: 'agent.update'; id: string; patch: AgentConfigPatch }
  /**
   * Several members changed as one edit (one undo step): e.g. the personas
   * the "rewrite as real people" upgrade returned (I25)
   */
  | { type: 'agent.updateMany'; updates: ReadonlyArray<{ id: string; patch: AgentConfigPatch }> }
  | { type: 'agent.delete'; id: string }
  | { type: 'agent.reorder'; id: string; index: number };

export interface AgentRosterHistory {
  past: AgentRoster[];
  present: AgentRoster;
  future: AgentRoster[];
}

/** Maps a role string to its priority number. teacher=10, assistant=7, else=5. */
export function priorityForRole(role: string): number {
  if (role === 'teacher') return 10;
  if (role === 'assistant') return 7;
  return 5;
}

/** Returns a sensible display name for a role. */
function nameForRole(role: string): string {
  if (role === 'teacher') return 'Teacher';
  if (role === 'assistant') return 'Assistant';
  return 'Student';
}

/**
 * Build a new GeneratedAgentConfig with defaults derived from role + index.
 * avatar cycles through AGENT_DEFAULT_AVATARS, color through AGENT_COLOR_PALETTE.
 */
export function createAgentConfig(role: string, index: number, id: string): GeneratedAgentConfig {
  return {
    id,
    name: nameForRole(role),
    role,
    persona: '',
    avatar: AGENT_DEFAULT_AVATARS[index % AGENT_DEFAULT_AVATARS.length],
    color: AGENT_COLOR_PALETTE[index % AGENT_COLOR_PALETTE.length],
    priority: priorityForRole(role),
  };
}

/** Count how many agents in the roster have role 'teacher'. */
export function teacherCount(roster: AgentRoster): number {
  return roster.filter((a) => a.role === 'teacher').length;
}

export function applyAgentEditOperation(roster: AgentRoster, op: AgentEditOperation): AgentRoster;
export function applyAgentEditOperation(
  history: AgentRosterHistory,
  op: AgentEditOperation,
): AgentRosterHistory;
export function applyAgentEditOperation(
  target: AgentRoster | AgentRosterHistory,
  op: AgentEditOperation,
): AgentRoster | AgentRosterHistory {
  if (isAgentRosterHistory(target)) {
    const next = applyOperationToRoster(target.present, op);
    // If the roster didn't change (e.g. update against missing id), skip history push.
    if (next === target.present) return target;

    return {
      past: capHistory([...target.past, target.present]),
      present: next,
      future: [],
    };
  }

  return applyOperationToRoster(target, op);
}

export function undoAgentEditOperation(h: AgentRosterHistory): AgentRosterHistory {
  if (h.past.length === 0) return h;

  const previous = h.past[h.past.length - 1];
  return {
    past: h.past.slice(0, -1),
    present: previous,
    future: [h.present, ...h.future],
  };
}

export function redoAgentEditOperation(h: AgentRosterHistory): AgentRosterHistory {
  if (h.future.length === 0) return h;

  const next = h.future[0];
  return {
    past: capHistory([...h.past, h.present]),
    present: next,
    future: h.future.slice(1),
  };
}

function applyOperationToRoster(roster: AgentRoster, op: AgentEditOperation): AgentRoster {
  return produce(roster, (draft) => {
    switch (op.type) {
      case 'agent.add': {
        draft.push({ ...op.agent });
        return;
      }
      case 'agent.update': {
        updateAgent(draft, roster, op.id, op.patch);
        return;
      }
      case 'agent.updateMany': {
        for (const { id, patch } of op.updates) updateAgent(draft, roster, id, patch);
        return;
      }
      case 'agent.delete': {
        const idx = draft.findIndex((a) => a.id === op.id);
        if (idx === -1) return;
        const agent = draft[idx];

        // Guard: cannot delete the last teacher.
        if (agent.role === 'teacher' && teacherCount(roster) <= 1) {
          throw new Error('LAST_TEACHER');
        }

        draft.splice(idx, 1);
        return;
      }
      case 'agent.reorder': {
        const currentIndex = draft.findIndex((a) => a.id === op.id);
        if (currentIndex === -1) return;

        const [agent] = draft.splice(currentIndex, 1);
        const nextIndex = Math.max(0, Math.min(op.index, draft.length));
        draft.splice(nextIndex, 0, agent);
        return;
      }
    }
  });
}

/** One member's patch, in place; a missing id is a no-op */
function updateAgent(
  draft: AgentRoster,
  roster: AgentRoster,
  id: string,
  patch: AgentConfigPatch,
): void {
  const agent = draft.find((a) => a.id === id);
  if (!agent) return;

  // Guard: role change that would drop teacher count to 0.
  if (patch.role !== undefined && patch.role !== agent.role) {
    if (agent.role === 'teacher' && teacherCount(roster) <= 1) {
      throw new Error('LAST_TEACHER');
    }
  }

  Object.assign(agent, patch);

  // Recompute priority when role changes.
  if (patch.role !== undefined) {
    agent.priority = priorityForRole(agent.role);
  }
}

function isAgentRosterHistory(
  target: AgentRoster | AgentRosterHistory,
): target is AgentRosterHistory {
  return 'present' in target && 'past' in target && 'future' in target;
}

function capHistory(past: AgentRoster[]): AgentRoster[] {
  return past.length > MAX_HISTORY ? past.slice(past.length - MAX_HISTORY) : past;
}

// ---------------------------------------------------------------------------
// Script references: what of the course's script points at a roster member
// ---------------------------------------------------------------------------

/** How much of the course's script refers to one roster member */
export interface AgentScriptReferences {
  /** Class moments (discussion actions) this member opens, by id */
  moments: number;
  /** Narration lines and moment openers that say this member's name */
  mentions: number;
}

/** A shorter name is not searched for: one character matches almost any line */
export const MIN_MENTIONED_NAME_CHARS = 2;

/** The script of one scene, as the reference helpers read it */
type ScriptScene = Pick<Scene, 'id' | 'actions'>;

function saysName(text: string | undefined, name: string): boolean {
  return !!text && text.toLocaleLowerCase().includes(name);
}

/**
 * What a delete or rename would leave pointing at a member: the class moments
 * they open (`discussion.agentId`; deleted, the engine skips them silently)
 * and the lines that say their name (pre-generated narration and voice keep
 * saying it). Names shorter than {@link MIN_MENTIONED_NAME_CHARS} count no
 * mentions.
 */
export function countAgentScriptReferences(
  scenes: readonly ScriptScene[],
  agent: { readonly id: string; readonly name: string },
): AgentScriptReferences {
  const name = agent.name.trim().toLocaleLowerCase();
  const searchName = Array.from(name).length >= MIN_MENTIONED_NAME_CHARS;
  let moments = 0;
  let mentions = 0;
  for (const scene of scenes) {
    for (const action of scene.actions ?? []) {
      if (action.type === 'discussion') {
        if (action.agentId === agent.id) moments++;
        if (searchName && saysName(action.topic, name)) mentions++;
      } else if (action.type === 'speech') {
        if (searchName && saysName(action.text, name)) mentions++;
      }
    }
  }
  return { moments, mentions };
}

/**
 * The scenes whose actions change when the class moments a member opens are
 * handed to the teacher (`teacherId`), or dropped (no `teacherId`): each
 * changed scene with its new actions, for `updateScene`. Scenes without such
 * a moment are left out.
 */
export function rewriteAgentMoments(
  scenes: readonly ScriptScene[],
  agentId: string,
  teacherId?: string,
): Array<{ sceneId: string; actions: Action[] }> {
  const changed: Array<{ sceneId: string; actions: Action[] }> = [];
  for (const scene of scenes) {
    const actions = scene.actions ?? [];
    if (!actions.some((a) => a.type === 'discussion' && a.agentId === agentId)) continue;
    const next = teacherId
      ? actions.map((a) =>
          a.type === 'discussion' && a.agentId === agentId ? { ...a, agentId: teacherId } : a,
        )
      : actions.filter((a) => !(a.type === 'discussion' && a.agentId === agentId));
    changed.push({ sceneId: scene.id, actions: next });
  }
  return changed;
}
