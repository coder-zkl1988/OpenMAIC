// @vitest-environment jsdom
/**
 * Who has been present in the course reaches every Pi request (I06): the
 * class presence (turns, last page, learner messages since) built from the
 * loaded sessions, and how each lecture moment ended, recorded as a badge on
 * its page's lecture bubble.
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

describe('useChatSessions: class presence on every Pi request', () => {
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

  const presenceOf = (index: number) =>
    requests[index].body.config.classPresence as {
      agents: Array<Record<string, unknown>>;
      moments?: Array<{ actionId: string; outcome: string }>;
    };

  it('sends who spoke how often, where, and the learner messages since', async () => {
    mount();
    await act(async () => {
      await api.sendMessage('Why are leaves green?');
    });
    // Nobody has spoken yet: one entry per requested agent, 0 turns
    expect(presenceOf(0).agents).toEqual([
      { agentId: 'gen-student', turns: 0 },
      { agentId: 'gen-assistant', turns: 0 },
      { agentId: 'gen-teacher', turns: 0 },
    ]);
    expect(presenceOf(0)).not.toHaveProperty('moments');

    await act(async () => {
      await api.sendMessage('And in autumn?');
    });
    // The follow-up itself counts as a learner message since Mia's answer
    expect(presenceOf(1).agents[0]).toEqual({
      agentId: 'gen-student',
      turns: 1,
      lastSceneId: 'scene-1',
      learnerTurnsSince: 1,
    });
  });

  it('records how a lecture moment ended on its lecture bubble, and sends it as a moment', async () => {
    mount();
    let lectureId = '';
    await act(async () => {
      lectureId = await api.startLecture('scene-1');
    });
    const moment = {
      type: 'discussion' as const,
      id: 'moment-1',
      topic: 'Why do they cancel?',
      prompt: 'Get a guess first',
    };
    act(() =>
      api.recordLectureMoment('scene-1', moment, { agentId: 'gen-teacher', outcome: 'skipped' }),
    );
    // Replayed later: the badge is replaced, not added
    act(() =>
      api.recordLectureMoment('scene-1', moment, {
        agentId: 'gen-teacher',
        outcome: 'auto_skipped',
      }),
    );
    const bubble = api.sessions.find((s) => s.id === lectureId)!.messages[0];
    const badges = bubble.parts.filter((part) => (part.type as string) === 'action-discussion');
    expect(badges).toHaveLength(1);
    expect((badges[0] as unknown as { input: unknown }).input).toEqual({
      topic: 'Why do they cancel?',
      prompt: 'Get a guess first',
      discussionActionId: 'moment-1',
      agentId: 'gen-teacher',
      outcome: 'auto_skipped',
    });

    // A page never lectured has no bubble: nothing is written
    act(() =>
      api.recordLectureMoment('scene-2', { ...moment, id: 'moment-2' }, { outcome: 'not_shown' }),
    );
    expect(
      api.sessions.some((s) =>
        s.messages.some((m) =>
          m.parts.some(
            (part) =>
              (part as unknown as { input?: { discussionActionId?: string } }).input
                ?.discussionActionId === 'moment-2',
          ),
        ),
      ),
    ).toBe(false);

    await act(async () => {
      await api.startDiscussion({ topic: 'Something else', agentId: 'gen-student' });
    });
    expect(presenceOf(0).moments).toEqual([{ actionId: 'moment-1', outcome: 'auto_skipped' }]);
  });

  it("sends the aside the assistant's own presence", async () => {
    mount();
    await act(async () => {
      await api.sendMessage('Why are leaves green?');
    });
    await act(async () => {
      await api.sendAsideMessage('What unit is that?', { agentId: 'gen-assistant' });
    });
    expect(requests).toHaveLength(2);
    expect(requests[1].body.config.asideToLecture).toBe(true);
    expect(presenceOf(1).agents).toEqual([{ agentId: 'gen-assistant', turns: 0 }]);
  });
});
