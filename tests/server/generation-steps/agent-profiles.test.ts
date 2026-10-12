import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PERSONA_GUIDE } from '@/lib/orchestration/persona-guide';
import { StepRefusal } from '@/lib/server/generation/steps/context';
import {
  echoesLearner,
  generateAgentProfiles,
  readRoster,
  type AgentProfilesInput,
} from '@/lib/server/generation/steps/agent-profiles';

import { fakeModel, testLogger } from './helpers';

const mocks = vi.hoisted(() => ({ callLLM: vi.fn() }));

vi.mock('@/lib/ai/llm', () => ({ callLLM: mocks.callLLM }));

const model = fakeModel();

const request: Omit<AgentProfilesInput, 'model'> = {
  stageInfo: { name: 'Photosynthesis', description: 'How plants make food' },
  sceneOutlines: [{ title: 'Light reactions' }, { title: 'Calvin cycle', description: 'Carbon' }],
  languageDirective: 'Teach in English.',
  availableAvatars: ['/a.png', '/b.png'],
  availableVoices: [
    { providerId: 'tts-a', voiceId: 'v1', voiceName: 'One' },
    { providerId: 'tts-a', modelId: 'm2', voiceId: 'v2', voiceName: 'Two' },
  ],
  narratorVoice: { providerId: 'tts-a', voiceId: 'v2' },
};

function answer(agents: unknown[]) {
  mocks.callLLM.mockResolvedValue({ text: '```json\n' + JSON.stringify({ agents }) + '\n```' });
}

const TEACHER_PERSONA =
  'Ms. Lee is calm and warm, explains slowly with everyday examples, and often asks the class to guess first.';
const STUDENT_PERSONA =
  'Sam is quick and talkative, blurts out "why?" when something surprises him, and still mixes up light and heat.';

const classroom = [
  { name: 'Ms. Lee', role: 'teacher', persona: TEACHER_PERSONA, avatar: '/a.png', color: '#111' },
  {
    name: 'Sam',
    role: 'student',
    persona: STUDENT_PERSONA,
    voice: 'tts-a::v1',
    voiceDesign: { identity: 'young boy', texture: 'bright', delivery: 'quick' },
  },
];

describe('agent profiles step', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.callLLM.mockReset();
  });

  it('binds the teacher to the narrator voice and the others to advertised voices', async () => {
    answer(classroom);
    const agents = await generateAgentProfiles({ ...request, model }, { log: testLogger() });

    expect(mocks.callLLM).toHaveBeenCalledWith(
      expect.objectContaining({ model: model.model }),
      'agent-profiles',
      undefined,
      undefined,
      { serverManaged: false },
    );
    expect(agents).toHaveLength(2);
    expect(agents[0]).toMatchObject({
      role: 'teacher',
      priority: 10,
      voiceConfig: { providerId: 'tts-a', modelId: 'm2', voiceId: 'v2' },
    });
    expect(agents[1]).toMatchObject({
      role: 'student',
      avatar: '/b.png',
      priority: 5,
      voiceConfig: { providerId: 'tts-a', voiceId: 'v1' },
      voiceDesign: { identity: 'young boy', texture: 'bright', delivery: 'quick' },
    });
    expect(agents[0]!.id).toMatch(/^gen-/);
  });

  it('places the classmates around the learner, without anything personal about them', async () => {
    answer(classroom);
    await generateAgentProfiles(
      { ...request, learnerLevel: 'Grade 8, finds formulas hard', model },
      { log: testLogger() },
    );
    const { prompt } = mocks.callLLM.mock.calls[0]![0] as { prompt: string };
    expect(prompt).toContain('Course description: How plants make food');
    expect(prompt).toContain(
      'The learner taking this course (private; only to judge their level): Grade 8, finds formulas hard',
    );
    expect(prompt).toContain("Place their levels around the learner's level given above");
    expect(prompt).toContain('never a copy of the learner');
    expect(prompt).toContain('Never copy anything personal about the real learner');
    expect(prompt).toContain('relate to another agent in this class');
    expect(prompt).toContain('never an invented or unusual error');
  });

  it('places the classmates around the course level when the learner said nothing', async () => {
    answer(classroom);
    await generateAgentProfiles({ ...request, model }, { log: testLogger() });
    const { prompt } = mocks.callLLM.mock.calls[0]![0] as { prompt: string };
    expect(prompt).not.toContain('The learner taking this course');
    expect(prompt).toContain('Place their levels around the level the course is aimed at');
  });

  it('writes personas with the one shared guide', async () => {
    answer(classroom);
    await generateAgentProfiles({ ...request, model }, { log: testLogger() });
    const { prompt, system } = mocks.callLLM.mock.calls[0]![0] as {
      prompt: string;
      system: string;
    };
    expect(prompt).toContain(PERSONA_GUIDE.split('\n')[0]);
    expect(prompt).toContain('typically 3-5');
    expect(system).toContain('typically 3-5');
  });

  it.each([
    ['not json', 'unparseable'],
    [JSON.stringify({ agents: [classroom[0]] }), 'too-few-agents'],
    [JSON.stringify({ agents: [classroom[0], classroom[0]] }), 'teacher-count'],
    [
      JSON.stringify({ agents: [classroom[0], { ...classroom[1], persona: 'Curious.' }] }),
      'persona-too-short',
    ],
    [
      JSON.stringify({ agents: [classroom[0], { ...classroom[1], role: 'janitor' }] }),
      'unknown-role',
    ],
  ])('refuses an answer still unusable when asked again (%#)', async (text, reason) => {
    mocks.callLLM.mockResolvedValue({ text });
    const failure = await generateAgentProfiles({ ...request, model }, { log: testLogger() }).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(StepRefusal);
    expect((failure as StepRefusal).reason).toBe(reason);
    expect(mocks.callLLM).toHaveBeenCalledTimes(2);
  });

  it('asks once more with what was wrong, and keeps the corrected answer', async () => {
    mocks.callLLM
      .mockResolvedValueOnce({
        text: JSON.stringify({
          agents: [classroom[0], { ...classroom[1], name: 'Ms. Lee', persona: 'Shy.' }],
        }),
      })
      .mockResolvedValueOnce({ text: JSON.stringify({ agents: classroom }) });
    const agents = await generateAgentProfiles({ ...request, model }, { log: testLogger() });

    expect(agents.map((agent) => agent.name)).toEqual(['Ms. Lee', 'Sam']);
    const first = (mocks.callLLM.mock.calls[0]![0] as { prompt: string }).prompt;
    const second = (mocks.callLLM.mock.calls[1]![0] as { prompt: string }).prompt;
    expect(second.startsWith(first)).toBe(true);
    expect(second).toContain('Your previous answer could not be used:');
    expect(second).toContain('- Agent 2 ("Ms. Lee") has the same name as agent 1');
    expect(second).toContain('- Agent 2 ("Ms. Lee")\'s persona is 4 characters');
  });

  it('reads a localized role as the role it names', async () => {
    answer([
      { ...classroom[0], role: '老师' },
      { ...classroom[1], role: '学生' },
      {
        name: 'Ada',
        role: 'TA',
        persona:
          'Ada is a patient graduate student who quietly offers a hint when someone is stuck.',
      },
    ]);
    const agents = await generateAgentProfiles({ ...request, model }, { log: testLogger() });
    expect(agents.map((agent) => [agent.role, agent.priority])).toEqual([
      ['teacher', 10],
      ['student', 5],
      ['assistant', 7],
    ]);
    // The teacher, found by its normalized role, still speaks with the narrator voice.
    expect(agents[0]!.voiceConfig).toEqual({ providerId: 'tts-a', modelId: 'm2', voiceId: 'v2' });
    expect(mocks.callLLM).toHaveBeenCalledTimes(1);
  });

  it('writes the class size and kind the learner chose, as people', async () => {
    answer([
      ...classroom,
      {
        ...classroom[1],
        name: 'Max',
        persona:
          'Max is shy and careful, writes everything down, and speaks only when he is sure of the answer.',
      },
    ]);
    await generateAgentProfiles(
      { ...request, agentCount: 3, classAtmosphere: 'lively', model },
      { log: testLogger() },
    );
    const { prompt, system } = mocks.callLLM.mock.calls[0]![0] as {
      prompt: string;
      system: string;
    };
    expect(system).toContain('The class has exactly 3 agents.');
    expect(prompt).toContain('Generate exactly 3 agents: the teacher and 2 others');
    expect(prompt).not.toContain('typically 3-5');
    expect(prompt).toContain('This is a lively, talkative class');
    expect(prompt).toContain('each still has their own temperament and level');
  });

  it('asks again for a class of the wrong size, and keeps it rather than fall back', async () => {
    answer(classroom);
    const log = testLogger();
    const agents = await generateAgentProfiles({ ...request, agentCount: 4, model }, { log });
    expect(agents).toHaveLength(2);
    expect(mocks.callLLM).toHaveBeenCalledTimes(2);
    const second = (mocks.callLLM.mock.calls[1]![0] as { prompt: string }).prompt;
    expect(second).toContain(
      '- The class has exactly 4 agents (the teacher and 3 others); there are 2.',
    );
    expect(log.warn).toHaveBeenCalledWith('Agent profiles: kept a class of 2, not 4');
  });

  it('keeps a usable class of the wrong size when its retry is unusable', async () => {
    mocks.callLLM
      .mockResolvedValueOnce({ text: JSON.stringify({ agents: classroom }) })
      .mockResolvedValueOnce({ text: 'not json' });
    const log = testLogger();
    const agents = await generateAgentProfiles({ ...request, agentCount: 3, model }, { log });
    expect(agents.map((agent) => agent.name)).toEqual(['Ms. Lee', 'Sam']);
    expect(mocks.callLLM).toHaveBeenCalledTimes(2);
    expect(log.warn).toHaveBeenCalledWith(
      'Agent profiles attempt 1 unusable (agent-count): Expected 3 agents but the LLM returned 2',
    );
    expect(log.warn).toHaveBeenCalledWith('Agent profiles: kept a class of 2, not 3');
  });

  it('keeps a usable class of the wrong size when its retry fails', async () => {
    mocks.callLLM
      .mockResolvedValueOnce({ text: JSON.stringify({ agents: classroom }) })
      .mockRejectedValueOnce(new Error('provider down'));
    const agents = await generateAgentProfiles(
      { ...request, agentCount: 3, model },
      { log: testLogger() },
    );
    expect(agents).toHaveLength(2);
  });

  it('gives the retry for the size only the time left before the deadline', async () => {
    answer(classroom);
    // Too little time left: no retry at all
    const agents = await generateAgentProfiles(
      { ...request, agentCount: 3, deadlineAt: Date.now() + 5_000, model },
      { log: testLogger() },
    );
    expect(agents).toHaveLength(2);
    expect(mocks.callLLM).toHaveBeenCalledTimes(1);

    // Enough time: the retry runs under a signal that ends before the deadline
    mocks.callLLM.mockClear();
    let retrySignal: AbortSignal | undefined;
    mocks.callLLM
      .mockResolvedValueOnce({ text: JSON.stringify({ agents: classroom }) })
      .mockImplementationOnce(async (options: { abortSignal?: AbortSignal }) => {
        retrySignal = options.abortSignal;
        throw new DOMException('The operation timed out.', 'TimeoutError');
      });
    const kept = await generateAgentProfiles(
      { ...request, agentCount: 3, deadlineAt: Date.now() + 60_000, model },
      { log: testLogger() },
    );
    expect(kept).toHaveLength(2);
    expect(retrySignal).toBeInstanceOf(AbortSignal);
  });

  it('still fails when the run itself was aborted during the retry', async () => {
    const run = new AbortController();
    mocks.callLLM
      .mockResolvedValueOnce({ text: JSON.stringify({ agents: classroom }) })
      .mockImplementationOnce(async () => {
        run.abort();
        throw new DOMException('Aborted', 'AbortError');
      });
    const failure = await generateAgentProfiles(
      { ...request, agentCount: 3, model },
      { log: testLogger(), signal: run.signal },
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DOMException);
  });

  it("asks again when a persona repeats the learner's own words or name, and never keeps it", async () => {
    const echoing = [
      classroom[0],
      {
        ...classroom[1],
        persona: `${STUDENT_PERSONA} He goes to Lincoln High School in Ohio and plays basketball.`,
      },
    ];
    mocks.callLLM
      .mockResolvedValueOnce({ text: JSON.stringify({ agents: echoing }) })
      .mockResolvedValueOnce({ text: JSON.stringify({ agents: classroom }) });
    const log = testLogger();
    const agents = await generateAgentProfiles(
      {
        ...request,
        learnerLevel: 'Grade 8 at Lincoln High School in Ohio, finds formulas hard',
        model,
      },
      { log },
    );
    expect(agents[1]!.persona).toBe(STUDENT_PERSONA);
    const second = (mocks.callLLM.mock.calls[1]![0] as { prompt: string }).prompt;
    expect(second).toContain(
      '- Agent 2 ("Sam"): the persona repeats the real learner\'s own words or name.',
    );
    // The log never quotes the learner's words
    expect(JSON.stringify(vi.mocked(log.warn).mock.calls)).not.toContain('Lincoln');

    mocks.callLLM.mockReset();
    mocks.callLLM.mockResolvedValue({ text: JSON.stringify({ agents: echoing }) });
    const failure = await generateAgentProfiles(
      { ...request, learnerLevel: 'Grade 8 at Lincoln High School in Ohio', model },
      { log: testLogger() },
    ).catch((error: unknown) => error);
    expect((failure as StepRefusal).reason).toBe('learner-detail');
  });
});

describe('reading a roster the model wrote', () => {
  it('says what to fix, one line each', () => {
    const reading = readRoster(
      JSON.stringify({ agents: [{ name: 'A', role: 'teacher', persona: TEACHER_PERSONA }, null] }),
    );
    expect(reading).toMatchObject({ ok: false, reason: 'unknown-role' });
    expect(reading.ok ? '' : reading.feedback.split('\n')).toEqual([
      '- Agent 2 has the role ""; a role is "teacher", "assistant" or "student".',
      '- Agent 2 has no name.',
      '- Agent 2 has no persona.',
    ]);
  });

  it('names a usable class of the wrong size by its size, and keeps it at hand', () => {
    const text = JSON.stringify({ agents: classroom });
    const tooMany = readRoster(text, { agentCount: 1 });
    expect(tooMany).toMatchObject({ ok: false, reason: 'agent-count' });
    expect(tooMany.ok ? undefined : tooMany.usable).toHaveLength(2);
    expect(readRoster(text, { agentCount: 1, lastAttempt: true })).toMatchObject({ ok: true });
  });

  it('finds the learner repeated: their name, 6 CJK characters or 4 words in a row', () => {
    expect(echoesLearner('小明很爱提问。', { name: '小明' })).toBe(true);
    expect(echoesLearner('Samuel is the same as ever.', { name: 'Sam' })).toBe(false);
    expect(echoesLearner('Ask sam, he knows.', { name: 'Sam' })).toBe(true);
    expect(echoesLearner('她在北京四中读初二。', { level: '我在北京四中读初二，喜欢篮球' })).toBe(
      true,
    );
    expect(echoesLearner('她读初二，数学一般。', { level: '我在北京四中读初二，喜欢篮球' })).toBe(
      false,
    );
    expect(
      echoesLearner('He also finds formulas hard at times.', {
        level: 'Grade 8, finds formulas hard at times',
      }),
    ).toBe(true);
    expect(
      echoesLearner('He finds formulas hard.', { level: 'Grade 8, finds formulas hard' }),
    ).toBe(false);
  });

  it('says when it is not the JSON asked for', () => {
    expect(readRoster('{"agents": {}}')).toMatchObject({ ok: false, reason: 'unparseable' });
    expect(readRoster('null')).toMatchObject({ ok: false, reason: 'unparseable' });
  });
});
