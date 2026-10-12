/**
 * The class memory a Pi request carries (I13, I14.3): one entry per earlier
 * exchange — the learner's question in a sentence, each speaker's gist cut
 * from what they said — older entries folded into per-speaker counts, the
 * learner's missed quiz concepts (no answers) and repeated questions, all
 * within the route's text budget.
 */
import { describe, expect, it, vi } from 'vitest';
import type { UIMessage } from 'ai';
import type { ChatMessageMetadata, ChatSession, SessionConfig } from '@/lib/types/chat';
import { PI_REQUEST_BOUNDS } from '@/lib/types/chat';
import {
  buildClassMemory,
  classMemoryEntryKind,
  cutText,
  findRepeatedQuestions,
  loadQuizMisses,
  questionSentence,
  quizMissedConcepts,
} from '@/lib/chat/class-memory';

type Message = UIMessage<ChatMessageMetadata>;

let clock = 1_000;
function user(text: string): Message {
  clock += 10;
  return {
    id: `u-${clock}`,
    role: 'user',
    parts: [{ type: 'text', text }],
    metadata: { createdAt: clock },
  };
}
function agent(agentId: string, text: string, extra: Partial<ChatMessageMetadata> = {}): Message {
  clock += 10;
  return {
    id: `a-${clock}`,
    role: 'assistant',
    parts: [{ type: 'text', text }],
    metadata: { agentId, createdAt: clock, ...extra },
  };
}
function session(
  id: string,
  type: ChatSession['type'],
  messages: Message[],
  config: Partial<SessionConfig> = {},
  sceneId = 'scene-1',
): ChatSession {
  clock += 10;
  return {
    id,
    type,
    title: id,
    status: 'completed',
    messages,
    config: { agentIds: [], ...config },
    toolCalls: [],
    pendingToolCalls: [],
    sceneId,
    createdAt: clock,
    updatedAt: clock,
  };
}

const AGENTS = ['teacher', 'ta', 'mia'];
const charLength = (text: string) => Array.from(text).length;

describe('text cuts', () => {
  it('cuts by characters, ending in … within the limit', () => {
    expect(cutText('  short   text ', 60)).toBe('short text');
    const cut = cutText('相'.repeat(80), 60);
    expect(charLength(cut)).toBe(60);
    expect(cut.endsWith('…')).toBe(true);
  });

  it('keeps the sentence that asks, else a sentence long enough to stand alone', () => {
    expect(questionSentence('我看了这个图。为什么这里是负的？还有别的吗', 120)).toBe(
      '为什么这里是负的？',
    );
    expect(questionSentence('Hmm. I do not get the phase part. Anything else', 120)).toBe(
      'Hmm. I do not get the phase part.',
    );
    expect(questionSentence('Version 3.5 is out now', 120)).toBe('Version 3.5 is out now');
  });
});

describe('classMemoryEntryKind', () => {
  it('tells asides, Q&A, lecture moments and quiz reviews apart', () => {
    expect(classMemoryEntryKind(session('a', 'qa', [], { aside: true }))).toBe('aside');
    expect(classMemoryEntryKind(session('q', 'qa', []))).toBe('qa');
    expect(
      classMemoryEntryKind(session('d', 'discussion', [], { momentKind: 'ask-learner' })),
    ).toBe('lecture-moment');
    expect(classMemoryEntryKind(session('l', 'discussion', []))).toBe('lecture-moment');
    expect(
      classMemoryEntryKind(session('r', 'discussion', [], { momentKind: 'quiz-review' })),
    ).toBe('discussion');
  });
});

describe('buildClassMemory', () => {
  it('remembers who said what, in speaking order, and what the learner asked', () => {
    const aside = session(
      'aside-1',
      'qa',
      [
        user('老师刚才说的相位差是什么意思？'),
        agent('ta', '就是两列波错开了多少，比如两个人跳绳一个快半拍。'),
      ],
      { aside: true },
    );
    const moment = session(
      'moment-1',
      'discussion',
      [
        agent('mia', 'Wait, they cancel completely?'),
        agent('teacher', 'Only where crest meets trough.'),
        agent('mia', 'Oh, not everywhere!'),
      ],
      { momentKind: 'lecture' },
      'scene-2',
    );
    const memory = buildClassMemory({ sessions: [aside, moment], agentIds: AGENTS });
    expect(memory?.entries).toEqual([
      {
        kind: 'aside',
        sceneId: 'scene-1',
        learnerQuestion: '老师刚才说的相位差是什么意思？',
        points: [{ agentId: 'ta', gist: '就是两列波错开了多少，比如两个人跳绳一个快半拍。' }],
      },
      {
        kind: 'lecture-moment',
        sceneId: 'scene-2',
        points: [
          {
            agentId: 'mia',
            gist: 'Wait, they cancel completely? Oh, not everywhere!',
          },
          { agentId: 'teacher', gist: 'Only where crest meets trough.' },
        ],
      },
    ]);
    // Nothing but the cut words: no paraphrase, within the gist bound
    for (const entry of memory!.entries) {
      for (const point of entry.points) {
        expect(charLength(point.gist)).toBeLessThanOrEqual(PI_REQUEST_BOUNDS.memoryGistMaxChars);
      }
    }
  });

  it('leaves out the requesting session, other agents, empty and cut-off turns', () => {
    const earlier = session('qa-1', 'qa', [
      agent('stranger', 'I am not in this class.'),
      user('Why are leaves green?'),
      agent('teacher', '...', { interrupted: true }),
      agent('teacher', 'Chlorophyll reflects green light...', { interrupted: true }),
    ]);
    const current = session('qa-2', 'qa', [user('And in autumn?')]);
    const memory = buildClassMemory({
      sessions: [earlier, current],
      agentIds: AGENTS,
      excludeSessionId: 'qa-2',
    });
    expect(memory?.entries).toEqual([
      {
        kind: 'qa',
        sceneId: 'scene-1',
        learnerQuestion: 'Why are leaves green?',
        points: [{ agentId: 'teacher', gist: 'Chlorophyll reflects green light' }],
        // The only answer was cut off: the learner's question stayed open
        unresolved: true,
      },
    ]);
  });

  it('marks an exchange open when the learner had the last word', () => {
    const memory = buildClassMemory({
      sessions: [
        session('qa-1', 'qa', [
          user('What is a node?'),
          agent('teacher', 'A point that never moves.'),
          user('Why does it never move?'),
        ]),
        session('qa-2', 'qa', [user('What is an antinode?'), agent('teacher', 'The opposite.')]),
      ],
      agentIds: AGENTS,
    });
    expect(memory?.entries.map((entry) => entry.unresolved)).toEqual([true, undefined]);
  });

  it('folds entries past the newest twelve into per-speaker counts', () => {
    const sessions = Array.from({ length: 15 }, (_, index) =>
      session(`qa-${index}`, 'qa', [
        user(`Question number ${index}?`),
        agent('teacher', `Answer ${index}`),
        ...(index < 2 ? [agent('mia', `Me too ${index}`)] : []),
      ]),
    );
    const memory = buildClassMemory({ sessions, agentIds: AGENTS });
    expect(memory?.entries).toHaveLength(PI_REQUEST_BOUNDS.memoryEntriesMax);
    expect(memory?.entries[0].learnerQuestion).toBe('Question number 3?');
    expect(memory?.olderTallies).toEqual([
      { agentId: 'teacher', turns: 3 },
      { agentId: 'mia', turns: 2 },
    ]);
  });

  it('stays within the text budget, dropping the oldest entries first', () => {
    const long = (seed: string) => `${seed} ${'很长的解释'.repeat(30)}`;
    const sessions = Array.from({ length: 12 }, (_, index) =>
      session(`qa-${index}`, 'qa', [
        user(`${'为什么'.repeat(30)}${index}？`),
        agent('teacher', long(`T${index}`)),
        agent('ta', long(`A${index}`)),
        agent('mia', long(`M${index}`)),
      ]),
    );
    const memory = buildClassMemory({ sessions, agentIds: AGENTS })!;
    const total =
      memory.entries.reduce(
        (sum, entry) =>
          sum +
          charLength(entry.learnerQuestion ?? '') +
          entry.points.reduce((points, point) => points + charLength(point.gist), 0),
        0,
      ) +
      (memory.learner?.missedConcepts ?? []).reduce((sum, item) => sum + charLength(item), 0) +
      (memory.learner?.repeatedQuestions ?? []).reduce((sum, item) => sum + charLength(item), 0);
    expect(total).toBeLessThanOrEqual(PI_REQUEST_BOUNDS.memoryTotalMaxChars);
    expect(memory.entries.length).toBeLessThan(12);
    // The newest survive; the dropped ones still count per speaker
    expect(memory.entries.at(-1)?.points[0].gist.startsWith('T11')).toBe(true);
    expect(memory.olderTallies?.find((tally) => tally.agentId === 'teacher')?.turns).toBe(
      12 - memory.entries.length,
    );
  });

  it('adds the learner: missed quiz concepts and repeated questions', () => {
    const sessions = [
      session('qa-1', 'qa', [user('What is a standing wave?'), agent('teacher', 'Two waves.')]),
      session('qa-2', 'qa', [user('what is a standing wave'), agent('teacher', 'Again: two.')]),
    ];
    const memory = buildClassMemory({
      sessions,
      agentIds: AGENTS,
      quizMisses: [{ sceneId: 'quiz-1', concepts: ['Where does photosynthesis happen?'] }],
    });
    expect(memory?.learner).toEqual({
      missedConcepts: ['Where does photosynthesis happen?'],
      repeatedQuestions: ['What is a standing wave?'],
    });
  });

  it('leaves unnamed a page no longer in the course', () => {
    const memory = buildClassMemory({
      sessions: [
        session('qa-1', 'qa', [user('Why?'), agent('teacher', 'Because.')], {}, 'gone'),
        session('qa-2', 'qa', [user('How?'), agent('teacher', 'Like so.')], {}, 'scene-1'),
      ],
      agentIds: AGENTS,
      sceneIds: new Set(['scene-1']),
    });
    expect(memory?.entries.map((entry) => entry.sceneId)).toEqual([undefined, 'scene-1']);
  });

  it('is absent when there is nothing to remember', () => {
    expect(buildClassMemory({ sessions: [], agentIds: AGENTS })).toBeUndefined();
    expect(
      buildClassMemory({
        sessions: [session('qa-1', 'qa', [user('Hi?')])],
        agentIds: AGENTS,
        excludeSessionId: 'qa-1',
      }),
    ).toBeUndefined();
  });
});

describe('findRepeatedQuestions', () => {
  it('counts questions asked again, not quick replies or answers to a moment', () => {
    const sessions = [
      session('qa-1', 'qa', [user('为什么会抵消？'), agent('teacher', '因为相位相反。')]),
      session('d-1', 'discussion', [agent('teacher', '你们猜猜？'), user('我不太确定')], {
        momentKind: 'ask-learner',
      }),
      session('d-2', 'discussion', [agent('teacher', '再猜猜？'), user('我不太确定')], {
        momentKind: 'ask-learner',
      }),
      session('qa-2', 'qa', [user('为什么两列波会抵消？'), agent('teacher', '相位相反。')]),
      session('qa-3', 'qa', [user('为什么会抵消呢？')]),
    ];
    expect(findRepeatedQuestions(sessions)).toEqual(['为什么会抵消？']);
  });
});

describe('quiz misses', () => {
  const questions = [
    { id: 'q1', question: 'What colour is chlorophyll?' },
    { id: 'q2', question: 'Where does photosynthesis happen?' },
  ];

  it('names the stems answered wrong, never the answers', () => {
    expect(
      quizMissedConcepts(questions, [
        { questionId: 'q1', status: 'correct' },
        { questionId: 'q2', status: 'incorrect' },
      ]),
    ).toEqual(['Where does photosynthesis happen?']);
  });

  it('loads every reviewed quiz in page order and leaves out the rest', async () => {
    const quiz = (id: string, order: number) => ({
      id,
      type: 'quiz',
      stageId: 'stage-1',
      order,
      content: { type: 'quiz', questions },
    });
    const load = vi.fn(async ({ sceneId }: { sceneId: string }) => {
      if (sceneId === 'quiz-b') throw new Error('offline');
      if (sceneId === 'quiz-c') return { state: { phase: 'submitted' } };
      return {
        state: {
          phase: 'reviewed',
          results: [
            { questionId: 'q1', correct: false, status: 'incorrect' as const, earned: 0 },
            { questionId: 'q2', correct: true, status: 'correct' as const, earned: 1 },
          ],
        },
      };
    });
    const misses = await loadQuizMisses(
      [
        quiz('quiz-b', 2),
        { id: 'slide', type: 'slide', stageId: 'stage-1', order: 0 },
        quiz('quiz-a', 1),
        quiz('quiz-c', 3),
      ],
      { load },
    );
    expect(misses).toEqual([{ sceneId: 'quiz-a', concepts: ['What colour is chlorophyll?'] }]);
    expect(load).toHaveBeenCalledTimes(3);
  });

  it('touches nothing without a quiz, and gives up on a slow one', async () => {
    const load = vi.fn();
    await expect(loadQuizMisses([{ id: 's', type: 'slide' }], { load })).resolves.toEqual([]);
    expect(load).not.toHaveBeenCalled();

    const never = vi.fn(() => new Promise<never>(() => undefined));
    await expect(
      loadQuizMisses(
        [
          {
            id: 'q',
            type: 'quiz',
            stageId: 'st',
            content: { type: 'quiz', questions: [{ id: 'q1', question: 'x' }] },
          },
        ],
        { load: never, timeoutMs: 5 },
      ),
    ).resolves.toEqual([]);
  });
});
