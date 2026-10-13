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
  /**
   * The question names (@) someone other than the assistant (I23): not the
   * assistant's to answer (resolveAsideAgent sends it to the one named, or to
   * the teacher)
   */
  readonly addressesOthers?: boolean;
  /**
   * Fullscreen: the chat that shows an aside is hidden, so an answer there
   * would never be seen. The teacher answers instead, over the dock.
   */
  readonly presenting?: boolean;
}

/**
 * Whether the learner's question (typed, spoken or a bare raised hand) goes
 * to the teaching assistant instead of the teacher:
 *
 * - never with the setting off or no assistant in the classroom (today's
 *   flow: the teacher pauses at the end of the line), nor for a question
 *   that names someone else (see {@link resolveAsideAgent}), nor in
 *   fullscreen, where the aside could not be seen (the teacher's answer
 *   shows over the dock);
 * - always while an aside is open (follow-ups stay with the assistant, even
 *   if the lecture has paused since);
 * - otherwise only while the lecture plays (or is paused just for a voice
 *   question to the assistant) and no Q&A / discussion or teacher-bound hand
 *   is open. Paused, idle or live: the teacher answers, as today.
 */
export function shouldAssistantAnswer(input: AssistantRouteInput): boolean {
  if (!input.enabled || !input.assistantAgentId || input.addressesOthers || input.presenting) {
    return false;
  }
  if (input.asideOpen) return true;
  if (input.liveSessionOpen || input.teacherHandPending) return false;
  if (input.engineMode === 'playing') return true;
  return input.engineMode === 'paused' && input.pausedForVoice;
}

/** Someone the learner's message names (@), as the aside route reads them */
export interface AddressedAgent {
  readonly id: string;
  readonly role: string;
}

export interface AsideRouteInput extends Omit<AssistantRouteInput, 'addressesOthers'> {
  /** Who the message names (@), in the order named */
  readonly addressed?: readonly AddressedAgent[];
  /** Who answers in the open aside (the last one asked on the side), null without one */
  readonly asideAgentId?: string | null;
}

/**
 * Who answers the learner on the side while the teacher keeps lecturing, or
 * null for the teacher.
 *
 * Naming (@) a classmate or the teaching assistant during the lecture is
 * talking to them, not raising a hand: in a real class they whisper back and
 * the teacher goes on. So while the lecture plays (or an aside is already
 * open) the first one named answers on the side, whatever the assistant
 * setting says, since the learner chose them. Naming the teacher keeps the
 * teacher's flow (the answer comes at the end of the line); so does
 * fullscreen, where the chat with the aside is hidden, and an open Q&A or a
 * hand already waiting for the teacher (the named one answers first there).
 * A message that names nobody follows {@link shouldAssistantAnswer}; a
 * follow-up in an open aside stays with whoever answers it.
 */
export function resolveAsideAgent(input: AsideRouteInput): string | null {
  if (input.presenting) return null;
  const addressed = input.addressed ?? [];
  if (addressed.length > 0) {
    if (addressed.some((agent) => agent.role === 'teacher')) return null;
    const named = addressed[0]!.id;
    if (input.asideOpen) return named;
    if (input.liveSessionOpen || input.teacherHandPending) return null;
    if (input.engineMode === 'playing') return named;
    return input.engineMode === 'paused' && input.pausedForVoice ? named : null;
  }
  if (input.asideOpen && input.asideAgentId) return input.asideAgentId;
  return shouldAssistantAnswer(input) ? input.assistantAgentId : null;
}
