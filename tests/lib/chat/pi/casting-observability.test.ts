/**
 * Casting observability and the eval seams (I20, I21, I27): call_agent's
 * optional castReason, the eval-only child stub, the castingMode switch, the
 * pi.casting log line, and prompt caching on every Pi LLM call.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssistantMessage, Context } from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import type { AgentConfig } from '@/lib/orchestration/registry/types';
import type { StatelessChatRequest, StatelessEvent } from '@/lib/types/chat';

const mocks = vi.hoisted(() => ({
  directorScript: [] as AssistantMessage[],
  systemPrompts: [] as string[],
  streamOptions: [] as Array<Record<string, unknown>>,
  logInfo: vi.fn(),
}));

vi.mock('@/lib/agent/runtime/stream-fn', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/agent/runtime/stream-fn')>();
  const { createAssistantMessageEventStream } = await import('@earendil-works/pi-ai');
  return {
    ...actual,
    createCallLlmStreamFn: vi.fn((options: Record<string, unknown>) => {
      mocks.streamOptions.push(options);
      return ((_model, context: Context) => {
        mocks.systemPrompts.push(context.systemPrompt ?? '');
        const stream = createAssistantMessageEventStream();
        const message = mocks.directorScript.shift() ?? scripted([], 'done');
        queueMicrotask(() =>
          stream.push({
            type: 'done',
            reason: message.stopReason === 'toolUse' ? 'toolUse' : 'stop',
            message,
          }),
        );
        return stream;
      }) as StreamFn;
    }),
  };
});

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: mocks.logInfo, warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { getPiCastingMode } from '@/lib/config/feature-flags';
import { buildCastingLog, sumAssistantUsage } from '@/lib/chat/pi/casting-log';
import { runPiDirectorLoop } from '@/lib/chat/pi/director-loop';
import { PI_PROMPT_CACHE_OPTIONS } from '@/lib/chat/pi/prompt-cache';
import { buildCallAgentTool, normalizeCastReason } from '@/lib/chat/pi/tools/call-agent';

const USAGE = {
  input: 100,
  output: 20,
  cacheRead: 300,
  cacheWrite: 50,
  totalTokens: 470,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function scripted(
  calls: Array<{ name: string; args: Record<string, unknown> }>,
  text = '',
): AssistantMessage {
  return {
    role: 'assistant',
    content: [
      ...(text ? [{ type: 'text' as const, text }] : []),
      ...calls.map((call, index) => ({
        type: 'toolCall' as const,
        id: `${call.name}-${index}-${Math.random()}`,
        name: call.name,
        arguments: call.args,
      })),
    ],
    api: 'test',
    provider: 'test',
    model: 'scripted-director',
    usage: USAGE,
    stopReason: calls.length > 0 ? 'toolUse' : 'stop',
    timestamp: Date.now(),
  };
}

const now = new Date('2026-01-01T00:00:00Z');
function agent(overrides: Partial<AgentConfig> & Pick<AgentConfig, 'id' | 'name' | 'role'>) {
  return {
    persona: `${overrides.name} is a person in this class with a long enough persona.`,
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
const teacher = agent({ id: 't', name: '林老师', role: 'teacher' });
const assistant = agent({ id: 'a', name: '小禾', role: 'assistant' });
const student = agent({ id: 's1', name: '小思', role: 'student' });
const classroom = [teacher, assistant, student];

function makeBody(config: Partial<StatelessChatRequest['config']> = {}): StatelessChatRequest {
  return {
    messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: '为什么会抵消？' }] }],
    storeState: {
      stage: { id: 'stage-1', name: 'Waves' },
      scenes: [
        {
          id: 'p1',
          title: '干涉',
          order: 1,
          type: 'slide',
          content: { type: 'slide', canvas: { elements: [] } },
        },
      ],
      currentSceneId: 'p1',
      mode: 'autonomous',
      whiteboardOpen: false,
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

function toolOpts(events: StatelessEvent[], overrides: Record<string, unknown> = {}) {
  return {
    body: makeBody(),
    agentConfigs: classroom,
    send: async (event: StatelessEvent) => {
      events.push(event);
    },
    languageModel: {} as never,
    onAgentDone: vi.fn(),
    onActionDone: vi.fn(),
    thinkingConfig: { mode: 'disabled' as const, enabled: false },
    abortSignal: new AbortController().signal,
    maxAgentTurns: 6,
    getAgentTurnCount: () => 0,
    getAgentResponses: () => [],
    getWhiteboardLedger: () => [],
    maxActionsPerAgent: 8,
    enableWhiteboardTools: false,
    ...overrides,
  };
}

beforeEach(() => {
  mocks.directorScript.length = 0;
  mocks.systemPrompts.length = 0;
  mocks.streamOptions.length = 0;
  mocks.logInfo.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('castReason (I20)', () => {
  it('normalizes a valid reason and ignores anything else', () => {
    expect(normalizeCastReason('voices_confusion')).toBe('voices_confusion');
    expect(normalizeCastReason(' Clears_Up ')).toBe('clears_up');
    expect(normalizeCastReason('because')).toBeUndefined();
    expect(normalizeCastReason(3)).toBeUndefined();
    expect(normalizeCastReason(undefined)).toBeUndefined();
  });

  it('is an optional plain string in the call_agent schema', () => {
    const tool = buildCallAgentTool(toolOpts([]));
    const schema = tool.parameters as unknown as {
      required?: string[];
      properties: Record<string, { type?: string; description?: string }>;
    };
    expect(schema.required ?? []).not.toContain('castReason');
    expect(schema.properties.castReason?.type).toBe('string');
    expect(schema.properties.castReason?.description).toContain('voices_confusion');
  });
});

describe('the eval-only child stub (I21)', () => {
  it('runs no child LLM but emits the turn and records it, with castReason', async () => {
    const events: StatelessEvent[] = [];
    const onAgentDone = vi.fn();
    const onAgentTurnMeta = vi.fn();
    const childTurnStub = vi.fn(() => '**我**觉得是方向相反？');
    const tool = buildCallAgentTool(
      toolOpts(events, {
        onAgentDone,
        onAgentTurnMeta,
        childTurnStub,
        getAgentTurnCount: () => 2,
        takeSceneEvidence: () => ({
          content: 'scene packet',
          metadata: [{ sceneId: 'p1' }],
        }),
      }),
    );

    const result = await tool.execute('c1', {
      agentId: 's1',
      instruction: 'She can voice her confusion.',
      castReason: 'voices_confusion',
    });

    expect(childTurnStub).toHaveBeenCalledWith({
      agentId: 's1',
      agentName: '小思',
      role: 'student',
      instruction: 'She can voice her confusion.',
      castReason: 'voices_confusion',
      turnIndex: 2,
      evidenceSceneIds: ['p1'],
    });
    expect(events.map((event) => event.type)).toEqual(['agent_start', 'text_delta', 'agent_end']);
    expect(events[0]).toMatchObject({
      type: 'agent_start',
      data: { agentId: 's1', castReason: 'voices_confusion' },
    });
    expect(events[1]).toMatchObject({ data: { content: '我觉得是方向相反？' } });
    expect(onAgentDone).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 's1', contentPreview: '我觉得是方向相反？' }),
    );
    expect(onAgentTurnMeta).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'student', castReason: 'voices_confusion', chars: 9 }),
    );
    expect(result.details).toMatchObject({
      runtimeMode: 'stub',
      castReason: 'voices_confusion',
      sceneEvidence: [{ sceneId: 'p1' }],
    });
  });

  it('leaves castReason out when it is invalid, and treats an empty line as an empty turn', async () => {
    const events: StatelessEvent[] = [];
    const tool = buildCallAgentTool(toolOpts(events, { childTurnStub: () => '' }));

    await tool.execute('c1', { agentId: 't', instruction: 'Answer.', castReason: 'whatever' });
    expect(events[0]?.type).toBe('agent_start');
    expect((events[0] as { data: Record<string, unknown> }).data).not.toHaveProperty('castReason');
    expect(events.map((event) => event.type)).toEqual(['agent_start', 'agent_end']);

    await tool.execute('c2', { agentId: 't', instruction: 'Answer.' });
    const third = await tool.execute('c3', { agentId: 't', instruction: 'Answer.' });
    expect(third.details).toMatchObject({ skipped: true, reason: 'consecutive_empty_turns' });
  });
});

describe('castingMode (I21)', () => {
  it('reads OPENMAIC_PI_PERSONA_CASTING at call time, persona by default', () => {
    expect(getPiCastingMode()).toBe('persona');
    for (const value of ['legacy', '0', 'false', 'off', ' OFF ']) {
      vi.stubEnv('OPENMAIC_PI_PERSONA_CASTING', value);
      expect(getPiCastingMode()).toBe('legacy');
    }
    for (const value of ['persona', '1', 'true', '']) {
      vi.stubEnv('OPENMAIC_PI_PERSONA_CASTING', value);
      expect(getPiCastingMode()).toBe('persona');
    }
  });
});

describe('sumAssistantUsage', () => {
  it('sums the usage of assistant messages only', () => {
    expect(
      sumAssistantUsage([
        { role: 'user' },
        { role: 'assistant', usage: USAGE },
        { role: 'assistant', usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } },
        { role: 'assistant' },
      ]),
    ).toEqual({ input: 101, output: 22, cacheRead: 303, cacheWrite: 54 });
    expect(sumAssistantUsage([{ role: 'assistant' }])).toBeUndefined();
    expect(sumAssistantUsage(undefined)).toBeUndefined();
  });
});

describe('the pi.casting log (I20)', () => {
  it('summarizes the turns, the ending, the tools and the cost by role', () => {
    const log = buildCastingLog({
      castingMode: 'persona',
      body: makeBody({ sessionType: 'discussion', addressedAgentIds: ['s1'] }),
      agents: classroom,
      turns: [
        {
          summary: {
            agentId: 's1',
            agentName: '小思',
            contentPreview: '嗯？',
            actionCount: 0,
            whiteboardActions: [],
            actionWarnings: [],
          },
          meta: {
            role: 'student',
            castReason: 'addressed',
            chars: 2,
            durationMs: 5,
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
          },
        },
        {
          summary: {
            agentId: 't',
            agentName: '林老师',
            contentPreview: '好问题',
            actionCount: 1,
            whiteboardActions: [],
            actionWarnings: [],
          },
        },
      ],
      terminal: 'cue_user',
      cuePrompt: true,
      studentLastWordNudged: true,
      studentLastWordEnd: 'cue_user',
      studentLastWordAgentId: 's1',
      toolTrace: [
        { sequence: 1, toolName: 'call_agent', args: {}, isError: false, resultPreview: '' },
        {
          sequence: 2,
          toolName: 'call_agent',
          args: {},
          isError: false,
          resultPreview: '',
          details: { skipped: true, reason: 'agent_turn_limit' },
        },
        { sequence: 3, toolName: 'cue_user', args: {}, isError: false, resultPreview: '' },
      ],
      directorUsage: { input: 10, output: 2, cacheRead: 30, cacheWrite: 5 },
    });

    expect(log).toEqual({
      castingMode: 'persona',
      sessionType: 'discussion',
      aside: false,
      momentKind: 'lecture',
      addressed: ['s1'],
      roles: { t: 'teacher', a: 'assistant', s1: 'student' },
      turns: [
        {
          agentId: 's1',
          role: 'student',
          chars: 2,
          durationMs: 5,
          castReason: 'addressed',
          actions: 0,
        },
        { agentId: 't', role: 'teacher', chars: 3, actions: 1 },
      ],
      terminal: 'cue_user',
      cuePrompt: true,
      studentLastWord: { nudged: true, endedBy: 'cue_user', agentId: 's1' },
      toolCalls: 3,
      toolCounts: { call_agent: 2, cue_user: 1 },
      skipped: { 'call_agent:agent_turn_limit': 1 },
      usage: {
        director: { input: 10, output: 2, cacheRead: 30, cacheWrite: 5 },
        byRole: { student: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, turns: 1 } },
      },
    });
  });
});

describe('runPiDirectorLoop with a scripted director and stubbed children', () => {
  async function runLoop(
    opts: { castingMode?: 'persona' | 'legacy'; body?: StatelessChatRequest } = {},
  ) {
    const events: StatelessEvent[] = [];
    const lines: Record<string, string> = {
      t: '两列波在那一点步调相反。',
      s1: '是不是方向相反就会抵消？',
      a: '想象两个人反方向推门。',
    };
    const controller = new AbortController();
    await runPiDirectorLoop({
      body: opts.body ?? makeBody(),
      agentConfigs: classroom,
      send: async (event) => {
        events.push(event);
      },
      languageModel: {} as never,
      thinkingConfig: { mode: 'disabled', enabled: false },
      abortSignal: controller.signal,
      signal: controller.signal,
      maxAgentTurns: 4,
      maxActionsPerAgent: 8,
      enableWhiteboardTools: false,
      ...(opts.castingMode ? { castingMode: opts.castingMode } : {}),
      childTurnStub: ({ agentId }) => lines[agentId] ?? '',
    });
    return events;
  }

  function queueDirector() {
    mocks.directorScript.push(
      scripted([
        {
          name: 'call_agent',
          args: { agentId: 't', instruction: 'Answer it.', castReason: 'answers_learner' },
        },
      ]),
      scripted([
        {
          name: 'call_agent',
          args: { agentId: 's1', instruction: 'Voice it.', castReason: 'voices_confusion' },
        },
      ]),
      scripted([
        {
          name: 'call_agent',
          args: { agentId: 'a', instruction: 'Clear it up.', castReason: 'not-a-reason' },
        },
      ]),
      scripted([{ name: 'cue_user', args: {} }]),
    );
  }

  it('streams the stubbed turns with their castReasons and logs pi.casting', async () => {
    queueDirector();
    const events = await runLoop();

    const starts = events.filter((event) => event.type === 'agent_start');
    expect(starts.map((event) => event.data.agentId)).toEqual(['t', 's1', 'a']);
    expect(starts.map((event) => event.data.castReason)).toEqual([
      'answers_learner',
      'voices_confusion',
      undefined,
    ]);
    expect(events.filter((event) => event.type === 'text_delta')).toHaveLength(3);
    expect(events.at(-2)).toMatchObject({ type: 'cue_user', data: { fromAgentId: 'a' } });
    expect(events.at(-1)?.type).toBe('done');

    const line = mocks.logInfo.mock.calls
      .map((call) => String(call[0]))
      .find((message) => message.startsWith('pi.casting '));
    expect(line).toBeDefined();
    // The student-last-word record lives inside pi.casting, not on its own line
    expect(
      mocks.logInfo.mock.calls.some((call) => String(call[0]).startsWith('pi.student_last_word')),
    ).toBe(false);
    const log = JSON.parse(line!.slice('pi.casting '.length));
    expect(log).toMatchObject({
      castingMode: 'persona',
      sessionType: 'qa',
      terminal: 'cue_user',
      cuePrompt: false,
      toolCounts: { call_agent: 3, cue_user: 1 },
      studentLastWord: { nudged: false },
    });
    expect(log.turns.map((turn: { role: string }) => turn.role)).toEqual([
      'teacher',
      'student',
      'assistant',
    ]);
    expect(log.turns[1]).toMatchObject({ castReason: 'voices_confusion', chars: 12 });
    // Four director calls, each with the scripted usage
    expect(log.usage.director).toEqual({
      input: 400,
      output: 80,
      cacheRead: 1200,
      cacheWrite: 200,
    });
    // No text or learner content in the log
    expect(line).not.toContain('为什么会抵消');
    expect(line).not.toContain('步调相反');
  });

  it('caches the director prompt, whose stable part ends before the course outline', async () => {
    queueDirector();
    await runLoop();

    expect(mocks.streamOptions[0]).toMatchObject({
      source: 'pi-chat-director',
      ...PI_PROMPT_CACHE_OPTIONS,
    });
    const [stable] = mocks.systemPrompts[0]!.split(
      PI_PROMPT_CACHE_OPTIONS.systemPromptSegmentBreak,
    );
    expect(stable).toContain('# Classroom Casting');
    expect(stable).not.toContain('# Course Outline');
    expect(stable).not.toContain('Agents who already spoke');
  });

  it('switches the director to the legacy rules by option or by env', async () => {
    queueDirector();
    await runLoop({ castingMode: 'legacy' });
    expect(mocks.systemPrompts[0]).toContain('Prefer 1-2 classroom agents');
    expect(mocks.systemPrompts[0]).not.toContain('# Classroom Casting');

    mocks.systemPrompts.length = 0;
    vi.stubEnv('OPENMAIC_PI_PERSONA_CASTING', 'off');
    queueDirector();
    await runLoop();
    expect(mocks.systemPrompts[0]).toContain('priority: 1');
    const line = mocks.logInfo.mock.calls
      .map((call) => String(call[0]))
      .findLast((message) => message.startsWith('pi.casting '));
    expect(JSON.parse(line!.slice('pi.casting '.length)).castingMode).toBe('legacy');
  });
});
