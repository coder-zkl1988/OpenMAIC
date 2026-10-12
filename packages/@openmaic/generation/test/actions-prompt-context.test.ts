import { describe, expect, test } from 'vitest';
import type { Action, DiscussionAction } from '@openmaic/dsl';

import {
  PROMPT_IDS,
  buildEarlierKeyPoints,
  buildPrompt,
  formatAgentsForPrompt,
  formatTeacherVoiceForPrompt,
  generateSceneActions,
} from '@openmaic/generation';
import type {
  AICallFn,
  AgentInfo,
  GeneratedInteractiveContent,
  SceneGenerationContext,
} from '@openmaic/generation';

import { pblOutline, quizOutline, slideOutline, widgetOutline } from './scene-fixtures.js';

const roster: AgentInfo[] = [
  {
    id: 'gen-t',
    name: '王老师',
    role: 'teacher',
    persona: 'Warm and patient; asks the class to guess first.',
  },
  {
    id: 'gen-ta',
    name: '小禾',
    role: 'assistant',
    persona: 'Hands-on, steps in when someone is stuck.',
  },
  {
    id: 'gen-si',
    name: '小思',
    role: 'student',
    persona: 'Curious, blurts out "what if?" at surprises.',
  },
];

const at = (
  pageIndex: number,
  extra: Partial<SceneGenerationContext> = {},
): SceneGenerationContext => ({
  pageIndex,
  totalPages: 6,
  allTitles: Array.from({ length: 6 }, (_, i) => `Page ${i + 1}`),
  previousSpeeches: [],
  ...extra,
});

function capture(response: string) {
  const calls: Array<{ system: string; user: string }> = [];
  const aiCall: AICallFn = async (system, user) => {
    calls.push({ system, user });
    return response;
  };
  return { aiCall, calls };
}

describe('what the earlier pages taught', () => {
  test('lists the key points of the pages before this one, a few per page, cut short', () => {
    const text = buildEarlierKeyPoints(
      at(4, {
        allKeyPoints: [
          ['Waves add up', '  Crest   meets crest ', 'Third', 'Fourth is left out'],
          [],
          ['相'.repeat(70)],
          ['This page itself'],
          ['A later page'],
        ],
      }),
    );
    expect(text).toBe(
      [
        'Taught on earlier pages (key points):',
        '  - page 1: Waves add up; Crest meets crest; Third',
        `  - page 3: ${'相'.repeat(60)}…`,
      ].join('\n'),
    );
  });

  test('says nothing on the first page or without the plan', () => {
    expect(buildEarlierKeyPoints(at(1, { allKeyPoints: [['A']] }))).toBe('');
    expect(buildEarlierKeyPoints(at(3))).toBe('');
    expect(buildEarlierKeyPoints(at(3, { allKeyPoints: [[], ['  ']] }))).toBe('');
    expect(buildEarlierKeyPoints(undefined)).toBe('');
  });

  test('leaves the oldest pages out first when the course is long', () => {
    const allKeyPoints = Array.from({ length: 40 }, (_, i) =>
      Array.from({ length: 3 }, (_, j) => `Point ${j} of page ${i + 1} ${'x'.repeat(40)}`),
    );
    const text = buildEarlierKeyPoints({ ...at(40, { allKeyPoints }), totalPages: 40 });
    expect(Array.from(text).length).toBeLessThanOrEqual(1200 + 40);
    expect(text).toContain('  - page 39: ');
    expect(text).not.toContain('  - page 1: ');
  });

  test('reach the slide actions prompt, which has the class recall what this page builds on', async () => {
    const { aiCall, calls } = capture(JSON.stringify([{ type: 'text', content: 'Hi' }]));
    await generateSceneActions(slideOutline(), { elements: [] }, aiCall, {
      ctx: at(3, { allKeyPoints: [['Caller owns dependencies'], ['Constructor injection']] }),
    });
    expect(calls[0]!.user).toContain(
      'Taught on earlier pages (key points):\n  - page 1: Caller owns dependencies\n  - page 2: Constructor injection',
    );
    expect(calls[0]!.system).toContain('**Building on an earlier page**');
    expect(calls[0]!.system).toContain('never as if someone had answered');

    const bare = buildPrompt(PROMPT_IDS.SLIDE_ACTIONS, {
      title: 't',
      keyPoints: '',
      description: '',
      elements: '[]',
      courseContext: '',
      agents: '',
      userProfile: '',
      languageDirective: '',
    })!;
    expect(bare.user).not.toContain('{{');
  });
});

describe('the class in an actions prompt', () => {
  test('quotes a persona in full up to a few paragraphs, and cuts a longer one', () => {
    const text = formatAgentsForPrompt([
      { id: 'x', name: 'X', role: 'student', persona: 'p'.repeat(2500) },
    ]);
    expect(text).toBe(
      `Classroom Agents:\n- id: "x", name: "X", role: student — ${'p'.repeat(2000)}…`,
    );
  });

  test("is the teacher's persona and only the others' names where only the teacher speaks", () => {
    expect(formatTeacherVoiceForPrompt(roster)).toBe(
      [
        'Classroom Agents:',
        '- Teacher (speaks every line): name: "王老师" — Warm and patient; asks the class to guess first.',
        '- Also in class (they do not speak in your text): 小禾 (assistant), 小思 (student)',
      ].join('\n'),
    );
    expect(formatTeacherVoiceForPrompt([])).toBe('');
  });

  test("a quiz opening and a project introduction are given no one else's persona", async () => {
    for (const [outline, content] of [
      [quizOutline(), { questions: [] }],
      [pblOutline(), {}],
    ] as const) {
      const { aiCall, calls } = capture(JSON.stringify([{ type: 'text', content: 'Go' }]));
      await generateSceneActions(outline, content as never, aiCall, { agents: roster });
      expect(calls[0]!.user, outline.type).toContain('Warm and patient');
      expect(calls[0]!.user, outline.type).toContain('小禾 (assistant), 小思 (student)');
      expect(calls[0]!.user, outline.type).not.toContain('Hands-on');
      expect(calls[0]!.user, outline.type).not.toContain('blurts out');
      expect(calls[0]!.system, outline.type).toContain("speak in that teacher's voice");
    }
  });
});

describe('a class moment on an interactive page', () => {
  const content = {
    html: '<!DOCTYPE html><html><body><input id="length-slider"></body></html>',
    widgetType: 'simulation',
  } as unknown as GeneratedInteractiveContent;

  const discussionOf = (actions: Action[]) =>
    actions.find((action): action is DiscussionAction => action.type === 'discussion');

  test('is allowed at the end, opened by someone on the roster', async () => {
    const { aiCall } = capture(
      JSON.stringify([
        { type: 'text', content: '这个摆的绳长可以调。' },
        { type: 'action', name: 'widget_highlight', params: { target: '#length-slider' } },
        {
          type: 'action',
          name: 'discussion',
          params: {
            topic: '动手之前先猜一猜：绳子长一倍，摆动会变快还是变慢？',
            prompt: 'Tempting: longer swings faster. Right: the period grows with √L.',
            agentId: 'gen-t',
          },
        },
      ]),
    );
    const actions = await generateSceneActions(widgetOutline(), content, aiCall, {
      agents: roster,
    });
    expect(actions.map((action) => action.type)).toEqual([
      'speech',
      'widget_highlight',
      'discussion',
    ]);
    expect(discussionOf(actions)).toMatchObject({ agentId: 'gen-t' });
  });

  test('that names nobody on the roster is dropped, and nothing follows a moment', async () => {
    const { aiCall } = capture(
      JSON.stringify([
        { type: 'text', content: 'Try it.' },
        { type: 'action', name: 'discussion', params: { topic: 'What if?', agentId: 'student_9' } },
        { type: 'text', content: 'After the moment.' },
      ]),
    );
    const actions = await generateSceneActions(widgetOutline(), content, aiCall, {
      agents: roster,
    });
    expect(actions.map((action) => action.type)).toEqual(['speech']);
  });

  test('is decided by persona, with the class moments and the learner in the prompt', async () => {
    const { aiCall, calls } = capture('[]');
    await generateSceneActions(widgetOutline(), content, aiCall, {
      agents: roster,
      userProfile: 'Student: Lin — new to physics',
      ctx: at(3, { previousMoments: [{ page: 2, agentName: '小思', topic: '为什么？' }] }),
    });
    const { system, user } = calls[0]!;
    expect(user).toContain('Class moments so far:');
    expect(user).toContain('Student: Lin — new to physics');
    expect(user).toContain('blurts out "what if?"');
    expect(system).toContain('## Class Moment (discussion)');
    expect(system).toContain('decide it as a real class would, not by schedule');
    expect(system).toContain('**predict** before they try it');
    expect(system).toContain('responds to what the learner actually did there');
    expect(system).toContain('A prediction keeps the outcome hidden');
    expect(system).toContain('`widget_reveal`, and `discussion`');

    const bare = buildPrompt(PROMPT_IDS.INTERACTIVE_ACTIONS, {
      title: 't',
      keyPoints: '',
      description: '',
      conceptName: '',
      designIdea: '',
      widgetType: '',
      widgetConfig: '{}',
      elementInventory: '',
      courseContext: '',
      agents: '',
      languageDirective: '',
    })!;
    expect(`${bare.system}\n${bare.user}`).not.toMatch(/\{\{\w[\w-]*\}\}/);
  });
});
