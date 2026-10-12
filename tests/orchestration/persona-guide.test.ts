/**
 * The one persona guide and the checks every roster a model writes passes:
 * what code can judge for sure (roles, one teacher, names, persona length)
 * refuses a roster; how alike two students read only warns.
 */
import { describe, expect, it } from 'vitest';

import {
  AUTO_AGENT_COUNT_MAX,
  AUTO_AGENT_COUNT_MIN,
  CLASS_ATMOSPHERES,
  describeClassAtmosphere,
  formatRosterIssues,
  isClassAtmosphere,
  normalizeRosterRole,
  PERSONA_GUIDE,
  PERSONA_MAX_CHARS,
  PERSONA_MIN_CHARS,
  personaSimilarity,
  validateRoster,
} from '@/lib/orchestration/persona-guide';
import { PI_REQUEST_BOUNDS } from '@/lib/types/chat';

const teacher = {
  name: '王老师',
  role: 'teacher',
  persona:
    '王老师四十来岁，说话慢条斯理。讲课喜欢先抛一个生活里的问题，再请同学们猜一猜；答错了也不急。',
};
const student = (name: string, persona: string) => ({ name, role: 'student', persona });
const SI = '小思是个安静的女生，基础扎实但不太自信。只有被点到或很有把握时才开口，常把正负号弄混。';
const WEN =
  '小问精力旺盛，一听到出乎意料的结果就脱口问“为什么”。他反应快，但常常没想清楚就先说出来。';

describe('the persona guide', () => {
  it('describes a real person in five elements, never a script or a quota', () => {
    expect(PERSONA_GUIDE).toContain('believable PERSON, not a script');
    expect(PERSONA_GUIDE).toContain('no quota of how often they speak');
    expect(PERSONA_GUIDE).toContain('plain prose (no lists, no markdown)');
    for (const element of [
      'temperament',
      'how they talk',
      'what they already know and do not know yet',
      'what makes them speak up',
      'for the teacher: how they teach',
    ]) {
      expect(PERSONA_GUIDE).toContain(element);
    }
  });

  it('keeps a persona within what a request carries', () => {
    expect(PERSONA_MIN_CHARS).toBeLessThan(PERSONA_MAX_CHARS);
    expect(PERSONA_MAX_CHARS).toBeLessThanOrEqual(PI_REQUEST_BOUNDS.personaMaxChars);
  });
});

describe('a role as written', () => {
  it.each([
    ['teacher', 'teacher'],
    [' Teacher ', 'teacher'],
    ['老师', 'teacher'],
    ['教师', 'teacher'],
    ['老師', 'teacher'],
    ['assistant', 'assistant'],
    ['TA', 'assistant'],
    ['Teaching  Assistant', 'assistant'],
    ['助教', 'assistant'],
    ['student', 'student'],
    ['学生', 'student'],
    ['同学', 'student'],
  ])('reads %j as %s', (role, expected) => {
    expect(normalizeRosterRole(role)).toBe(expected);
  });

  it('has no place for anything else', () => {
    expect(normalizeRosterRole('janitor')).toBeUndefined();
    expect(normalizeRosterRole('')).toBeUndefined();
    expect(normalizeRosterRole('constructor')).toBeUndefined();
    expect(normalizeRosterRole(undefined as unknown as string)).toBeUndefined();
  });
});

describe('checking a roster', () => {
  it('accepts a class of real people, with the roles normalized', () => {
    const result = validateRoster([
      { ...teacher, role: '老师', extra: 1 },
      { ...student('小思', SI), role: '学生', extra: 2 },
      { ...student('小问', WEN), extra: 3 },
    ]);
    expect(result).toMatchObject({ ok: true, issues: [], warnings: [] });
    expect(result.agents.map((agent) => [agent.role, agent.extra])).toEqual([
      ['teacher', 1],
      ['student', 2],
      ['student', 3],
    ]);
  });

  it('lists every problem, by agent', () => {
    const result = validateRoster([
      { name: 'A', role: 'teacher', persona: 'x'.repeat(PERSONA_MAX_CHARS + 1) },
      { name: 'B', role: 'teacher', persona: teacher.persona },
      { name: ' a ', role: 'janitor', persona: '' },
      { name: '', role: 'student', persona: 'Too short.' },
    ]);
    expect(result.ok).toBe(false);
    expect(result.issues.map(({ code, agentIndex }) => [code, agentIndex])).toEqual([
      ['unknown-role', 2],
      ['teacher-count', undefined],
      ['duplicate-name', 2],
      ['empty-name', 3],
      ['persona-too-long', 0],
      ['empty-persona', 2],
      ['persona-too-short', 3],
    ]);
    // An agent of an unknown role is listed as a student; the roster is not ok.
    expect(result.agents[2]!.role).toBe('student');
    expect(formatRosterIssues(result.issues).split('\n')).toEqual([
      '- Agent 3 ("a") has the role "janitor"; a role is "teacher", "assistant" or "student".',
      '- The class needs exactly 1 teacher; there are 2 ("A", "B").',
      '- Agent 3 ("a") has the same name as agent 1; every person in the class has their own name.',
      '- Agent 4 has no name.',
      `- Agent 1 ("A")'s persona is ${PERSONA_MAX_CHARS + 1} characters; keep it to 3-5 sentences (at most ${PERSONA_MAX_CHARS} characters).`,
      '- Agent 3 ("a") has no persona.',
      `- Agent 4's persona is 10 characters; describe the person in 3-5 sentences (at least ${PERSONA_MIN_CHARS} characters).`,
    ]);
  });

  it('needs a teacher and enough people', () => {
    expect(validateRoster([student('小思', SI), student('小问', WEN)]).issues).toEqual([
      { code: 'teacher-count', message: 'The class needs exactly 1 teacher; there is none.' },
    ]);
    expect(validateRoster([teacher]).issues.map((issue) => issue.code)).toEqual(['too-few-agents']);
    expect(
      validateRoster([teacher, student('小思', SI)], { minAgents: 3 }).issues[0],
    ).toMatchObject({ code: 'too-few-agents', message: expect.stringContaining('at least 3') });
  });

  it('counts persona length in characters, not UTF-16 units', () => {
    const emoji = '😀'.repeat(PERSONA_MIN_CHARS);
    expect(validateRoster([{ ...teacher, persona: emoji }, student('小思', SI)]).ok).toBe(true);
  });

  it('only warns when two students read almost the same', () => {
    const twin = WEN.replace('小问', '小文');
    const result = validateRoster([teacher, student('小问', WEN), student('小文', twin)]);
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.warnings).toEqual([
      {
        code: 'similar-students',
        agentIndex: 2,
        message:
          'Agent 3 ("小文") reads almost like Agent 2 ("小问"); students in a real class differ.',
      },
    ]);
  });

  it('measures likeness by character pairs', () => {
    expect(personaSimilarity(SI, SI)).toBe(1);
    expect(personaSimilarity(SI, WEN)).toBeLessThan(0.3);
    expect(personaSimilarity('', SI)).toBe(0);
  });
});

describe('the class the learner chose', () => {
  it('has sizes from a teacher and one more up to a full room', () => {
    expect(AUTO_AGENT_COUNT_MIN).toBe(2);
    expect(AUTO_AGENT_COUNT_MAX).toBeGreaterThan(AUTO_AGENT_COUNT_MIN);
  });

  it('is described by its people, never by how often they speak', () => {
    expect(CLASS_ATMOSPHERES).toEqual(['focused', 'conversational', 'lively']);
    for (const atmosphere of CLASS_ATMOSPHERES) {
      expect(isClassAtmosphere(atmosphere)).toBe(true);
      const text = describeClassAtmosphere(atmosphere);
      expect(text).toContain('each still has their own temperament and level');
      expect(text).not.toMatch(/\d|\btimes\b|per page|every page/);
    }
    expect(describeClassAtmosphere('lively')).toContain('more of the students are outgoing');
    expect(isClassAtmosphere('noisy')).toBe(false);
    expect(isClassAtmosphere(undefined)).toBe(false);
  });
});
