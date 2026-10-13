/**
 * The Pi casting eval's scoring (I21), without a model: what a run is read
 * as (tool trace, scripted delegations, streamed turns), the plain-fact
 * checks, the observed metrics, and the persona-vs-legacy comparison.
 */
import { describe, expect, it } from 'vitest';
import type { StatelessEvent } from '@/lib/types/chat';
import {
  checkExpectation,
  collectTurns,
  compareModes,
  observeRun,
  quotesLine,
  summarizeRuns,
  toDelegationRecord,
  type DelegationRecord,
  type RunObservation,
} from '@/eval/pi-casting/scoring';

const roles = { t: 'teacher', a: 'assistant', s: 'student' };

function done(
  trace: Array<{ toolName: string; details?: unknown }>,
  extra: Record<string, unknown> = {},
): StatelessEvent {
  return {
    type: 'done',
    data: {
      totalActions: 0,
      totalAgents: 0,
      directorToolTrace: trace.map((entry, index) => ({
        sequence: index + 1,
        args: {},
        isError: false,
        resultPreview: '',
        ...entry,
      })),
      ...extra,
    },
  };
}

describe('quotesLine (H1)', () => {
  it('flags an instruction that writes the line for the agent', () => {
    expect(quotesLine('让小思说「我觉得是方向相反吧」')).toBe(true);
    expect(quotesLine('Have her say "maybe the amplitudes differ" in her own words')).toBe(true);
    expect(quotesLine('请他回应“为什么会抵消”这个问题')).toBe(true);
  });

  it('leaves situation-and-intent instructions alone', () => {
    expect(quotesLine('小思 is still unsure about phase; she can voice that confusion')).toBe(
      false,
    );
    // Short quoted terms are naming a concept, not scripting a line
    expect(quotesLine('解释一下「相位」')).toBe(false);
    // English apostrophes never pair up into a quote
    expect(quotesLine("She doesn't know it yet, so she shouldn't explain it")).toBe(false);
  });
});

describe('toDelegationRecord', () => {
  it('keeps who, why and which evidence, and whether the line was scripted', () => {
    expect(
      toDelegationRecord({
        agentId: 's',
        agentName: '小思',
        role: 'student',
        instruction: '让她说「我猜是振幅不一样」',
        castReason: 'voices_confusion',
        turnIndex: 1,
        evidenceSceneIds: ['p3'],
      }),
    ).toEqual({
      agentId: 's',
      role: 'student',
      castReason: 'voices_confusion',
      quotesLine: true,
      evidenceSceneIds: ['p3'],
    });
  });
});

describe('collectTurns', () => {
  it('joins each turn’s streamed text by message, in speaking order', () => {
    const events: StatelessEvent[] = [
      { type: 'agent_start', data: { messageId: 'm1', agentId: 't', agentName: '林老师' } },
      { type: 'text_delta', data: { messageId: 'm1', content: ' 因为步调' } },
      { type: 'text_delta', data: { messageId: 'm1', content: '相反。 ' } },
      { type: 'agent_end', data: { messageId: 'm1', agentId: 't' } },
      { type: 'agent_start', data: { messageId: 'm2', agentId: 's', agentName: '小思' } },
      // A delta without a message id belongs to the open turn
      { type: 'text_delta', data: { content: '哦……' } },
      { type: 'agent_end', data: { messageId: 'm2', agentId: 's' } },
      { type: 'agent_start', data: { messageId: 'm3', agentId: 'a', agentName: '小禾' } },
      { type: 'agent_end', data: { messageId: 'm3', agentId: 'a' } },
    ];
    expect(collectTurns(events)).toEqual([
      { messageId: 'm1', agentId: 't', agentName: '林老师', text: '因为步调相反。' },
      { messageId: 'm2', agentId: 's', agentName: '小思', text: '哦……' },
      { messageId: 'm3', agentId: 'a', agentName: '小禾', text: '' },
    ]);
  });
});

describe('observeRun with the tool trace and the scripted delegations', () => {
  it('reads the nudge, the tool count and a cue_user hand-back from the trace', () => {
    const run = observeRun([
      { type: 'agent_start', data: { messageId: '1', agentId: 's', agentName: 'S' } },
      { type: 'cue_user', data: { fromAgentId: 's', prompt: '你觉得呢？' } },
      done([
        { toolName: 'call_agent' },
        { toolName: 'cue_user', details: { emitted: false, reason: 'student_last_word' } },
        { toolName: 'cue_user', details: { emitted: true } },
      ]),
    ]);
    expect(run).toMatchObject({
      terminal: 'cue_user',
      toolCalls: 3,
      nudged: true,
      fallbackCue: false,
    });
  });

  it('tells the loop’s automatic hand-back from a cue_user call', () => {
    const run = observeRun([
      { type: 'agent_start', data: { messageId: '1', agentId: 't', agentName: 'T' } },
      { type: 'cue_user', data: { fromAgentId: 't' } },
      done([{ toolName: 'call_agent' }]),
    ]);
    expect(run).toMatchObject({ terminal: 'cue_user', fallbackCue: true, nudged: false });
    // Closing is never a fallback cue
    expect(
      observeRun([done([{ toolName: 'close_session' }], { sessionClosed: true })]).fallbackCue,
    ).toBe(false);
  });

  it('counts student delegations that carried an untaught page’s evidence', () => {
    const delegations: DelegationRecord[] = [
      { agentId: 's', role: 'student', quotesLine: false, evidenceSceneIds: ['p11'] },
      { agentId: 's', role: 'student', quotesLine: false, evidenceSceneIds: ['p3'] },
      // The teacher may get it: they preview what comes next
      { agentId: 't', role: 'teacher', quotesLine: false, evidenceSceneIds: ['p11'] },
    ];
    const run = observeRun([], undefined, { delegations, upcomingSceneIds: ['p10', 'p11'] });
    expect(run.studentUpcomingEvidence).toBe(1);
    expect(run.delegations).toEqual(delegations);
    expect(checkExpectation(run, { check: 'noUpcomingEvidenceToStudents' }, roles)).toBe(false);
    expect(
      checkExpectation(
        { ...run, studentUpcomingEvidence: 0 },
        { check: 'noUpcomingEvidenceToStudents' },
        roles,
      ),
    ).toBe(true);
  });
});

describe('student evidence from the tool trace', () => {
  it('reads what each child actually got, for stub and real children alike', () => {
    const events: StatelessEvent[] = [
      done([
        { toolName: 'read_scene' },
        {
          toolName: 'call_agent',
          details: { agentId: 's', sceneEvidence: [{ sceneId: 'p11', title: 'Doppler' }] },
        },
        { toolName: 'call_agent', details: { agentId: 't', sceneEvidence: [{ sceneId: 'p11' }] } },
        { toolName: 'call_agent', details: { agentId: 'a' } },
      ]),
    ];
    const context = { upcomingSceneIds: ['p11'], roles };
    expect(observeRun(events, undefined, context).studentUpcomingEvidence).toBe(1);
    // The trace wins over what the stub saw
    expect(
      observeRun(events, undefined, {
        ...context,
        delegations: [{ agentId: 's', role: 'student', quotesLine: false, evidenceSceneIds: [] }],
      }).studentUpcomingEvidence,
    ).toBe(1);
    // Without upcoming pages there is nothing to count
    expect(observeRun(events, undefined, { roles }).studentUpcomingEvidence).toBeUndefined();
  });
});

describe('the cuePrompt check', () => {
  const run: RunObservation = { speakers: ['t'], castReasons: [], terminal: 'cue_user' };

  it('passes only when the hand-back carries a question to the learner', () => {
    expect(checkExpectation(run, { check: 'cuePrompt' }, roles)).toBe(false);
    expect(checkExpectation({ ...run, cuePrompt: '会怎样？' }, { check: 'cuePrompt' }, roles)).toBe(
      true,
    );
    expect(
      checkExpectation(
        { ...run, terminal: 'close_session', cuePrompt: '会怎样？' },
        { check: 'cuePrompt' },
        roles,
      ),
    ).toBe(false);
  });
});

describe('summarizeRuns: observed metrics', () => {
  it('reports nudges, fallback cues, scripted instructions and the last speaker’s role', () => {
    const summary = summarizeRuns({
      scenarioId: 'x',
      mode: 'persona',
      children: 'stub',
      roles,
      expectations: [],
      runs: [
        {
          speakers: ['t', 's'],
          castReasons: [],
          terminal: 'cue_user',
          toolCalls: 4,
          nudged: true,
          fallbackCue: false,
          delegations: [
            { agentId: 't', role: 'teacher', quotesLine: false, evidenceSceneIds: [] },
            { agentId: 's', role: 'student', quotesLine: true, evidenceSceneIds: [] },
          ],
        },
        {
          speakers: ['t'],
          castReasons: [],
          terminal: 'cue_user',
          toolCalls: 2,
          nudged: false,
          fallbackCue: true,
          delegations: [{ agentId: 't', role: 'teacher', quotesLine: false, evidenceSceneIds: [] }],
        },
        // No trace (an older event stream): left out of the trace metrics
        { speakers: ['a'], castReasons: [], terminal: 'close_session' },
      ],
    });
    expect(summary.metrics).toMatchObject({
      nudgeRate: 0.5,
      fallbackCueRate: 0.5,
      scriptedInstructionShare: 0.333,
      meanToolCalls: 3,
    });
    expect(summary.distributions.lastSpeakerRole).toEqual({
      student: 1,
      teacher: 1,
      assistant: 1,
    });
  });

  it('reports zero rates, not NaN, when nothing was traced or delegated', () => {
    const summary = summarizeRuns({
      scenarioId: 'x',
      mode: 'legacy',
      children: 'e2e',
      roles,
      expectations: [],
      runs: [{ speakers: [], castReasons: [], terminal: 'none' }],
    });
    expect(summary.metrics).toMatchObject({
      nudgeRate: 0,
      fallbackCueRate: 0,
      scriptedInstructionShare: 0,
      meanToolCalls: 0,
    });
    expect(summary.distributions.lastSpeakerRole).toEqual({ '(none)': 1 });
  });
});

describe('compareModes', () => {
  function result(
    scenarioId: string,
    mode: 'persona' | 'legacy',
    children: 'stub' | 'e2e',
    runs: RunObservation[],
  ) {
    return summarizeRuns({
      scenarioId,
      mode,
      children,
      runs,
      roles,
      expectations: [{ check: 'firstSpeaker', agentId: 's' }],
    });
  }

  it('pairs persona with legacy per scenario and child runtime', () => {
    const comparisons = compareModes([
      result('x', 'persona', 'stub', [
        { speakers: ['s', 't'], castReasons: [], terminal: 'cue_user' },
        { speakers: ['s', 't'], castReasons: [], terminal: 'cue_user' },
      ]),
      result('x', 'legacy', 'stub', [
        { speakers: ['t'], castReasons: [], terminal: 'cue_user' },
        { speakers: ['s', 't'], castReasons: [], terminal: 'cue_user' },
      ]),
      // No legacy counterpart: not compared
      result('x', 'persona', 'e2e', [{ speakers: ['s'], castReasons: [], terminal: 'cue_user' }]),
      result('y', 'legacy', 'stub', [{ speakers: ['t'], castReasons: [], terminal: 'cue_user' }]),
    ]);

    expect(comparisons).toEqual([
      {
        scenarioId: 'x',
        children: 'stub',
        persona: {
          hardPassRate: 1,
          meanTurns: 2,
          nonTeacherShare: 0.5,
          roleCoverage: 0.667,
          topSequence: 's > t',
        },
        legacy: {
          hardPassRate: 0.5,
          meanTurns: 1.5,
          nonTeacherShare: 0.333,
          roleCoverage: 0.5,
          // A tie between sequences resolves alphabetically
          topSequence: 's > t',
        },
        hardPassDelta: 0.5,
      },
    ]);
  });
});
