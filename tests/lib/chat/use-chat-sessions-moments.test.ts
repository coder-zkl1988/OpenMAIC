// @vitest-environment jsdom
/**
 * Who speaks for the classroom in the chat layer:
 * - the lecture bubble is the classroom's own teacher (the one the narration
 *   and the participants block name), not the built-in default-1; a lecture
 *   persisted before keeps its default-1;
 * - a discussion keeps how its moment opened (the opener's words, the
 *   teacher's intent, the opener) in its config and sends it on every
 *   request: the start, follow-ups and a resume;
 * - a moment without an opener is the teacher's, never a random student's.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UIMessage } from 'ai';
import type { ChatMessageMetadata, ChatSession } from '@/lib/types/chat';
import { PI_REQUEST_BOUNDS } from '@/lib/types/chat';

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
  settings: { selectedAgentIds: ['gen-student', 'gen-assistant', 'gen-teacher'] as string[] },
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

import {
  buildDiscussionMomentFields,
  discussionRequestFields,
  useChatSessions,
} from '@/components/chat/use-chat-sessions';

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

describe('discussion moment fields', () => {
  it('keeps the opener, trims the texts and cuts them to the route bounds', () => {
    const longTopic = '话'.repeat(PI_REQUEST_BOUNDS.discussionTopicMaxChars + 20);
    const fields = buildDiscussionMomentFields({
      topic: `  ${longTopic}  `,
      prompt: '  Let them predict before the reveal ',
      triggerAgentId: 'gen-student',
    });
    expect(Array.from(fields.discussionTopic!)).toHaveLength(
      PI_REQUEST_BOUNDS.discussionTopicMaxChars,
    );
    expect(fields).toMatchObject({
      discussionPrompt: 'Let them predict before the reveal',
      triggerAgentId: 'gen-student',
    });
    // Empty values are left out
    expect(buildDiscussionMomentFields({ topic: '  ', prompt: '' })).toEqual({});
  });

  it("copies a discussion's moment from its config, and nothing for Q&A", () => {
    const session = {
      type: 'discussion',
      title: 'Why do they cancel?',
      config: {
        agentIds: ['gen-student', 'gen-teacher'],
        discussionTopic: 'Why do they cancel?',
        discussionPrompt: 'Get a guess first',
        triggerAgentId: 'gen-student',
        momentKind: 'lecture',
      },
    } as Pick<ChatSession, 'type' | 'title' | 'config'>;
    expect(discussionRequestFields(session)).toEqual({
      discussionTopic: 'Why do they cancel?',
      discussionPrompt: 'Get a guess first',
      triggerAgentId: 'gen-student',
      momentKind: 'lecture',
    });
    // Persisted before the config kept the topic: the title is the topic
    expect(
      discussionRequestFields({
        type: 'discussion',
        title: 'Old topic',
        config: { agentIds: ['default-1'], triggerAgentId: 'default-2' },
      }),
    ).toEqual({ discussionTopic: 'Old topic', triggerAgentId: 'default-2' });
    expect(
      discussionRequestFields({ type: 'qa', title: 'Q&A', config: { agentIds: ['default-1'] } }),
    ).toEqual({});
    expect(discussionRequestFields(undefined)).toEqual({});
  });
});

describe('useChatSessions: who speaks for the classroom', () => {
  let container: HTMLDivElement;
  let root: Root;
  let api: ReturnType<typeof useChatSessions>;
  let requests: FakeRequest[];
  let scripts: Array<{ events: unknown[]; hold?: boolean }>;
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
    onResult(useChatSessions(callbacks));
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

  async function waitFor(check: () => boolean, timeout = 6000) {
    const start = Date.now();
    while (!check()) {
      if (Date.now() - start > timeout) throw new Error('timed out waiting');
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    }
  }

  const discussion = () => api.sessions.find((session) => session.type === 'discussion');

  it("names the classroom's own teacher on the lecture bubble and its actions", async () => {
    mount();
    let lectureId = '';
    await act(async () => {
      lectureId = await api.startLecture('scene-1');
    });
    const lecture = api.sessions.find((session) => session.id === lectureId)!;
    expect(lecture.config.agentIds).toEqual(['gen-teacher']);
    expect(lecture.messages[0].metadata).toMatchObject({
      agentId: 'gen-teacher',
      senderName: 'Ms. Lin',
      senderAvatar: '/avatars/lin.png',
      originalRole: 'teacher',
    });

    act(() =>
      api.addLectureMessage(lectureId, { id: 'spot-1', type: 'spotlight', elementId: 'e-1' }, 0),
    );
    await waitFor(() => mocks.actionExecute.mock.calls.length > 0);
    expect(mocks.actionExecute.mock.calls[0][1]).toMatchObject({ agentId: 'gen-teacher' });
  });

  it('keeps default-1 on a lecture persisted before lectures named the teacher', async () => {
    mocks.stage.chats = [
      {
        id: 'lecture-old',
        type: 'lecture',
        title: 'Leaves',
        status: 'completed',
        messages: [
          {
            id: 'lecture-msg-old',
            role: 'assistant',
            parts: [{ type: 'text', text: 'Hello' }],
            metadata: { agentId: 'default-1', senderName: 'AI Teacher', originalRole: 'teacher' },
          },
        ],
        config: { agentIds: ['default-1'] },
        toolCalls: [],
        pendingToolCalls: [],
        sceneId: 'scene-1',
        lastActionIndex: 0,
        createdAt: 1,
        updatedAt: 2,
      },
    ];
    mount();
    let lectureId = '';
    await act(async () => {
      lectureId = await api.startLecture('scene-1');
    });
    expect(lectureId).toBe('lecture-old');
    act(() =>
      api.addLectureMessage(lectureId, { id: 'spot-1', type: 'spotlight', elementId: 'e-1' }, 1),
    );
    await waitFor(() => mocks.actionExecute.mock.calls.length > 0);
    expect(mocks.actionExecute.mock.calls[0][1]).toMatchObject({ agentId: 'default-1' });
  });

  it('keeps how the moment opened and sends it on the start and on follow-ups', async () => {
    mount();
    await act(async () => {
      await api.startDiscussion({
        topic: '  Wait — why do the two forces cancel?  ',
        prompt: 'Let the learner guess before the reveal',
        agentId: 'gen-student',
      });
    });
    const moment = {
      discussionTopic: 'Wait — why do the two forces cancel?',
      discussionPrompt: 'Let the learner guess before the reveal',
      triggerAgentId: 'gen-student',
    };
    expect(requests[0].body.config).toMatchObject({ sessionType: 'discussion', ...moment });
    expect(discussion()!.config).toMatchObject({
      agentIds: ['gen-student', 'gen-assistant', 'gen-teacher'],
      ...moment,
    });

    await act(async () => {
      await api.sendMessage('Because they point opposite ways?');
    });
    expect(requests).toHaveLength(2);
    expect(requests[1].body.config).toMatchObject({ sessionType: 'discussion', ...moment });
  });

  it('sends the moment again when a soft-paused discussion resumes', async () => {
    mount();
    scripts.push({ events: turnEvents().slice(0, 2), hold: true });
    act(() => {
      void api.startDiscussion({ topic: 'Why green?', agentId: 'gen-student' });
    });
    await waitFor(() => requests.length === 1);
    await act(async () => {
      await api.softPauseActiveSession();
    });
    expect(requests[0].signal.aborted).toBe(true);

    await act(async () => {
      await api.resumeActiveSession();
    });
    expect(requests).toHaveLength(2);
    expect(requests[1].body.config).toMatchObject({
      sessionType: 'discussion',
      discussionTopic: 'Why green?',
      triggerAgentId: 'gen-student',
    });
    expect(requests[1].body.config).not.toHaveProperty('discussionPrompt');
  });

  it("gives a moment without an opener to the classroom's teacher", async () => {
    mount();
    await act(async () => {
      await api.startDiscussion({ topic: 'What do you predict happens next?' });
    });
    expect(requests[0].body.config).toMatchObject({ triggerAgentId: 'gen-teacher' });
    expect(discussion()!.config.triggerAgentId).toBe('gen-teacher');
  });

  it('sends no moment fields on a Q&A follow-up', async () => {
    mount();
    await act(async () => {
      await api.sendMessage('Why are leaves green?');
    });
    await act(async () => {
      await api.sendMessage('And in autumn?');
    });
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.body.config).toMatchObject({ sessionType: 'qa' });
      expect(request.body.config).not.toHaveProperty('discussionTopic');
      expect(request.body.config).not.toHaveProperty('triggerAgentId');
    }
  });
});
