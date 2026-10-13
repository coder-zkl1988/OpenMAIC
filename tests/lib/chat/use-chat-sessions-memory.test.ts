// @vitest-environment jsdom
/**
 * What every Pi request carries about the course besides presence: the class
 * memory (I13, an aside included, I14.3), how far the lecture got on this
 * page (I14), whether the teacher may call on the learner (I10.5), and the
 * kind of class moment a discussion is, with the learner's choice on a
 * whole-class question (I10) or no opener for a quiz review (I11).
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UIMessage } from 'ai';
import type { ChatMessageMetadata } from '@/lib/types/chat';

const mocks = vi.hoisted(() => ({
  stage: {
    stage: { id: 'stage-1' },
    chats: [] as unknown[],
    scenes: [{ id: 'scene-1', title: 'Leaves', actions: [] }] as unknown[],
    outlines: [] as unknown[],
    currentSceneId: 'scene-1',
    mode: 'playback',
    setChats: () => undefined,
  },
  settings: {
    selectedAgentIds: ['gen-student', 'gen-assistant', 'gen-teacher'] as string[],
    teacherMayCallOnLearner: false,
  },
  actionExecute: vi.fn(async (..._args: unknown[]) => undefined),
  agents: {
    'gen-teacher': {
      id: 'gen-teacher',
      name: 'Ms. Lin',
      role: 'teacher',
      persona: 'Patient physics teacher.',
      avatar: '/avatars/lin.png',
      color: '#2563eb',
      allowedActions: ['spotlight'],
      priority: 10,
      isGenerated: true,
    },
    'gen-assistant': {
      id: 'gen-assistant',
      name: 'Sam',
      role: 'assistant',
      persona: 'Helpful TA.',
      avatar: '/avatars/sam.png',
      color: '#10b981',
      allowedActions: [],
      priority: 7,
      isGenerated: true,
    },
    'gen-student': {
      id: 'gen-student',
      name: 'Mia',
      role: 'student',
      persona: 'Curious, guesses fast.',
      avatar: '/avatars/mia.png',
      color: '#f59e0b',
      allowedActions: [],
      priority: 5,
      isGenerated: true,
    },
  } as Record<string, unknown>,
}));

vi.mock('@/lib/store', () => ({
  useStageStore: Object.assign(
    (selector: (state: typeof mocks.stage) => unknown) => selector(mocks.stage),
    { getState: () => mocks.stage },
  ),
}));
vi.mock('@/lib/store/canvas', () => ({
  useCanvasStore: {
    getState: () => ({
      whiteboardOpen: false,
      whiteboardManualVisibilityRevision: 0,
      whiteboardClearing: false,
      runtimeWhiteboardProjection: null,
      setWhiteboardOpen: vi.fn(),
    }),
  },
}));
vi.mock('@/lib/store/settings', () => ({
  useSettingsStore: { getState: () => mocks.settings },
}));
vi.mock('@/lib/store/user-profile', () => ({
  useUserProfileStore: { getState: () => ({ nickname: '', bio: '' }) },
}));
vi.mock('@/lib/orchestration/registry/store', () => ({
  useAgentRegistry: { getState: () => ({ getAgent: (id: string) => mocks.agents[id] }) },
}));
vi.mock('@/lib/hooks/use-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/model-settings/capabilities', () => ({
  classroomChatUsable: () => true,
  loadModelCapabilities: async () => ({}),
}));
vi.mock('@/lib/config/feature-flags', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/config/feature-flags')>()),
  isPiChatEnabled: () => true,
}));
vi.mock('@/lib/interactive/chat-observation', () => ({
  sampleInteractiveState: async () => undefined,
}));
vi.mock('@/lib/chat/quiz-results-for-store-state', () => ({
  buildQuizResultsForStoreState: async () => undefined,
  didActiveSceneRemainUnchanged: () => true,
}));
vi.mock('@/lib/whiteboard/runtime/browser-projection', () => ({
  refreshWhiteboardRuntimeProjection: vi.fn(),
}));
vi.mock('@/lib/action/engine', () => ({
  ActionEngine: class {
    execute = mocks.actionExecute;
  },
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), info: vi.fn() } }));

import { useChatSessions } from '@/components/chat/use-chat-sessions';

/** One agent turn that hands the floor back to the learner (the session stays open) */
function turnEvents(agentId = 'gen-student', text = 'I guess they cancel out?') {
  return [
    { type: 'agent_start', data: { messageId: `m-${agentId}`, agentId, agentName: agentId } },
    { type: 'text_delta', data: { messageId: `m-${agentId}`, content: text } },
    { type: 'agent_end', data: { messageId: `m-${agentId}`, agentId } },
    { type: 'cue_user', data: { fromAgentId: agentId } },
    {
      type: 'done',
      data: { totalActions: 0, totalAgents: 1, agentHadContent: true, cueUserReceived: true },
    },
  ];
}

interface FakeRequest {
  body: { config: Record<string, unknown>; messages: UIMessage<ChatMessageMetadata>[] };
  signal: AbortSignal;
}

describe('useChatSessions: class memory, lecture progress and moment kinds', () => {
  let container: HTMLDivElement;
  let root: Root;
  let api: ReturnType<typeof useChatSessions>;
  let requests: FakeRequest[];
  let scripts: Array<{ events: unknown[]; hold?: boolean }>;
  let lectureProgress: { sceneId: string; actionIndex: number } | null;
  const callbacks = {
    onLiveSpeech: vi.fn(),
    onThinking: vi.fn(),
    onCueUser: vi.fn(),
    onActiveBubble: vi.fn(),
    onLiveSessionError: vi.fn(),
    onSoftCloseSession: vi.fn(),
    onStopSession: vi.fn(),
    onSegmentSealed: vi.fn(),
    shouldHoldAfterReveal: vi.fn(() => false),
  };

  function Probe({
    onResult,
  }: {
    readonly onResult: (value: ReturnType<typeof useChatSessions>) => void;
  }) {
    onResult(useChatSessions({ ...callbacks, getLectureProgress: () => lectureProgress }));
    return null;
  }

  const encode = (events: unknown[]) =>
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');

  function mount() {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() =>
      root.render(
        createElement(Probe, {
          onResult: (value) => {
            api = value;
          },
        }),
      ),
    );
  }

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    for (const spy of Object.values(callbacks)) spy.mockClear();
    mocks.actionExecute.mockClear();
    mocks.stage.chats = [];
    mocks.settings.selectedAgentIds = ['gen-student', 'gen-assistant', 'gen-teacher'];
    mocks.settings.teacherMayCallOnLearner = false;
    lectureProgress = null;
    requests = [];
    scripts = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const signal = init.signal as AbortSignal;
        requests.push({ body: JSON.parse(String(init.body)), signal });
        const script = scripts.shift() ?? { events: turnEvents() };
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(encode(script.events)));
            if (!script.hold) controller.close();
            signal.addEventListener('abort', () =>
              controller.error(new DOMException('Aborted', 'AbortError')),
            );
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      }),
    );
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  const configOf = (index: number) => requests[index].body.config;
  const storeStateOf = (index: number) =>
    (requests[index].body as unknown as { storeState: Record<string, unknown> }).storeState;

  it('remembers the earlier exchanges in the next session, and the assistant’s aside', async () => {
    mount();
    await act(async () => {
      await api.sendMessage('Why are leaves green?');
    });
    // Nothing earlier yet: no memory
    expect(configOf(0)).not.toHaveProperty('classMemory');

    scripts.push({ events: turnEvents('gen-assistant', 'Green light bounces off chlorophyll.') });
    await act(async () => {
      await api.sendAsideMessage('What is chlorophyll?', { agentId: 'gen-assistant' });
    });
    // The aside requests only its assistant, yet remembers what the class said
    expect(configOf(1).agentIds).toEqual(['gen-assistant']);
    expect(configOf(1).classMemory).toEqual({
      entries: [
        {
          kind: 'qa',
          sceneId: 'scene-1',
          learnerQuestion: 'Why are leaves green?',
          points: [{ agentId: 'gen-student', gist: 'I guess they cancel out?' }],
        },
      ],
    });

    await act(async () => {
      await api.startDiscussion({ topic: 'Why do they cancel?', agentId: 'gen-student' });
    });
    const memory = configOf(2).classMemory as { entries: Array<Record<string, unknown>> };
    expect(memory.entries).toEqual([
      {
        kind: 'qa',
        sceneId: 'scene-1',
        learnerQuestion: 'Why are leaves green?',
        points: [{ agentId: 'gen-student', gist: 'I guess they cancel out?' }],
      },
      // What the assistant said on the side reaches the teacher (I14.3)
      {
        kind: 'aside',
        sceneId: 'scene-1',
        learnerQuestion: 'What is chlorophyll?',
        points: [{ agentId: 'gen-assistant', gist: 'Green light bounces off chlorophyll.' }],
      },
    ]);
    // Three paced turns
  }, 20_000);

  it('says how far the lecture got on this page, and nothing about another page', async () => {
    mount();
    lectureProgress = { sceneId: 'scene-1', actionIndex: 4 };
    await act(async () => {
      await api.sendMessage('What did you just say?');
    });
    expect(storeStateOf(0).lectureProgress).toEqual({ sceneId: 'scene-1', actionIndex: 4 });

    lectureProgress = { sceneId: 'scene-9', actionIndex: 2 };
    await act(async () => {
      await api.sendAsideMessage('And this?', { agentId: 'gen-assistant' });
    });
    expect(storeStateOf(1)).not.toHaveProperty('lectureProgress');
  });

  it('lets the teacher call on the learner only when the learner allows it', async () => {
    mount();
    await act(async () => {
      await api.sendMessage('Why?');
    });
    expect(configOf(0)).not.toHaveProperty('teacherMayCallOnLearner');

    mocks.settings.teacherMayCallOnLearner = true;
    await act(async () => {
      await api.sendMessage('And then?');
    });
    expect(configOf(1).teacherMayCallOnLearner).toBe(true);
  });

  it("sends a whole-class question's kind and the learner's choice, and keeps them for follow-ups", async () => {
    mount();
    await act(async () => {
      await api.startDiscussion({
        topic: 'What do you predict?',
        prompt: 'Predict first',
        agentId: 'gen-teacher',
        momentKind: 'ask-learner',
        learnerStance: 'answer',
      });
    });
    expect(configOf(0)).toMatchObject({
      sessionType: 'discussion',
      triggerAgentId: 'gen-teacher',
      discussionTopic: 'What do you predict?',
      momentKind: 'ask-learner',
      learnerStance: 'answer',
    });
    await act(async () => {
      await api.sendMessage('It bends!');
    });
    expect(configOf(1)).toMatchObject({ momentKind: 'ask-learner', learnerStance: 'answer' });
  });

  it('keeps a stance only for a whole-class question', async () => {
    mount();
    await act(async () => {
      await api.startDiscussion({
        topic: 'Mia, what do you think?',
        agentId: 'gen-teacher',
        momentKind: 'lecture',
        learnerStance: 'listen',
      });
    });
    expect(configOf(0).momentKind).toBe('lecture');
    expect(configOf(0)).not.toHaveProperty('learnerStance');
  });

  it('opens a quiz review with no opener: the director picks', async () => {
    mount();
    await act(async () => {
      await api.startDiscussion({
        topic: 'Let’s go over Q2',
        prompt: 'Quiz review: Q2 (single choice)',
        momentKind: 'quiz-review',
      });
    });
    expect(configOf(0)).toMatchObject({
      agentIds: ['gen-student', 'gen-assistant', 'gen-teacher'],
      momentKind: 'quiz-review',
      discussionTopic: 'Let’s go over Q2',
      discussionPrompt: 'Quiz review: Q2 (single choice)',
    });
    expect(configOf(0)).not.toHaveProperty('triggerAgentId');
    const review = api.sessions.find((s) => s.type === 'discussion')!;
    expect(review.config.momentKind).toBe('quiz-review');
    expect(review.config.triggerAgentId).toBeUndefined();
  });
});

describe('withLectureProgress', () => {
  const storeState: import('@/lib/chat/agent-loop').AgentLoopStoreState = {
    stage: null,
    scenes: [],
    currentSceneId: 'scene-1',
    mode: 'playback',
    whiteboardOpen: false,
  };

  it('keeps progress on the current scene only, as a whole index within the bound', async () => {
    const { withLectureProgress } = await import('@/components/chat/use-chat-sessions');
    expect(withLectureProgress(storeState, { sceneId: 'scene-1', actionIndex: 2 })).toEqual({
      ...storeState,
      lectureProgress: { sceneId: 'scene-1', actionIndex: 2 },
    });
    expect(
      withLectureProgress(storeState, { sceneId: 'scene-1', actionIndex: 10_000_000 })
        .lectureProgress,
    ).toEqual({ sceneId: 'scene-1', actionIndex: 100_000 });
    for (const progress of [
      null,
      undefined,
      { sceneId: 'scene-2', actionIndex: 1 },
      { sceneId: 'scene-1', actionIndex: -1 },
      { sceneId: 'scene-1', actionIndex: 1.5 },
    ]) {
      expect(withLectureProgress(storeState, progress)).toBe(storeState);
    }
    expect(
      withLectureProgress(
        { ...storeState, currentSceneId: null },
        { sceneId: 'x', actionIndex: 0 },
      ),
    ).not.toHaveProperty('lectureProgress');
  });
});
