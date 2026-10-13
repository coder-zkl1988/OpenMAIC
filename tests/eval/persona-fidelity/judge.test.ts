/**
 * The persona fidelity judge (I26) without a real model: its prompts carry
 * the bias guards, what it reads is shuffled and keyed so position and names
 * cannot leak, and an answer it gets wrong is reported as unusable instead
 * of being coerced into a score. The judge calls run against a mock model.
 */
import { describe, expect, it } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import {
  BOUNDARY_JUDGE_SYSTEM,
  PERSONA_JUDGE_SYSTEM,
  SPEAKER_JUDGE_SYSTEM,
  buildBoundaryJudgePrompt,
  buildPersonaJudgePrompt,
  buildSpeakerJudgePrompt,
  extractJsonObject,
  judgeBoundary,
  judgeRoster,
  judgeSpeaker,
  keyPersonas,
  letterRoster,
  parseBoundaryVerdict,
  parseRosterVerdict,
  parseSpeakerVerdict,
} from '@/eval/persona-fidelity/judge';

const roster = [
  { id: 't', name: '林老师', role: 'teacher', persona: '林老师教了十多年物理，说话慢条斯理。' },
  { id: 'a', name: '小禾', role: 'assistant', persona: '小禾是热心的助教，爱举生活里的例子。' },
  { id: 's1', name: '小思', role: 'student', persona: '小思安静，常把相位和振幅弄混。' },
  { id: 's2', name: '阿杰', role: 'student', persona: '阿杰话多，爱抢答，常常想当然。' },
];

/** A mock model that answers every call with `reply(promptText)` */
function mockModel(reply: (prompt: string) => string) {
  return new MockLanguageModelV3({
    doGenerate: async (options) => {
      const prompt = options.prompt
        .flatMap((message) =>
          Array.isArray(message.content)
            ? message.content.map((part) => ('text' in part ? part.text : ''))
            : [message.content],
        )
        .join('\n');
      return {
        content: [{ type: 'text', text: reply(prompt) }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: {
          inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 0, text: 0, reasoning: 0 },
        },
        warnings: [],
      };
    },
  });
}

function personaEntry(key: string, overrides: Record<string, unknown> = {}) {
  return {
    key,
    elements: {
      temperament: true,
      speech: true,
      knowledge: true,
      speaks_up: false,
      misconception: true,
      teaching: true,
    },
    real_person: 4,
    caricature: 1,
    script_like: false,
    ...overrides,
  };
}

describe('extractJsonObject', () => {
  it('finds the object inside fences and chatter, and nothing else', () => {
    expect(extractJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJsonObject('Sure! {"a": {"b": 2}} Hope this helps.')).toEqual({ a: { b: 2 } });
    expect(extractJsonObject('[1, 2]')).toBeUndefined();
    expect(extractJsonObject('{not json}')).toBeUndefined();
    expect(extractJsonObject('')).toBeUndefined();
  });
});

describe('persona judge', () => {
  it('states the bias guards in its rubric', () => {
    expect(PERSONA_JUDGE_SYSTEM).toContain('Vivid, quirky or extreme is NOT more real');
    expect(PERSONA_JUDGE_SYSTEM).toContain('Length is not quality');
    expect(PERSONA_JUDGE_SYSTEM).toContain('the order is random');
    expect(PERSONA_JUDGE_SYSTEM).toContain('caricature, 1-5');
  });

  it('keys the personas in a seed-dependent order, remembering their place', () => {
    const keyed = keyPersonas(roster, 'seed');
    expect(keyed.map(({ key }) => key)).toEqual(['P1', 'P2', 'P3', 'P4']);
    expect(keyed.map(({ index }) => index).sort()).toEqual([0, 1, 2, 3]);
    expect(keyPersonas(roster, 'seed')).toEqual(keyed);
    for (const persona of keyed) expect(persona.name).toBe(roster[persona.index]!.name);
    const prompt = buildPersonaJudgePrompt({ name: '机械波', description: '高一物理' }, keyed);
    expect(prompt).toContain('Course: 机械波 — 高一物理');
    for (const persona of keyed) {
      expect(prompt).toContain(`${persona.key} — ${persona.name} (role: ${persona.role}):`);
    }
  });

  it('reads verdicts back in roster order, with role-bound elements only where they apply', () => {
    const keyed = keyPersonas(roster, 'seed');
    const text = JSON.stringify({
      personas: keyed.map(({ key, index }) => personaEntry(key, { real_person: index + 1 })),
      students_distinct: 'true',
      reason: 'ok',
    });
    const verdict = parseRosterVerdict(text, keyed);
    expect(verdict.error).toBeUndefined();
    expect(verdict.personas.map(({ name, realPerson }) => [name, realPerson])).toEqual([
      ['林老师', 1],
      ['小禾', 2],
      ['小思', 3],
      ['阿杰', 4],
    ]);
    expect(verdict.personas[0]!.elements).toMatchObject({ misconception: null, teaching: true });
    expect(verdict.personas[1]!.elements).toMatchObject({ misconception: null, teaching: null });
    expect(verdict.personas[2]!.elements).toMatchObject({ misconception: true, teaching: null });
    expect(verdict.studentsDistinct).toBe(true);
    expect(verdict.reason).toBe('ok');
  });

  it('reports an answer it cannot trust instead of scoring it', () => {
    const keyed = keyPersonas(roster.slice(0, 2), 'seed');
    const answer = (entries: unknown[]) => JSON.stringify({ personas: entries });
    expect(parseRosterVerdict('no json', keyed).error).toContain('No personas array');
    expect(parseRosterVerdict(answer([personaEntry('P1')]), keyed).error).toContain(
      'No verdict for P2',
    );
    expect(
      parseRosterVerdict(
        answer([personaEntry('P1'), personaEntry('P2', { real_person: 6 })]),
        keyed,
      ).error,
    ).toContain('Malformed verdict for P2');
    expect(
      parseRosterVerdict(
        answer([personaEntry('P1'), personaEntry('P2', { script_like: 'maybe' })]),
        keyed,
      ).error,
    ).toContain('Malformed');
    // Numeric strings are fine; fewer than two students: no distinctness verdict
    const fine = parseRosterVerdict(
      answer([personaEntry('P1', { real_person: '5' }), personaEntry('P2')]),
      keyed,
    );
    expect(fine.error).toBeUndefined();
    expect(fine.studentsDistinct).toBeNull();
  });

  it('judges a roster through the model, returning roster order', async () => {
    let seenPrompt = '';
    const model = mockModel((prompt) => {
      seenPrompt = prompt;
      // Rate each persona by the key it was shown under, from the prompt itself
      const keys = Array.from(prompt.matchAll(/(P\d+) — (\S+) \(role/g));
      return JSON.stringify({
        personas: keys.map(([, key, name]) =>
          personaEntry(key!, { caricature: name === '阿杰' ? 3 : 1 }),
        ),
        students_distinct: true,
        reason: '',
      });
    });
    const verdict = await judgeRoster(model, { name: '机械波' }, roster, 'seed');
    expect(seenPrompt).toContain('Vivid, quirky or extreme is NOT more real');
    expect(verdict.personas.map(({ name, caricature }) => [name, caricature])).toEqual([
      ['林老师', 1],
      ['小禾', 1],
      ['小思', 1],
      ['阿杰', 3],
    ]);
  });

  it('turns a failed call into an unusable verdict', async () => {
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        throw new Error('rate limited');
      },
    });
    const verdict = await judgeRoster(model, { name: 'x' }, roster, 'seed');
    expect(verdict).toMatchObject({ personas: [], error: expect.stringContaining('rate limited') });
  });
});

describe('speaker judge', () => {
  it('shows the roster under letters in a seed-dependent order', () => {
    const people = letterRoster(roster, 'line-1');
    expect(people.map(({ letter }) => letter)).toEqual(['A', 'B', 'C', 'D']);
    expect(people.map(({ id }) => id).sort()).toEqual(['a', 's1', 's2', 't']);
    const prompt = buildSpeakerJudgePrompt({ people, learnerText: '为什么？', line: '我猜是……' });
    for (const person of people) {
      expect(prompt).toContain(`${person.letter}. ${person.name} (${person.role}):`);
    }
    expect(prompt).toContain('The learner had just said: "为什么？"');
    expect(prompt).toContain('The line: "我猜是……"');
    expect(buildSpeakerJudgePrompt({ people, learnerText: ' ', line: 'x' })).toContain(
      'the learner had not spoken yet',
    );
    expect(SPEAKER_JUDGE_SYSTEM).toContain('replaced by [NAME]');
    expect(SPEAKER_JUDGE_SYSTEM).toContain('"unsure"');
  });

  it('maps the letter back to the agent, and refuses anything else', () => {
    const people = [
      { letter: 'A', id: 's2' },
      { letter: 'B', id: 't' },
    ];
    expect(parseSpeakerVerdict('{"speaker":"B","confidence":4,"reason":"r"}', people)).toEqual({
      picked: 't',
      confidence: 4,
      reason: 'r',
    });
    expect(parseSpeakerVerdict('{"speaker":"a."}', people).picked).toBe('s2');
    expect(parseSpeakerVerdict('{"speaker":"Unsure"}', people).picked).toBe('unsure');
    expect(parseSpeakerVerdict('{"speaker":"C"}', people)).toMatchObject({
      error: expect.stringContaining('Unknown speaker'),
    });
    expect(parseSpeakerVerdict('{"speaker":"阿杰"}', people).picked).toBeUndefined();
    expect(parseSpeakerVerdict('{"who":"A"}', people).error).toContain('No speaker');
  });

  it('judges a line through the model', async () => {
    const model = mockModel((prompt) => {
      const letter = /([A-D])\. 小思 \(student\)/.exec(prompt)?.[1];
      return JSON.stringify({ speaker: letter, confidence: 3, reason: 'shy and unsure' });
    });
    const verdict = await judgeSpeaker(model, {
      roster,
      learnerText: '[NAME]，你觉得呢？',
      line: '我……我不太确定，是振幅不一样吗？',
      seed: 'p#0#1',
    });
    expect(verdict).toMatchObject({ picked: 's1', confidence: 3 });
  });
});

describe('boundary judge', () => {
  const turns = [
    { agentId: 't', name: '林老师', role: 'teacher', text: '好问题。' },
    { agentId: 's1', name: '小思', role: 'student', text: '是驻波吗？' },
  ];

  it('lists taught and upcoming pages and numbers the turns', () => {
    const prompt = buildBoundaryJudgePrompt({
      taught: [{ title: '干涉', keyPoints: ['加强与减弱'] }],
      currentNarration: '两列相同的波相遇……',
      upcoming: [{ title: '驻波', keyPoints: ['波节与波腹'] }],
      learnerText: '吉他弦为什么有的点不动？',
      turns,
    });
    expect(prompt).toContain('Taught so far:\n- 干涉: 加强与减弱');
    expect(prompt).toContain('(Just said on the current page: 两列相同的波相遇……)');
    expect(prompt).toContain('Not taught yet:\n- 驻波: 波节与波腹');
    expect(prompt).toContain('1. 林老师 (teacher): 好问题。\n2. 小思 (student): 是驻波吗？');
    expect(
      buildBoundaryJudgePrompt({ taught: [], upcoming: [], learnerText: 'x', turns }),
    ).toContain('Not taught yet:\n- (nothing)');
    expect(BOUNDARY_JUDGE_SYSTEM).toContain('student_wrong');
  });

  it('turns 1-based turn numbers into indexes, dropping what is out of range', () => {
    expect(
      parseBoundaryVerdict(
        '{"untaught":[2,"2",9],"student_lectures":[],"assistant_takes_over":[0],"student_wrong":[2,1],"reason":"r"}',
        2,
      ),
    ).toEqual({
      untaught: [1],
      studentLectures: [],
      assistantTakeover: [],
      studentWrong: [0, 1],
      reason: 'r',
    });
    expect(parseBoundaryVerdict('{"untaught":[]}', 2).error).toContain('Missing list');
    expect(parseBoundaryVerdict('nope', 2).error).toContain('Unparseable');
  });

  it('judges an exchange through the model', async () => {
    const model = mockModel(() =>
      JSON.stringify({
        untaught: [2],
        student_lectures: [],
        assistant_takes_over: [],
        student_wrong: [2],
        reason: '',
      }),
    );
    expect(
      await judgeBoundary(model, { taught: [], upcoming: [], learnerText: 'x', turns }),
    ).toMatchObject({ untaught: [1], studentWrong: [1] });
  });
});
