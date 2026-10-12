/**
 * Scoring of the Pi casting eval. Hard checks exist only for uncontroversial
 * cases (a bare "明白了" closes, a named student answers first, ...); every
 * other aspect of casting is reported as a distribution over N samples, and
 * the gate fails only on a regression against a stored baseline.
 */
import type {
  CastReason,
  PiCastingMode,
  PiChildTurnStubInput,
  StatelessEvent,
} from '@/lib/types/chat';

/** One call_agent delegation as the scripted child stub saw it (stub runs only) */
export interface DelegationRecord {
  agentId: string;
  role: string;
  castReason?: CastReason;
  /** The director's instruction puts a quoted line in the agent's mouth (H1) */
  quotesLine: boolean;
  /** Scenes whose read_scene evidence came with this delegation */
  evidenceSceneIds: string[];
}

/** What one run of the director loop did, read from its events */
export interface RunObservation {
  /** agentId of every agent turn, in order */
  speakers: string[];
  castReasons: Array<CastReason | undefined>;
  terminal: 'cue_user' | 'close_session' | 'none';
  /** The question cue_user put to the learner, if any */
  cuePrompt?: string;
  endReason?: string;
  error?: string;
  /** Director tool calls (only when the done event carried its tool trace) */
  toolCalls?: number;
  /** The one-time "a student had the last word" reminder fired (tool trace) */
  nudged?: boolean;
  /** The hand-back came from the loop's automatic cue, not a cue_user call (tool trace) */
  fallbackCue?: boolean;
  /** What each child turn was asked, in order (stub runs only) */
  delegations?: DelegationRecord[];
  /** Student delegations that carried evidence of a page the lesson has not reached */
  studentUpcomingEvidence?: number;
}

/** A quoted span of at least this many characters reads as a line written for the agent */
const QUOTED_LINE_MIN_CHARS = 6;
const QUOTED_SPANS = [/「([^」]*)」/gu, /『([^』]*)』/gu, /“([^”]*)”/gu, /"([^"]*)"/gu];

/**
 * Whether a director instruction scripts the agent's words (H1: an instruction
 * describes the situation and intent, never the line). Straight single quotes
 * are ignored: English apostrophes would pair up across words.
 */
export function quotesLine(instruction: string): boolean {
  return QUOTED_SPANS.some((pattern) =>
    Array.from(instruction.matchAll(pattern)).some(
      (match) => Array.from((match[1] ?? '').trim()).length >= QUOTED_LINE_MIN_CHARS,
    ),
  );
}

/** The record of one delegation, from what the child stub received */
export function toDelegationRecord(input: PiChildTurnStubInput): DelegationRecord {
  return {
    agentId: input.agentId,
    role: input.role,
    ...(input.castReason ? { castReason: input.castReason } : {}),
    quotesLine: quotesLine(input.instruction),
    evidenceSceneIds: [...input.evidenceSceneIds],
  };
}

/** One visible agent turn of a run: its speaker and the text it streamed */
export interface ObservedTurn {
  messageId: string;
  agentId: string;
  agentName: string;
  text: string;
}

/** Every agent turn of a run, with its streamed text joined, in speaking order */
export function collectTurns(events: readonly StatelessEvent[]): ObservedTurn[] {
  const turns: ObservedTurn[] = [];
  const byMessage = new Map<string, ObservedTurn>();
  let current: ObservedTurn | undefined;
  for (const event of events) {
    if (event.type === 'agent_start') {
      current = {
        messageId: event.data.messageId,
        agentId: event.data.agentId,
        agentName: event.data.agentName,
        text: '',
      };
      turns.push(current);
      byMessage.set(current.messageId, current);
    } else if (event.type === 'text_delta') {
      const turn = event.data.messageId ? byMessage.get(event.data.messageId) : current;
      if (turn) turn.text += event.data.content;
    } else if (event.type === 'agent_end') {
      current = undefined;
    }
  }
  return turns.map((turn) => ({ ...turn, text: turn.text.trim() }));
}

function traceReason(details: unknown): unknown {
  return details && typeof details === 'object'
    ? (details as { reason?: unknown }).reason
    : undefined;
}

/** The agent and the scene evidence a call_agent trace entry records */
function traceEvidence(details: unknown): { agentId: string; sceneIds: string[] } | undefined {
  if (!details || typeof details !== 'object') return undefined;
  const { agentId, sceneEvidence } = details as { agentId?: unknown; sceneEvidence?: unknown };
  if (typeof agentId !== 'string') return undefined;
  const sceneIds = Array.isArray(sceneEvidence)
    ? sceneEvidence.flatMap((packet) =>
        packet && typeof (packet as { sceneId?: unknown }).sceneId === 'string'
          ? [(packet as { sceneId: string }).sceneId]
          : [],
      )
    : [];
  return { agentId, sceneIds };
}

function traceEmitted(details: unknown): boolean {
  return Boolean(
    details && typeof details === 'object' && (details as { emitted?: unknown }).emitted === true,
  );
}

export function observeRun(
  events: readonly StatelessEvent[],
  error?: string,
  context: {
    /** What the scripted stub received, in call order */
    delegations?: readonly DelegationRecord[];
    /** Pages after the current one: students never get their evidence (I04) */
    upcomingSceneIds?: readonly string[];
    /** agentId -> role, to read the evidence each child got from the tool trace */
    roles?: Readonly<Record<string, string>>;
  } = {},
): RunObservation {
  const observation: RunObservation = { speakers: [], castReasons: [], terminal: 'none' };
  let cueUserCalled: boolean | undefined;
  let tracedEvidence: Array<{ agentId: string; sceneIds: string[] }> | undefined;
  for (const event of events) {
    if (event.type === 'agent_start') {
      observation.speakers.push(event.data.agentId);
      observation.castReasons.push(event.data.castReason);
    } else if (event.type === 'cue_user') {
      observation.terminal = 'cue_user';
      if (event.data.prompt) observation.cuePrompt = event.data.prompt;
    } else if (event.type === 'done') {
      if (event.data.sessionClosed) {
        observation.terminal = 'close_session';
        if (event.data.endReason) observation.endReason = event.data.endReason;
      }
      const trace = event.data.directorToolTrace;
      if (trace) {
        observation.toolCalls = trace.length;
        observation.nudged = trace.some(
          (entry) => traceReason(entry.details) === 'student_last_word',
        );
        cueUserCalled = trace.some(
          (entry) => entry.toolName === 'cue_user' && traceEmitted(entry.details),
        );
        tracedEvidence = trace.flatMap((entry) => {
          const evidence =
            entry.toolName === 'call_agent' ? traceEvidence(entry.details) : undefined;
          return evidence ? [evidence] : [];
        });
      }
    } else if (event.type === 'error') {
      observation.error = event.data.message;
    }
  }
  if (cueUserCalled !== undefined) {
    observation.fallbackCue = observation.terminal === 'cue_user' && !cueUserCalled;
  }
  const upcoming = new Set(context.upcomingSceneIds ?? []);
  if (context.delegations) observation.delegations = [...context.delegations];
  // What each child actually got: the tool trace (stub or real children),
  // else what the scripted stub saw
  const received =
    tracedEvidence && context.roles
      ? tracedEvidence.map(({ agentId, sceneIds }) => ({
          role: context.roles![agentId],
          sceneIds,
        }))
      : context.delegations?.map(({ role, evidenceSceneIds }) => ({
          role,
          sceneIds: evidenceSceneIds,
        }));
  if (received && context.upcomingSceneIds) {
    observation.studentUpcomingEvidence = received.filter(
      ({ role, sceneIds }) =>
        role === 'student' && sceneIds.some((sceneId) => upcoming.has(sceneId)),
    ).length;
  }
  if (error) observation.error = error;
  return observation;
}

/** An uncontroversial check on one run */
export type Expectation =
  | { check: 'terminal'; is: 'cue_user' | 'close_session' }
  | { check: 'maxTurns'; n: number }
  | { check: 'firstSpeaker'; agentId: string }
  | { check: 'speakerAt'; index: number; agentId: string }
  | { check: 'called'; agentId: string }
  | { check: 'notCalled'; agentId: string }
  /** A student's line never ends the turn, unless it asks the learner (cue_user with a prompt) */
  | { check: 'studentNotLastWord' }
  /** The turn hands back with a question to the learner (cue_user with a prompt) */
  | { check: 'cuePrompt' }
  /** No student is handed evidence of a page the lesson has not reached */
  | { check: 'noUpcomingEvidenceToStudents' };

export function describeExpectation(expectation: Expectation): string {
  switch (expectation.check) {
    case 'terminal':
      return `ends with ${expectation.is}`;
    case 'maxTurns':
      return `at most ${expectation.n} agent turn(s)`;
    case 'firstSpeaker':
      return `${expectation.agentId} speaks first`;
    case 'speakerAt':
      return `${expectation.agentId} speaks at turn ${expectation.index + 1}`;
    case 'called':
      return `${expectation.agentId} is called`;
    case 'notCalled':
      return `${expectation.agentId} is not called`;
    case 'studentNotLastWord':
      return "a student's line does not end the turn (unless asking the learner)";
    case 'cuePrompt':
      return 'hands back with a question to the learner';
    case 'noUpcomingEvidenceToStudents':
      return 'no student gets evidence of an untaught page';
  }
}

export function checkExpectation(
  run: RunObservation,
  expectation: Expectation,
  roles: Readonly<Record<string, string>>,
): boolean {
  if (run.error) return false;
  switch (expectation.check) {
    case 'terminal':
      return run.terminal === expectation.is;
    case 'maxTurns':
      return run.speakers.length <= expectation.n;
    case 'firstSpeaker':
      return run.speakers[0] === expectation.agentId;
    case 'speakerAt':
      return run.speakers[expectation.index] === expectation.agentId;
    case 'called':
      return run.speakers.includes(expectation.agentId);
    case 'notCalled':
      return !run.speakers.includes(expectation.agentId);
    case 'studentNotLastWord': {
      const last = run.speakers.at(-1);
      return !last || roles[last] !== 'student' || Boolean(run.cuePrompt);
    }
    case 'cuePrompt':
      return run.terminal === 'cue_user' && Boolean(run.cuePrompt);
    case 'noUpcomingEvidenceToStudents':
      return (run.studentUpcomingEvidence ?? 0) === 0;
  }
}

export interface HardCheckResult {
  label: string;
  passRate: number;
}

/** One scenario under one casting mode, over its samples */
export interface ScenarioModeSummary {
  scenarioId: string;
  mode: PiCastingMode;
  /** 'stub': scripted children; 'e2e': real child agents */
  children: 'stub' | 'e2e';
  samples: number;
  errors: number;
  hard: HardCheckResult[];
  /** Share of samples that passed every hard check (1 when there are none) */
  hardPassRate: number;
  distributions: {
    firstSpeaker: Record<string, number>;
    sequence: Record<string, number>;
    terminal: Record<string, number>;
    turns: Record<string, number>;
    castReasons: Record<string, number>;
    /** The role of the last speaker ('(none)' when nobody spoke) */
    lastSpeakerRole: Record<string, number>;
  };
  /** Observed only, never targets */
  metrics: {
    meanTurns: number;
    /** Agent turns by anyone but the teacher */
    nonTeacherShare: number;
    /** Distinct roles that spoke, over the roles present, averaged */
    roleCoverage: number;
    /** Runs whose last line was a student's and that handed back to the learner */
    studentLastWordHandBack: number;
    /** Runs where the "a student had the last word" reminder fired */
    nudgeRate: number;
    /** Runs handed back by the loop's automatic cue instead of a cue_user call */
    fallbackCueRate: number;
    /** Delegations whose instruction scripted the agent's line (H1; stub runs) */
    scriptedInstructionShare: number;
    meanToolCalls: number;
  };
}

function bump(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function rate(count: number, total: number): number {
  return total > 0 ? Number((count / total).toFixed(3)) : 0;
}

export function summarizeRuns(opts: {
  scenarioId: string;
  mode: PiCastingMode;
  children: 'stub' | 'e2e';
  runs: readonly RunObservation[];
  expectations: readonly Expectation[];
  roles: Readonly<Record<string, string>>;
}): ScenarioModeSummary {
  const { runs, expectations, roles } = opts;
  const distributions: ScenarioModeSummary['distributions'] = {
    firstSpeaker: {},
    sequence: {},
    terminal: {},
    turns: {},
    castReasons: {},
    lastSpeakerRole: {},
  };
  const presentRoles = new Set(Object.values(roles));
  let turnTotal = 0;
  let nonTeacherTurns = 0;
  let coverageTotal = 0;
  let studentLastWordHandBack = 0;
  let nudged = 0;
  let fallbackCues = 0;
  let traced = 0;
  let toolCalls = 0;
  let delegations = 0;
  let scriptedInstructions = 0;
  for (const run of runs) {
    if (run.error) continue;
    bump(distributions.firstSpeaker, run.speakers[0] ?? '(none)');
    bump(distributions.sequence, run.speakers.join(' > ') || '(none)');
    bump(distributions.terminal, run.terminal);
    bump(distributions.turns, String(run.speakers.length));
    for (const reason of run.castReasons) bump(distributions.castReasons, reason ?? '(none)');
    turnTotal += run.speakers.length;
    nonTeacherTurns += run.speakers.filter((id) => roles[id] !== 'teacher').length;
    const spokenRoles = new Set(run.speakers.map((id) => roles[id]).filter(Boolean));
    coverageTotal += presentRoles.size > 0 ? spokenRoles.size / presentRoles.size : 0;
    const last = run.speakers.at(-1);
    bump(distributions.lastSpeakerRole, last ? (roles[last] ?? '(unknown)') : '(none)');
    if (last && roles[last] === 'student' && run.terminal === 'cue_user') {
      studentLastWordHandBack += 1;
    }
    if (run.toolCalls !== undefined) {
      traced += 1;
      toolCalls += run.toolCalls;
      if (run.nudged) nudged += 1;
      if (run.fallbackCue) fallbackCues += 1;
    }
    for (const delegation of run.delegations ?? []) {
      delegations += 1;
      if (delegation.quotesLine) scriptedInstructions += 1;
    }
  }
  const completed = runs.filter((run) => !run.error).length;
  const hard = expectations.map((expectation) => ({
    label: describeExpectation(expectation),
    passRate: rate(
      runs.filter((run) => checkExpectation(run, expectation, roles)).length,
      runs.length,
    ),
  }));
  const allPassed = runs.filter((run) =>
    expectations.every((expectation) => checkExpectation(run, expectation, roles)),
  ).length;

  return {
    scenarioId: opts.scenarioId,
    mode: opts.mode,
    children: opts.children,
    samples: runs.length,
    errors: runs.length - completed,
    hard,
    hardPassRate: expectations.length > 0 ? rate(allPassed, runs.length) : 1,
    distributions,
    metrics: {
      meanTurns: rate(turnTotal, completed),
      nonTeacherShare: rate(nonTeacherTurns, turnTotal),
      roleCoverage: rate(coverageTotal, completed),
      studentLastWordHandBack: rate(studentLastWordHandBack, completed),
      nudgeRate: rate(nudged, traced),
      fallbackCueRate: rate(fallbackCues, traced),
      scriptedInstructionShare: rate(scriptedInstructions, delegations),
      meanToolCalls: rate(toolCalls, traced),
    },
  };
}

/** A whole eval run, as stored next to its report and reused as a baseline */
export interface CastingEvalSummary {
  model: string;
  createdAt: string;
  samples: number;
  results: ScenarioModeSummary[];
  /** persona vs legacy, for every scenario and child runtime that ran in both */
  comparisons?: ModeComparison[];
}

/** One casting mode's headline numbers for a scenario */
export interface ModeSnapshot {
  hardPassRate: number;
  meanTurns: number;
  nonTeacherShare: number;
  roleCoverage: number;
  /** The most frequent speaking sequence ('(none)' when no run completed) */
  topSequence: string;
}

/** The new persona casting next to the legacy rules on one scenario */
export interface ModeComparison {
  scenarioId: string;
  children: 'stub' | 'e2e';
  persona: ModeSnapshot;
  legacy: ModeSnapshot;
  /** persona minus legacy */
  hardPassDelta: number;
}

function topKey(counts: Record<string, number>): string {
  return (
    Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ??
    '(none)'
  );
}

function snapshot(result: ScenarioModeSummary): ModeSnapshot {
  return {
    hardPassRate: result.hardPassRate,
    meanTurns: result.metrics.meanTurns,
    nonTeacherShare: result.metrics.nonTeacherShare,
    roleCoverage: result.metrics.roleCoverage,
    topSequence: topKey(result.distributions.sequence),
  };
}

/**
 * persona next to legacy for every scenario and child runtime run in both
 * modes: what the persona prompt changes, for reading (never a gate).
 */
export function compareModes(results: readonly ScenarioModeSummary[]): ModeComparison[] {
  const comparisons: ModeComparison[] = [];
  for (const persona of results) {
    if (persona.mode !== 'persona') continue;
    const legacy = results.find(
      (candidate) =>
        candidate.mode === 'legacy' &&
        candidate.scenarioId === persona.scenarioId &&
        candidate.children === persona.children,
    );
    if (!legacy) continue;
    comparisons.push({
      scenarioId: persona.scenarioId,
      children: persona.children,
      persona: snapshot(persona),
      legacy: snapshot(legacy),
      hardPassDelta: Number((persona.hardPassRate - legacy.hardPassRate).toFixed(3)),
    });
  }
  return comparisons;
}

export interface Regression {
  scenarioId: string;
  mode: PiCastingMode;
  children: 'stub' | 'e2e';
  label: string;
  baseline: number;
  current: number;
}

/**
 * Hard checks whose pass rate fell more than `tolerance` below the baseline,
 * for every scenario, mode and child runtime present in both runs. Only this
 * fails CI: distributions are for reading, and absolute rates depend on N.
 */
export function findRegressions(
  current: CastingEvalSummary,
  baseline: CastingEvalSummary,
  tolerance: number,
): Regression[] {
  const regressions: Regression[] = [];
  for (const result of current.results) {
    const before = baseline.results.find(
      (candidate) =>
        candidate.scenarioId === result.scenarioId &&
        candidate.mode === result.mode &&
        candidate.children === result.children,
    );
    if (!before) continue;
    for (const check of result.hard) {
      const previous = before.hard.find((candidate) => candidate.label === check.label);
      if (previous && check.passRate < previous.passRate - tolerance) {
        regressions.push({
          scenarioId: result.scenarioId,
          mode: result.mode,
          children: result.children,
          label: check.label,
          baseline: previous.passRate,
          current: check.passRate,
        });
      }
    }
  }
  return regressions;
}
