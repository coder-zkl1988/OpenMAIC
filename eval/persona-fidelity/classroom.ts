/**
 * The classroom half of the persona fidelity eval (I26): what a played
 * request is read as, which roster plays it, and how its lines are put to
 * the judge for speaker identification and the cognitive-boundary counts.
 * The runner plays the class; everything after the events lives here so it
 * can be tested with a mock judge.
 */
import type { LanguageModel } from 'ai';
import type { StatelessEvent } from '@/lib/types/chat';
import { runBatched } from '../pi-casting/run-sample';
import { collectTurns, observeRun } from '../pi-casting/scoring';
import {
  MIN_SPEAKER_UNITS,
  anonymize,
  detectBoundary,
  emptyBoundaryFlags,
  judgedBoundary,
  speechUnits,
  summarizeBoundary,
  summarizeSpeakerId,
  type BoundaryFlags,
  type BoundarySummary,
  type ClassroomRun,
  type GenerationSample,
  type RosterVerdict,
  type SpeakerJudgment,
  type SpeakerSummary,
} from './checks';
import { judgeBoundary, judgeSpeaker } from './judge';
import {
  currentNarration,
  splitPages,
  taughtText,
  type ClassroomScenario,
  type FidelityAgent,
  type FidelityClassroom,
  type FidelityCourse,
} from './scenario';

/** A played request, with what the judge and the proxies made of it (transcripts.json) */
export type TranscriptRun = ClassroomRun & {
  det?: BoundaryFlags;
  judged?: BoundaryFlags;
  /** Why the judge's boundary verdict could not be used */
  judgeNote?: string;
  speakers?: Array<{ turnIndex: number; picked?: string; error?: string }>;
};

/** The roster that plays a course's classroom, and where it came from */
export function pickClassroomRoster(
  course: FidelityCourse,
  source: 'fixed' | 'generated',
  generated: ReadonlyArray<{ agents?: FidelityAgent[]; result: GenerationSample }>,
): { roster: FidelityAgent[]; from: string } {
  const fixed = course.classroom?.roster ?? [];
  if (source === 'fixed') return { roster: fixed, from: 'fixed' };
  const usable = generated.find(
    ({ agents, result }) =>
      agents && result.check?.valid && agents.length >= 3 && result.check.counts.student > 0,
  );
  return usable?.agents
    ? { roster: usable.agents, from: 'generated' }
    : { roster: fixed, from: 'fixed (no usable generated roster)' };
}

/** One played request as the eval reads it: who said what, and how it ended */
export function toClassroomRun(opts: {
  courseId: string;
  promptId: string;
  sample: number;
  built: Extract<ClassroomScenario, { scenario: unknown }>;
  /** The request's agents (body.config.agentIds) */
  agentIds: readonly string[];
  roster: readonly FidelityAgent[];
  events: readonly StatelessEvent[];
  error?: string;
}): TranscriptRun {
  const roles = Object.fromEntries(opts.roster.map((agent) => [agent.id, agent.role]));
  const observation = observeRun(opts.events, opts.error);
  const config = opts.built.scenario.config;
  return {
    courseId: opts.courseId,
    promptId: opts.promptId,
    sample: opts.sample,
    learnerText: opts.built.learnerText,
    addressedAgentIds: config?.addressedAgentIds ?? [],
    aside: config?.asideToLecture === true,
    rosterRoles: opts.agentIds.map((id) => roles[id] ?? 'unknown'),
    turns: collectTurns(opts.events)
      .filter((turn) => turn.text)
      .map((turn) => ({
        agentId: turn.agentId,
        name: turn.agentName,
        role: roles[turn.agentId] ?? 'unknown',
        text: turn.text,
      })),
    terminal: observation.terminal,
    ...(observation.cuePrompt ? { cuePrompt: observation.cuePrompt } : {}),
    ...(observation.error ? { error: observation.error } : {}),
  };
}

/** The roster's mean caricature as the judge rated it (null when unusable) */
export function meanCaricature(verdict: RosterVerdict): number | null {
  if (verdict.error || verdict.personas.length === 0) return null;
  const total = verdict.personas.reduce((sum, persona) => sum + persona.caricature, 0);
  return Number((total / verdict.personas.length).toFixed(3));
}

/**
 * Put every line long enough to tell (MIN_SPEAKER_UNITS) to the judge, with
 * every roster name removed from it and from the learner's message, and the
 * roster in a per-line order. Each run records the judge's picks.
 */
export async function assessSpeakers(opts: {
  courseId: string;
  roster: readonly FidelityAgent[];
  runs: readonly TranscriptRun[];
  judgeModel: LanguageModel;
  concurrency: number;
  rosterCaricatureMean?: number | null;
}): Promise<SpeakerSummary> {
  const names = opts.roster.map((agent) => agent.name);
  const lines = opts.runs
    .filter((run) => !run.error)
    .flatMap((run) => run.turns.map((turn, turnIndex) => ({ run, turn, turnIndex })));
  const judgeable = lines.filter(({ turn }) => speechUnits(turn.text) >= MIN_SPEAKER_UNITS);
  const judgments = await runBatched(judgeable.length, opts.concurrency, async (index) => {
    const { run, turn, turnIndex } = judgeable[index]!;
    const verdict = await judgeSpeaker(opts.judgeModel, {
      roster: opts.roster,
      learnerText: anonymize(run.learnerText, names),
      line: anonymize(turn.text, names),
      seed: `${run.promptId}#${run.sample}#${turnIndex}`,
    });
    (run.speakers ??= []).push({
      turnIndex,
      ...(verdict.picked ? { picked: verdict.picked } : {}),
      ...(verdict.error ? { error: verdict.error } : {}),
    });
    const judgment: SpeakerJudgment = {
      promptId: run.promptId,
      turnIndex,
      trueAgentId: turn.agentId,
      ...(verdict.picked ? { picked: verdict.picked } : {}),
      ...(verdict.confidence ? { confidence: verdict.confidence } : {}),
      ...(verdict.error ? { error: verdict.error } : {}),
    };
    return judgment;
  });
  for (const run of opts.runs) run.speakers?.sort((a, b) => a.turnIndex - b.turnIndex);
  return summarizeSpeakerId({
    courseId: opts.courseId,
    roles: Object.fromEntries(opts.roster.map((agent) => [agent.id, agent.role])),
    lines: lines.length,
    tooShort: lines.length - judgeable.length,
    judgments,
    ...(opts.rosterCaricatureMean !== undefined
      ? { rosterCaricatureMean: opts.rosterCaricatureMean }
      : {}),
  });
}

/**
 * The four cognitive-boundary counters of each completed run: the
 * deterministic proxies always, the judge's reading when it gave a usable
 * one (a run where nobody spoke has nothing to judge).
 */
export async function assessBoundary(opts: {
  courseId: string;
  classroom: FidelityClassroom;
  runs: readonly TranscriptRun[];
  judgeModel: LanguageModel;
  concurrency: number;
}): Promise<BoundarySummary> {
  const context = {
    upcomingTerms: opts.classroom.upcomingTerms,
    taughtText: taughtText(opts.classroom),
  };
  const { taught, upcoming } = splitPages(opts.classroom);
  const narration = currentNarration(opts.classroom).join(' ');
  const completed = opts.runs.filter((run) => !run.error);
  await runBatched(completed.length, opts.concurrency, async (index) => {
    const run = completed[index]!;
    run.det = detectBoundary(run, context);
    if (run.turns.length === 0) {
      run.judged = emptyBoundaryFlags();
      return;
    }
    const verdict = await judgeBoundary(opts.judgeModel, {
      taught,
      ...(narration ? { currentNarration: narration } : {}),
      upcoming,
      learnerText: run.learnerText,
      turns: run.turns,
    });
    if (verdict.error) run.judgeNote = verdict.error;
    else run.judged = judgedBoundary(run, verdict);
  });
  return summarizeBoundary(
    opts.courseId,
    opts.runs.map((run) => ({
      run,
      det: run.det ?? emptyBoundaryFlags(),
      ...(run.judged ? { judged: run.judged } : {}),
      ...(run.judgeNote ? { judgeError: run.judgeNote } : {}),
    })),
  );
}
