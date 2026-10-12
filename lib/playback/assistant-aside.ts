/**
 * The teaching assistant's aside: while the lecture plays, the teacher keeps
 * lecturing and the classroom's teaching assistant answers the learner's
 * question in the interaction panel (text only), instead of the teacher
 * pausing at the end of the line.
 */
import type { AgentConfig } from '@/lib/orchestration/registry/types';
import type { EngineMode } from './types';

/**
 * The classroom's teaching assistant: the selected agent with role
 * 'assistant' (the highest priority one when there are several), or null.
 */
export function pickAssistantAgent<T extends Pick<AgentConfig, 'id' | 'role' | 'priority'>>(
  agents: readonly (T | null | undefined)[],
): T | null {
  let best: T | null = null;
  for (const agent of agents) {
    if (!agent || agent.role !== 'assistant') continue;
    if (!best || (agent.priority ?? 0) > (best.priority ?? 0)) best = agent;
  }
  return best;
}

export interface AssistantRouteInput {
  /** The `assistantAnswersDuringLecture` setting */
  readonly enabled: boolean;
  /** The classroom's teaching assistant (pickAssistantAgent), null without one */
  readonly assistantAgentId: string | null;
  /**
   * An aside is open or streaming, or the learner raised a hand to the
   * assistant: what is said next goes to the assistant, whatever the lecture
   * does meanwhile
   */
  readonly asideOpen: boolean;
  /** The lecture engine's mode (null without a playable scene) */
  readonly engineMode: EngineMode | null;
  /** A Q&A or discussion with the teacher is open (or soft-closing, or soft-paused) */
  readonly liveSessionOpen: boolean;
  /** A hand or question already waits for the teacher (raised before this mode applied) */
  readonly teacherHandPending: boolean;
  /** The lecture is paused only while the learner records a question for the assistant */
  readonly pausedForVoice: boolean;
}

/**
 * Whether the learner's question (typed, spoken or a bare raised hand) goes
 * to the teaching assistant instead of the teacher:
 *
 * - never with the setting off or no assistant in the classroom (today's
 *   flow: the teacher pauses at the end of the line);
 * - always while an aside is open (follow-ups stay with the assistant, even
 *   if the lecture has paused since);
 * - otherwise only while the lecture plays (or is paused just for a voice
 *   question to the assistant) and no Q&A / discussion or teacher-bound hand
 *   is open. Paused, idle or live: the teacher answers, as today.
 */
export function shouldAssistantAnswer(input: AssistantRouteInput): boolean {
  if (!input.enabled || !input.assistantAgentId) return false;
  if (input.asideOpen) return true;
  if (input.liveSessionOpen || input.teacherHandPending) return false;
  if (input.engineMode === 'playing') return true;
  return input.engineMode === 'paused' && input.pausedForVoice;
}
