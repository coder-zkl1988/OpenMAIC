/**
 * The Pi casting eval's scenario file (I21), without a model: it covers the
 * observed failures and the counter-examples, every scenario is a request
 * the route would pass through unchanged, and the runner's selection,
 * upcoming-page and delegation-recording helpers behave.
 */
import path from 'path';
import { describe, expect, it } from 'vitest';
import type { PiChildTurnStubInput } from '@/lib/types/chat';
import {
  createScriptedChildStub,
  loadCastingScenarios,
  scenarioAgents,
  selectScenarios,
  upcomingSceneIds,
  validateScenarioFile,
  type CastingScenario,
  type CastingScenarioFile,
} from '@/eval/pi-casting/scenario';

const file = loadCastingScenarios(
  path.join(process.cwd(), 'eval/pi-casting/scenarios/casting.json'),
);
const byId = (id: string) => file.scenarios.find((scenario) => scenario.id === id)!;

describe('casting.json', () => {
  it('is sound: every scenario is a request the route keeps as it is', () => {
    expect(validateScenarioFile(file)).toEqual([]);
  });

  it('covers the observed failures, the counter-examples and the moment kinds', () => {
    const tagged = (tag: string) =>
      file.scenarios.filter((scenario) => scenario.tags?.includes(tag)).map(({ id }) => id);
    expect(tagged('observed-failure')).toEqual(
      expect.arrayContaining([
        'observed-ta-silent-12-pages',
        'observed-student-silent-until-asked',
        'observed-students-silent-12-pages',
      ]),
    );
    expect(tagged('counter-example')).toEqual(
      expect.arrayContaining(['ack-closes', 'shy-student-just-spoke', 'ta-silent-no-reason']),
    );
    const kinds = new Set(file.scenarios.map((scenario) => scenario.config?.momentKind));
    expect(kinds).toEqual(new Set([undefined, 'lecture', 'ask-learner', 'quiz-review']));
    const stances = new Set(file.scenarios.map((scenario) => scenario.config?.learnerStance));
    expect(stances).toEqual(new Set([undefined, 'answer', 'listen']));
  });

  it('keeps hard checks to plain facts: the observed TA failure is a distribution only', () => {
    expect(byId('observed-ta-silent-12-pages').expect ?? []).toEqual([]);
    expect(byId('observed-students-silent-12-pages').expect ?? []).toEqual([]);
    expect(byId('ack-closes').expect).toEqual(
      expect.arrayContaining([{ check: 'terminal', is: 'close_session' }]),
    );
    expect(byId('ask-learner-answer').expect).toEqual(
      expect.arrayContaining([{ check: 'cuePrompt' }, { check: 'maxTurns', n: 1 }]),
    );
  });

  it('runs a small end-to-end set with real children', () => {
    const e2e = file.scenarios.filter((scenario) => scenario.e2e).map(({ id }) => id);
    expect(e2e.length).toBeGreaterThanOrEqual(3);
    expect(e2e.length).toBeLessThan(file.scenarios.length / 2);
  });
});

describe('validateScenarioFile', () => {
  const roster = [
    { id: 't', name: 'T', role: 'teacher' as const, persona: 'A teacher.' },
    { id: 's', name: 'S', role: 'student' as const, persona: 'A student.' },
  ];
  const base: CastingScenario = {
    id: 'x',
    description: '',
    roster: 'r',
    pages: [{ id: 'p1', title: 'P1', speech: ['one'] }],
    messages: [{ role: 'user', text: 'hi' }],
  };
  const check = (scenario: Partial<CastingScenario>, extra: Partial<CastingScenarioFile> = {}) =>
    validateScenarioFile({
      rosters: { r: roster },
      scenarios: [{ ...base, ...scenario }],
      ...extra,
    });

  it('accepts a plain scenario', () => {
    expect(check({})).toEqual([]);
  });

  it('flags what the route would drop or the director could not use', () => {
    expect(check({ roster: 'nope' })).toEqual([expect.stringContaining('unknown roster')]);
    expect(check({ currentPageId: 'p9' })).toEqual([expect.stringContaining('currentPageId')]);
    expect(check({ lectureProgress: { pageId: 'p1', actionIndex: 1 } })).toEqual([
      expect.stringContaining('past the page'),
    ]);
    expect(check({ config: { momentKind: 'lecture' } })).toEqual([
      expect.stringContaining('needs sessionType'),
    ]);
    expect(
      check({
        config: { sessionType: 'discussion', momentKind: 'lecture', learnerStance: 'answer' },
      }),
    ).toEqual([expect.stringContaining('learnerStance needs')]);
    expect(check({ agentIds: ['t'], config: { addressedAgentIds: ['s'] } })).toEqual([
      expect.stringContaining('addressed agent "s"'),
    ]);
    expect(
      check({
        config: { classPresence: { agents: [{ agentId: 't', turns: 1, lastSceneId: 'p9' }] } },
      }),
    ).toEqual([expect.stringContaining('lastSceneId')]);
    expect(
      check({
        config: {
          classPresence: { agents: [], moments: [{ actionId: 'nope', outcome: 'skipped' }] },
        },
      }),
    ).toEqual([expect.stringContaining('not a discussion action')]);
    expect(check({ scripts: { ghost: ['…'] } })).toEqual([expect.stringContaining('script for')]);
    expect(check({ expect: [{ check: 'called', agentId: 'ghost' }] })).toEqual([
      expect.stringContaining('expectation names'),
    ]);
    expect(check({ messages: [{ role: 'assistant', text: 'who?' }] })).toEqual([
      expect.stringContaining('needs a roster agentId'),
    ]);
    const memory = { entries: [{ kind: 'qa' as const, points: [{ agentId: 's', gist: 'Hm?' }] }] };
    expect(check({ agentIds: ['t'], config: { classMemory: memory } })).toEqual([
      expect.stringContaining('classMemory point of "s"'),
    ]);
    // An aside keeps the rest of the class in its memory, as the route does
    expect(
      check({ agentIds: ['t'], config: { asideToLecture: true, classMemory: memory } }),
    ).toEqual([]);
  });

  it('flags a roster with two teachers and duplicate scenario ids', () => {
    const problems = validateScenarioFile({
      rosters: { r: [...roster, { ...roster[0]!, id: 't2' }] },
      scenarios: [base, base],
    });
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining('more than one teacher'),
        expect.stringContaining('duplicate id'),
      ]),
    );
  });
});

describe('upcomingSceneIds', () => {
  it('lists the pages after the current one', () => {
    expect(upcomingSceneIds(byId('asks-about-upcoming-page'))).toEqual(['p10', 'p11', 'p12']);
    expect(upcomingSceneIds(byId('observed-students-silent-12-pages'))).toHaveLength(5);
  });

  it('is empty on the last page, which is the default current page', () => {
    expect(upcomingSceneIds({ ...byId('ack-closes'), currentPageId: undefined })).toEqual([]);
  });
});

describe('selectScenarios', () => {
  it('filters by id and by tag, and keeps everything without a filter', () => {
    expect(selectScenarios(file.scenarios, {})).toHaveLength(file.scenarios.length);
    expect(selectScenarios(file.scenarios, { ids: ['ack-closes'] }).map(({ id }) => id)).toEqual([
      'ack-closes',
    ]);
    const boundary = selectScenarios(file.scenarios, { tags: ['cognitive-boundary'] });
    expect(boundary.map(({ id }) => id)).toEqual(['asks-about-upcoming-page']);
    expect(
      selectScenarios(file.scenarios, { ids: ['ack-closes'], tags: ['observed-failure'] }),
    ).toEqual([]);
  });
});

describe('createScriptedChildStub', () => {
  it('shows every delegation to onCall before answering it', async () => {
    const scenario = byId('addressed-assistant-first');
    const seen: PiChildTurnStubInput[] = [];
    const stub = createScriptedChildStub(scenario, scenarioAgents(file, scenario), (input) =>
      seen.push(input),
    );
    const input: PiChildTurnStubInput = {
      agentId: 'ta1',
      agentName: '小禾',
      role: 'assistant',
      instruction: 'The learner asked you by name for an everyday example.',
      castReason: 'addressed',
      turnIndex: 0,
      evidenceSceneIds: ['p6'],
    };
    expect(await stub(input)).toContain('秋千');
    expect(seen).toEqual([input]);
  });
});
