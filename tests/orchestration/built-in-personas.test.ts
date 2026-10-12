/**
 * The built-in agents are real people too: personas that describe a person
 * (not instructions, not formatting rules, not a schedule), for any subject,
 * and a class that passes the same checks as a generated one.
 */
import { describe, expect, it } from 'vitest';

import { validateRoster } from '@/lib/orchestration/persona-guide';
import { BUILT_IN_AGENTS, getDefaultAgents } from '@/lib/orchestration/registry/built-in';

const agents = Object.values(BUILT_IN_AGENTS);

describe('the built-in personas', () => {
  it('keep their ids, names and roles', () => {
    expect(agents.map((agent) => [agent.id, agent.name, agent.role])).toEqual([
      ['default-1', 'AI teacher', 'teacher'],
      ['default-2', 'AI助教', 'assistant'],
      ['default-3', '显眼包', 'student'],
      ['default-4', '好奇宝宝', 'student'],
      ['default-5', '笔记员', 'student'],
      ['default-6', '思考者', 'student'],
    ]);
  });

  it('make a class that passes the checks a generated class does', () => {
    const result = validateRoster(agents);
    expect(result.issues).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it.each(agents.map((agent) => [agent.id, agent.persona] as const))(
    '%s describes a person, not rules for one',
    (_id, persona) => {
      expect(persona).not.toMatch(/\bYou\b|\byou are\b/);
      expect(persona).not.toMatch(/\n|markdown|bold|bullet|numbered|header/i);
      expect(persona).not.toMatch(/ahead of the current topic|pulling the discussion forward/);
      expect(persona).not.toMatch(/whiteboard|spotlight|laser/i);
      const sentences = persona.split(/(?<=[.!?])\s+(?=[A-Z])/);
      expect(sentences.length).toBeGreaterThanOrEqual(3);
      expect(sentences.length).toBeLessThanOrEqual(5);
    },
  );

  it('reach the generation pipeline as they are', () => {
    expect(getDefaultAgents().map((agent) => agent.persona)).toEqual(
      agents.map((agent) => agent.persona),
    );
  });
});
