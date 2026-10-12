import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type, type Static } from 'typebox';
import { PI_REQUEST_BOUNDS, type StatelessEvent } from '@/lib/types/chat';

const CueUserParams = Type.Object({
  prompt: Type.Optional(
    Type.String({
      description:
        'Only when the last visible line of this turn asks the learner a direct question: that question as the speaker put it, short; leave it empty otherwise.',
    }),
  ),
});

type CueUserParams = Static<typeof CueUserParams>;

type CueUserSkipReason =
  | 'no_agent_turns'
  | 'no_substantive_teacher_turn'
  | 'no_substantive_teaching_turn';

/** The question forwarded to the client: trimmed, cut, or absent when empty */
export function normalizeCuePrompt(prompt: string | undefined): string | undefined {
  const trimmed = prompt?.trim();
  if (!trimmed) return undefined;
  const chars = Array.from(trimmed);
  return chars.length > PI_REQUEST_BOUNDS.cuePromptMaxChars
    ? chars.slice(0, PI_REQUEST_BOUNDS.cuePromptMaxChars).join('')
    : trimmed;
}

export function buildCueUserTool(opts: {
  cueUser: (data: Extract<StatelessEvent, { type: 'cue_user' }>['data']) => Promise<boolean>;
  getLastAgentId: () => string | undefined;
  /**
   * The hand-back gate. It sees the normalized prompt: a student's last line
   * that asks the learner a direct question may hand the turn back (I02/I31).
   */
  canCueUser?: (prompt: string | undefined) => boolean;
  cueUserSkipReason?: CueUserSkipReason;
  isSessionClosed?: () => boolean;
  /**
   * A one-time reminder when a student had the last word of the turn (their
   * line may be wrong or open). Returns the reminder text the first time it
   * applies, undefined otherwise; the call after a reminder goes through.
   */
  takeLastWordNudge?: (prompt: string | undefined) => string | undefined;
}): AgentTool<typeof CueUserParams> {
  return {
    name: 'cue_user',
    label: 'Cue user',
    description:
      'Hand the classroom turn back to the user after the useful classroom agent turns are complete.',
    parameters: CueUserParams,
    executionMode: 'sequential',
    execute: async (_toolCallId: string, params: CueUserParams) => {
      if (opts.isSessionClosed?.()) {
        return {
          content: [
            {
              type: 'text',
              text: 'The classroom session is already closed. Do not cue the user again.',
            },
          ],
          details: { emitted: false, skipped: true, reason: 'session_closed' },
        };
      }

      const prompt = normalizeCuePrompt(params.prompt);
      if (opts.canCueUser && !opts.canCueUser(prompt)) {
        const reason = opts.cueUserSkipReason ?? 'no_agent_turns';
        return {
          content: [
            {
              type: 'text',
              text:
                reason === 'no_substantive_teacher_turn'
                  ? 'Call the teacher for a visible answer before cueing the user.'
                  : reason === 'no_substantive_teaching_turn'
                    ? "Call the teacher or teaching assistant for a visible answer before cueing the user. If a student's last line asked the learner a direct question, cue the user with that question as the prompt."
                    : 'Call at least one classroom agent before cueing the user.',
            },
          ],
          details: { emitted: false, skipped: true, reason },
        };
      }

      const nudge = opts.takeLastWordNudge?.(prompt);
      if (nudge) {
        return {
          content: [{ type: 'text', text: nudge }],
          details: { emitted: false, skipped: true, reason: 'student_last_word' },
        };
      }

      const emitted = await opts.cueUser({
        fromAgentId: opts.getLastAgentId(),
        ...(prompt ? { prompt } : {}),
      });
      return {
        content: [
          {
            type: 'text',
            text: emitted
              ? 'The user has been cued for the next classroom turn.'
              : 'The user was already cued for this classroom turn.',
          },
        ],
        details: { emitted },
      };
    },
  };
}
