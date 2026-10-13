// @vitest-environment jsdom
/**
 * What a Pi request says about the people in it: the learner's interface
 * language (built-in agents go by the names the learner sees, I22), whom the
 * learner's message names with "@" (I23, per request, never kept), and why
 * the director cast each speaker, kept on the speaker's message (I20).
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
    scenes: [] as unknown[],
    outlines: [] as unknown[],
    currentSceneId: 'scene-1',
    mode: 'playback',
    setChats: () => undefined,
  },
  agents: {
    'default-1': { id: 'default-1', name: 'AI teacher', role: 'teacher', avatar: '/t.png' },
    'default-2': { id: 'default-2', name: 'AI assistant', role: 'assistant', avatar: '/a.png' },
    'gen-mia': { id: 'gen-mia', name: 'Mia', role: 'student', avatar: '/m.png' },
  } as Record<string, unknown>,
  locale: 'zh-CN' as string | undefined,
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
  useSettingsStore: {
    getState: () => ({ selectedAgentIds: ['default-1', 'default-2', 'gen-mia'] }),
  },
}));
vi.mock('@/lib/store/user-profile', () => ({
  useUserProfileStore: { getState: () => ({ nickname: '', bio: '' }) },
}));
vi.mock('@/lib/orchestration/registry/store', () => ({
  useAgentRegistry: { getState: () => ({ getAgent: (id: string) => mocks.agents[id] }) },
}));
// The interface shows built-in agents under localized names
const NAMES: Record<string, string> = {
  'settings.agentNames.default-1': '林老师',
  'settings.agentNames.default-2': '小禾',
};
vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ t: (key: string) => NAMES[key] ?? key, locale: mocks.locale }),
}));
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
    execute = vi.fn(async () => undefined);
  },
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), info: vi.fn() } }));

import {
  addressedAgentIdsOf,
  agentStartMessage,
  useChatSessions,
  withUiLocale,
} from '@/components/chat/use-chat-sessions';

describe('request helpers', () => {
  it('sends only a supported interface language', () => {
    const template = { messages: [], config: { agentIds: ['default-1'] } };
    expect(withUiLocale(template, 'ja-JP')).toEqual({ ...template, uiLocale: 'ja-JP' });
    expect(withUiLocale(template, 'xx-YY')).toBe(template);
    expect(withUiLocale(template, undefined)).toBe(template);
  });

  it('reads whom a message names, under the localized or the registry name', () => {
    const t = (key: string) => NAMES[key] ?? key;
    const roster = ['default-1', 'default-2', 'gen-mia'];
    expect(addressedAgentIdsOf('@小禾 你觉得呢？@Mia', roster, t)).toEqual([
      'default-2',
      'gen-mia',
    ]);
    expect(addressedAgentIdsOf('@AI teacher why?', roster, t)).toEqual(['default-1']);
    expect(addressedAgentIdsOf('no one named', roster, t)).toEqual([]);
  });

  it("keeps the director's cast reason on the speaker's message", () => {
    const data = { messageId: 'm1', agentId: 'gen-mia', agentName: 'Mia', avatar: undefined };
    expect(agentStartMessage(data, { name: 'Mia', avatar: '/m.png' }, 5, 'addressed')).toEqual({
      id: 'm1',
      role: 'assistant',
      parts: [],
      metadata: {
        senderName: 'Mia',
        senderAvatar: '/m.png',
        originalRole: 'agent',
        agentId: 'gen-mia',
        createdAt: 5,
        castReason: 'addressed',
      },
    });
    expect(agentStartMessage(data, undefined, 5).metadata).not.toHaveProperty('castReason');
  });
});

describe('useChatSessions: language, @-mentions and cast reasons on the wire', () => {
  let container: HTMLDivElement;
  let root: Root;
  let api: ReturnType<typeof useChatSessions>;
  let bodies: Array<Record<string, unknown> & { config: Record<string, unknown> }>;
  let castReason: unknown;

  function Probe({
    onResult,
  }: {
    readonly onResult: (value: ReturnType<typeof useChatSessions>) => void;
  }) {
    onResult(useChatSessions({}));
    return null;
  }

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    mocks.locale = 'zh-CN';
    bodies = [];
    castReason = 'addressed';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        const events = [
          {
            type: 'agent_start',
            data: { messageId: 'mia-1', agentId: 'gen-mia', agentName: 'Mia', castReason },
          },
          { type: 'text_delta', data: { messageId: 'mia-1', content: '我觉得是因为光合作用' } },
          { type: 'agent_end', data: { messageId: 'mia-1', agentId: 'gen-mia' } },
          { type: 'cue_user', data: { fromAgentId: 'gen-mia' } },
          {
            type: 'done',
            data: { totalActions: 0, totalAgents: 1, agentHadContent: true, cueUserReceived: true },
          },
        ];
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')),
            );
            controller.close();
          },
        });
        return new Response(stream, { status: 200 });
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

  const lastAgentMessage = (): UIMessage<ChatMessageMetadata> | undefined =>
    api.sessions
      .flatMap((session) => session.messages)
      .filter((message) => message.role === 'assistant')
      .at(-1);

  it('sends the interface language and whom the question names; keeps why Mia was cast', async () => {
    await act(async () => {
      await api.sendMessage('@Mia 你怎么看？');
    });

    expect(bodies).toHaveLength(1);
    expect(bodies[0].uiLocale).toBe('zh-CN');
    expect(bodies[0].config.addressedAgentIds).toEqual(['gen-mia']);
    expect(lastAgentMessage()?.metadata).toMatchObject({
      agentId: 'gen-mia',
      castReason: 'addressed',
    });
    // Per request: nothing of it is kept in the session's config
    expect(api.sessions.at(-1)?.config).not.toHaveProperty('addressedAgentIds');
  });

  it('names nobody and drops an unknown cast reason or language', async () => {
    mocks.locale = 'xx-YY';
    castReason = 'because';
    act(() => root.render(createElement(Probe, { onResult: (value) => (api = value) })));
    await act(async () => {
      await api.sendMessage('为什么叶子是绿的？');
    });

    expect(bodies[0]).not.toHaveProperty('uiLocale');
    expect(bodies[0].config).not.toHaveProperty('addressedAgentIds');
    expect(lastAgentMessage()?.metadata).not.toHaveProperty('castReason');
  });

  it("sends the language on the assistant's aside too, and its own mention", async () => {
    await act(async () => {
      await api.sendAsideMessage('@小禾 这一步看不懂', { agentId: 'default-2' });
    });

    expect(bodies[0].uiLocale).toBe('zh-CN');
    expect(bodies[0].config).toMatchObject({
      agentIds: ['default-2'],
      addressedAgentIds: ['default-2'],
    });
  });
});
