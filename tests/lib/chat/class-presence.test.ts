import { describe, expect, it } from 'vitest';
import type { UIMessage } from 'ai';
import type { ChatMessageMetadata, ChatSession } from '@/lib/types/chat';
import { PI_REQUEST_BOUNDS } from '@/lib/types/chat';
import {
  buildClassPresence,
  collectLectureMoments,
  upsertLectureMomentBadge,
  withRequestMessages,
} from '@/lib/chat/class-presence';
import { buildLectureNoteMoments, isMissedMoment } from '@/lib/chat/lecture-notes';
import type { Scene } from '@/lib/types/stage';

type Message = UIMessage<ChatMessageMetadata>;

function agentLine(
  agentId: string,
  text: string,
  createdAt: number,
  extra: Partial<ChatMessageMetadata> = {},
): Message {
  return {
    id: `a-${agentId}-${createdAt}`,
    role: 'assistant',
    parts: [{ type: 'text', text }],
    metadata: { agentId, senderName: agentId, createdAt, ...extra },
  };
}

function learnerLine(text: string, createdAt: number): Message {
  return {
    id: `u-${createdAt}`,
    role: 'user',
    parts: [{ type: 'text', text }],
    metadata: { senderName: 'You', originalRole: 'user', createdAt },
  };
}

function session(
  id: string,
  type: ChatSession['type'],
  messages: Message[],
  extra: Partial<ChatSession> = {},
): ChatSession {
  return {
    id,
    type,
    title: id,
    status: 'completed',
    messages,
    config: { agentIds: [] },
    toolCalls: [],
    pendingToolCalls: [],
    createdAt: messages[0]?.metadata?.createdAt ?? 0,
    updatedAt: 0,
    ...extra,
  };
}

function badge(discussionActionId: string, outcome?: string, agentId?: string) {
  return {
    type: 'action-discussion',
    actionId: `discussion-${discussionActionId}`,
    actionName: 'discussion',
    input: {
      topic: `topic ${discussionActionId}`,
      discussionActionId,
      ...(agentId ? { agentId } : {}),
      ...(outcome ? { outcome } : {}),
    },
    state: 'result',
    output: { success: true },
  } as unknown as Message['parts'][number];
}

function lecture(id: string, sceneId: string, createdAt: number, parts: Message['parts']) {
  return session(
    id,
    'lecture',
    [
      {
        id: `lecture-${id}`,
        role: 'assistant',
        parts,
        metadata: { agentId: 'teacher', senderName: 'Ms. Lin', createdAt },
      },
    ],
    { sceneId, createdAt },
  );
}

describe('buildClassPresence: who has been present in this course', () => {
  it('counts visible turns in Q&A, discussion and aside sessions, never the lecture', () => {
    const presence = buildClassPresence({
      agentIds: ['teacher', 'ta', 'mia', 'leo'],
      sessions: [
        lecture('lec-1', 'scene-1', 1, [{ type: 'text', text: 'Narration' }]),
        session('qa-1', 'qa', [learnerLine('Why?', 10), agentLine('teacher', 'Because.', 11)], {
          sceneId: 'scene-1',
        }),
        session(
          'disc-1',
          'discussion',
          [
            agentLine('mia', 'I think they cancel?', 20),
            agentLine('teacher', 'Close — what about friction?', 21),
            learnerLine('Friction slows it', 22),
            agentLine('mia', 'Oh right!', 23),
          ],
          { sceneId: 'scene-3' },
        ),
        // The teaching assistant's aside (a Q&A session marked aside)
        session('aside-1', 'qa', [learnerLine('Units?', 30), agentLine('ta', 'Newtons.', 31)], {
          sceneId: 'scene-4',
          config: { agentIds: ['ta'], aside: true },
        }),
      ],
    });

    expect(presence?.agents).toEqual([
      { agentId: 'teacher', turns: 2, lastSceneId: 'scene-3', learnerTurnsSince: 2 },
      { agentId: 'ta', turns: 1, lastSceneId: 'scene-4', learnerTurnsSince: 0 },
      { agentId: 'mia', turns: 2, lastSceneId: 'scene-3', learnerTurnsSince: 1 },
      // Never spoke: 0 turns, no last scene, nothing since
      { agentId: 'leo', turns: 0 },
    ]);
    expect(presence).not.toHaveProperty('moments');
  });

  it('leaves out lines that were cut off or only "...", and messages without an agent', () => {
    const presence = buildClassPresence({
      agentIds: ['mia'],
      sessions: [
        session('qa-1', 'qa', [
          agentLine('mia', 'Half a thou...', 1, { interrupted: true }),
          agentLine('mia', '...', 2),
          agentLine('mia', ' … ', 3),
          { ...agentLine('mia', 'System error', 4), metadata: { senderName: 'System' } },
        ]),
      ],
    });
    expect(presence?.agents).toEqual([{ agentId: 'mia', turns: 0 }]);
  });

  it('orders learner messages and turns by time across sessions', () => {
    const presence = buildClassPresence({
      agentIds: ['mia'],
      sessions: [
        // A later session listed first: time decides, not list order
        session('qa-2', 'qa', [learnerLine('Again?', 50)]),
        session('qa-1', 'qa', [agentLine('mia', 'Me!', 10), learnerLine('Ok', 20)], {
          sceneId: 'scene-2',
        }),
      ],
    });
    expect(presence?.agents).toEqual([
      { agentId: 'mia', turns: 1, lastSceneId: 'scene-2', learnerTurnsSince: 2 },
    ]);
  });

  it('carries the lecture moments with their latest outcome, oldest first, at most 64', () => {
    const presence = buildClassPresence({
      agentIds: ['teacher'],
      sessions: [
        lecture('lec-2', 'scene-2', 200, [badge('m3', 'joined')]),
        lecture('lec-1', 'scene-1', 100, [
          badge('m1', 'skipped'),
          badge('m2', 'not_shown'),
          // Replayed: the latest outcome, at its latest position
          badge('m1', 'auto_skipped'),
          // Persisted before badges carried an outcome: left out
          badge('legacy'),
        ]),
      ],
    });
    expect(presence?.moments).toEqual([
      { actionId: 'm2', outcome: 'not_shown' },
      { actionId: 'm1', outcome: 'auto_skipped' },
      { actionId: 'm3', outcome: 'joined' },
    ]);

    const many = lecture(
      'lec-many',
      'scene-9',
      1,
      Array.from({ length: PI_REQUEST_BOUNDS.presenceMomentsMax + 6 }, (_, i) =>
        badge(`m${i}`, 'skipped'),
      ),
    );
    const capped = buildClassPresence({ agentIds: ['teacher'], sessions: [many] })!;
    expect(capped.moments).toHaveLength(PI_REQUEST_BOUNDS.presenceMomentsMax);
    // The newest are kept
    expect(capped.moments!.at(-1)?.actionId).toBe(`m${PI_REQUEST_BOUNDS.presenceMomentsMax + 5}`);
  });

  it('clamps counts and needs at least one agent', () => {
    const lines = Array.from({ length: PI_REQUEST_BOUNDS.presenceCountMax + 3 }, (_, i) =>
      agentLine('mia', 'Hi', i + 1),
    );
    const presence = buildClassPresence({
      agentIds: ['mia', 'mia'],
      sessions: [session('qa', 'qa', lines)],
    });
    expect(presence?.agents).toHaveLength(1);
    expect(presence?.agents[0].turns).toBe(PI_REQUEST_BOUNDS.presenceCountMax);
    expect(buildClassPresence({ agentIds: [], sessions: [] })).toBeUndefined();
  });

  it("counts the request's own messages, even before the session list shows them", () => {
    const sessions = [session('qa-1', 'qa', [agentLine('mia', 'Me!', 10)], { sceneId: 's1' })];
    const withFollowUp = withRequestMessages(sessions, {
      sessionId: 'qa-1',
      type: 'qa',
      messages: [agentLine('mia', 'Me!', 10), learnerLine('And then?', 20)],
    });
    expect(buildClassPresence({ agentIds: ['mia'], sessions: withFollowUp })?.agents[0]).toEqual({
      agentId: 'mia',
      turns: 1,
      lastSceneId: 's1',
      learnerTurnsSince: 1,
    });

    // A session created a moment ago is added
    const withNew = withRequestMessages(sessions, {
      sessionId: 'qa-2',
      type: 'qa',
      sceneId: 's2',
      messages: [learnerLine('New question', 30)],
    });
    expect(withNew).toHaveLength(2);
    expect(withNew[1]).toMatchObject({ id: 'qa-2', type: 'qa', sceneId: 's2' });
    expect(buildClassPresence({ agentIds: ['mia'], sessions: withNew })?.agents[0]).toMatchObject({
      learnerTurnsSince: 1,
    });
  });
});

describe('lecture moment badges', () => {
  it('writes one badge per moment: a new outcome replaces the old one and goes last', () => {
    const text = { type: 'text', text: 'Narration' } as Message['parts'][number];
    const first = upsertLectureMomentBadge(
      [text],
      { topic: 'Why?', discussionActionId: 'm1', agentId: 'mia', outcome: 'skipped' },
      1,
    );
    const second = upsertLectureMomentBadge(
      [...first, badge('m2', 'joined')],
      { topic: 'Why?', discussionActionId: 'm1', agentId: 'mia', outcome: 'joined' },
      2,
    );
    expect(second).toHaveLength(3);
    expect(second[0]).toBe(text);
    expect(
      second.map((part) => (part as { input?: { discussionActionId?: string } }).input),
    ).toMatchObject([
      undefined,
      { discussionActionId: 'm2' },
      { discussionActionId: 'm1', outcome: 'joined' },
    ]);
    expect(second[2]).toMatchObject({
      type: 'action-discussion',
      actionName: 'discussion',
      actionId: 'discussion-2',
      state: 'result',
    });
  });

  it("collects each moment's page and opener for the notes", () => {
    const moments = collectLectureMoments([
      lecture('lec-1', 'scene-1', 1, [badge('m1', 'auto_skipped', 'mia')]),
    ]);
    expect(moments).toEqual([
      expect.objectContaining({
        discussionActionId: 'm1',
        outcome: 'auto_skipped',
        agentId: 'mia',
        sceneId: 'scene-1',
      }),
    ]);

    const scenes = [
      {
        id: 'scene-1',
        actions: [
          { id: 's1', type: 'speech', text: 'Line' },
          { id: 'm1', type: 'discussion', topic: 'Why?', prompt: 'Predict' },
          { id: 'm2', type: 'discussion', topic: 'How?', agentId: 'leo' },
        ],
      },
    ] as unknown as Scene[];
    const notes = buildLectureNoteMoments(scenes, moments);
    // The badge names the opener actually used (here a legacy moment's teacher stand-in)
    expect(notes.get('m1')).toEqual({
      sceneId: 'scene-1',
      actionId: 'm1',
      topic: 'Why?',
      prompt: 'Predict',
      agentId: 'mia',
      outcome: 'auto_skipped',
    });
    // Not come up yet: the action's own opener, no outcome
    expect(notes.get('m2')).toEqual({
      sceneId: 'scene-1',
      actionId: 'm2',
      topic: 'How?',
      agentId: 'leo',
    });
    expect(isMissedMoment('skipped')).toBe(true);
    expect(isMissedMoment('auto_skipped')).toBe(true);
    expect(isMissedMoment('joined')).toBe(false);
    expect(isMissedMoment('not_shown')).toBe(false);
    expect(isMissedMoment(undefined)).toBe(false);
  });
});
