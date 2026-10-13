/**
 * The class as it has unfolded so far, in the Pi prompts: presence facts for
 * the director (I06), class memory for the director and each agent's own
 * slice (I13, I14.3), where an agent stands now (I33), and what the lecture
 * just said on a page for the teacher and assistant (I14).
 */
import { describe, expect, it } from 'vitest';
import type { AgentConfig } from '@/lib/orchestration/registry/types';
import type { StatelessChatRequest } from '@/lib/types/chat';
import {
  buildClassMemoryChildSection,
  buildClassMemoryDirectorSection,
  buildClassPresenceSection,
  buildLectureSoFarSection,
  CHILD_MEMORY_ENTRIES_MAX,
  getAgentStateNote,
  getLectureSoFar,
  LECTURE_SO_FAR_MAX_CHARS,
  PRESENCE_MOMENTS_LISTED_MAX,
} from '@/lib/chat/pi/class-context';
import {
  buildChildPrompt,
  buildDirectorPrompt,
  buildNativeChildPrompt,
} from '@/lib/chat/pi/prompts';
import { PROMPT_CACHE_BREAK } from '@/lib/chat/pi/prompt-cache';

const now = new Date('2026-01-01T00:00:00Z');

function agent(overrides: Partial<AgentConfig> & Pick<AgentConfig, 'id' | 'name' | 'role'>) {
  return {
    persona: '',
    avatar: '',
    color: '#3366ff',
    allowedActions: [],
    priority: 1,
    createdAt: now,
    updatedAt: now,
    isDefault: false,
    ...overrides,
  } as AgentConfig;
}

const teacher = agent({
  id: 't',
  name: '林老师',
  role: 'teacher',
  persona: '林老师教了十年物理。',
});
const assistant = agent({ id: 'a', name: '小禾', role: 'assistant', persona: '小禾爱举例子。' });
const student = agent({ id: 's1', name: '小思', role: 'student', persona: '小思有点害羞。' });
const classmate = agent({ id: 's2', name: '阿杰', role: 'student', persona: '阿杰爱抢答。' });
const classroom = [teacher, assistant, student, classmate];

function makeBody(
  config: Partial<StatelessChatRequest['config']> = {},
  storeState: Partial<StatelessChatRequest['storeState']> = {},
): StatelessChatRequest {
  return {
    messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: '相位差是什么意思？' }] }],
    storeState: {
      stage: { id: 'stage-1', name: 'Waves' },
      scenes: [
        {
          id: 'p1',
          title: '波的叠加',
          order: 1,
          type: 'slide',
          content: { type: 'slide', canvas: { elements: [] } },
          actions: [
            { id: 'p1-s1', type: 'speech', text: '今天我们讲波的叠加。' },
            { id: 'd1', type: 'discussion', topic: '为什么会抵消？', agentId: 's1' },
            { id: 'd0', type: 'discussion', topic: '大家猜猜会怎样？' },
          ],
        },
        {
          id: 'p2',
          title: '干涉',
          order: 2,
          type: 'slide',
          content: { type: 'slide', canvas: { elements: [] } },
          actions: [
            { id: 'p2-s1', type: 'speech', text: '两列波相遇，相位差半个周期时会互相抵消。' },
            { id: 'p2-spot', type: 'spotlight', elementId: 'e1' },
            { id: 'p2-s2', type: 'speech', text: '这就是相消干涉。' },
            { id: 'p2-s3', type: 'speech', text: 'NOT_SAID_YET' },
          ],
        },
      ],
      currentSceneId: 'p2',
      mode: 'autonomous',
      whiteboardOpen: false,
      ...storeState,
    },
    config: {
      agentIds: classroom.map((member) => member.id),
      agentConfigs: classroom,
      sessionType: 'qa',
      ...config,
    },
    apiKey: '',
  } as unknown as StatelessChatRequest;
}

const memory: NonNullable<StatelessChatRequest['config']['classMemory']> = {
  entries: [
    {
      kind: 'qa',
      sceneId: 'p1',
      learnerQuestion: '叠加是相加吗？',
      points: [
        { agentId: 't', gist: '对，位移直接相加。' },
        { agentId: 's1', gist: '那两个波峰就更高了？' },
      ],
    },
    {
      kind: 'discussion',
      sceneId: 'p1',
      points: [{ agentId: 's2', gist: '我觉得小思说得对！' }],
    },
    {
      kind: 'aside',
      sceneId: 'p2',
      learnerQuestion: '波峰遇波谷会怎样？',
      points: [{ agentId: 'a', gist: '会抵消，像反方向推门。' }],
      unresolved: true,
    },
  ],
  olderTallies: [{ agentId: 't', turns: 3 }],
  learner: { missedConcepts: ['相位'], repeatedQuestions: ['相位差是什么意思？'] },
};

describe('class presence for the director (I06)', () => {
  const presence = {
    agents: [
      { agentId: 't', turns: 4, lastSceneId: 'p2', learnerTurnsSince: 0 },
      { agentId: 'a', turns: 0 },
      { agentId: 's1', turns: 1, lastSceneId: 'p1', learnerTurnsSince: 3 },
    ],
    moments: [
      { actionId: 'd1', outcome: 'skipped' as const },
      { actionId: 'd0', outcome: 'joined' as const },
    ],
  };

  it('states who has spoken, when, and how the lecture moments went', () => {
    const section = buildClassPresenceSection(makeBody({ classPresence: presence }), classroom);

    expect(section).toContain('# Class presence so far');
    expect(section).toContain(
      '- 林老师 (teacher): spoke 4 times; last on page 2; the learner has not written since.',
    );
    expect(section).toContain('- 小禾 (teaching assistant): has not spoken yet.');
    expect(section).toContain(
      '- 小思 (student): spoke 1 time; last on page 1; the learner has written 3 messages since.',
    );
    expect(section).toContain('- Page 1: 小思 raised «为什么会抵消？»; the learner skipped it.');
    // A legacy moment without an opener belongs to the teacher
    expect(section).toContain('- Page 1: 林老师 raised «大家猜猜会怎样？»; the learner joined');
    // Facts only: no agent without an entry, no instruction
    expect(section).not.toContain('阿杰');
    expect(section).not.toMatch(/\b(should|must)\b/);
  });

  it('lists the newest moments and only counts the older ones', () => {
    const scenes = [
      {
        id: 'p1',
        title: 'One',
        order: 1,
        type: 'slide',
        content: { type: 'slide', canvas: { elements: [] } },
        actions: Array.from({ length: 11 }, (_, index) => ({
          id: `m${index}`,
          type: 'discussion',
          topic: `topic ${index}`,
          agentId: 's1',
        })),
      },
    ] as unknown as StatelessChatRequest['storeState']['scenes'];
    const moments = Array.from({ length: 11 }, (_, index) => ({
      actionId: `m${index}`,
      outcome: index < 2 ? ('auto_skipped' as const) : ('joined' as const),
    }));
    const section = buildClassPresenceSection(
      makeBody({ classPresence: { agents: [], moments } }, { scenes }),
      classroom,
    );

    const listed = section.split('\n').filter((line) => line.startsWith('- Page'));
    expect(listed).toHaveLength(PRESENCE_MOMENTS_LISTED_MAX);
    expect(section).toContain('«topic 10»');
    expect(section).not.toContain('«topic 2»');
    expect(section).toContain('(3 earlier moments not listed: auto skipped 2, joined 1)');
  });

  it('renders nothing without presence, and in the dynamic tail of the director prompt', () => {
    expect(buildClassPresenceSection(makeBody(), classroom)).toBe('');

    const prompt = buildDirectorPrompt(makeBody({ classPresence: presence }), classroom, 4);
    const tail = prompt.split(PROMPT_CACHE_BREAK).at(-1) ?? '';
    expect(tail).toContain('# Class presence so far');
    expect(prompt.split(PROMPT_CACHE_BREAK)[0]).not.toContain('# Class presence so far');

    // An aside's director casts only the assistant: no presence facts there
    const aside = buildDirectorPrompt(
      makeBody({ classPresence: presence, asideToLecture: true }),
      [assistant],
      1,
    );
    expect(aside).not.toContain('# Class presence so far');
  });
});

describe('class memory (I13)', () => {
  it('gives the director every exchange, the learner and the callback rule', () => {
    const section = buildClassMemoryDirectorSection(makeBody({ classMemory: memory }), classroom);

    expect(section).toContain('Before these (not listed one by one), spoke: 林老师 3 times.');
    expect(section).toContain(
      '- Page 1, Q&A: the learner asked «叠加是相加吗？»; 林老师 said «对，位移直接相加。»; 小思 said «那两个波峰就更高了？».',
    );
    expect(section).toContain(
      '- Page 2, side answer during the lecture: the learner asked «波峰遇波谷会怎样？»; 小禾 said «会抵消，像反方向推门。». The learner was still unsure at the end.',
    );
    expect(section).toContain('- Quiz concepts they got wrong: 相位');
    expect(section).toContain('- Questions they asked more than once: «相位差是什么意思？»');
    expect(section).toContain('never mention quiz scores or grades unless the learner asks');

    const prompt = buildDirectorPrompt(makeBody({ classMemory: memory }), classroom, 4);
    expect(prompt.split(PROMPT_CACHE_BREAK).at(-1)).toContain('# Earlier in this class');
  });

  it('gives a student only its own slice: what it said, and what others said to or about it', () => {
    const section = buildClassMemoryChildSection(
      makeBody({ classMemory: memory }),
      student,
      classroom,
    );

    expect(section).toContain('you said «那两个波峰就更高了？»');
    expect(section).toContain('林老师 said «对，位移直接相加。»');
    // Named by a classmate: only the line that names them
    expect(section).toContain('- Page 1, discussion: 阿杰 said «我觉得小思说得对！».');
    // Not theirs: the assistant's side answer; never the learner's results
    expect(section).not.toContain('会抵消');
    expect(section).not.toContain('Quiz concepts');
    expect(section).not.toContain('相位差是什么意思');
  });

  it("gives the teacher the assistant's side answers, the open questions and the learner", () => {
    const section = buildClassMemoryChildSection(
      makeBody({ classMemory: memory }),
      teacher,
      classroom,
    );

    expect(section).toContain('小禾 said «会抵消，像反方向推门。»');
    expect(section).toContain('do not contradict them; if one was wrong, correct it openly');
    expect(section).toContain('- Quiz concepts they got wrong: 相位');
    expect(section).not.toContain('阿杰 said');
  });

  it('keeps an agent slice to the newest relevant exchanges', () => {
    const entries = Array.from({ length: CHILD_MEMORY_ENTRIES_MAX + 3 }, (_, index) => ({
      kind: 'qa' as const,
      points: [{ agentId: 's1', gist: `line ${index}` }],
    }));
    const section = buildClassMemoryChildSection(
      makeBody({ classMemory: { entries } }),
      student,
      classroom,
    );
    expect(section.split('\n').filter((line) => line.startsWith('- '))).toHaveLength(
      CHILD_MEMORY_ENTRIES_MAX,
    );
    expect(section).not.toContain('«line 2»');
    expect(section).toContain(`«line ${CHILD_MEMORY_ENTRIES_MAX + 2}»`);
  });

  it('puts the slice after the cache break of both child prompts', () => {
    const body = makeBody({ classMemory: memory });
    for (const prompt of [
      buildChildPrompt(body, student, [], []),
      buildNativeChildPrompt(body, student, [], []),
    ]) {
      const [stable, volatile] = prompt.split(PROMPT_CACHE_BREAK);
      expect(stable).toContain('You are 小思.');
      expect(stable).not.toContain('# Earlier in this class');
      expect(volatile).toContain('# Earlier in this class');
    }
  });
});

describe('where an agent stands now (I33)', () => {
  it('derives the latest line of the agent from the memory, bounded and latest only', () => {
    const body = makeBody({
      classMemory: {
        entries: [
          { kind: 'qa', sceneId: 'p1', points: [{ agentId: 's1', gist: '我还是不懂相位。' }] },
          {
            kind: 'discussion',
            sceneId: 'p2',
            points: [{ agentId: 's1', gist: '哦，原来是步调。' }],
          },
        ],
      },
    });

    expect(getAgentStateNote(body, 's1')).toEqual({
      text: '哦，原来是步调。',
      source: 'memory',
      sceneId: 'p2',
      kind: 'discussion',
    });
    expect(getAgentStateNote(body, 's2')).toBeUndefined();

    const section = buildClassMemoryChildSection(body, student, classroom);
    expect(section).toContain(
      'Where you stand now: the last thing you said in this class (page 2, discussion) was «哦，原来是步调。».',
    );
    expect(section).toContain('still found unclear, then still holds');
    // A student's state is never rewritten into its persona
    expect(buildChildPrompt(body, student, [], [])).toContain('小思有点害羞。');
  });

  it("prefers the request's own note, and words the carry-over by role", () => {
    const body = makeBody({
      classMemory: {
        entries: [{ kind: 'qa', points: [{ agentId: 't', gist: '位移直接相加。' }] }],
        agentNotes: [{ agentId: 's1', note: '第三页还困惑，现在刚弄明白一半。' }],
      },
    });

    expect(getAgentStateNote(body, 's1')).toEqual({
      text: '第三页还困惑，现在刚弄明白一半。',
      source: 'note',
    });
    expect(buildClassMemoryChildSection(body, student, classroom)).toContain(
      'it does not change who you are): «第三页还困惑，现在刚弄明白一半。»',
    );
    expect(buildClassMemoryChildSection(body, teacher, classroom)).toContain(
      'Stay consistent with it; if it needs correcting, correct it openly.',
    );
  });
});

describe('what the lecture just said (I14)', () => {
  it('takes the narration up to and including the current action', () => {
    const body = makeBody({}, { lectureProgress: { sceneId: 'p2', actionIndex: 2 } });

    expect(getLectureSoFar(body)?.text).toBe(
      '两列波相遇，相位差半个周期时会互相抵消。 这就是相消干涉。',
    );
    expect(getLectureSoFar(makeBody())).toBeUndefined();
    expect(
      getLectureSoFar(makeBody({}, { lectureProgress: { sceneId: 'p2', actionIndex: 1 } }))?.text,
    ).toBe('两列波相遇，相位差半个周期时会互相抵消。');
  });

  it('keeps only the last characters of a long narration', () => {
    const long = '很'.repeat(LECTURE_SO_FAR_MAX_CHARS * 2);
    const body = makeBody(
      {},
      {
        lectureProgress: { sceneId: 'p1', actionIndex: 1 },
        scenes: [
          {
            id: 'p1',
            title: 'One',
            order: 1,
            type: 'slide',
            content: { type: 'slide', canvas: { elements: [] } },
            actions: [
              { id: 'x', type: 'speech', text: `HEAD${long}` },
              { id: 'y', type: 'speech', text: 'TAIL' },
            ],
          },
        ] as unknown as StatelessChatRequest['storeState']['scenes'],
      },
    );
    const text = getLectureSoFar(body)?.text ?? '';
    expect(Array.from(text)).toHaveLength(LECTURE_SO_FAR_MAX_CHARS);
    expect(text.startsWith('…')).toBe(true);
    expect(text.endsWith('TAIL')).toBe(true);
    expect(text).not.toContain('HEAD');
  });

  it('goes to the teacher and assistant only', () => {
    const body = makeBody({}, { lectureProgress: { sceneId: 'p2', actionIndex: 2 } });

    expect(buildLectureSoFarSection(body, 'teacher')).toContain(
      'What you have said so far in the lecture on page 2 "干涉"',
    );
    expect(buildLectureSoFarSection(body, 'assistant')).toContain(
      'What the teacher has said so far in the lecture on page 2 "干涉"',
    );
    expect(buildLectureSoFarSection(body, 'student')).toBe('');

    expect(buildChildPrompt(body, assistant, [], [])).toContain('这就是相消干涉。');
    expect(buildChildPrompt(body, assistant, [], [])).not.toContain('NOT_SAID_YET');
    // A student is only reminded of what they heard of the page so far, as part
    // of what the lesson covered, never what is still to come
    const forStudent = buildChildPrompt(body, student, [], []);
    expect(forStudent).not.toContain('# What was just said on this page');
    expect(forStudent).not.toContain('NOT_SAID_YET');
  });

  it("has the aside assistant follow the teacher's explanation and point ahead", () => {
    const body = makeBody(
      { asideToLecture: true, agentIds: ['a'], agentConfigs: [assistant] },
      { lectureProgress: { sceneId: 'p2', actionIndex: 2 } },
    );
    const prompt = buildChildPrompt(body, assistant, [], []);

    expect(prompt).toContain('Explain it the way the teacher just put it');
    expect(prompt).toContain('老师下一页就讲');
    expect(prompt).toContain('# What was just said on this page');
  });
});
