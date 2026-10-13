import type { AgentTurnSummary } from '../types';

// ==================== Peer Context ====================

/**
 * Build a context section summarizing what other agents said this round.
 * Returns empty string if no agents have spoken yet.
 *
 * With `currentAgentId` (the Pi child prompts), the agent also gets its own
 * earlier lines back, so it keeps the stance it already took; with
 * `currentAgentRole` the teacher and assistant are asked to take up a peer's
 * inaccurate or open point before adding anything new.
 */
export function buildPeerContextSection(
  agentResponses: AgentTurnSummary[] | undefined,
  currentAgentName: string,
  options: { currentAgentId?: string; currentAgentRole?: string } = {},
): string {
  if (!agentResponses || agentResponses.length === 0) return '';

  const isSelf = (response: AgentTurnSummary) =>
    options.currentAgentId !== undefined
      ? response.agentId === options.currentAgentId
      : response.agentName === currentAgentName;
  // Filter out self (defensive — director shouldn't dispatch same agent twice)
  const peers = agentResponses.filter((r) => !isSelf(r));
  const ownLines =
    options.currentAgentId !== undefined
      ? agentResponses.filter((r) => isSelf(r) && r.contentPreview.trim().length > 0)
      : [];
  if (peers.length === 0 && ownLines.length === 0) return '';

  const sections: string[] = [];
  if (peers.length > 0) {
    const peerLines = peers.map((r) => `- ${r.agentName}: "${r.contentPreview}"`).join('\n');
    const isStaff =
      options.currentAgentRole === 'teacher' || options.currentAgentRole === 'assistant';
    sections.push(`
# This Round's Context (CRITICAL — READ BEFORE RESPONDING)
The following agents have already spoken in this discussion round:
${peerLines}

You are ${currentAgentName}, responding AFTER the agents above. You MUST:
1. NOT repeat greetings or introductions — they have already been made
2. NOT restate what previous speakers already explained
3. Add NEW value from YOUR unique perspective as ${currentAgentName}
4. Build on, question, or extend what was said — do not echo it
5. If you agree with a previous point, say so briefly and then ADD something new
${isStaff ? "6. If a previous speaker's point was inaccurate or left open, take that up first, in your own way, before adding anything new\n" : ''}`);
  }
  if (ownLines.length > 0) {
    sections.push(`
# What you already said in this session
${ownLines.map((r) => `- "${r.contentPreview}"`).join('\n')}
Stay consistent with it: change your mind only when someone has just given you a reason to.
`);
  }
  return sections.join('');
}
