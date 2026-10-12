// @vitest-environment jsdom
/**
 * The teaching assistant's aside in the chat layer: it answers while the
 * lecture keeps playing, on a channel of its own — its own session (never the
 * active one), request controller and streaming flag, follow-ups appended to
 * it, text only (no actions, no TTS), and its outcome never reaching the
 * lecture-facing callbacks (live speech, cue, stop / error cleanup).
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UIMessage } from 'ai';
import type { ChatMessageMetadata, ChatSession } from '@/lib/types/chat';

const mocks = vi.hoisted(() => ({
  stage: {
    stage: { id: 'stage-1' },
    chats: [] as unknown[],
    scenes: [] as unknown[],
    outlines: [] as unknown[],
    currentSceneId: 'scene-1',
    mode: 'playback',
    setChats: () => undefined,
  },
  setWhiteboardOpen: vi.fn(),
  actionExecute: vi.fn(async () => undefined),
  agents: {
    'default-2': {
      id: 'default-2',
      name: 'AI助教',
      role: 'assistant',
      persona: 'Teaching assistant.',
      avatar: '/avatars/assist.png',
      color: '#10b981',
      allowedActions: ['wb_open', 'wb_draw_text'],
      priority: 7,
      createdAt: new Date(),
      updatedAt: new Date(),
      isDefault: true,
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
      setWhiteboardOpen: mocks.setWhiteboardOpen,
    }),
  },
}));
vi.mock('@/lib/store/settings', () => ({
  useSettingsStore: { getState: () => ({ selectedAgentIds: ['default-1', 'default-2'] }) },
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
  buildAsideRequestTemplate,
  isAsideSession,
  isOpenLiveSession,
  isOpenMainLiveSession,
  markLastAssistantInterrupted,
  toTextOnlyAgentConfig,
  useChatSessions,
} from '@/components/chat/use-chat-sessions';
import type { AgentConfig } from '@/lib/orchestration/registry/types';

const ANSWER = '叶绿素反射绿光';

/** The assistant's answer: thinking, a stray board event and action (both dropped), text, cue */
function answerEvents(text = ANSWER) {
  return [
    { type: 'thinking', data: { stage: 'director' } },
    {
      type: 'whiteboard',
      data: { kind: 'open', stageId: 'stage-1', manualVisibilityRevision: 0 },
    },
    {
      type: 'agent_start',
      data: { messageId: 'ta-1', agentId: 'default-2', agentName: 'AI助教' },
    },
    { type: 'text_delta', data: { messageId: 'ta-1', content: text } },
    {
      type: 'action',
      data: { messageId: 'ta-1', actionId: 'a-1', actionName: 'wb_open', params: {} },
    },
    { type: 'agent_end', data: { messageId: 'ta-1', agentId: 'default-2' } },
    { type: 'cue_user', data: { fromAgentId: 'default-2' } },
    {
      type: 'done',
      data: { totalActions: 0, totalAgents: 1, agentHadContent: true, cueUserReceived: true },
    },
  ];
}

interface FakeRequest {
  url: string;
  body: {
    config: Record<string, unknown> & { agentConfigs?: Record<string, unknown>[] };
    messages: UIMessage<ChatMessageMetadata>[];
  };
  signal: AbortSignal;
}

describe('aside helpers', () => {
  const session = (config: ChatSession['config'], status: ChatSession['status'] = 'active') =>
    ({ type: 'qa', status, config }) as Pick<ChatSession, 'type' | 'status' | 'config'>;

  it('marks an aside in its config and keeps it out of the lecture-facing lookups', () => {
    const aside = session({ agentIds: ['default-2'], aside: true });
    const qa = session({ agentIds: ['default-1'] });
    expect(isAsideSession(aside)).toBe(true);
    expect(isAsideSession(qa)).toBe(false);
    expect(isOpenLiveSession(aside)).toBe(true);
    expect(isOpenMainLiveSession(aside)).toBe(false);
    expect(isOpenMainLiveSession(qa)).toBe(true);
    expect(isOpenMainLiveSession(session({ agentIds: [] }, 'completed'))).toBe(false);
  });

  it('requests the assistant alone, one turn, text only, flagged asideToLecture', () => {
    const agent = mocks.agents['default-2'] as AgentConfig;
    const template = buildAsideRequestTemplate({
      messages: [],
      agentId: 'default-2',
      agent,
      elementReference: { kind: 'slide_element', sceneId: 'scene-1', elementId: 'e-1' },
    });
    expect(template.config).toMatchObject({
      agentIds: ['default-2'],
      sessionType: 'qa',
      piMaxAgentTurns: 1,
      piEnableWhiteboardTools: false,
      asideToLecture: true,
    });
    expect(template.config.agentConfigs).toEqual([toTextOnlyAgentConfig(agent)]);
    expect(template.config.agentConfigs?.[0]).toMatchObject({ allowedActions: [] });
    expect(template.config.agentConfigs?.[0]).not.toHaveProperty('createdAt');
    expect(template.elementReference).toEqual({
      kind: 'slide_element',
      sceneId: 'scene-1',
      elementId: 'e-1',
    });
    // Unknown to the client registry: the server resolves the id and strips actions itself
    expect(
      buildAsideRequestTemplate({ messages: [], agentId: 'default-2' }).config,
    ).not.toHaveProperty('agentConfigs');
  });

  it('marks a cut answer with "..." and the interrupted flag', () => {
    const messages = markLastAssistantInterrupted([
      { id: 'u', role: 'user', parts: [{ type: 'text', text: 'Q' }] },
      { id: 'a', role: 'assistant', parts: [{ type: 'text', text: 'Half' }] },
    ]);
    expect(messages[1].parts).toEqual([{ type: 'text', text: 'Half...' }]);
    expect(messages[1].metadata?.interrupted).toBe(true);
    expect(messages[0]).toEqual({ id: 'u', role: 'user', parts: [{ type: 'text', text: 'Q' }] });
  });
});

describe('useChatSessions: the assistant aside', () => {
  let container: HTMLDivElement;
  let root: Root;
  let api: ReturnType<typeof useChatSessions>;
  let requests: FakeRequest[];
  /** Per request: the events sent, and whether the stream stays open after them */
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
    onAsideLiveSpeech: vi.fn(),
    onAsideThinking: vi.fn(),
  };
  const lectureFacing = [
    'onLiveSpeech',
    'onThinking',
    'onCueUser',
    'onActiveBubble',
    'onLiveSessionError',
    'onSoftCloseSession',
    'onStopSession',
    'onSegmentSealed',
    'shouldHoldAfterReveal',
  ] as const;

  function Probe({
    onResult,
  }: {
    readonly onResult: (value: ReturnType<typeof useChatSessions>) => void;
  }) {
    onResult(useChatSessions(callbacks));
    return null;
  }

  function encode(events: unknown[]) {
    return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
  }

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    for (const spy of Object.values(callbacks)) spy.mockClear();
    mocks.setWhiteboardOpen.mockClear();
    mocks.actionExecute.mockClear();
    requests = [];
    scripts = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        const signal = init.signal as AbortSignal;
        requests.push({ url: String(url), body: JSON.parse(String(init.body)), signal });
        const script = scripts.shift() ?? { events: answerEvents() };
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

  const aside = () => api.sessions.find((session) => isAsideSession(session));
  const textOf = (message: UIMessage<ChatMessageMetadata>) =>
    message.parts.map((part) => (part.type === 'text' ? part.text : `[${part.type}]`)).join('');

  async function startLecture() {
    let lectureId = '';
    await act(async () => {
      lectureId = await api.startLecture('scene-1');
    });
    return lectureId;
  }

  async function ask(text: string) {
    let pending!: Promise<void>;
    act(() => {
      pending = api.sendAsideMessage(text, { agentId: 'default-2' });
    });
    return pending;
  }

  it('answers in a session of its own: the lecture stays the active session', async () => {
    const lectureId = await startLecture();
    const pending = ask('为什么叶子是绿色的？');
    expect(api.isAsideStreaming).toBe(true);
    await act(async () => {
      await pending;
    });

    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe('/api/chat/pi');
    expect(requests[0].body.config).toMatchObject({
      agentIds: ['default-2'],
      sessionType: 'qa',
      asideToLecture: true,
      piEnableWhiteboardTools: false,
      piMaxAgentTurns: 1,
    });
    expect(requests[0].body.config.agentConfigs?.[0]).toMatchObject({
      id: 'default-2',
      allowedActions: [],
    });

    const session = aside()!;
    expect(session).toMatchObject({ type: 'qa', status: 'active', sceneId: 'scene-1' });
    expect(session.config).toMatchObject({ agentIds: ['default-2'], aside: true });
    expect(session.messages.map(textOf)).toEqual(['为什么叶子是绿色的？', ANSWER]);
    expect(session.messages[1].metadata?.agentId).toBe('default-2');
    // Never the active session: the lecture keeps it
    expect(api.activeSessionId).toBe(lectureId);
    expect(api.activeSessionType).toBe('lecture');
    expect(api.asideSessionId).toBe(session.id);
    expect(api.isAsideStreaming).toBe(false);
    // Its live text and thinking go to the aside channel only
    expect(callbacks.onAsideLiveSpeech).toHaveBeenCalledWith(ANSWER, 'default-2');
    expect(callbacks.onAsideThinking).toHaveBeenCalled();
    for (const name of lectureFacing) expect(callbacks[name], name).not.toHaveBeenCalled();
    // Text only: no action ran or showed, the board was left alone
    expect(mocks.actionExecute).not.toHaveBeenCalled();
    expect(mocks.setWhiteboardOpen).not.toHaveBeenCalled();
    // The lecture-facing buffer controls do not see it
    expect(api.pauseActiveLiveBuffer()).toBe(false);
  });

  it('appends follow-ups to the open aside', async () => {
    await startLecture();
    await act(async () => {
      await ask('为什么叶子是绿色的？');
    });
    const first = aside()!;
    await act(async () => {
      await ask('那秋天呢？');
    });

    expect(api.sessions.filter((session) => isAsideSession(session))).toHaveLength(1);
    expect(aside()!.id).toBe(first.id);
    expect(aside()!.messages.map(textOf)).toEqual([
      '为什么叶子是绿色的？',
      ANSWER,
      '那秋天呢？',
      ANSWER,
    ]);
    // The follow-up carries the conversation so far
    expect(requests[1].body.messages.map(textOf)).toEqual([
      '为什么叶子是绿色的？',
      ANSWER,
      '那秋天呢？',
    ]);
    for (const name of lectureFacing) expect(callbacks[name], name).not.toHaveBeenCalled();
  });

  it('keeps an error inside the aside: no lecture-facing stop or error cleanup', async () => {
    await startLecture();
    scripts.push({ events: [{ type: 'error', data: { message: 'model failed' } }] });
    await act(async () => {
      await ask('为什么？');
    });

    const session = aside()!;
    expect(session.status).toBe('error');
    expect(textOf(session.messages.at(-1)!)).toBe('model failed');
    expect(api.asideSessionId).toBeNull();
    expect(api.isAsideStreaming).toBe(false);
    expect(callbacks.onAsideLiveSpeech).toHaveBeenLastCalledWith(null, null);
    for (const name of lectureFacing) expect(callbacks[name], name).not.toHaveBeenCalled();
  });

  it('has its own controller: the shared interrupt and the lecture ending leave it streaming', async () => {
    const lectureId = await startLecture();
    scripts.push({ events: answerEvents().slice(0, 4), hold: true });
    void ask('为什么？');
    await waitFor(() => requests.length === 1);

    act(() => api.handleInterrupt());
    await act(async () => {
      await api.endSession(lectureId);
    });
    expect(requests[0].signal.aborted).toBe(false);
    expect(api.isAsideStreaming).toBe(true);
    expect(aside()!.status).toBe('active');

    await act(async () => {
      await api.endAsideSession();
    });
    expect(requests[0].signal.aborted).toBe(true);
  });

  it('ends with a scene switch: completed, messages kept ("..." on a cut answer), the lecture untouched', async () => {
    const lectureId = await startLecture();
    scripts.push({ events: answerEvents().slice(0, 4), hold: true });
    void ask('为什么？');
    await waitFor(() => callbacks.onAsideLiveSpeech.mock.calls.some(([text]) => text === ANSWER));

    await act(async () => {
      await api.endActiveSession({ source: 'scene_switch' });
    });

    expect(requests[0].signal.aborted).toBe(true);
    const session = aside()!;
    expect(session.status).toBe('completed');
    expect(session.messages.map(textOf)).toEqual(['为什么？', `${ANSWER}...`]);
    expect(session.messages[1].metadata?.interrupted).toBe(true);
    expect(api.asideSessionId).toBeNull();
    expect(api.isAsideStreaming).toBe(false);
    expect(api.sessions.find((s) => s.id === lectureId)?.status).toBe('active');
    for (const name of lectureFacing) expect(callbacks[name], name).not.toHaveBeenCalled();
  });

  it('is ended when the teacher takes over with a normal question', async () => {
    await startLecture();
    scripts.push({ events: answerEvents().slice(0, 4), hold: true });
    void ask('为什么？');
    await waitFor(() => requests.length === 1);

    scripts.push({ events: [], hold: true });
    act(() => {
      void api.sendMessage('老师，请再讲一遍');
    });
    await waitFor(() => requests.length === 2);

    expect(requests[0].signal.aborted).toBe(true);
    expect(aside()!.status).toBe('completed');
    expect(requests[1].body.config).not.toHaveProperty('asideToLecture');
    const teacherQa = api.sessions.find(
      (session) => session.type === 'qa' && !isAsideSession(session),
    );
    expect(teacherQa?.messages.map(textOf)).toEqual(['老师，请再讲一遍']);
    // Clean up the held teacher request
    await act(async () => {
      await api.endActiveSession();
    });
  });

  it('ends first when a teacher discussion is confirmed', async () => {
    await startLecture();
    scripts.push({ events: answerEvents().slice(0, 4), hold: true });
    void ask('为什么？');
    await waitFor(() => requests.length === 1);

    scripts.push({ events: [], hold: true });
    act(() => {
      void api.startDiscussion({ topic: '叶绿素', agentId: 'default-1' });
    });
    await waitFor(() => requests.length === 2);

    expect(requests[0].signal.aborted).toBe(true);
    expect(aside()!.status).toBe('completed');
    expect(api.asideSessionId).toBeNull();
    expect(api.activeSessionType).toBe('discussion');
    expect(requests[1].body.config).toMatchObject({ sessionType: 'discussion' });
    expect(requests[1].body.config).not.toHaveProperty('asideToLecture');
    await act(async () => {
      await api.endActiveSession();
    });
  });
});
