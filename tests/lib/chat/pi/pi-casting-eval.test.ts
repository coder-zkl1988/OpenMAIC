/**
 * The Pi casting eval (I21) without a model: its scenarios build valid Pi
 * requests, the scripted child stub replays lines in call order, and the
 * scoring keeps hard checks to plain facts and gates only on regressions.
 */
import path from 'path';
import { describe, expect, it } from 'vitest';
import { buildDirectorPrompt } from '@/lib/chat/pi/prompts';
import { resolveAgentConfigs } from '@/lib/chat/pi/config';
import type { StatelessEvent } from '@/lib/types/chat';
import {
  buildScenarioRequest,
  createScriptedChildStub,
  loadCastingScenarios,
  scenarioAgents,
} from '@/eval/pi-casting/scenario';
import {
  checkExpectation,
  findRegressions,
  observeRun,
  summarizeRuns,
  type CastingEvalSummary,
  type RunObservation,
} from '@/eval/pi-casting/scoring';

const file = loadCastingScenarios(
  path.join(process.cwd(), 'eval/pi-casting/scenarios/casting.json'),
);

describe('casting scenarios', () => {
  it('cover the observed failures and the counter-examples', () => {
    const ids = file.scenarios.map((scenario) => scenario.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(
      expect.arrayContaining([
        'observed-ta-silent-12-pages',
        'observed-student-silent-until-asked',
        'ack-closes',
        'shy-student-just-spoke',
        'ta-silent-no-reason',
      ]),
    );
    expect(
      file.scenarios.find((scenario) => scenario.id === 'observed-ta-silent-12-pages')?.pages,
    ).toHaveLength(12);
  });

  it.each(file.scenarios.map((scenario) => [scenario.id, scenario] as const))(
    '%s builds a request the director can run',
    (_id, scenario) => {
      const body = buildScenarioRequest(file, scenario);
      const agents = resolveAgentConfigs(body);
      const agentIds = new Set(agents.map((agent) => agent.id));
      const sceneIds = new Set(body.storeState.scenes.map((scene) => scene.id));

      expect(agents.map((agent) => agent.id)).toEqual(body.config.agentIds);
      expect(body.storeState.currentSceneId && sceneIds.has(body.storeState.currentSceneId)).toBe(
        true,
      );
      if (body.storeState.lectureProgress) {
        expect(sceneIds.has(body.storeState.lectureProgress.sceneId)).toBe(true);
      }
      for (const message of body.messages) {
        const agentId = (message.metadata as { agentId?: string } | undefined)?.agentId;
        if (agentId) expect(agentIds.has(agentId)).toBe(true);
      }
      for (const id of Object.keys(scenario.scripts ?? {})) expect(agentIds.has(id)).toBe(true);
      for (const expectation of scenario.expect ?? []) {
        if ('agentId' in expectation) expect(agentIds.has(expectation.agentId)).toBe(true);
      }
      for (const entry of body.config.classPresence?.agents ?? []) {
        expect(agentIds.has(entry.agentId)).toBe(true);
        if (entry.lastSceneId) expect(sceneIds.has(entry.lastSceneId)).toBe(true);
      }
      if (body.config.triggerAgentId) expect(agentIds.has(body.config.triggerAgentId)).toBe(true);

      for (const mode of ['persona', 'legacy'] as const) {
        expect(buildDirectorPrompt(body, agents, 6, { castingMode: mode })).toContain(
          'You are the director',
        );
      }
    },
  );

  it('replays each agent its own lines in call order, then repeats the last', async () => {
    const scenario = file.scenarios.find(
      (candidate) => candidate.id === 'observed-student-silent-until-asked',
    )!;
    const stub = createScriptedChildStub(scenario, scenarioAgents(file, scenario));
    const call = (agentId: string) =>
      stub({
        agentId,
        agentName: '',
        role: '',
        instruction: '',
        turnIndex: 0,
        evidenceSceneIds: [],
      });

    expect(await call('t1')).toContain('小思，你来说说');
    expect(await call('s1')).toBe('是……因为它们方向相反吗？');
    expect(await call('t1')).toContain('方向相反只说对了一半');
    expect(await call('t1')).toContain('方向相反只说对了一半');
  });
});

describe('casting eval scoring', () => {
  const roles = { t: 'teacher', a: 'assistant', s: 'student' };

  it('reads a run from its events', () => {
    const events: StatelessEvent[] = [
      { type: 'agent_start', data: { messageId: '1', agentId: 't', agentName: 'T' } },
      {
        type: 'agent_start',
        data: { messageId: '2', agentId: 's', agentName: 'S', castReason: 'asks_learner' },
      },
      { type: 'cue_user', data: { fromAgentId: 's', prompt: '你觉得呢？' } },
      { type: 'done', data: { totalActions: 0, totalAgents: 2 } },
    ];
    expect(observeRun(events)).toEqual({
      speakers: ['t', 's'],
      castReasons: [undefined, 'asks_learner'],
      terminal: 'cue_user',
      cuePrompt: '你觉得呢？',
    });
    expect(
      observeRun([
        {
          type: 'done',
          data: { totalActions: 0, totalAgents: 1, sessionClosed: true, endReason: 'user_done' },
        },
      ]),
    ).toMatchObject({ terminal: 'close_session', endReason: 'user_done' });
  });

  it('checks only plain facts, and fails every check of a broken run', () => {
    const run: RunObservation = { speakers: ['t', 's'], castReasons: [], terminal: 'cue_user' };

    expect(checkExpectation(run, { check: 'firstSpeaker', agentId: 't' }, roles)).toBe(true);
    expect(checkExpectation(run, { check: 'speakerAt', index: 1, agentId: 's' }, roles)).toBe(true);
    expect(checkExpectation(run, { check: 'notCalled', agentId: 'a' }, roles)).toBe(true);
    expect(checkExpectation(run, { check: 'maxTurns', n: 1 }, roles)).toBe(false);
    expect(checkExpectation(run, { check: 'terminal', is: 'close_session' }, roles)).toBe(false);
    // A student's last line passes only when it asked the learner
    expect(checkExpectation(run, { check: 'studentNotLastWord' }, roles)).toBe(false);
    expect(
      checkExpectation({ ...run, cuePrompt: '你呢？' }, { check: 'studentNotLastWord' }, roles),
    ).toBe(true);
    expect(
      checkExpectation({ ...run, error: 'boom' }, { check: 'notCalled', agentId: 'a' }, roles),
    ).toBe(false);
  });

  it('summarizes samples as distributions and observed metrics', () => {
    const summary = summarizeRuns({
      scenarioId: 'x',
      mode: 'persona',
      children: 'stub',
      runs: [
        { speakers: ['t', 's'], castReasons: ['answers_learner', undefined], terminal: 'cue_user' },
        { speakers: ['t'], castReasons: ['answers_learner'], terminal: 'close_session' },
        { speakers: [], castReasons: [], terminal: 'none', error: 'timed out' },
      ],
      expectations: [{ check: 'firstSpeaker', agentId: 't' }],
      roles,
    });

    expect(summary).toMatchObject({
      samples: 3,
      errors: 1,
      hard: [{ label: 't speaks first', passRate: 0.667 }],
      hardPassRate: 0.667,
      distributions: {
        firstSpeaker: { t: 2 },
        sequence: { 't > s': 1, t: 1 },
        terminal: { cue_user: 1, close_session: 1 },
        castReasons: { answers_learner: 2, '(none)': 1 },
      },
      metrics: {
        meanTurns: 1.5,
        nonTeacherShare: 0.333,
        roleCoverage: 0.5,
        studentLastWordHandBack: 0.5,
      },
    });
  });

  it('flags only a drop below the baseline beyond the tolerance', () => {
    const summary = (passRate: number): CastingEvalSummary => ({
      model: 'm',
      createdAt: '',
      samples: 5,
      results: [
        {
          ...summarizeRuns({
            scenarioId: 'x',
            mode: 'persona',
            children: 'stub',
            runs: [],
            expectations: [],
            roles,
          }),
          hard: [{ label: 'ends with close_session', passRate }],
        },
      ],
    });

    expect(findRegressions(summary(0.7), summary(0.8), 0.2)).toEqual([]);
    expect(findRegressions(summary(0.4), summary(0.8), 0.2)).toEqual([
      {
        scenarioId: 'x',
        mode: 'persona',
        children: 'stub',
        label: 'ends with close_session',
        baseline: 0.8,
        current: 0.4,
      },
    ]);
    // A scenario missing from the baseline is never a regression
    expect(findRegressions(summary(0), { ...summary(1), results: [] }, 0)).toEqual([]);
  });
});
