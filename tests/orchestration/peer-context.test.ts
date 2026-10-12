import { describe, expect, it } from 'vitest';
import { buildPeerContextSection } from '@/lib/orchestration/summarizers/peer-context';
import type { AgentTurnSummary } from '@/lib/orchestration/types';

function turn(agentId: string, agentName: string, contentPreview: string): AgentTurnSummary {
  return { agentId, agentName, contentPreview, actionCount: 0, whiteboardActions: [] };
}

const responses = [
  turn('student-1', '小思', 'I think the waves just disappear.'),
  turn('teacher-1', '林老师', 'Not quite: the energy moves elsewhere.'),
  turn('student-1', '小思', 'Oh, so it goes to the bright spots?'),
];

describe('buildPeerContextSection', () => {
  it('is empty when nobody has spoken', () => {
    expect(buildPeerContextSection(undefined, '小思')).toBe('');
    expect(buildPeerContextSection([], '小思', { currentAgentId: 'student-1' })).toBe('');
  });

  it('keeps the legacy shape without an agent id: peers only, matched by name', () => {
    const section = buildPeerContextSection(responses, '小思');

    expect(section).toContain("# This Round's Context");
    expect(section).toContain('- 林老师: "Not quite: the energy moves elsewhere."');
    expect(section).not.toContain('I think the waves just disappear.');
    expect(section).not.toContain('# What you already said');
    expect(section).not.toContain('take that up first');
    expect(buildPeerContextSection([responses[0]!], '小思')).toBe('');
  });

  it('reminds an agent of its own earlier lines so it keeps its stance', () => {
    const section = buildPeerContextSection(responses, '小思', {
      currentAgentId: 'student-1',
      currentAgentRole: 'student',
    });

    expect(section).toContain('# What you already said in this session');
    expect(section).toContain('- "I think the waves just disappear."');
    expect(section).toContain('- "Oh, so it goes to the bright spots?"');
    expect(section).toContain('change your mind only when someone has just given you a reason');
    // A student is not asked to correct the others
    expect(section).not.toContain('take that up first');
    // Own lines only: nobody else spoke yet
    const alone = buildPeerContextSection([responses[0]!], '小思', { currentAgentId: 'student-1' });
    expect(alone).not.toContain("# This Round's Context");
    expect(alone).toContain('# What you already said in this session');
  });

  it("has the teacher and assistant take up a peer's inaccurate or open point first", () => {
    for (const role of ['teacher', 'assistant']) {
      const section = buildPeerContextSection(responses, '林老师', {
        currentAgentId: 'teacher-1',
        currentAgentRole: role,
      });
      expect(section).toContain(
        "6. If a previous speaker's point was inaccurate or left open, take that up first",
      );
      expect(section).toContain('- 小思: "I think the waves just disappear."');
    }
  });
});
