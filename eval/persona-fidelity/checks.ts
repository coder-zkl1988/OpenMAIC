/**
 * Persona fidelity eval (I26): everything that does not need a model. The
 * deterministic persona checks, the anonymization the speaker test relies
 * on, the cognitive-boundary detectors, the aggregation of judge verdicts,
 * the judge-vendor guard and the baseline comparison all live here, so they
 * are unit-tested (tests/eval/persona-fidelity) while the runner only wires
 * models to them.
 */
import { personaSimilarity, validateRoster } from '@/lib/orchestration/persona-guide';

// ==================== Text helpers ====================

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const WORDISH = /[\p{Script=Latin}\p{N}_]/u;

/**
 * A pattern for a term or a name in running text, ignoring case. A term that
 * starts or ends with a Latin letter or digit only matches as a whole word
 * there ("def" never matches "undefined"); CJK terms match anywhere.
 */
export function termPattern(term: string, flags = 'iu'): RegExp {
  const trimmed = term.trim();
  const chars = Array.from(trimmed);
  const start = chars[0] && WORDISH.test(chars[0]) ? '(?<![\\p{Script=Latin}\\p{N}_])' : '';
  const end = chars.at(-1) && WORDISH.test(chars.at(-1)!) ? '(?![\\p{Script=Latin}\\p{N}_])' : '';
  return new RegExp(`${start}${escapeRegExp(trimmed)}${end}`, flags);
}

export function containsTerm(text: string, term: string): boolean {
  return term.trim().length > 0 && termPattern(term).test(text);
}

function countMatches(text: string, pattern: RegExp): number {
  return (text.match(pattern) ?? []).length;
}

/**
 * How much someone said, in Chinese-character units: a Han character is one,
 * a Latin word or a number two. The role lengths in the Pi prompts are given
 * in Chinese characters (a student says about 10-60).
 */
export function speechUnits(text: string): number {
  return (
    countMatches(text, /\p{Script=Han}/gu) +
    2 * countMatches(text, /[\p{Script=Latin}\p{N}]+(?:['’][\p{Script=Latin}]+)*/gu)
  );
}

/** The share of Han and of Latin letters among the two */
export function scriptShares(text: string): { han: number; latin: number } {
  const han = countMatches(text, /\p{Script=Han}/gu);
  const latin = countMatches(text, /\p{Script=Latin}/gu);
  const total = han + latin;
  return total === 0 ? { han: 0, latin: 0 } : { han: han / total, latin: latin / total };
}

// ==================== Persona generation ====================

export type ExpectedScript = 'han' | 'latin';

/**
 * Wording that turns a person into a schedule, a quota or a task list: the
 * persona guide forbids it (a persona describes who someone is). A heuristic,
 * reported as a rate, never a gate.
 */
export const SCRIPT_MARKERS: ReadonlyArray<{ id: string; pattern: RegExp }> = [
  { id: 'responsible-for', pattern: /负责|responsible for|in charge of/iu },
  {
    id: 'page-schedule',
    pattern:
      /第\s*\d+\s*(?:页|张|节)|每一?页|(?:on|at|in) (?:slide|page) \d+|every (?:slide|page)/iu,
  },
  {
    id: 'quota',
    pattern:
      /(?:至少|最多|每节课|每堂课)[^。，,.]{0,6}\d+\s*次|\d+\s*次(?:发言|提问)|\b\d+ times (?:per|a|each)\b|at least \d+ (?:times|questions)/iu,
  },
];

const LIST_MARKUP = /^\s*(?:[-*•·]|\d+[.)、])\s*\S/mu;

/** The roster as the eval reads it: names, roles and personas only */
export interface PersonaInput {
  name: string;
  role: string;
  persona: string;
}

export interface PersonaCheck {
  name: string;
  role: string;
  /** Characters (code points) of the trimmed persona */
  chars: number;
  /** Ids of the SCRIPT_MARKERS it matched */
  scriptMarkers: string[];
  /** Written as a list or with markdown list markers */
  listMarkup: boolean;
  /** The learner's private details found in the name or persona */
  leakedTerms: string[];
  /** Not mostly in the script the course's language directive asks for */
  scriptMismatch: boolean;
}

export interface RosterCheck {
  /** validateRoster passed: roles, one teacher, names, persona lengths */
  valid: boolean;
  issueCodes: string[];
  warningCodes: string[];
  counts: { teacher: number; assistant: number; student: number };
  personas: PersonaCheck[];
  /** The highest bigram similarity between two students (0 with fewer than 2) */
  maxStudentSimilarity: number;
}

export interface CourseExpectations {
  /** The learner's private details (city, hobby, job...) that must never reach a persona */
  privateTerms?: readonly string[];
  expectScript?: ExpectedScript;
}

export function checkPersona(agent: PersonaInput, course: CourseExpectations): PersonaCheck {
  const persona = (agent.persona ?? '').trim();
  const shares = scriptShares(`${agent.name} ${persona}`);
  const scriptMismatch =
    course.expectScript === 'han'
      ? shares.han < 0.5
      : course.expectScript === 'latin'
        ? shares.latin < 0.8
        : false;
  return {
    name: agent.name,
    role: agent.role,
    chars: Array.from(persona).length,
    scriptMarkers: SCRIPT_MARKERS.filter(({ pattern }) => pattern.test(persona)).map(
      ({ id }) => id,
    ),
    listMarkup: LIST_MARKUP.test(persona),
    leakedTerms: (course.privateTerms ?? []).filter(
      (term) => containsTerm(persona, term) || containsTerm(agent.name, term),
    ),
    scriptMismatch,
  };
}

export function checkRoster(
  agents: readonly PersonaInput[],
  course: CourseExpectations,
): RosterCheck {
  const checked = validateRoster(agents);
  // validateRoster lists an unknown role as a student; here it counts as nobody
  const unknownRole = new Set(
    checked.issues
      .filter((issue) => issue.code === 'unknown-role')
      .map((issue) => issue.agentIndex),
  );
  const counts = { teacher: 0, assistant: 0, student: 0 };
  checked.agents.forEach((agent, index) => {
    if (!unknownRole.has(index)) counts[agent.role] += 1;
  });
  const students = checked.agents.filter(
    (agent, index) => agent.role === 'student' && !unknownRole.has(index),
  );
  let maxStudentSimilarity = 0;
  for (let later = 1; later < students.length; later += 1) {
    for (let earlier = 0; earlier < later; earlier += 1) {
      maxStudentSimilarity = Math.max(
        maxStudentSimilarity,
        personaSimilarity(students[earlier]!.persona ?? '', students[later]!.persona ?? ''),
      );
    }
  }
  return {
    valid: checked.ok,
    issueCodes: checked.issues.map((issue) => issue.code),
    warningCodes: checked.warnings.map((warning) => warning.code),
    counts,
    personas: agents.map((agent) => checkPersona(agent, course)),
    maxStudentSimilarity: Number(maxStudentSimilarity.toFixed(3)),
  };
}

// ==================== Judge verdicts (types shared with judge.ts) ====================

/** One persona as the judge rated it */
export interface PersonaVerdict {
  name: string;
  role: string;
  chars: number;
  elements: {
    temperament: boolean;
    speech: boolean;
    knowledge: boolean;
    speaksUp: boolean;
    /** Students only (a misconception common at their level); null otherwise */
    misconception: boolean | null;
    /** The teacher only (how they teach and involve the class); null otherwise */
    teaching: boolean | null;
  };
  /** 1-5: could you meet this exact person in such a class */
  realPerson: number;
  /** 1-5: how exaggerated or stereotyped */
  caricature: number;
  scriptLike: boolean;
}

export interface RosterVerdict {
  personas: PersonaVerdict[];
  /** null with fewer than two students */
  studentsDistinct: boolean | null;
  reason: string;
  /** The judge's answer could not be used */
  error?: string;
}

/** A persona that reads as a real person, not as a caricature */
export function isBelievable(verdict: PersonaVerdict): boolean {
  return verdict.realPerson >= 4 && verdict.caricature <= 2;
}

/** Present elements over the elements that apply to this role */
export function elementCoverage(verdict: PersonaVerdict): number {
  const values = Object.values(verdict.elements).filter(
    (value): value is boolean => value !== null,
  );
  return values.length === 0 ? 0 : values.filter(Boolean).length / values.length;
}

export type CalibrationKey = 'plain' | 'caricature' | 'script';

export interface CalibrationResult {
  passed: boolean;
  failures: string[];
}

/**
 * The judge's bias guard. Before its persona scores are trusted, it rates
 * three fixed personas: an ordinary, specific student; an exaggerated
 * stereotype; and a schedule written as a persona. A judge that finds the
 * caricature as real as the ordinary person (or misses the script) prefers
 * exaggerated, stereotyped personas, so its quality scores are not used.
 */
export function checkCalibration(
  verdicts: Partial<Record<CalibrationKey, PersonaVerdict>>,
): CalibrationResult {
  const { plain, caricature, script } = verdicts;
  if (!plain || !caricature || !script) {
    return { passed: false, failures: ['the judge did not rate all three calibration personas'] };
  }
  const failures: string[] = [];
  if (!(plain.realPerson > caricature.realPerson)) {
    failures.push(
      `the stereotype looked as real as the ordinary student (${caricature.realPerson} vs ${plain.realPerson})`,
    );
  }
  if (!(caricature.caricature > plain.caricature)) {
    failures.push(
      `the stereotype was not rated more exaggerated (${caricature.caricature} vs ${plain.caricature})`,
    );
  }
  if (!script.scriptLike) failures.push('the schedule-like persona was not flagged as a script');
  if (plain.scriptLike) failures.push('the ordinary student was flagged as a script');
  if (!(plain.realPerson > script.realPerson)) {
    failures.push(
      `the schedule looked as real as the ordinary student (${script.realPerson} vs ${plain.realPerson})`,
    );
  }
  return { passed: failures.length === 0, failures };
}

// ==================== Generation summary ====================

export interface GenerationSample {
  /** generateAgentProfiles returned a roster */
  ok: boolean;
  error?: string;
  check?: RosterCheck;
  verdict?: RosterVerdict;
}

export interface GenerationSummary {
  courseId: string;
  samples: number;
  /** Runs that produced no roster (both attempts refused, or a failure) */
  errors: number;
  /** Rosters that pass validateRoster, over all samples */
  validRate: number;
  meanAgents: number;
  meanCounts: { teacher: number; assistant: number; student: number };
  /** Personas, over all generated personas */
  scriptMarkerRate: number;
  listMarkupRate: number;
  scriptMismatchRate: number;
  /** Rosters with any of the learner's private details in them */
  leakRate: number;
  meanMaxStudentSimilarity: number;
  /** Rosters with a 'similar-students' warning */
  similarWarningRate: number;
  judge?: {
    judgedRosters: number;
    judgeErrors: number;
    elementCoverage: number;
    realPersonMean: number;
    caricatureMean: number;
    believableRate: number;
    scriptLikeRate: number;
    /** Rosters with 2+ students whose students read as different people */
    studentsDistinctRate: number | null;
    /**
     * Pearson r between persona length and real_person: near 0 is wanted; a
     * strong positive r means the judge rewards length (null: too few points)
     */
    lengthBias: number | null;
  };
}

function round(value: number): number {
  return Number(value.toFixed(3));
}

function ratio(count: number, total: number): number {
  return total > 0 ? round(count / total) : 0;
}

function mean(values: readonly number[]): number {
  return values.length > 0
    ? round(values.reduce((sum, value) => sum + value, 0) / values.length)
    : 0;
}

/** Pearson correlation, or null with fewer than 3 points or no variance */
export function pearson(xs: readonly number[], ys: readonly number[]): number | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return null;
  const mx = xs.slice(0, n).reduce((a, b) => a + b, 0) / n;
  const my = ys.slice(0, n).reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = xs[i]! - mx;
    const dy = ys[i]! - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return null;
  return round(sxy / Math.sqrt(sxx * syy));
}

export function summarizeGeneration(
  courseId: string,
  samples: readonly GenerationSample[],
): GenerationSummary {
  const checks = samples.flatMap((sample) => (sample.ok && sample.check ? [sample.check] : []));
  const personas = checks.flatMap((check) => check.personas);
  const verdicts = samples.flatMap((sample) => (sample.verdict ? [sample.verdict] : []));
  const usable = verdicts.filter((verdict) => !verdict.error);
  const rated = usable.flatMap((verdict) => verdict.personas);
  const distinct = usable.flatMap((verdict) =>
    verdict.studentsDistinct === null ? [] : [verdict.studentsDistinct],
  );
  return {
    courseId,
    samples: samples.length,
    errors: samples.filter((sample) => !sample.ok).length,
    validRate: ratio(checks.filter((check) => check.valid).length, samples.length),
    meanAgents: mean(checks.map((check) => check.personas.length)),
    meanCounts: {
      teacher: mean(checks.map((check) => check.counts.teacher)),
      assistant: mean(checks.map((check) => check.counts.assistant)),
      student: mean(checks.map((check) => check.counts.student)),
    },
    scriptMarkerRate: ratio(
      personas.filter((persona) => persona.scriptMarkers.length > 0).length,
      personas.length,
    ),
    listMarkupRate: ratio(personas.filter((persona) => persona.listMarkup).length, personas.length),
    scriptMismatchRate: ratio(
      personas.filter((persona) => persona.scriptMismatch).length,
      personas.length,
    ),
    leakRate: ratio(
      checks.filter((check) => check.personas.some((persona) => persona.leakedTerms.length > 0))
        .length,
      checks.length,
    ),
    meanMaxStudentSimilarity: mean(checks.map((check) => check.maxStudentSimilarity)),
    similarWarningRate: ratio(
      checks.filter((check) => check.warningCodes.includes('similar-students')).length,
      checks.length,
    ),
    ...(verdicts.length > 0
      ? {
          judge: {
            judgedRosters: usable.length,
            judgeErrors: verdicts.length - usable.length,
            elementCoverage: mean(rated.map(elementCoverage)),
            realPersonMean: mean(rated.map((verdict) => verdict.realPerson)),
            caricatureMean: mean(rated.map((verdict) => verdict.caricature)),
            believableRate: ratio(rated.filter(isBelievable).length, rated.length),
            scriptLikeRate: ratio(
              rated.filter((verdict) => verdict.scriptLike).length,
              rated.length,
            ),
            studentsDistinctRate:
              distinct.length > 0 ? ratio(distinct.filter(Boolean).length, distinct.length) : null,
            lengthBias: pearson(
              rated.map((verdict) => verdict.chars),
              rated.map((verdict) => verdict.realPerson),
            ),
          },
        }
      : {}),
  };
}

// ==================== Speaker identification ====================

/** Shorter lines ("嗯", "OK") say nothing about who said them */
export const MIN_SPEAKER_UNITS = 6;

const HONORIFICS = new Set(['mr', 'mrs', 'ms', 'miss', 'dr', 'prof', 'sir', 'madam']);

/**
 * The ways a name can appear in a line: the name itself and, for a Latin
 * name of several words, each word of 3+ letters that is not an honorific
 * ("Ms. Rivera" is also "Rivera").
 */
export function nameVariants(name: string): string[] {
  const trimmed = name.trim();
  if (!trimmed) return [];
  const words = trimmed
    .split(/[\s.]+/u)
    .filter((word) => /^\p{Script=Latin}{3,}$/u.test(word) && !HONORIFICS.has(word.toLowerCase()));
  return [...new Set([trimmed, ...(words.length > 1 ? words : [])])];
}

/**
 * A line with every name in it replaced: the speaker test must identify a
 * speaker from what they say and how, never from a name ("我是小思", "Leo
 * thinks"). Longest names first, so "林老师" goes before a shorter name.
 */
export function anonymize(text: string, names: readonly string[], placeholder = '[NAME]'): string {
  const variants = [...new Set(names.flatMap(nameVariants))].sort(
    (a, b) => Array.from(b).length - Array.from(a).length,
  );
  return variants.reduce(
    (current, variant) => current.replace(termPattern(variant, 'giu'), placeholder),
    text,
  );
}

/** One line the judge tried to attribute */
export interface SpeakerJudgment {
  promptId: string;
  turnIndex: number;
  trueAgentId: string;
  /** An agent id, 'unsure', or undefined when the judge's answer was unusable */
  picked?: string;
  confidence?: number;
  error?: string;
}

export interface SpeakerSummary {
  courseId: string;
  /** Visible lines in the transcripts */
  lines: number;
  /** Too short to attribute (not judged) */
  tooShort: number;
  judged: number;
  errors: number;
  /** Right person, over usable verdicts ('unsure' counts as wrong) */
  accuracy: number;
  /** 1 / class size: what picking at random scores */
  chance: number;
  /** The picked person has the speaker's role */
  roleAccuracy: number;
  unsureRate: number;
  /** Lines by students attributed to a student: the right one (null without such) */
  studentWithinRoleAccuracy: number | null;
  /** 1 / number of students */
  studentChance: number | null;
  perAgent: Record<string, { lines: number; correct: number }>;
  /** true speaker -> picked agent id or 'unsure' -> count */
  confusion: Record<string, Record<string, number>>;
  /**
   * The roster's mean caricature (judge): identification bought with
   * caricature is no win, so the two are read together
   */
  rosterCaricatureMean?: number | null;
}

export function summarizeSpeakerId(opts: {
  courseId: string;
  roles: Readonly<Record<string, string>>;
  lines: number;
  tooShort: number;
  judgments: readonly SpeakerJudgment[];
  rosterCaricatureMean?: number | null;
}): SpeakerSummary {
  const { roles } = opts;
  const usable = opts.judgments.filter((judgment) => judgment.picked !== undefined);
  const classSize = Object.keys(roles).length;
  const studentCount = Object.values(roles).filter((role) => role === 'student').length;
  const perAgent: SpeakerSummary['perAgent'] = {};
  const confusion: SpeakerSummary['confusion'] = {};
  let correct = 0;
  let roleCorrect = 0;
  let unsure = 0;
  let studentToStudent = 0;
  let studentRight = 0;
  for (const judgment of usable) {
    const picked = judgment.picked!;
    const right = picked === judgment.trueAgentId;
    const trueRole = roles[judgment.trueAgentId];
    const pickedRole = roles[picked];
    perAgent[judgment.trueAgentId] ??= { lines: 0, correct: 0 };
    perAgent[judgment.trueAgentId]!.lines += 1;
    confusion[judgment.trueAgentId] ??= {};
    confusion[judgment.trueAgentId]![picked] = (confusion[judgment.trueAgentId]![picked] ?? 0) + 1;
    if (right) {
      correct += 1;
      perAgent[judgment.trueAgentId]!.correct += 1;
    }
    if (picked === 'unsure') unsure += 1;
    if (trueRole && pickedRole === trueRole) roleCorrect += 1;
    if (trueRole === 'student' && pickedRole === 'student') {
      studentToStudent += 1;
      if (right) studentRight += 1;
    }
  }
  return {
    courseId: opts.courseId,
    lines: opts.lines,
    tooShort: opts.tooShort,
    judged: opts.judgments.length,
    errors: opts.judgments.length - usable.length,
    accuracy: ratio(correct, usable.length),
    chance: classSize > 0 ? round(1 / classSize) : 0,
    roleAccuracy: ratio(roleCorrect, usable.length),
    unsureRate: ratio(unsure, usable.length),
    studentWithinRoleAccuracy: studentToStudent > 0 ? ratio(studentRight, studentToStudent) : null,
    studentChance: studentCount > 1 ? round(1 / studentCount) : null,
    perAgent,
    confusion,
    ...(opts.rosterCaricatureMean !== undefined
      ? { rosterCaricatureMean: opts.rosterCaricatureMean }
      : {}),
  };
}

// ==================== Cognitive boundary ====================

export const BOUNDARY_KINDS = [
  /** A student uses content the lesson has not taught yet */
  'untaught',
  /** A student lectures like a teacher */
  'studentLectures',
  /** The teaching assistant takes over the class */
  'assistantTakeover',
  /** A student's wrong or unsure line is left without a response */
  'wrongUnanswered',
] as const;
export type BoundaryKind = (typeof BOUNDARY_KINDS)[number];

/** Turn indexes (0-based) flagged per kind */
export type BoundaryFlags = Record<BoundaryKind, number[]>;

/** Twice the top of a student's length in the Pi prompts (about 10-60 characters) */
export const STUDENT_LECTURE_UNITS = 120;

export interface TranscriptTurn {
  agentId: string;
  name: string;
  role: string;
  text: string;
}

/** One request of the classroom eval, as the learner saw it */
export interface ClassroomRun {
  courseId: string;
  promptId: string;
  sample: number;
  /** The learner's latest message */
  learnerText: string;
  /** Agents the learner addressed by name */
  addressedAgentIds: string[];
  /** An aside to the lecture (the assistant alone, by design) */
  aside: boolean;
  /** The roles of everyone in the request */
  rosterRoles: string[];
  turns: TranscriptTurn[];
  terminal: 'cue_user' | 'close_session' | 'none';
  cuePrompt?: string;
  error?: string;
}

export interface BoundaryContext {
  /** Key terms that only the pages after the current one teach */
  upcomingTerms: readonly string[];
  /** Titles, key points and narration of what has been taught */
  taughtText: string;
}

export function emptyBoundaryFlags(): BoundaryFlags {
  return { untaught: [], studentLectures: [], assistantTakeover: [], wrongUnanswered: [] };
}

/**
 * The deterministic proxies of the four counters:
 * - untaught: a student says an upcoming page's key term that neither the
 *   learner, the taught pages nor an earlier line of this exchange used;
 * - studentLectures: a student line longer than STUDENT_LECTURE_UNITS;
 * - assistantTakeover: the assistant, not addressed, says more than the
 *   teacher in a request where the teacher is present (first such turn);
 * - wrongUnanswered: a student had the last word without asking the learner
 *   (the I02 guarantee; the judge decides whether the line was wrong).
 */
export function detectBoundary(run: ClassroomRun, context: BoundaryContext): BoundaryFlags {
  const flags = emptyBoundaryFlags();
  const heard = [run.learnerText, context.taughtText];
  run.turns.forEach((turn, index) => {
    if (turn.role === 'student') {
      const before = heard.join('\n');
      if (
        context.upcomingTerms.some(
          (term) => containsTerm(turn.text, term) && !containsTerm(before, term),
        )
      ) {
        flags.untaught.push(index);
      }
      if (speechUnits(turn.text) > STUDENT_LECTURE_UNITS) flags.studentLectures.push(index);
    }
    heard.push(turn.text);
  });

  if (!run.aside && run.rosterRoles.includes('teacher')) {
    const addressed = new Set(run.addressedAgentIds);
    const units = (predicate: (turn: TranscriptTurn) => boolean) =>
      run.turns.filter(predicate).reduce((sum, turn) => sum + speechUnits(turn.text), 0);
    const unaddressedAssistant = (turn: TranscriptTurn) =>
      turn.role === 'assistant' && !addressed.has(turn.agentId);
    const first = run.turns.findIndex(unaddressedAssistant);
    if (first >= 0 && units(unaddressedAssistant) > units((turn) => turn.role === 'teacher')) {
      flags.assistantTakeover.push(first);
    }
  }

  const lastIndex = run.turns.length - 1;
  if (
    !run.aside &&
    run.turns[lastIndex]?.role === 'student' &&
    !(run.terminal === 'cue_user' && run.cuePrompt)
  ) {
    flags.wrongUnanswered.push(lastIndex);
  }
  return flags;
}

/** The judge's reading of one exchange (0-based turn indexes) */
export interface BoundaryVerdict {
  untaught: number[];
  studentLectures: number[];
  assistantTakeover: number[];
  studentWrong: number[];
  reason: string;
  error?: string;
}

/**
 * The judge's flags, kept only on turns of the right role; a wrong or unsure
 * student line counts as unanswered only when no teacher or assistant spoke
 * after it in the exchange.
 */
export function judgedBoundary(run: ClassroomRun, verdict: BoundaryVerdict): BoundaryFlags {
  const ofRole = (indexes: readonly number[], role: string) =>
    [...new Set(indexes)].filter((index) => run.turns[index]?.role === role).sort((a, b) => a - b);
  return {
    untaught: ofRole(verdict.untaught, 'student'),
    studentLectures: ofRole(verdict.studentLectures, 'student'),
    assistantTakeover: ofRole(verdict.assistantTakeover, 'assistant'),
    wrongUnanswered: ofRole(verdict.studentWrong, 'student').filter(
      (index) =>
        !run.turns
          .slice(index + 1)
          .some((turn) => turn.role === 'teacher' || turn.role === 'assistant'),
    ),
  };
}

export interface BoundaryCounter {
  /** Runs with at least one flag, and all flags (deterministic proxy) */
  detRuns: number;
  detInstances: number;
  detRate: number;
  /** The same, as the judge saw it (null rate when nothing was judged) */
  judgedRuns: number;
  judgedInstances: number;
  judgeRate: number | null;
}

export interface BoundarySummary {
  courseId: string;
  /** Runs that completed */
  runs: number;
  judged: number;
  judgeErrors: number;
  counters: Record<BoundaryKind, BoundaryCounter>;
}

export function summarizeBoundary(
  courseId: string,
  entries: ReadonlyArray<{
    run: ClassroomRun;
    det: BoundaryFlags;
    judged?: BoundaryFlags;
    judgeError?: string;
  }>,
): BoundarySummary {
  const completed = entries.filter((entry) => !entry.run.error);
  const judged = completed.filter((entry) => entry.judged && !entry.judgeError);
  const counters = Object.fromEntries(
    BOUNDARY_KINDS.map((kind) => {
      const detRuns = completed.filter((entry) => entry.det[kind].length > 0).length;
      const judgedRuns = judged.filter((entry) => entry.judged![kind].length > 0).length;
      const counter: BoundaryCounter = {
        detRuns,
        detInstances: completed.reduce((sum, entry) => sum + entry.det[kind].length, 0),
        detRate: ratio(detRuns, completed.length),
        judgedRuns,
        judgedInstances: judged.reduce((sum, entry) => sum + entry.judged![kind].length, 0),
        judgeRate: judged.length > 0 ? ratio(judgedRuns, judged.length) : null,
      };
      return [kind, counter];
    }),
  ) as Record<BoundaryKind, BoundaryCounter>;
  return {
    courseId,
    runs: completed.length,
    judged: judged.length,
    judgeErrors: completed.filter((entry) => entry.judgeError).length,
    counters,
  };
}

// ==================== Judge vendor ====================

/** Model families by their model id, for aggregators and clouds that host many vendors */
const MODEL_FAMILIES: ReadonlyArray<[RegExp, string]> = [
  [/claude|anthropic/i, 'anthropic'],
  [/(?:^|[/:.\-_])(?:chat)?gpt|(?:^|[/:.\-_])o[1345](?:$|[\-_.:])|openai/i, 'openai'],
  [/gemini|gemma|google/i, 'google'],
  [/qwen|qwq|tongyi|dashscope/i, 'alibaba'],
  [/deepseek/i, 'deepseek'],
  [/glm|zhipu|bigmodel/i, 'zhipu'],
  [/kimi|moonshot/i, 'moonshot'],
  [/doubao|bytedance/i, 'bytedance'],
  [/hunyuan|tencent/i, 'tencent'],
  [/minimax|abab/i, 'minimax'],
  [/grok|x-ai|xai/i, 'xai'],
  [/llama|meta-/i, 'meta'],
  [/mistral|mixtral|codestral|magistral/i, 'mistral'],
  [/mimo|xiaomi/i, 'xiaomi'],
  [/ernie|wenxin|baidu/i, 'baidu'],
];

/** Providers that only serve their own vendor's models */
const PROVIDER_VENDORS: Readonly<Record<string, string>> = {
  openai: 'openai',
  azure: 'openai',
  anthropic: 'anthropic',
  google: 'google',
  deepseek: 'deepseek',
  qwen: 'alibaba',
  kimi: 'moonshot',
  minimax: 'minimax',
  glm: 'zhipu',
  doubao: 'bytedance',
  grok: 'xai',
  'tencent-hunyuan': 'tencent',
  xiaomi: 'xiaomi',
};

/**
 * Who made a model, from a `provider:model` string: the model id's family
 * first (an aggregator like openrouter or siliconflow hosts many vendors),
 * then the provider. A bare id is an OpenAI model, as parseModelString reads it.
 */
export function modelVendor(modelString: string): string {
  const colon = modelString.indexOf(':');
  const provider = colon > 0 ? modelString.slice(0, colon).toLowerCase() : 'openai';
  const modelId = colon > 0 ? modelString.slice(colon + 1) : modelString;
  for (const [pattern, vendor] of MODEL_FAMILIES) if (pattern.test(modelId)) return vendor;
  return PROVIDER_VENDORS[provider] ?? provider;
}

/** The judge must come from another vendor than the tested model (I26) */
export function compareVendors(
  testedModel: string,
  judgeModel: string,
): { testedVendor: string; judgeVendor: string; same: boolean } {
  const testedVendor = modelVendor(testedModel);
  const judgeVendor = modelVendor(judgeModel);
  return { testedVendor, judgeVendor, same: testedVendor === judgeVendor };
}

// ==================== Order ====================

function hashSeed(seed: string): number {
  let hash = 2166136261;
  for (const char of seed) {
    hash ^= char.codePointAt(0)!;
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * A copy in a random order that depends only on the seed (mulberry32): the
 * judge sees personas in no meaningful order, and a rerun sees the same one.
 */
export function seededShuffle<T>(items: readonly T[], seed: string): T[] {
  let state = hashSeed(seed);
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

// ==================== Run summary and baseline ====================

export interface PersonaFidelitySummary {
  testedModel: string;
  judgeModel: string;
  testedVendor: string;
  judgeVendor: string;
  /** The judge shares the tested model's vendor (only with EVAL_ALLOW_SAME_VENDOR=1) */
  sameVendor: boolean;
  createdAt: string;
  samples: number;
  castingMode: 'persona' | 'legacy';
  rosterSource: 'fixed' | 'generated';
  judgeCalibration?: CalibrationResult;
  generation: GenerationSummary[];
  speaker: SpeakerSummary[];
  boundary: BoundarySummary[];
}

export interface FidelityMetric {
  key: string;
  value: number;
  better: 'higher' | 'lower';
  /** Read from judge persona scores (untrusted when the judge failed calibration) */
  judgedGeneration?: boolean;
}

/** Every gated number of a run, under a stable key */
export function flattenFidelityMetrics(summary: PersonaFidelitySummary): FidelityMetric[] {
  const metrics: FidelityMetric[] = [];
  const add = (
    key: string,
    value: number | null | undefined,
    better: 'higher' | 'lower',
    judged = false,
  ) => {
    if (typeof value === 'number' && Number.isFinite(value)) {
      metrics.push({ key, value, better, ...(judged ? { judgedGeneration: true } : {}) });
    }
  };
  for (const course of summary.generation) {
    const key = `generation.${course.courseId}`;
    add(`${key}.validRate`, course.validRate, 'higher');
    add(`${key}.scriptMarkerRate`, course.scriptMarkerRate, 'lower');
    add(`${key}.leakRate`, course.leakRate, 'lower');
    add(`${key}.scriptMismatchRate`, course.scriptMismatchRate, 'lower');
    if (course.judge) {
      add(`${key}.judge.elementCoverage`, course.judge.elementCoverage, 'higher', true);
      add(`${key}.judge.believableRate`, course.judge.believableRate, 'higher', true);
      add(`${key}.judge.caricatureMean`, course.judge.caricatureMean, 'lower', true);
      add(`${key}.judge.scriptLikeRate`, course.judge.scriptLikeRate, 'lower', true);
    }
  }
  for (const course of summary.speaker) {
    add(`speaker.${course.courseId}.accuracy`, course.accuracy, 'higher');
    add(
      `speaker.${course.courseId}.studentWithinRoleAccuracy`,
      course.studentWithinRoleAccuracy,
      'higher',
    );
  }
  for (const course of summary.boundary) {
    for (const kind of BOUNDARY_KINDS) {
      const counter = course.counters[kind];
      add(`boundary.${course.courseId}.${kind}.detRate`, counter.detRate, 'lower');
      add(`boundary.${course.courseId}.${kind}.judgeRate`, counter.judgeRate, 'lower');
    }
  }
  return metrics;
}

export interface FidelityRegression {
  key: string;
  better: 'higher' | 'lower';
  baseline: number;
  current: number;
}

/**
 * Metrics that moved the wrong way by more than `tolerance` against the
 * baseline, for keys present in both runs. Judge persona scores are left out
 * when either run's judge failed calibration (they are not trusted then).
 */
export function findFidelityRegressions(
  current: PersonaFidelitySummary,
  baseline: PersonaFidelitySummary,
  tolerance: number,
): FidelityRegression[] {
  const trustJudged =
    current.judgeCalibration?.passed !== false && baseline.judgeCalibration?.passed !== false;
  const before = new Map(flattenFidelityMetrics(baseline).map((metric) => [metric.key, metric]));
  const regressions: FidelityRegression[] = [];
  for (const metric of flattenFidelityMetrics(current)) {
    if (metric.judgedGeneration && !trustJudged) continue;
    const previous = before.get(metric.key);
    if (!previous) continue;
    const worse =
      metric.better === 'higher'
        ? metric.value < previous.value - tolerance
        : metric.value > previous.value + tolerance;
    if (worse) {
      regressions.push({
        key: metric.key,
        better: metric.better,
        baseline: previous.value,
        current: metric.value,
      });
    }
  }
  return regressions;
}
