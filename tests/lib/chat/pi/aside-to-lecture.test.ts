/**
 * The teaching assistant's aside to the lecture (`config.asideToLecture`):
 * the teacher keeps lecturing and only the assistant answers in the chat —
 * text only, one agent turn, no whiteboard, finished with cue_user and never
 * closed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import type { AgentConfig } from '@/lib/orchestration/registry/types';
import type { StatelessChatRequest } from '@/lib/types/chat';

const PI_CHAT_FLAG = 'NEXT_PUBLIC_PI_CHAT_ENABLED';
const COURSEWARE_REFERENCE_FLAG = 'NEXT_PUBLIC_COURSEWARE_REFERENCE_ENABLED';
let originalPiChatFlag: string | undefined;
let originalCoursewareReferenceFlag: string | undefined;

type MockTool = {
  name: string;
  execute: (toolCallId: string, args: Record<string, unknown>) => Promise<unknown> | unknown;
};
type MockAgentOptions = { systemPrompt: string; tools: MockTool[] };

const mocks = vi.hoisted(() => ({
  resolveModel: vi.fn(),
  buildAgent: vi.fn(),
  createCallLlmStreamFn: vi.fn(),
}));

vi.mock('@/lib/server/resolve-model', () => ({ resolveModel: mocks.resolveModel }));
vi.mock('@/lib/ai/providers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/providers')>()),
  isProviderKeyRequired: vi.fn(() => false),
}));
vi.mock('@/lib/live-mode', () => ({ isLiveMode: false }));
vi.mock('@/lib/agent/runtime/stream-fn', () => ({
  createCallLlmStreamFn: mocks.createCallLlmStreamFn,
}));
vi.mock('@/lib/agent/runtime/build-agent', () => ({ buildAgent: mocks.buildAgent }));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import {
  ASIDE_MAX_AGENT_TURNS,
  getPiEnableWhiteboardTools,
  getPiMaxAgentTurns,
  isAsideToLecture,
  resolveAgentConfigs,
} from '@/lib/chat/pi/config';
import { buildChildPrompt, buildChildTurnPrompt, buildDirectorPrompt } from '@/lib/chat/pi/prompts';

const now = new Date('2026-01-01T00:00:00Z');
const teacher: AgentConfig = {
  id: 'teacher-1',
  name: 'AI teacher',
  role: 'teacher',
  persona: 'Lead teacher.',
  avatar: '',
  color: '#3366ff',
  allowedActions: ['spotlight', 'wb_open'],
  priority: 10,
  createdAt: now,
  updatedAt: now,
  isDefault: false,
};
const assistant: AgentConfig = {
  ...teacher,
  id: 'assistant-1',
  name: 'AI assistant',
  role: 'assistant',
  persona: 'Teaching assistant.',
  allowedActions: ['wb_open', 'wb_draw_text', 'spotlight'],
  priority: 7,
};

function toWire(agent: AgentConfig) {
  const { createdAt: _c, updatedAt: _u, isDefault: _d, ...rest } = agent;
  return rest;
}

function makeBody(config: Partial<StatelessChatRequest['config']> = {}): StatelessChatRequest {
  return {
    messages: [
      { id: 'user-1', role: 'user', parts: [{ type: 'text', text: '为什么叶子是绿色的？' }] },
    ],
    storeState: {
      stage: { id: 'stage-1', name: 'Photosynthesis', whiteboard: [] },
      scenes: [
        {
          id: 'scene-1',
          title: 'Chloroplasts',
          type: 'slide',
          content: { type: 'slide', canvas: { elements: [] } },
        },
      ],
      currentSceneId: 'scene-1',
      mode: 'autonomous',
      whiteboardOpen: false,
    },
    config: {
      agentIds: [assistant.id],
      agentConfigs: [toWire(assistant)],
      sessionType: 'qa',
      ...config,
    },
    apiKey: '',
    model: 'test:model',
  } as unknown as StatelessChatRequest;
}

describe('aside request config', () => {
  it('is recognised only from an explicit asideToLecture flag', () => {
    expect(isAsideToLecture(makeBody({ asideToLecture: true }))).toBe(true);
    expect(isAsideToLecture(makeBody())).toBe(false);
  });

  it('runs every agent text-only, one turn, without whiteboard tools', () => {
    const aside = makeBody({
      asideToLecture: true,
      piMaxAgentTurns: 6,
      piEnableWhiteboardTools: true,
    });
    expect(resolveAgentConfigs(aside).map((agent) => agent.allowedActions)).toEqual([[]]);
    expect(getPiMaxAgentTurns(aside)).toBe(ASIDE_MAX_AGENT_TURNS);
    expect(ASIDE_MAX_AGENT_TURNS).toBe(1);
    expect(getPiEnableWhiteboardTools(aside)).toBe(false);

    // A normal Q&A keeps the agent's actions and its requested limits
    const qa = makeBody({ piMaxAgentTurns: 3, piEnableWhiteboardTools: true });
    expect(resolveAgentConfigs(qa)[0].allowedActions).toEqual(assistant.allowedActions);
    expect(getPiMaxAgentTurns(qa)).toBe(3);
    expect(getPiEnableWhiteboardTools(qa)).toBe(true);
  });
});

describe('aside director and child prompts', () => {
  it('has the assistant answer alone, in text, and cue the learner instead of closing', () => {
    const prompt = buildDirectorPrompt(makeBody({ asideToLecture: true }), [teacher, assistant], 1);
    expect(prompt).toContain('KEEPS lecturing');
    expect(prompt).toContain(
      'Call `call_agent` exactly once, for AI assistant ("assistant-1", the teaching assistant)',
    );
    expect(prompt).toContain('Never call anyone else');
    expect(prompt).toContain('in text only');
    expect(prompt).toContain('call `cue_user` so the learner can follow up');
    expect(prompt).toContain('there is no `close_session` here');
    // None of the teacher-first or closing rules of a normal Q&A
    expect(prompt).not.toContain('The teacher (role: teacher) should usually');
    expect(prompt).not.toContain('# Classroom Casting');
    expect(prompt).not.toContain('For these call `close_session`');
  });

  it('has a classmate the learner named answer on the side, as a classmate whispers back', () => {
    const student: AgentConfig = {
      ...teacher,
      id: 'student-1',
      name: 'Kai',
      role: 'student',
      persona: 'A curious classmate.',
      priority: 5,
    };
    const body = makeBody({ asideToLecture: true });
    body.config.agentIds = ['student-1'];
    const prompt = buildDirectorPrompt(body, [student], 1);
    expect(prompt).toContain(
      'to a classmate. Only Kai ("student-1", a classmate) answers it here.',
    );
    expect(prompt).toContain('Call `call_agent` exactly once, for Kai ("student-1", a classmate)');
    expect(prompt).toContain('the way a classmate whispers back during a lecture');
    expect(prompt).not.toContain('Ask the assistant to answer');
    expect(prompt).toContain('there is no `close_session` here');

    const child = buildChildPrompt(body, student, [], []);
    expect(child).toContain('STUDENT, whispering with the learner during the lecture');
    expect(child).toContain('when you are unsure or do not know, say so');
    expect(child).not.toContain('TEACHING ASSISTANT, answering on the side');
  });

  it('keeps the normal Q&A rules without the flag', () => {
    const prompt = buildDirectorPrompt(makeBody(), [teacher, assistant], 4);
    expect(prompt).toContain('The teacher (role: teacher) should usually');
    expect(prompt).not.toContain('highest priority');
    expect(prompt).toContain('For these call `close_session`');
    expect(prompt).not.toContain('KEEPS lecturing');
  });

  it('relaxes the assistant length cap for an aside answer', () => {
    const aside = buildChildPrompt(makeBody({ asideToLecture: true }), assistant, [], []);
    expect(aside).toContain('answering on the side');
    expect(aside).toContain('around 150 Chinese characters or 2-4 short sentences');
    expect(aside).not.toContain('About 60-100 Chinese characters');
    expect(buildChildTurnPrompt('Answer it.', 'assistant', {}, { aside: true })).toContain(
      'no more than about 150 Chinese characters',
    );

    const qa = buildChildPrompt(makeBody(), assistant, [], []);
    expect(qa).toContain('About 60-100 Chinese characters');
    expect(buildChildTurnPrompt('Answer it.', 'assistant')).toContain(
      'about 60-100 Chinese characters',
    );
  });
});

describe('POST /api/chat/pi with asideToLecture', () => {
  const captured = { childSystemPrompts: [] as string[], callResults: [] as unknown[] };

  function makeRequest(body: unknown): NextRequest {
    return new Request('http://localhost/api/chat/pi', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }) as unknown as NextRequest;
  }

  async function readSseEvents(response: Response) {
    const text = await response.text();
    return text
      .split('\n\n')
      .filter((part) => part.startsWith('data: '))
      .map((part) => JSON.parse(part.slice('data: '.length)));
  }

  /** The director calls the assistant twice (the second over the one-turn limit), then cues */
  function mockDirector() {
    mocks.buildAgent.mockImplementation((agentOpts: MockAgentOptions) => {
      const isDirector = agentOpts.tools.some((tool) => tool.name === 'cue_user');
      if (isDirector) {
        return {
          prompt: async () => {
            const callAgent = agentOpts.tools.find((tool) => tool.name === 'call_agent');
            const cueUser = agentOpts.tools.find((tool) => tool.name === 'cue_user');
            for (const id of ['call-1', 'call-2']) {
              captured.callResults.push(
                await callAgent?.execute(id, {
                  agentId: 'assistant-1',
                  instruction: 'Answer the side question.',
                }),
              );
            }
            await cueUser?.execute('cue-1', { prompt: 'Anything else?' });
          },
          waitForIdle: async () => {},
          subscribe: () => () => {},
          state: { messages: [] },
        };
      }
      captured.childSystemPrompts.push(agentOpts.systemPrompt);
      return {
        subscribe: () => () => {},
        prompt: async () => {},
        waitForIdle: async () => {},
        state: {
          messages: [{ role: 'assistant', content: [{ type: 'text', text: '叶绿素反射绿光。' }] }],
        },
      };
    });
  }

  beforeEach(() => {
    originalPiChatFlag = process.env[PI_CHAT_FLAG];
    originalCoursewareReferenceFlag = process.env[COURSEWARE_REFERENCE_FLAG];
    process.env[PI_CHAT_FLAG] = 'true';
    process.env[COURSEWARE_REFERENCE_FLAG] = 'false';
    vi.resetModules();
    captured.childSystemPrompts = [];
    captured.callResults = [];
    mocks.resolveModel.mockReset();
    mocks.buildAgent.mockReset();
    mocks.createCallLlmStreamFn.mockReset();
    mocks.resolveModel.mockResolvedValue({
      model: { id: 'language-model' },
      apiKey: 'resolved-key',
      providerId: 'test-provider',
      modelInfo: { outputWindow: 4096 },
      thinkingConfig: { mode: 'disabled', enabled: false },
    });
    mocks.createCallLlmStreamFn.mockReturnValue(vi.fn());
    mockDirector();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalPiChatFlag === undefined) delete process.env[PI_CHAT_FLAG];
    else process.env[PI_CHAT_FLAG] = originalPiChatFlag;
    if (originalCoursewareReferenceFlag === undefined) {
      delete process.env[COURSEWARE_REFERENCE_FLAG];
    } else {
      process.env[COURSEWARE_REFERENCE_FLAG] = originalCoursewareReferenceFlag;
    }
  });

  function directorTools() {
    return mocks.buildAgent.mock.calls
      .map(([options]) => options as MockAgentOptions)
      .find((options) => options.tools.some((tool) => tool.name === 'cue_user'))
      ?.tools.map((tool) => tool.name);
  }

  it('gives the director no close_session, one assistant turn, and no stage actions', async () => {
    const { POST } = await import('@/app/api/chat/pi/route');
    const response = await POST(
      makeRequest(makeBody({ asideToLecture: true, piEnableWhiteboardTools: true })),
    );
    const events = await readSseEvents(response);

    expect(response.status).toBe(200);
    expect(directorTools()).toContain('call_agent');
    expect(directorTools()).toContain('cue_user');
    expect(directorTools()).not.toContain('close_session');

    // One agent turn: the second call is refused by the limit
    expect(captured.childSystemPrompts).toHaveLength(1);
    expect(captured.callResults[1]).toMatchObject({
      details: { skipped: true, reason: 'agent_turn_limit', maxAgentTurns: 1 },
    });
    // Text only: the assistant's whiteboard / slide actions are not offered
    expect(captured.childSystemPrompts[0]).not.toContain('Open the whiteboard for hand-drawn');
    expect(captured.childSystemPrompts[0]).toContain('answering on the side');

    expect(events.filter((event) => event.type === 'agent_start')).toHaveLength(1);
    expect(events.some((event) => event.type === 'action')).toBe(false);
    const done = events.find((event) => event.type === 'done');
    expect(done?.data).toMatchObject({ cueUserReceived: true, sessionClosed: false });
  });

  it('offers close_session and the requested whiteboard actions to a normal Q&A', async () => {
    const { POST } = await import('@/app/api/chat/pi/route');
    const response = await POST(makeRequest(makeBody({ piEnableWhiteboardTools: true })));
    await readSseEvents(response);

    expect(directorTools()).toContain('close_session');
    expect(captured.childSystemPrompts[0]).toContain('Open the whiteboard for hand-drawn');
  });
});
