/**
 * The Pi route bounds the optional persona and classroom context of a request
 * (discussion moment, presence, memory, lecture progress, locale): text is
 * trimmed and cut, ids must resolve to this request's agents and stage, and
 * whatever is malformed is dropped. None of it ever refuses the turn.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import { PI_REQUEST_BOUNDS, type StatelessChatRequest } from '@/lib/types/chat';

const PI_CHAT_FLAG = 'NEXT_PUBLIC_PI_CHAT_ENABLED';
let originalPiChatFlag: string | undefined;

const mocks = vi.hoisted(() => ({
  resolveModel: vi.fn(),
  runPiDirectorLoop: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock('@/lib/server/resolve-model', () => ({ resolveModel: mocks.resolveModel }));
vi.mock('@/lib/ai/providers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/providers')>()),
  isProviderKeyRequired: vi.fn(() => false),
}));
vi.mock('@/lib/live-mode', () => ({ isLiveMode: false }));
vi.mock('@/lib/chat/pi/director-loop', () => ({ runPiDirectorLoop: mocks.runPiDirectorLoop }));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: mocks.logWarn, error: vi.fn(), debug: vi.fn() }),
}));

function agentConfig(id: string, role: string, persona = `${id} speaks briefly.`) {
  return {
    id,
    name: id,
    role,
    persona,
    priority: role === 'teacher' ? 10 : 5,
    avatar: '',
    color: '#3366ff',
    allowedActions: [],
  };
}

function makeBody(
  overrides: {
    config?: Record<string, unknown>;
    storeState?: Record<string, unknown>;
    [key: string]: unknown;
  } = {},
) {
  const { config, storeState, ...rest } = overrides;
  return {
    messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Why?' }] }],
    storeState: {
      stage: { id: 'stage-1', name: 'Waves' },
      scenes: [
        {
          id: 'scene-1',
          title: 'Phase',
          order: 1,
          type: 'slide',
          content: { type: 'slide', canvas: { elements: [] } },
          actions: [
            { id: 'speech-1', type: 'speech', text: 'Two waves meet.' },
            { id: 'disc-1', type: 'discussion', topic: 'Why do they cancel?', agentId: 'student' },
          ],
        },
        {
          id: 'scene-2',
          title: 'Beats',
          order: 2,
          type: 'slide',
          content: { type: 'slide', canvas: { elements: [] } },
          actions: [],
        },
      ],
      currentSceneId: 'scene-1',
      mode: 'playback',
      whiteboardOpen: false,
      ...storeState,
    },
    config: {
      agentIds: ['teacher', 'assistant', 'student'],
      agentConfigs: [
        agentConfig('teacher', 'teacher'),
        agentConfig('assistant', 'assistant'),
        agentConfig('student', 'student'),
      ],
      ...config,
    },
    apiKey: '',
    model: 'test:model',
    ...rest,
  };
}

async function post(body: Record<string, unknown>) {
  const { POST } = await import('@/app/api/chat/pi/route');
  const response = await POST(
    new Request('http://localhost/api/chat/pi', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }) as unknown as NextRequest,
  );
  await response.text();
  return response;
}

/** The body the director loop was started with */
function directorBody(): StatelessChatRequest {
  expect(mocks.runPiDirectorLoop).toHaveBeenCalledTimes(1);
  return (mocks.runPiDirectorLoop.mock.calls[0][0] as { body: StatelessChatRequest }).body;
}

function warnings(): string {
  return mocks.logWarn.mock.calls.map((call) => String(call[0])).join('\n');
}

describe('POST /api/chat/pi classroom context bounds', () => {
  beforeEach(() => {
    originalPiChatFlag = process.env[PI_CHAT_FLAG];
    process.env[PI_CHAT_FLAG] = 'true';
    vi.resetModules();
    mocks.resolveModel.mockReset();
    mocks.runPiDirectorLoop.mockReset();
    mocks.logWarn.mockReset();
    mocks.resolveModel.mockResolvedValue({
      model: { id: 'language-model' },
      apiKey: 'resolved-key',
      providerId: 'test-provider',
      modelInfo: { outputWindow: 4096 },
      thinkingConfig: { mode: 'disabled', enabled: false },
    });
    mocks.runPiDirectorLoop.mockResolvedValue(undefined);
  });

  afterEach(() => {
    if (originalPiChatFlag === undefined) delete process.env[PI_CHAT_FLAG];
    else process.env[PI_CHAT_FLAG] = originalPiChatFlag;
  });

  it('passes well-formed context through untouched and logs nothing', async () => {
    const context = {
      sessionType: 'discussion',
      discussionTopic: 'Why do they cancel?',
      discussionPrompt: 'Let the class guess before explaining superposition.',
      triggerAgentId: 'teacher',
      momentKind: 'ask-learner',
      learnerStance: 'listen',
      addressedAgentIds: ['student'],
      teacherMayCallOnLearner: false,
      classPresence: {
        agents: [
          { agentId: 'student', turns: 2, lastSceneId: 'scene-1', learnerTurnsSince: 1 },
          { agentId: 'assistant', turns: 0 },
        ],
        moments: [{ actionId: 'disc-1', outcome: 'skipped' }],
      },
      classMemory: {
        entries: [
          {
            kind: 'qa',
            sceneId: 'scene-1',
            learnerQuestion: 'What is a phase?',
            points: [{ agentId: 'teacher', gist: 'Where a wave is in its cycle.' }],
            unresolved: false,
          },
        ],
        olderTallies: [{ agentId: 'student', turns: 3 }],
        learner: { missedConcepts: ['phase difference'], repeatedQuestions: ['What is phase?'] },
      },
    };
    const response = await post(
      makeBody({
        config: context,
        storeState: { lectureProgress: { sceneId: 'scene-1', actionIndex: 1 } },
        uiLocale: 'en-US',
      }),
    );

    expect(response.status).toBe(200);
    const body = directorBody();
    expect(body.config).toMatchObject(context);
    expect(body.storeState.lectureProgress).toEqual({ sceneId: 'scene-1', actionIndex: 1 });
    expect(body.uiLocale).toBe('en-US');
    expect(mocks.logWarn).not.toHaveBeenCalled();
  });

  it('drops discussion fields that do not fit the session', async () => {
    await post(
      makeBody({
        config: {
          sessionType: 'qa',
          triggerAgentId: 'ghost',
          momentKind: 'ask-learner',
          learnerStance: 'listen',
          teacherMayCallOnLearner: 'yes',
        },
      }),
    );
    const config = directorBody().config;
    expect(config.triggerAgentId).toBeUndefined();
    expect(config.momentKind).toBeUndefined();
    expect(config.learnerStance).toBeUndefined();
    expect(config.teacherMayCallOnLearner).toBeUndefined();
    expect(warnings()).toContain('config.triggerAgentId');
  });

  it('keeps a stance only for an ask-learner moment, and only known kinds', async () => {
    await post(
      makeBody({
        config: { sessionType: 'discussion', momentKind: 'pop-quiz', learnerStance: 'answer' },
      }),
    );
    const config = directorBody().config;
    expect(config.momentKind).toBeUndefined();
    expect(config.learnerStance).toBeUndefined();
  });

  it('trims the moment text and cuts long personas instead of refusing', async () => {
    const longPersona = '人'.repeat(PI_REQUEST_BOUNDS.personaMaxChars + 50);
    const response = await post(
      makeBody({
        config: {
          sessionType: 'discussion',
          discussionTopic: `  ${'问'.repeat(PI_REQUEST_BOUNDS.discussionTopicMaxChars + 10)}  `,
          discussionPrompt: '   ',
          agentConfigs: [
            agentConfig('teacher', 'teacher', longPersona),
            agentConfig('assistant', 'assistant'),
            agentConfig('student', 'student'),
          ],
        },
      }),
    );

    expect(response.status).toBe(200);
    const config = directorBody().config;
    expect(Array.from(config.discussionTopic ?? '')).toHaveLength(
      PI_REQUEST_BOUNDS.discussionTopicMaxChars,
    );
    expect(config.discussionPrompt).toBeUndefined();
    expect(config.agentConfigs?.[0].persona).toHaveLength(PI_REQUEST_BOUNDS.personaMaxChars);
    expect(warnings()).toContain('config.agentConfigs[0].persona');
  });

  it('keeps only addressed agents of this classroom, once each', async () => {
    await post(
      makeBody({ config: { addressedAgentIds: ['student', 'ghost', 'student', 7, 'teacher'] } }),
    );
    expect(directorBody().config.addressedAgentIds).toEqual(['student', 'teacher']);

    mocks.runPiDirectorLoop.mockClear();
    await post(makeBody({ config: { addressedAgentIds: ['ghost'] } }));
    expect(directorBody().config.addressedAgentIds).toBeUndefined();
  });

  it('keeps presence facts that resolve, with the latest outcome of a replayed moment', async () => {
    await post(
      makeBody({
        config: {
          classPresence: {
            agents: [
              { agentId: 'student', turns: 4, lastSceneId: 'scene-gone', learnerTurnsSince: -1 },
              { agentId: 'student', turns: 9 },
              { agentId: 'ghost', turns: 1 },
              { agentId: 'assistant', turns: 'many' },
              { agentId: 'teacher', turns: 1e9 },
            ],
            moments: [
              { actionId: 'disc-1', outcome: 'auto_skipped' },
              { actionId: 'disc-unknown', outcome: 'joined' },
              { actionId: 'speech-1', outcome: 'joined' },
              { actionId: 'disc-1', outcome: 'joined' },
              { actionId: 'disc-1', outcome: 'maybe' },
            ],
          },
        },
      }),
    );
    expect(directorBody().config.classPresence).toEqual({
      agents: [
        { agentId: 'student', turns: 4 },
        { agentId: 'teacher', turns: PI_REQUEST_BOUNDS.presenceCountMax },
      ],
      moments: [{ actionId: 'disc-1', outcome: 'joined' }],
    });
  });

  it('drops presence that has nothing left', async () => {
    await post(
      makeBody({ config: { classPresence: { agents: [{ agentId: 'ghost', turns: 1 }] } } }),
    );
    expect(directorBody().config.classPresence).toBeUndefined();
  });

  it('bounds class memory: unknown speakers out, oldest entries first over budget', async () => {
    const gist = '要'.repeat(PI_REQUEST_BOUNDS.memoryGistMaxChars);
    const fullEntry = (index: number) => ({
      kind: 'discussion',
      sceneId: 'scene-2',
      learnerQuestion: `第${index}个问题`,
      points: Array.from({ length: 4 }, () => ({ agentId: 'student', gist })),
    });
    const entries = [
      { kind: 'gossip', points: [{ agentId: 'teacher', gist: 'x' }] },
      { kind: 'qa', points: [{ agentId: 'ghost', gist: 'unknown speaker' }] },
      ...Array.from({ length: 10 }, (_, index) => fullEntry(index)),
    ];
    await post(
      makeBody({
        config: {
          classMemory: {
            entries,
            learner: { missedConcepts: ['  ', 'superposition'], repeatedQuestions: 'nope' },
            agentNotes: [
              { agentId: 'student', note: 'still unsure about phase' },
              { agentId: 'student', note: 'second note for the same agent' },
            ],
          },
        },
      }),
    );
    const memory = directorBody().config.classMemory;
    expect(memory?.learner).toEqual({ missedConcepts: ['superposition'] });
    expect(memory?.agentNotes).toEqual([{ agentId: 'student', note: 'still unsure about phase' }]);
    // Each full entry is ~245 characters: only the newest ones fit in the budget
    const kept = memory?.entries ?? [];
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(10);
    expect(kept.at(-1)?.learnerQuestion).toBe('第9个问题');
    const total =
      kept.reduce(
        (sum, entry) =>
          sum +
          Array.from(entry.learnerQuestion ?? '').length +
          entry.points.reduce((points, point) => points + Array.from(point.gist).length, 0),
        0,
      ) +
      'superposition'.length +
      'still unsure about phase'.length;
    expect(total).toBeLessThanOrEqual(PI_REQUEST_BOUNDS.memoryTotalMaxChars);
  });

  it("keeps the rest of the class in an aside's memory, by the stage roster only", async () => {
    const memory = {
      entries: [
        {
          kind: 'qa',
          learnerQuestion: 'What is a phase?',
          points: [
            { agentId: 'teacher', gist: 'Where a wave is in its cycle.' },
            { agentId: 'student', gist: 'So it is like a clock hand?' },
            { agentId: 'ghost', gist: 'Not in this class.' },
          ],
        },
      ],
    };
    const asideBody = (asideToLecture: boolean) =>
      makeBody({
        config: {
          agentIds: ['assistant'],
          agentConfigs: [agentConfig('assistant', 'assistant')],
          asideToLecture,
          classMemory: memory,
        },
        storeState: {
          stage: {
            id: 'stage-1',
            name: 'Waves',
            generatedAgentConfigs: [{ id: 'teacher' }, { id: 'assistant' }],
            agentIds: ['student'],
          },
        },
      });

    await post(asideBody(true));
    expect(directorBody().config.classMemory?.entries[0].points.map((p) => p.agentId)).toEqual([
      'teacher',
      'student',
    ]);

    // Outside an aside the request's own agents decide, as before
    mocks.runPiDirectorLoop.mockClear();
    await post(asideBody(false));
    expect(directorBody().config.classMemory?.entries[0].points).toEqual([]);
  });

  it('keeps lecture progress only for a scene of this stage', async () => {
    await post(
      makeBody({ storeState: { lectureProgress: { sceneId: 'scene-x', actionIndex: 2 } } }),
    );
    expect(directorBody().storeState.lectureProgress).toBeUndefined();

    mocks.runPiDirectorLoop.mockClear();
    await post(
      makeBody({ storeState: { lectureProgress: { sceneId: 'scene-1', actionIndex: -1 } } }),
    );
    expect(directorBody().storeState.lectureProgress).toBeUndefined();
  });

  it('keeps only a supported interface locale', async () => {
    await post(makeBody({ uiLocale: 'xx-XX' }));
    expect(directorBody().uiLocale).toBeUndefined();

    mocks.runPiDirectorLoop.mockClear();
    await post(makeBody({ uiLocale: 'zh-CN' }));
    expect(directorBody().uiLocale).toBe('zh-CN');
  });
});
