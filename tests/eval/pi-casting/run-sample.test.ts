/**
 * The casting eval's plumbing end to end, with a scripted director instead
 * of a model: a scenario becomes a real Pi request, the real director loop
 * runs it with the scripted children, and the run is observed as the runner
 * scores it (speakers, hand-back, tool trace, and which evidence each child
 * was handed).
 */
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssistantMessage, Context } from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';

const mocks = vi.hoisted(() => ({
  directorScript: [] as AssistantMessage[],
  systemPrompts: [] as string[],
}));

vi.mock('@/lib/agent/runtime/stream-fn', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/agent/runtime/stream-fn')>();
  const { createAssistantMessageEventStream } = await import('@earendil-works/pi-ai');
  return {
    ...actual,
    createCallLlmStreamFn: vi.fn(() => {
      return ((_model, context: Context) => {
        mocks.systemPrompts.push(context.systemPrompt ?? '');
        const stream = createAssistantMessageEventStream();
        const message = mocks.directorScript.shift() ?? scripted([]);
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
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { resolveAgentConfigs } from '@/lib/chat/pi/config';
import { runDirectorSample, runBatched, parseList } from '@/eval/pi-casting/run-sample';
import {
  buildScenarioRequest,
  createScriptedChildStub,
  loadCastingScenarios,
  upcomingSceneIds,
} from '@/eval/pi-casting/scenario';
import {
  collectTurns,
  observeRun,
  toDelegationRecord,
  type DelegationRecord,
} from '@/eval/pi-casting/scoring';

function scripted(calls: Array<{ name: string; args: Record<string, unknown> }>): AssistantMessage {
  return {
    role: 'assistant',
    content: calls.map((call, index) => ({
      type: 'toolCall' as const,
      id: `${call.name}-${index}-${Math.random()}`,
      name: call.name,
      arguments: call.args,
    })),
    api: 'test',
    provider: 'test',
    model: 'scripted-director',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: calls.length > 0 ? 'toolUse' : 'stop',
    timestamp: Date.now(),
  };
}

const file = loadCastingScenarios(
  path.join(process.cwd(), 'eval/pi-casting/scenarios/casting.json'),
);
const scenario = file.scenarios.find(({ id }) => id === 'asks-about-upcoming-page')!;
const evalModel = { model: {} as never };

function queueDirector() {
  mocks.directorScript.push(
    scripted([{ name: 'read_scene', args: { sceneId: 'p11' } }]),
    scripted([
      {
        name: 'call_agent',
        args: { agentId: 's1', instruction: 'She may guess.', castReason: 'voices_confusion' },
      },
    ]),
    scripted([
      {
        name: 'call_agent',
        args: { agentId: 't1', instruction: 'Take up her guess.', castReason: 'clears_up' },
      },
    ]),
    scripted([{ name: 'cue_user', args: {} }]),
  );
}

beforeEach(() => {
  mocks.directorScript.length = 0;
  mocks.systemPrompts.length = 0;
});

describe('runDirectorSample with scripted children', () => {
  it('runs the real loop and observes speakers, hand-back, trace and evidence', async () => {
    queueDirector();
    const body = buildScenarioRequest(file, scenario);
    const delegations: DelegationRecord[] = [];
    const stub = createScriptedChildStub(scenario, resolveAgentConfigs(body), (input) =>
      delegations.push(toDelegationRecord(input)),
    );

    const sample = await runDirectorSample({
      body,
      mode: 'persona',
      evalModel,
      timeoutMs: 10_000,
      childTurnStub: stub,
    });
    expect(sample.error).toBeUndefined();

    const roles = Object.fromEntries(
      resolveAgentConfigs(body).map((agent) => [agent.id, agent.role]),
    );
    const run = observeRun(sample.events, sample.error, {
      delegations,
      upcomingSceneIds: upcomingSceneIds(scenario),
      roles,
    });
    expect(run).toMatchObject({
      speakers: ['s1', 't1'],
      castReasons: ['voices_confusion', 'clears_up'],
      terminal: 'cue_user',
      toolCalls: 4,
      nudged: false,
      fallbackCue: false,
      studentUpcomingEvidence: 0,
    });
    // The student was not handed page 11 (untaught); the teacher was
    expect(delegations.map(({ agentId, evidenceSceneIds }) => [agentId, evidenceSceneIds])).toEqual(
      [
        ['s1', []],
        ['t1', ['p11']],
      ],
    );
    expect(collectTurns(sample.events).map(({ agentId, text }) => [agentId, text])).toEqual([
      ['s1', scenario.scripts!.s1![0]],
      ['t1', scenario.scripts!.t1![0]],
    ]);
  });

  it('passes the casting mode to the director prompt', async () => {
    const body = buildScenarioRequest(file, scenario);
    for (const mode of ['persona', 'legacy'] as const) {
      queueDirector();
      await runDirectorSample({
        body,
        mode,
        evalModel,
        timeoutMs: 10_000,
        childTurnStub: createScriptedChildStub(scenario, resolveAgentConfigs(body)),
      });
    }
    const [persona, legacy] = [mocks.systemPrompts[0], mocks.systemPrompts[4]];
    expect(persona).toContain('You are the director');
    expect(legacy).toContain('You are the director');
    expect(persona).not.toEqual(legacy);
  });
});

describe('runner helpers', () => {
  it('runs jobs in bounded batches and keeps their order', async () => {
    let inFlight = 0;
    let peak = 0;
    const results = await runBatched(5, 2, async (index) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return index;
    });
    expect(results).toEqual([0, 1, 2, 3, 4]);
    expect(peak).toBe(2);
  });

  it('parses comma-separated env lists', () => {
    expect(parseList(' a, ,b ,')).toEqual(['a', 'b']);
    expect(parseList(undefined)).toEqual([]);
  });
});
