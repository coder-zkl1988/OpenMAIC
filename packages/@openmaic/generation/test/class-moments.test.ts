import { describe, expect, test, vi } from 'vitest';
import type { Action, DiscussionAction } from '@openmaic/dsl';

import {
  PROMPT_IDS,
  buildPrompt,
  classMomentOf,
  classMomentsFromScenes,
  generateSceneActions,
  loadPrompt,
  summarizeClassMoments,
} from '@openmaic/generation';
import type {
  AgentInfo,
  ClassMomentScene,
  GenerationLogger,
  SceneGenerationContext,
} from '@openmaic/generation';

import { buildClassMoments, buildCourseContext } from '../src/prompt-formatters.js';
import { slideOutline } from './scene-fixtures.js';

const page = (
  pageIndex: number,
  previousMoments?: SceneGenerationContext['previousMoments'],
): SceneGenerationContext => ({
  pageIndex,
  totalPages: 12,
  allTitles: Array.from({ length: 12 }, (_, i) => `Page ${i + 1}`),
  previousSpeeches: [],
  ...(previousMoments ? { previousMoments } : {}),
});

describe('class moments of a course so far', () => {
  test('lists who spoke up on which page, for the next page to pace its own', () => {
    expect(
      buildClassMoments(
        page(7, [
          { page: 3, agentName: '小问', topic: '为什么叠加以后形状完全变了？' },
          { page: 5, agentName: '小禾助教', topic: '我们来试着改一下频率' },
        ]),
      ),
    ).toBe(
      [
        'Class moments so far:',
        '  - page 3: 小问 — "为什么叠加以后形状完全变了？"',
        '  - page 5: 小禾助教 — "我们来试着改一下频率"',
      ].join('\n'),
    );
  });

  test('says how long the class has listened when nobody has spoken up', () => {
    expect(buildClassMoments(page(5, []))).toBe('Class moments so far: none yet (pages 1-4).');
    expect(buildClassMoments(page(1, []))).toContain('this is the first page');
  });

  test('says nothing without the history', () => {
    expect(buildClassMoments(page(5))).toBe('');
    expect(buildClassMoments(undefined)).toBe('');
  });

  test('marks the moment that ended the page just before, with the teacher note to settle it', () => {
    expect(
      buildClassMoments(
        page(6, [
          {
            page: 1,
            agentName: '小问',
            agentRole: 'student',
            topic: '这个也能叠加吗？',
            prompt: 'Too old to follow up.',
          },
          {
            page: 5,
            agentName: '小思',
            agentRole: 'student',
            topic: '那是不是频率越高声音越大？',
            prompt: 'Wrong idea: pitch and loudness are the same thing.',
          },
        ]),
      ),
    ).toBe(
      [
        'Class moments so far:',
        '  - page 1: 小问 (student) — "这个也能叠加吗？"',
        '  - page 5 (it ended the page just before this one): 小思 (student) — "那是不是频率越高声音越大？"',
        "    teacher's note: Wrong idea: pitch and loudness are the same thing.",
      ].join('\n'),
    );
  });

  test('keeps the teacher note of the recent moments only, cut short', () => {
    const text = buildClassMoments(
      page(9, [
        { page: 4, agentName: 'A', topic: 'old', prompt: 'old note' },
        { page: 6, agentName: 'B', topic: 'recent', prompt: '错'.repeat(250) },
      ]),
    );
    expect(text).not.toContain('old note');
    expect(text).toContain(`    teacher's note: ${'错'.repeat(200)}…`);
    expect(text).not.toContain('(it ended the page just before this one)');
  });
});

describe('activity pages among the class moments', () => {
  test('a quiz or an interactive page is listed as the class working, not as silence', () => {
    expect(
      buildClassMoments(
        page(6, [
          { page: 2, kind: 'interactive' },
          { page: 3, agentName: '小问', agentRole: 'student', topic: '为什么？' },
          { page: 5, kind: 'quiz' },
        ]),
      ),
    ).toBe(
      [
        'Class moments so far:',
        '  - page 2: interactive page — the whole class was trying it hands-on',
        '  - page 3: 小问 (student) — "为什么？"',
        '  - page 5 (the page just before this one): quiz — the whole class was answering questions',
      ].join('\n'),
    );
  });

  test('the slide actions prompt does not read an activity page as silence', () => {
    const { system } = buildPrompt(PROMPT_IDS.SLIDE_ACTIONS, {
      title: 't',
      keyPoints: '',
      description: '',
      elements: '[]',
      courseContext: '',
      agents: '',
      userProfile: '',
      languageDirective: '',
    })!;
    expect(system).toContain(
      'A quiz, interactive or project page listed there is time the whole class spent working, not a stretch of silence.',
    );
  });
});

describe('a moment nothing could settle yet', () => {
  const confusion = {
    page: 3,
    agentName: '小思',
    agentRole: 'student',
    topic: '那是不是频率越高声音越大？',
    prompt: 'Wrong idea: pitch and loudness are the same thing.',
  };

  test('is marked for this page to settle when only a quiz or project came after it', () => {
    const text = buildClassMoments(
      page(6, [confusion, { page: 4, kind: 'quiz' }, { page: 5, kind: 'pbl' }]),
    );
    expect(text).toContain(
      '  - page 3 (left open: only a quiz or project came after it, so settle it at the start of this page): 小思 (student)',
    );
    expect(text).toContain(
      "    teacher's note: Wrong idea: pitch and loudness are the same thing.",
    );
  });

  test('is not marked when a page that follows moments up came in between', () => {
    for (const between of [
      [{ page: 4, kind: 'interactive' as const }],
      // A slide with no moment of its own is not listed: it was a page that could follow up
      [{ page: 5, kind: 'quiz' as const }],
    ]) {
      expect(buildClassMoments(page(6, [confusion, ...between]))).not.toContain('left open');
    }
  });

  test('says when a quiz, a project or the end of the course follows this page', () => {
    const kinds = (next: string): SceneGenerationContext => ({
      ...page(4, []),
      allKinds: ['slide', 'slide', 'slide', 'slide', next, 'slide'],
    });
    expect(buildClassMoments(kinds('quiz'))).toBe(
      [
        'Class moments so far: none yet (pages 1-3).',
        'After this page: a quiz page, where nothing settles a confusion or wrong guess left open here.',
      ].join('\n'),
    );
    expect(buildClassMoments(kinds('pbl'))).toContain('After this page: a project page');
    // An interactive or slide page can still follow the moment up
    expect(buildClassMoments(kinds('interactive'))).not.toContain('After this page');
    expect(buildClassMoments(kinds('slide'))).not.toContain('After this page');

    expect(buildClassMoments(page(12, [confusion]))).toContain('After this page: the course ends.');
    expect(buildClassMoments({ ...page(12, []), openEnded: true })).not.toContain(
      'After this page',
    );
  });

  test('the slide actions prompt keeps a confusion off a page nothing would settle', () => {
    const { system } = buildPrompt(PROMPT_IDS.SLIDE_ACTIONS, {
      title: 't',
      keyPoints: '',
      description: '',
      elements: '[]',
      courseContext: '',
      agents: '',
      userProfile: '',
      languageDirective: '',
    })!;
    expect(system).toContain(
      'When `Class moments so far` says the course ends after this page, or that a quiz or project page comes next, do not end this page on a confusion or a wrong guess',
    );
    expect(system).toContain('or one left open because only a quiz or project came after it');
    // Who opens a moment follows from who they are, never a rotation or a quota
    expect(system).toContain('a talkative student may open several and a shy one none');
    expect(system).not.toContain('the moments come from different people');
    expect(system).not.toContain('after a long stretch without one, a natural moment is welcome');
  });
});

describe('class moments read off the generated pages', () => {
  const roster: AgentInfo[] = [
    { id: 't', name: '王老师', role: 'teacher' },
    { id: 's1', name: '小思', role: 'student' },
  ];
  const slide = (actions: ClassMomentScene['actions'] = []): ClassMomentScene => ({
    type: 'slide',
    actions,
  });
  const course: Array<ClassMomentScene | null> = [
    slide([
      { type: 'speech' },
      { type: 'discussion', topic: '为什么？', prompt: ' note ', agentId: 's1' },
    ]),
    { type: 'quiz', actions: [{ type: 'speech' }] },
    null,
    slide([{ type: 'discussion', topic: '大家猜猜看？' }]),
    { type: 'interactive' },
    slide([{ type: 'discussion', topic: 'later' }]),
  ];

  test('are the discussions, by opener, and the activity pages, before the page asked for', () => {
    expect(classMomentsFromScenes(course, roster, 6)).toEqual([
      { page: 1, agentName: '小思', agentRole: 'student', topic: '为什么？', prompt: 'note' },
      { page: 2, kind: 'quiz' },
      { page: 4, agentName: '王老师', agentRole: 'teacher', topic: '大家猜猜看？' },
      { page: 5, kind: 'interactive' },
    ]);
    expect(classMomentsFromScenes(course, roster, 1)).toEqual([]);
    expect(classMomentsFromScenes(course, roster, 99)).toHaveLength(5);
  });

  test('skip a discussion without a topic', () => {
    expect(
      classMomentsFromScenes([slide([{ type: 'discussion', agentId: 's1' }])], roster, 2),
    ).toEqual([]);
  });

  test('sum up into counts that never reach a prompt', () => {
    const moments = classMomentsFromScenes(course, roster, 99);
    expect(summarizeClassMoments(moments, 9)).toEqual({
      pages: 9,
      discussions: 3,
      openers: [
        { name: '王老师', role: 'teacher', count: 2 },
        { name: '小思', role: 'student', count: 1 },
      ],
      activityPages: 2,
      // Page 3 is silent; pages 7-9 are the longest run.
      longestSilentStretch: 3,
    });
    expect(summarizeClassMoments([], 4)).toMatchObject({
      discussions: 0,
      openers: [],
      longestSilentStretch: 4,
    });
  });
});

describe('a course built page by page', () => {
  const at = (pageIndex: number, totalPages: number, openEnded?: boolean) =>
    buildCourseContext({
      pageIndex,
      totalPages,
      allTitles: Array.from({ length: totalPages }, (_, i) => `Page ${i + 1}`),
      previousSpeeches: [],
      ...(openEnded ? { openEnded } : {}),
    });

  test('does not take its latest page for the closing one', () => {
    expect(at(3, 3, true)).toContain('the latest page so far');
    expect(at(3, 3, true)).not.toContain('This is the LAST page');
    expect(at(3, 3)).toContain('This is the LAST page');
    expect(at(1, 1, true)).toContain('This is the FIRST page');
    expect(at(2, 4, true)).toContain('Page 2 of 4 (middle of the course)');
  });
});

describe('a discussion as a class moment', () => {
  const roster: AgentInfo[] = [
    { id: 't', name: '王老师', role: 'teacher' },
    { id: 's1', name: '小思', role: 'student' },
  ];

  test('is named by its opener, with their role and the teacher note', () => {
    expect(
      classMomentOf({ topic: '为什么？', prompt: '  note  ', agentId: 's1' }, 3, roster),
    ).toEqual({
      page: 3,
      agentName: '小思',
      agentRole: 'student',
      topic: '为什么？',
      prompt: 'note',
    });
  });

  test('belongs to the teacher without an opener, as the classroom plays it', () => {
    expect(classMomentOf({ topic: '大家猜猜看？' }, 2, roster)).toEqual({
      page: 2,
      agentName: '王老师',
      agentRole: 'teacher',
      topic: '大家猜猜看？',
    });
    expect(classMomentOf({ topic: 'q' }, 2, [])).toMatchObject({
      agentName: 'the teacher',
      agentRole: 'teacher',
    });
  });

  test('of someone no longer on the roster is a student', () => {
    expect(classMomentOf({ topic: 'q', agentId: 'gone' }, 2, roster)).toEqual({
      page: 2,
      agentName: 'a student',
      topic: 'q',
    });
  });
});

describe('who opens a class moment', () => {
  const roster: AgentInfo[] = [
    { id: 'gen-teacher', name: '王老师', role: 'teacher' },
    { id: 'gen-ta', name: '小禾', role: 'assistant' },
    { id: 'gen-si', name: '小思', role: 'student' },
    { id: 'gen-wen', name: '小问', role: 'student' },
  ];

  function logger() {
    const warn = vi.fn<(message: string) => void>();
    const log: GenerationLogger = { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() };
    return { log, warn };
  }

  async function lecture(
    params: Record<string, unknown>,
    options: { narration?: string; agents?: AgentInfo[]; log?: GenerationLogger } = {},
  ): Promise<Action[]> {
    const response = JSON.stringify([
      { type: 'text', content: options.narration ?? '这就是叠加原理。' },
      { type: 'action', name: 'discussion', params },
    ]);
    return generateSceneActions(slideOutline(), { elements: [] }, async () => response, {
      agents: 'agents' in options ? options.agents : roster,
      ...(options.log ? { logger: options.log } : {}),
    });
  }

  const discussionOf = (actions: Action[]) =>
    actions.find((action): action is DiscussionAction => action.type === 'discussion');

  test('is the person whose id the moment names, the teacher included', async () => {
    expect(discussionOf(await lecture({ topic: '为什么？', agentId: 'gen-wen' }))).toMatchObject({
      agentId: 'gen-wen',
      topic: '为什么？',
    });
    expect(
      discussionOf(await lecture({ topic: '大家先猜猜，结果会怎样？', agentId: 'gen-teacher' })),
    ).toMatchObject({ agentId: 'gen-teacher' });
  });

  test('is found by the name or the one-person role written in place of the id', async () => {
    expect(discussionOf(await lecture({ topic: '为什么？', agentId: '小问' }))?.agentId).toBe(
      'gen-wen',
    );
    expect(discussionOf(await lecture({ topic: '大家猜猜？', agentId: 'teacher' }))?.agentId).toBe(
      'gen-teacher',
    );
  });

  test('is the speaker a topic is labelled with, and the label is not their words', async () => {
    expect(
      discussionOf(await lecture({ topic: '小思（学生）：为什么会抵消？', agentId: 'x' })),
    ).toMatchObject({ agentId: 'gen-si', topic: '为什么会抵消？' });
    expect(
      discussionOf(await lecture({ topic: '小思：为什么会抵消？', agentId: 'gen-si' })),
    ).toMatchObject({ agentId: 'gen-si', topic: '为什么会抵消？' });
  });

  test('is the teacher when the topic calls on a classmate by name', async () => {
    expect(
      discussionOf(
        await lecture({ topic: '小思，你先猜猜看，结果会怎样？', agentId: 'student_1' }),
      ),
    ).toMatchObject({ agentId: 'gen-teacher', topic: '小思，你先猜猜看，结果会怎样？' });
  });

  test('is the classmate the teacher calls on at the end of the narration', async () => {
    const actions = await lecture(
      { topic: '是不是因为两个波正好相反？' },
      { narration: '刚才小问提到了频率。那么两个波叠加会怎样？小思，你来说说看。' },
    );
    expect(discussionOf(actions)?.agentId).toBe('gen-si');
  });

  test('when nobody can be found, the moment is dropped, never given to a random student', async () => {
    const { log, warn } = logger();
    for (let run = 0; run < 5; run += 1) {
      const actions = await lecture({ topic: '为什么？', agentId: 'student_7' }, { log });
      expect(discussionOf(actions)).toBeUndefined();
      expect(actions.map((action) => action.type)).toEqual(['speech']);
    }
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('dropped the class moment'));
  });

  test('a moment without a topic is dropped', async () => {
    expect(discussionOf(await lecture({ topic: '  ', agentId: 'gen-si' }))).toBeUndefined();
  });

  test('without a roster, the moment keeps no opener', async () => {
    const discussion = discussionOf(await lecture({ topic: '为什么？' }, { agents: [] }));
    expect(discussion).toMatchObject({ topic: '为什么？' });
    expect(discussion?.agentId).toBeUndefined();
  });
});

describe('the actions prompts', () => {
  const base = {
    title: 't',
    keyPoints: '',
    description: '',
    elements: '[]',
    courseContext: '',
    agents: '',
    userProfile: '',
    languageDirective: '',
  };

  test('the slide actions prompt decides class moments by persona, not by schedule', () => {
    const prompt = buildPrompt(PROMPT_IDS.SLIDE_ACTIONS, {
      ...base,
      classMoments: buildClassMoments(page(4, [])),
    })!;
    expect(prompt.user).toContain('Class moments so far: none yet (pages 1-3).');
    expect(prompt.system).toContain('decide it as a real class would, not by schedule');
    expect(prompt.system).toContain('Class moments so far');
    expect(prompt.system).not.toContain('Discussion slot');

    const bare = buildPrompt(PROMPT_IDS.SLIDE_ACTIONS, base)!;
    expect(bare.user).not.toContain('{{');
    expect(bare.system).not.toContain('{{');
  });

  test('the teacher opens the moments they start, and nobody singles the learner out', () => {
    const { system } = buildPrompt(PROMPT_IDS.SLIDE_ACTIONS, base)!;
    expect(system).toContain(
      "the teacher opens: `agentId` is the teacher's id and `topic` is the teacher's line",
    );
    expect(system).toContain('A whole-class question is opened by the teacher');
    expect(system).toContain('A moment never singles the learner out by name.');
    expect(system).not.toContain('it is that student, and `topic` is the teacher');
  });

  test('a moment carries a correction for the teacher, and the next page settles it', () => {
    const { system } = buildPrompt(PROMPT_IDS.SLIDE_ACTIONS, base)!;
    expect(system).toContain('write it as a correction');
    expect(system).toContain('why it is tempting at this level, and what is actually right');
    expect(system).toContain('**Following up a class moment**');
    expect(system).toContain('the learner may have skipped that moment or never seen it');
    expect(system).toContain('commonly have about this subject');
  });

  test('the quiz opening promises no review and follows up no moment', () => {
    const system = loadPrompt(PROMPT_IDS.QUIZ_ACTIONS)!.systemPrompt;
    expect(system).not.toMatch(/I'll be right here|I'll join you after you submit/);
    expect(system).not.toContain("Mention that you'll discuss results");
    expect(system).toContain('NEVER promise a review');
    expect(system).toContain('NEVER follow up earlier class moments here');
  });
});
