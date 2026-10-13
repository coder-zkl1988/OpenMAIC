/**
 * The persona fidelity eval's deterministic core (I26): persona checks,
 * anonymization, cognitive-boundary proxies, aggregation, the judge-vendor
 * guard, the judge's calibration and the baseline comparison.
 */
import { describe, expect, it } from 'vitest';
import {
  anonymize,
  checkCalibration,
  checkPersona,
  checkRoster,
  compareVendors,
  containsTerm,
  detectBoundary,
  elementCoverage,
  findFidelityRegressions,
  flattenFidelityMetrics,
  isBelievable,
  judgedBoundary,
  modelVendor,
  nameVariants,
  pearson,
  scriptShares,
  seededShuffle,
  speechUnits,
  summarizeBoundary,
  summarizeGeneration,
  summarizeSpeakerId,
  type ClassroomRun,
  type PersonaFidelitySummary,
  type PersonaVerdict,
  type TranscriptTurn,
} from '@/eval/persona-fidelity/checks';

const PERSONA =
  '小思是班里比较安静的女生，物理成绩中等偏下，常把相位和振幅弄混。她只有在真的想不通时才小声发问，被点到时会先说“我不太确定”。';

function verdict(overrides: Partial<PersonaVerdict> = {}): PersonaVerdict {
  return {
    name: 'X',
    role: 'student',
    chars: 80,
    elements: {
      temperament: true,
      speech: true,
      knowledge: true,
      speaksUp: true,
      misconception: true,
      teaching: null,
    },
    realPerson: 4,
    caricature: 1,
    scriptLike: false,
    ...overrides,
  };
}

describe('text helpers', () => {
  it('matches CJK terms anywhere and Latin terms as whole words, ignoring case', () => {
    expect(containsTerm('那是不是驻波呀', '驻波')).toBe(true);
    expect(containsTerm('use DEF to define it', 'def')).toBe(true);
    expect(containsTerm('the default value', 'def')).toBe(false);
    expect(containsTerm('for i in range(5):', 'range(')).toBe(true);
    expect(containsTerm('a wide range of', 'range(')).toBe(false);
    expect(containsTerm('anything', '  ')).toBe(false);
  });

  it('counts speech in Chinese-character units (a Latin word is two)', () => {
    expect(speechUnits('因为步调相反。')).toBe(6);
    expect(speechUnits("for x in scores, it's the item")).toBe(14);
    expect(speechUnits('')).toBe(0);
  });

  it('measures the share of Han and Latin letters', () => {
    expect(scriptShares('小思 is')).toEqual({ han: 0.5, latin: 0.5 });
    expect(scriptShares('123 ！')).toEqual({ han: 0, latin: 0 });
  });
});

describe('checkPersona', () => {
  it('flags schedule, quota and task wording, but not a person’s habits', () => {
    const scripted = checkPersona(
      {
        name: '李明',
        role: 'student',
        persona: '李明负责在第3页提出问题，每节课至少发言3次。',
      },
      {},
    );
    expect(scripted.scriptMarkers).toEqual(['responsible-for', 'page-schedule', 'quota']);
    expect(
      checkPersona(
        { name: 'Leo', role: 'student', persona: 'Leo is in charge of the demo on slide 4.' },
        {},
      ).scriptMarkers,
    ).toEqual(['responsible-for', 'page-schedule']);
    expect(
      checkPersona({ name: '小思', role: 'student', persona: PERSONA }, {}).scriptMarkers,
    ).toEqual([]);
  });

  it('flags list markup, leaked private details and the wrong language', () => {
    const check = checkPersona(
      { name: 'Tom', role: 'student', persona: '- Lives in Leeds\n- Loves maths' },
      { privateTerms: ['Leeds', 'nurse'], expectScript: 'han' },
    );
    expect(check).toMatchObject({
      listMarkup: true,
      leakedTerms: ['Leeds'],
      scriptMismatch: true,
    });
    expect(
      checkPersona({ name: '小思', role: 'student', persona: PERSONA }, { expectScript: 'han' })
        .scriptMismatch,
    ).toBe(false);
    expect(
      checkPersona({ name: '小思', role: 'student', persona: PERSONA }, { expectScript: 'latin' })
        .scriptMismatch,
    ).toBe(true);
  });
});

describe('checkRoster', () => {
  const teacher = { name: '林老师', role: '老师', persona: `林老师${PERSONA}` };
  const student = { name: '小思', role: 'student', persona: PERSONA };
  const other = {
    name: '阿杰',
    role: '学生',
    persona:
      '阿杰话多，反应快，爱抢答，物理不错但常常想当然，以为两列波相遇时会像小球一样撞开。被纠正时他会再追问一句。',
  };

  it('normalizes roles, counts them and passes a sound roster', () => {
    const check = checkRoster([teacher, student, other], {});
    expect(check).toMatchObject({
      valid: true,
      issueCodes: [],
      counts: { teacher: 1, assistant: 0, student: 2 },
    });
    expect(check.maxStudentSimilarity).toBeGreaterThan(0);
    expect(check.maxStudentSimilarity).toBeLessThan(0.6);
  });

  it('fails a roster with two teachers and does not count an unknown role', () => {
    const check = checkRoster(
      [teacher, { ...teacher, name: '王老师' }, { ...student, role: 'janitor' }],
      {},
    );
    expect(check.valid).toBe(false);
    expect(check.issueCodes).toEqual(expect.arrayContaining(['teacher-count', 'unknown-role']));
    expect(check.counts).toEqual({ teacher: 2, assistant: 0, student: 0 });
  });
});

describe('judge verdict helpers', () => {
  it('reads coverage over the elements that apply to the role', () => {
    expect(elementCoverage(verdict())).toBe(1);
    expect(
      elementCoverage(
        verdict({
          role: 'assistant',
          elements: {
            temperament: true,
            speech: false,
            knowledge: true,
            speaksUp: false,
            misconception: null,
            teaching: null,
          },
        }),
      ),
    ).toBe(0.5);
  });

  it('calls a persona believable only when real and not a caricature', () => {
    expect(isBelievable(verdict())).toBe(true);
    expect(isBelievable(verdict({ realPerson: 3 }))).toBe(false);
    expect(isBelievable(verdict({ caricature: 3 }))).toBe(false);
  });
});

describe('checkCalibration (the judge’s bias guard)', () => {
  const good = {
    plain: verdict({ realPerson: 5, caricature: 1 }),
    caricature: verdict({ realPerson: 2, caricature: 5 }),
    script: verdict({ realPerson: 1, caricature: 2, scriptLike: true }),
  };

  it('passes a judge that ranks the ordinary student above the stereotype and the schedule', () => {
    expect(checkCalibration(good)).toEqual({ passed: true, failures: [] });
  });

  it('fails a judge that finds the stereotype as real, or misses the schedule', () => {
    const fooled = checkCalibration({
      ...good,
      caricature: verdict({ realPerson: 5, caricature: 5 }),
    });
    expect(fooled.passed).toBe(false);
    expect(fooled.failures).toEqual([expect.stringContaining('stereotype looked as real')]);

    const blind = checkCalibration({
      ...good,
      script: verdict({ realPerson: 5, scriptLike: false }),
    });
    expect(blind.failures).toEqual([
      expect.stringContaining('not flagged as a script'),
      expect.stringContaining('schedule looked as real'),
    ]);
    expect(checkCalibration({ plain: good.plain }).passed).toBe(false);
  });
});

describe('summarizeGeneration', () => {
  it('reports deterministic rates over samples and the judge’s scores', () => {
    const roster = checkRoster(
      [
        { name: '林老师', role: 'teacher', persona: `林老师${PERSONA}` },
        { name: '小思', role: 'student', persona: PERSONA },
        { name: '李明', role: 'student', persona: `李明负责在第3页提问，住在杭州。${PERSONA}` },
      ],
      { privateTerms: ['杭州'] },
    );
    const summary = summarizeGeneration('waves', [
      {
        ok: true,
        check: roster,
        verdict: {
          personas: [
            verdict({ role: 'teacher', chars: 100, realPerson: 5, caricature: 1 }),
            verdict({ chars: 60, realPerson: 4, caricature: 1 }),
            verdict({ chars: 80, realPerson: 2, caricature: 2, scriptLike: true }),
          ],
          studentsDistinct: true,
          reason: '',
        },
      },
      { ok: false, error: 'refused' },
      {
        ok: true,
        check: roster,
        verdict: { personas: [], studentsDistinct: null, reason: '', error: 'x' },
      },
    ]);
    expect(summary).toMatchObject({
      samples: 3,
      errors: 1,
      validRate: 0.667,
      meanAgents: 3,
      meanCounts: { teacher: 1, assistant: 0, student: 2 },
      scriptMarkerRate: 0.333,
      leakRate: 1,
      judge: {
        judgedRosters: 1,
        judgeErrors: 1,
        realPersonMean: 3.667,
        caricatureMean: 1.333,
        believableRate: 0.667,
        scriptLikeRate: 0.333,
        studentsDistinctRate: 1,
      },
    });
    expect(summary.judge?.lengthBias).toBeCloseTo(0.327, 3);
  });

  it('has no judge block when nothing was judged', () => {
    expect(summarizeGeneration('x', [{ ok: false, error: 'e' }]).judge).toBeUndefined();
  });
});

describe('pearson', () => {
  it('is 1 for a perfect line and null without enough points or variance', () => {
    expect(pearson([1, 2, 3], [2, 4, 6])).toBe(1);
    expect(pearson([1, 2, 3], [3, 2, 1])).toBe(-1);
    expect(pearson([1, 2], [1, 2])).toBeNull();
    expect(pearson([1, 2, 3], [5, 5, 5])).toBeNull();
  });
});

describe('anonymize', () => {
  it('replaces every name, longest first, and the words of a Latin name', () => {
    expect(nameVariants('Ms. Rivera')).toEqual(['Ms. Rivera']);
    expect(nameVariants('Anna Lee Smith')).toEqual(['Anna Lee Smith', 'Anna', 'Lee', 'Smith']);
    expect(anonymize('小思远和小思都说林老师讲得好', ['小思', '小思远', '林老师'])).toBe(
      '[NAME]和[NAME]都说[NAME]讲得好',
    );
    expect(anonymize('I agree with leo, Ms. Rivera.', ['Leo', 'Ms. Rivera'])).toBe(
      'I agree with [NAME], [NAME].',
    );
    // Whole words only for Latin names
    expect(anonymize('Leonard said so', ['Leo'])).toBe('Leonard said so');
  });
});

describe('summarizeSpeakerId', () => {
  const roles = { t: 'teacher', a: 'assistant', s1: 'student', s2: 'student' };

  it('scores against chance, by role and among students only', () => {
    const summary = summarizeSpeakerId({
      courseId: 'c',
      roles,
      lines: 8,
      tooShort: 2,
      judgments: [
        { promptId: 'p', turnIndex: 0, trueAgentId: 't', picked: 't' },
        { promptId: 'p', turnIndex: 1, trueAgentId: 's1', picked: 's1' },
        { promptId: 'p', turnIndex: 2, trueAgentId: 's1', picked: 's2' },
        { promptId: 'p', turnIndex: 3, trueAgentId: 's2', picked: 'unsure' },
        { promptId: 'p', turnIndex: 4, trueAgentId: 'a', picked: 't' },
        { promptId: 'p', turnIndex: 5, trueAgentId: 'a', error: 'unparseable' },
      ],
      rosterCaricatureMean: 1.5,
    });
    expect(summary).toMatchObject({
      lines: 8,
      tooShort: 2,
      judged: 6,
      errors: 1,
      accuracy: 0.4,
      chance: 0.25,
      roleAccuracy: 0.6,
      unsureRate: 0.2,
      studentWithinRoleAccuracy: 0.5,
      studentChance: 0.5,
      rosterCaricatureMean: 1.5,
    });
    expect(summary.confusion).toEqual({
      t: { t: 1 },
      s1: { s1: 1, s2: 1 },
      s2: { unsure: 1 },
      a: { t: 1 },
    });
    expect(summary.perAgent.s1).toEqual({ lines: 2, correct: 1 });
  });
});

describe('cognitive boundary', () => {
  const turn = (agentId: string, role: string, text: string): TranscriptTurn => ({
    agentId,
    name: agentId,
    role,
    text,
  });
  const run = (turns: TranscriptTurn[], overrides: Partial<ClassroomRun> = {}): ClassroomRun => ({
    courseId: 'waves',
    promptId: 'p',
    sample: 0,
    learnerText: '吉他弦上为什么有的点不动？',
    addressedAgentIds: [],
    aside: false,
    rosterRoles: ['teacher', 'assistant', 'student', 'student'],
    turns,
    terminal: 'cue_user',
    ...overrides,
  });
  const context = { upcomingTerms: ['驻波', '波节'], taughtText: '干涉\n加强与减弱' };

  it('flags a student using an untaught term nobody brought up', () => {
    expect(detectBoundary(run([turn('s1', 'student', '那是驻波吧？')]), context).untaught).toEqual([
      0,
    ]);
    // The teacher previewed it first: the student only echoes
    expect(
      detectBoundary(
        run([turn('t', 'teacher', '这叫驻波，后面会讲。'), turn('s1', 'student', '哦，驻波！')]),
        context,
      ).untaught,
    ).toEqual([]);
    // The learner said it
    expect(
      detectBoundary(
        run([turn('s1', 'student', '驻波是什么？')], { learnerText: '驻波是什么？' }),
        context,
      ).untaught,
    ).toEqual([]);
  });

  it('flags a student lecturing at length', () => {
    const long = '因为'.repeat(70);
    expect(detectBoundary(run([turn('s1', 'student', long)]), context).studentLectures).toEqual([
      0,
    ]);
    expect(detectBoundary(run([turn('t', 'teacher', long)]), context).studentLectures).toEqual([]);
  });

  it('flags an unaddressed assistant who says more than the teacher', () => {
    const takeover = run([
      turn('t', 'teacher', '好问题。'),
      turn('a', 'assistant', '我来系统讲一下这一页和下一页的全部内容，先从定义开始。'),
    ]);
    expect(detectBoundary(takeover, context).assistantTakeover).toEqual([1]);
    expect(
      detectBoundary({ ...takeover, addressedAgentIds: ['a'] }, context).assistantTakeover,
    ).toEqual([]);
    expect(detectBoundary({ ...takeover, aside: true }, context).assistantTakeover).toEqual([]);
    expect(
      detectBoundary({ ...takeover, rosterRoles: ['assistant'] }, context).assistantTakeover,
    ).toEqual([]);
  });

  it('flags a student having the last word without asking the learner', () => {
    const last = run([
      turn('t', 'teacher', '你们觉得呢？'),
      turn('s1', 'student', '是不是方向相反？'),
    ]);
    expect(detectBoundary(last, context).wrongUnanswered).toEqual([1]);
    expect(detectBoundary({ ...last, cuePrompt: '你觉得呢？' }, context).wrongUnanswered).toEqual(
      [],
    );
    expect(detectBoundary({ ...last, aside: true }, context).wrongUnanswered).toEqual([]);
  });

  it('keeps judge flags on the right roles and counts only unanswered wrong lines', () => {
    const exchange = run([
      turn('s1', 'student', '是振幅不一样吧？'),
      turn('t', 'teacher', '不完全对，关键是步调。'),
      turn('s2', 'student', '那就是驻波！'),
      turn('a', 'assistant', '我们直接讲下一页吧。'),
      turn('s1', 'student', '所以永远抵消？'),
    ]);
    expect(
      judgedBoundary(exchange, {
        untaught: [2, 1],
        studentLectures: [1],
        assistantTakeover: [3, 0],
        studentWrong: [0, 2, 4, 4],
        reason: '',
      }),
    ).toEqual({
      untaught: [2],
      studentLectures: [],
      assistantTakeover: [3],
      // 0 and 2 were taken up by the teacher / assistant after them; 4 was not
      wrongUnanswered: [4],
    });
  });

  it('summarizes runs with a flag, by proxy and by the judge', () => {
    const a = run([turn('s1', 'student', '驻波！')]);
    const summary = summarizeBoundary('waves', [
      {
        run: a,
        det: detectBoundary(a, context),
        judged: { untaught: [0], studentLectures: [], assistantTakeover: [], wrongUnanswered: [0] },
      },
      {
        run: run([turn('t', 'teacher', '好。')]),
        det: detectBoundary(run([turn('t', 'teacher', '好。')]), context),
        judged: { untaught: [], studentLectures: [], assistantTakeover: [], wrongUnanswered: [] },
      },
      { run: run([], { error: 'timed out' }), det: detectBoundary(run([]), context) },
      {
        run: run([turn('t', 'teacher', '好。')]),
        det: detectBoundary(run([turn('t', 'teacher', '好。')]), context),
        judgeError: 'unparseable',
      },
    ]);
    expect(summary).toMatchObject({ runs: 3, judged: 2, judgeErrors: 1 });
    expect(summary.counters.untaught).toEqual({
      detRuns: 1,
      detInstances: 1,
      detRate: 0.333,
      judgedRuns: 1,
      judgedInstances: 1,
      judgeRate: 0.5,
    });
    expect(summary.counters.wrongUnanswered.detRuns).toBe(1);
    expect(summarizeBoundary('x', []).counters.untaught.judgeRate).toBeNull();
  });
});

describe('judge vendor guard', () => {
  it.each([
    ['anthropic:claude-sonnet-4-5', 'anthropic'],
    ['openrouter:anthropic/claude-3.7-sonnet', 'anthropic'],
    ['bedrock:us.anthropic.claude-opus-4-1', 'anthropic'],
    ['openai:gpt-4.1', 'openai'],
    ['openai:o3-mini', 'openai'],
    ['openrouter:openai/gpt-4o', 'openai'],
    ['azure:my-deployment', 'openai'],
    ['gpt-4o-mini', 'openai'],
    ['google:gemini-2.5-pro', 'google'],
    ['qwen:qwen-plus', 'alibaba'],
    ['siliconflow:Qwen/Qwen3-32B', 'alibaba'],
    ['siliconflow:deepseek-ai/DeepSeek-V3', 'deepseek'],
    ['deepseek:deepseek-chat', 'deepseek'],
    ['kimi:kimi-k2', 'moonshot'],
    ['glm:glm-4.6', 'zhipu'],
    ['doubao:doubao-seed-1-6', 'bytedance'],
    ['ollama:llama3.1', 'meta'],
    ['custom-lab:house-model', 'custom-lab'],
  ])('%s is made by %s', (model, vendor) => {
    expect(modelVendor(model)).toBe(vendor);
  });

  it('refuses a judge of the tested model’s own vendor', () => {
    expect(
      compareVendors('openrouter:anthropic/claude-3.7-sonnet', 'anthropic:claude-haiku-4-5'),
    ).toEqual({ testedVendor: 'anthropic', judgeVendor: 'anthropic', same: true });
    expect(compareVendors('qwen:qwen-plus', 'anthropic:claude-sonnet-4-5').same).toBe(false);
  });
});

describe('seededShuffle', () => {
  const items = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];

  it('is a permutation that depends only on the seed', () => {
    const once = seededShuffle(items, 'seed-1');
    expect(seededShuffle(items, 'seed-1')).toEqual(once);
    expect([...once].sort()).toEqual(items);
    expect(items).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
    const orders = new Set(
      ['s1', 's2', 's3', 's4'].map((seed) => seededShuffle(items, seed).join('')),
    );
    expect(orders.size).toBeGreaterThan(1);
  });
});

describe('baseline comparison', () => {
  function summary(overrides: {
    accuracy?: number;
    untaught?: number;
    believable?: number;
    calibrated?: boolean;
  }): PersonaFidelitySummary {
    const counter = (rate: number) => ({
      detRuns: 0,
      detInstances: 0,
      detRate: rate,
      judgedRuns: 0,
      judgedInstances: 0,
      judgeRate: rate,
    });
    return {
      testedModel: 'qwen:qwen-plus',
      judgeModel: 'anthropic:claude-sonnet-4-5',
      testedVendor: 'alibaba',
      judgeVendor: 'anthropic',
      sameVendor: false,
      createdAt: '',
      samples: 2,
      castingMode: 'persona',
      rosterSource: 'fixed',
      judgeCalibration: { passed: overrides.calibrated ?? true, failures: [] },
      generation: [
        {
          ...summarizeGeneration('waves', []),
          judge: {
            judgedRosters: 1,
            judgeErrors: 0,
            elementCoverage: 1,
            realPersonMean: 4,
            caricatureMean: 1,
            believableRate: overrides.believable ?? 0.8,
            scriptLikeRate: 0,
            studentsDistinctRate: 1,
            lengthBias: null,
          },
        },
      ],
      speaker: [
        {
          ...summarizeSpeakerId({
            courseId: 'waves',
            roles: {},
            lines: 0,
            tooShort: 0,
            judgments: [],
          }),
          accuracy: overrides.accuracy ?? 0.6,
        },
      ],
      boundary: [
        {
          courseId: 'waves',
          runs: 4,
          judged: 4,
          judgeErrors: 0,
          counters: {
            untaught: counter(overrides.untaught ?? 0.1),
            studentLectures: counter(0),
            assistantTakeover: counter(0),
            wrongUnanswered: counter(0),
          },
        },
      ],
    };
  }

  it('flattens every gated number under a stable key', () => {
    const keys = flattenFidelityMetrics(summary({})).map((metric) => metric.key);
    expect(keys).toEqual(
      expect.arrayContaining([
        'generation.waves.validRate',
        'generation.waves.judge.believableRate',
        'speaker.waves.accuracy',
        'boundary.waves.untaught.judgeRate',
      ]),
    );
    // A null (nothing to measure) is not a metric
    expect(keys).not.toContain('speaker.waves.studentWithinRoleAccuracy');
  });

  it('flags only moves in the wrong direction beyond the tolerance', () => {
    const base = summary({});
    expect(findFidelityRegressions(summary({ accuracy: 0.5, untaught: 0.2 }), base, 0.15)).toEqual(
      [],
    );
    expect(findFidelityRegressions(summary({ accuracy: 0.9, untaught: 0 }), base, 0.15)).toEqual(
      [],
    );
    expect(
      findFidelityRegressions(summary({ accuracy: 0.3, untaught: 0.4 }), base, 0.15).map(
        ({ key }) => key,
      ),
    ).toEqual([
      'speaker.waves.accuracy',
      'boundary.waves.untaught.detRate',
      'boundary.waves.untaught.judgeRate',
    ]);
  });

  it('ignores judged persona scores when either judge failed calibration', () => {
    const base = summary({});
    expect(
      findFidelityRegressions(summary({ believable: 0.2 }), base, 0.15).map(({ key }) => key),
    ).toEqual(['generation.waves.judge.believableRate']);
    expect(
      findFidelityRegressions(summary({ believable: 0.2, calibrated: false }), base, 0.15),
    ).toEqual([]);
  });
});
