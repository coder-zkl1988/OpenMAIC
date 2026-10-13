/**
 * The classroom half of the persona fidelity eval (I26) with a mock judge:
 * a played request becomes a transcript, the speaker test never shows the
 * judge a name in the line it attributes, and the boundary counters combine
 * the proxies with the judge's reading.
 */
import path from 'path';
import { describe, expect, it } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import type { StatelessEvent } from '@/lib/types/chat';
import { checkRoster } from '@/eval/persona-fidelity/checks';
import {
  assessBoundary,
  assessSpeakers,
  meanCaricature,
  pickClassroomRoster,
  toClassroomRun,
  type TranscriptRun,
} from '@/eval/persona-fidelity/classroom';
import {
  buildClassroomScenario,
  loadFidelityFile,
  type FidelityAgent,
} from '@/eval/persona-fidelity/scenario';

const file = loadFidelityFile(
  path.join(process.cwd(), 'eval/persona-fidelity/scenarios/courses.json'),
);
const waves = file.courses.find(({ id }) => id === 'waves-zh')!;
const classroom = waves.classroom!;
const roster = classroom.roster;

function mockJudge(reply: (prompt: string) => string) {
  const prompts: string[] = [];
  const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
      const prompt = options.prompt
        .flatMap((message) =>
          Array.isArray(message.content)
            ? message.content.map((part) => ('text' in part ? part.text : ''))
            : [message.content],
        )
        .join('\n');
      prompts.push(prompt);
      return {
        content: [{ type: 'text', text: reply(prompt) }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: {
          inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 0, text: 0, reasoning: 0 },
        },
        warnings: [],
      };
    },
  });
  return { model, prompts };
}

function speak(messageId: string, agentId: string, text: string): StatelessEvent[] {
  const name = roster.find((agent) => agent.id === agentId)?.name ?? agentId;
  return [
    { type: 'agent_start', data: { messageId, agentId, agentName: name } },
    ...(text ? [{ type: 'text_delta' as const, data: { messageId, content: text } }] : []),
    { type: 'agent_end', data: { messageId, agentId } },
  ];
}

function playedRun(
  promptId: string,
  events: StatelessEvent[],
  sample = 0,
  error?: string,
): TranscriptRun {
  const prompt = classroom.prompts.find(({ id }) => id === promptId)!;
  const built = buildClassroomScenario(waves, prompt, roster);
  if ('skip' in built) throw new Error(built.skip);
  return toClassroomRun({
    courseId: waves.id,
    promptId,
    sample,
    built,
    agentIds: roster.map(({ id }) => id),
    roster,
    events,
    ...(error ? { error } : {}),
  });
}

describe('pickClassroomRoster', () => {
  const generated: FidelityAgent[] = [
    { id: 'g1', name: '周老师', role: 'teacher', persona: '周老师'.repeat(20) },
    { id: 'g2', name: '大卫', role: 'student', persona: '大卫是个慢热的学生'.repeat(5) },
    { id: 'g3', name: '安安', role: 'assistant', persona: '安安是细心的助教'.repeat(6) },
  ];

  it('plays the fixed roster, or the first usable generated one', () => {
    expect(pickClassroomRoster(waves, 'fixed', []).from).toBe('fixed');
    const usable = { agents: generated, result: { ok: true, check: checkRoster(generated, {}) } };
    expect(pickClassroomRoster(waves, 'generated', [{ result: { ok: false } }, usable])).toEqual({
      roster: generated,
      from: 'generated',
    });
  });

  it('falls back to the fixed roster, saying so, without a usable generated one', () => {
    const tooSmall = generated.slice(0, 2);
    expect(
      pickClassroomRoster(waves, 'generated', [
        { agents: tooSmall, result: { ok: true, check: checkRoster(tooSmall, {}) } },
      ]),
    ).toEqual({ roster, from: 'fixed (no usable generated roster)' });
  });
});

describe('toClassroomRun', () => {
  it('reads who said what, drops empty turns, and keeps the hand-back question', () => {
    const run = playedRun('ask-student', [
      ...speak('m1', 's1', '我……我不太确定，是振幅不一样吗？'),
      ...speak('m2', 'ta1', ''),
      ...speak('m3', 't1', '小思想到了一半，关键是步调。'),
      { type: 'cue_user', data: { fromAgentId: 't1', prompt: '你觉得呢？' } },
      { type: 'done', data: { totalActions: 0, totalAgents: 3 } },
    ]);
    expect(run).toMatchObject({
      courseId: 'waves-zh',
      promptId: 'ask-student',
      learnerText: '小思，你觉得为什么有的地方会抵消？',
      addressedAgentIds: ['s1'],
      aside: false,
      rosterRoles: ['teacher', 'assistant', 'student', 'student'],
      terminal: 'cue_user',
      cuePrompt: '你觉得呢？',
    });
    expect(run.turns.map(({ agentId, role }) => [agentId, role])).toEqual([
      ['s1', 'student'],
      ['t1', 'teacher'],
    ]);
    expect(run.error).toBeUndefined();
    expect(playedRun('why-cancel', [], 1, 'timed out').error).toBe('timed out');
  });
});

describe('meanCaricature', () => {
  it('averages the judge’s caricature, or is null when the verdict is unusable', () => {
    const persona = (caricature: number) => ({
      name: 'x',
      role: 'student',
      chars: 1,
      elements: {
        temperament: true,
        speech: true,
        knowledge: true,
        speaksUp: true,
        misconception: true,
        teaching: null,
      },
      realPerson: 4,
      caricature,
      scriptLike: false,
    });
    expect(
      meanCaricature({ personas: [persona(1), persona(2)], studentsDistinct: true, reason: '' }),
    ).toBe(1.5);
    expect(
      meanCaricature({ personas: [], studentsDistinct: null, reason: '', error: 'x' }),
    ).toBeNull();
  });
});

describe('assessSpeakers', () => {
  it('shows the judge every line without names and scores its picks', async () => {
    const runs = [
      playedRun('ask-student', [
        ...speak('m1', 's1', '我不太确定……我是小思，我猜是振幅不一样？'),
        ...speak('m2', 't1', '小思想到了一半，阿杰你怎么看？关键是步调。'),
        ...speak('m3', 's2', '嗯'),
      ]),
      playedRun('why-cancel', [...speak('m4', 's2', '这不就是波峰撞波谷嘛！')], 0, 'timed out'),
    ];
    const { model, prompts } = mockJudge((prompt) => {
      // A judge that recognises the teacher by the follow-up question and is unsure otherwise
      const line = prompt.slice(prompt.indexOf('The line:'));
      const teacher = /([A-D])\. 林老师/.exec(prompt)![1];
      return JSON.stringify({ speaker: line.includes('怎么看') ? teacher : 'unsure' });
    });

    const summary = await assessSpeakers({
      courseId: waves.id,
      roster,
      runs,
      judgeModel: model,
      concurrency: 2,
      rosterCaricatureMean: 1.25,
    });

    // The failed run is not judged; "嗯" is too short to tell anyone by
    expect(prompts).toHaveLength(2);
    for (const prompt of prompts) {
      const shown = prompt.slice(prompt.indexOf('The learner'));
      for (const agent of roster) expect(shown).not.toContain(agent.name);
      expect(shown).toContain('[NAME]');
    }
    expect(summary).toMatchObject({
      lines: 3,
      tooShort: 1,
      judged: 2,
      errors: 0,
      accuracy: 0.5,
      unsureRate: 0.5,
      chance: 0.25,
      rosterCaricatureMean: 1.25,
    });
    expect(runs[0]!.speakers).toEqual([
      { turnIndex: 0, picked: 'unsure' },
      { turnIndex: 1, picked: 't1' },
    ]);
  });
});

describe('assessBoundary', () => {
  it('counts proxies on every completed run and the judge where it answered', async () => {
    const runs = [
      // A student names an untaught page and has the last word
      playedRun('ahead', [
        ...speak('m1', 't1', '这个问题后面会专门讲，先想想叠加。'),
        ...speak('m2', 's2', '这不就是驻波嘛！'),
      ]),
      // Nobody spoke: nothing to judge
      playedRun('whole-class', []),
      // The judge's answer is unusable
      playedRun('why-cancel', [...speak('m3', 't1', '因为两列波在那里步调相反。')]),
      playedRun('confused-follow-up', [], 0, 'timed out'),
    ];
    const { model, prompts } = mockJudge((prompt) =>
      prompt.includes('驻波嘛')
        ? JSON.stringify({
            untaught: [2],
            student_lectures: [],
            assistant_takes_over: [],
            student_wrong: [2],
            reason: '',
          })
        : 'I cannot tell.',
    );

    const summary = await assessBoundary({
      courseId: waves.id,
      classroom,
      runs,
      judgeModel: model,
      concurrency: 2,
    });

    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain('Not taught yet:\n- 衍射');
    expect(prompts[0]).toContain('(Just said on the current page:');
    expect(runs[0]!.det).toMatchObject({ untaught: [1], wrongUnanswered: [1] });
    expect(runs[0]!.judged).toMatchObject({ untaught: [1], wrongUnanswered: [1] });
    expect(runs[1]!.judged).toEqual({
      untaught: [],
      studentLectures: [],
      assistantTakeover: [],
      wrongUnanswered: [],
    });
    expect(runs[2]!.judgeNote).toContain('Unparseable');
    expect(summary).toMatchObject({ runs: 3, judged: 2, judgeErrors: 1 });
    expect(summary.counters.untaught).toMatchObject({ detRate: 0.333, judgeRate: 0.5 });
    expect(summary.counters.wrongUnanswered).toMatchObject({ detRuns: 1, judgedRuns: 1 });
  });
});
