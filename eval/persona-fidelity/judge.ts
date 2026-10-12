/**
 * The LLM judge of the persona fidelity eval (I26). It must come from
 * another vendor than the tested model (checks.compareVendors), and it is
 * guarded against preferring exaggerated, stereotyped personas: the rubric
 * says vivid is not more real and length is not quality, caricature is
 * scored on its own axis, the order of what it reads is shuffled, and it
 * must pass a fixed calibration set (checks.checkCalibration) before its
 * persona scores count.
 *
 * Prompt builders and parsers are pure and unit-tested; the judge* calls
 * only add generateText. A verdict that cannot be parsed is returned with
 * `error`, never coerced into a pass or a fail.
 */
import { generateText, type LanguageModel } from 'ai';
import {
  seededShuffle,
  type BoundaryVerdict,
  type PersonaVerdict,
  type RosterVerdict,
  type TranscriptTurn,
} from './checks';

// ==================== Parsing helpers ====================

/** The first JSON object in a reply (code fences and chatter around it ignored) */
export function extractJsonObject(text: string): Record<string, unknown> | undefined {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1)) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** A real boolean or "true"/"false"; anything else is unusable (null) */
function strictBool(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const lowered = value.trim().toLowerCase();
    if (lowered === 'true') return true;
    if (lowered === 'false') return false;
  }
  return null;
}

/** An integer score 1-5 (a numeric string is accepted); anything else is unusable */
function score(value: unknown): number | null {
  const number = typeof value === 'string' ? Number(value.trim()) : value;
  return typeof number === 'number' && Number.isInteger(number) && number >= 1 && number <= 5
    ? number
    : null;
}

function reasonOf(parsed: Record<string, unknown>): string {
  return typeof parsed.reason === 'string' ? parsed.reason : '';
}

// ==================== Persona quality ====================

/** One persona as the judge reads it, under an opaque key in a shuffled order */
export interface JudgedPersona {
  key: string;
  /** Its place in the roster (verdicts come back in roster order) */
  index: number;
  name: string;
  role: string;
  persona: string;
}

export const PERSONA_JUDGE_SYSTEM = `You review the personas written for the people of a simulated class: one teacher, perhaps a teaching assistant, and students who are the learner's classmates. A good persona describes a believable PERSON (who they are, how they talk, what they know and do not know yet, when they speak up and when they stay quiet), never a script of what they will do in this course.

For EACH persona, judge:
- elements, each true or false:
  - temperament: their temperament or how they come across;
  - speech: how they talk (register, verbal habits, how much they say);
  - knowledge: what they know and do not know yet (for a student: their level for this course);
  - speaks_up: what makes them speak up, and when they stay quiet;
  - misconception: STUDENTS ONLY: a confusion or misconception that learners at that level commonly have about this subject (an invented or unusual error is false); null for the teacher and the assistant;
  - teaching: THE TEACHER ONLY: how they teach and involve the class; null for everyone else.
- real_person, 1-5: could you meet this exact person in such a class? 5 = a specific, ordinary, consistent person; 3 = generic, or one trait pushed for effect; 1 = a cartoon, a stereotype, or a script rather than a person.
- caricature, 1-5: how exaggerated or stereotyped the persona is. 1 = not at all; 3 = one trait pushed hard; 5 = a cartoon of a type (the nerd, the class clown, the genius who is never wrong).
- script_like, true or false: it describes what they will do in this course (tasks, pages, quotas, questions they will ask) instead of who they are.

Guard against these biases:
- Vivid, quirky or extreme is NOT more real. A quiet, average, unremarkable student described specifically is as real as a colourful one, and usually more so. Never raise real_person for colour, drama, jokes or superlatives.
- Length is not quality: a short persona that covers the elements scores the same as a long one.
- Judge each persona on its own words; the order is random and means nothing.

Also judge the class as a whole: students_distinct, true or false: the students are clearly different people (temperament, level, manner), as in a real class; null when there are fewer than 2 students.

Respond with ONLY a JSON object, no code fences:
{"personas":[{"key":"P1","elements":{"temperament":true,"speech":true,"knowledge":true,"speaks_up":false,"misconception":true,"teaching":null},"real_person":4,"caricature":1,"script_like":false}],"students_distinct":true,"reason":"1-2 sentences"}`;

/**
 * The people of a roster under opaque keys (P1, P2...) in an order that
 * depends only on the seed, so position never favours anyone.
 */
export function keyPersonas(
  agents: ReadonlyArray<{ name: string; role: string; persona: string }>,
  seed: string,
): JudgedPersona[] {
  return seededShuffle(
    agents.map((agent, index) => ({ agent, index })),
    seed,
  ).map(({ agent, index }, position) => ({
    key: `P${position + 1}`,
    index,
    name: agent.name,
    role: agent.role,
    persona: agent.persona,
  }));
}

export function buildPersonaJudgePrompt(
  course: { name: string; description?: string },
  personas: readonly JudgedPersona[],
): string {
  return [
    `Course: ${course.name}${course.description ? ` — ${course.description}` : ''}`,
    '',
    'Personas (in random order):',
    ...personas.map(
      (persona) => `${persona.key} — ${persona.name} (role: ${persona.role}):\n${persona.persona}`,
    ),
  ].join('\n');
}

/** The verdicts, in roster order; unusable unless every persona has a well-formed one */
export function parseRosterVerdict(
  text: string,
  personas: readonly JudgedPersona[],
): RosterVerdict {
  const fail = (error: string): RosterVerdict => ({
    personas: [],
    studentsDistinct: null,
    reason: '',
    error: `${error}: ${text.slice(0, 200)}`,
  });
  const parsed = extractJsonObject(text);
  if (!parsed || !Array.isArray(parsed.personas)) return fail('No personas array');
  const byKey = new Map<string, Record<string, unknown>>();
  for (const entry of parsed.personas) {
    if (
      entry &&
      typeof entry === 'object' &&
      typeof (entry as { key?: unknown }).key === 'string'
    ) {
      byKey.set((entry as { key: string }).key.trim(), entry as Record<string, unknown>);
    }
  }
  const verdicts: PersonaVerdict[] = [];
  for (const persona of [...personas].sort((a, b) => a.index - b.index)) {
    const entry = byKey.get(persona.key);
    if (!entry) return fail(`No verdict for ${persona.key}`);
    const elements = (entry.elements ?? {}) as Record<string, unknown>;
    const core = {
      temperament: strictBool(elements.temperament),
      speech: strictBool(elements.speech),
      knowledge: strictBool(elements.knowledge),
      speaksUp: strictBool(elements.speaks_up),
    };
    const realPerson = score(entry.real_person);
    const caricature = score(entry.caricature);
    const scriptLike = strictBool(entry.script_like);
    if (
      Object.values(core).some((value) => value === null) ||
      realPerson === null ||
      caricature === null ||
      scriptLike === null
    ) {
      return fail(`Malformed verdict for ${persona.key}`);
    }
    // Role-bound elements apply only to their role, whatever the judge wrote
    const misconception =
      persona.role === 'student' ? (strictBool(elements.misconception) ?? false) : null;
    const teaching = persona.role === 'teacher' ? (strictBool(elements.teaching) ?? false) : null;
    verdicts.push({
      name: persona.name,
      role: persona.role,
      chars: Array.from(persona.persona.trim()).length,
      elements: {
        temperament: core.temperament!,
        speech: core.speech!,
        knowledge: core.knowledge!,
        speaksUp: core.speaksUp!,
        misconception,
        teaching,
      },
      realPerson,
      caricature,
      scriptLike,
    });
  }
  const students = personas.filter((persona) => persona.role === 'student').length;
  return {
    personas: verdicts,
    studentsDistinct: students >= 2 ? strictBool(parsed.students_distinct) : null,
    reason: reasonOf(parsed),
  };
}

/** Rate a roster's personas; the verdicts come back in the roster's own order */
export async function judgeRoster(
  model: LanguageModel,
  course: { name: string; description?: string },
  agents: ReadonlyArray<{ name: string; role: string; persona: string }>,
  seed: string,
): Promise<RosterVerdict> {
  const personas = keyPersonas(agents, seed);
  try {
    const result = await generateText({
      model,
      system: PERSONA_JUDGE_SYSTEM,
      prompt: buildPersonaJudgePrompt(course, personas),
      temperature: 0,
    });
    return parseRosterVerdict(result.text, personas);
  } catch (error) {
    return {
      personas: [],
      studentsDistinct: null,
      reason: '',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ==================== Speaker identification ====================

export const SPEAKER_JUDGE_SYSTEM = `You identify who in a simulated class said a line. You get the people of the class (a letter, a name, a role and a persona each) and one line one of them said, with every person's name in it replaced by [NAME]. Pick the person whose persona the line fits best: what they would know or not know yet, how they talk, how much they say, and what they would say at this moment. Role is evidence too, but between people of the same role decide by their personas. If the line could equally be several people's, answer "unsure" rather than guessing.

Respond with ONLY a JSON object, no code fences:
{"speaker":"<one letter from the list, or unsure>","confidence":3,"reason":"one sentence"}`;

/** The people under letters (A, B...) in a seed-dependent order */
export function letterRoster<T extends { id: string }>(
  roster: readonly T[],
  seed: string,
): Array<T & { letter: string }> {
  return seededShuffle(roster, seed).map((agent, index) => ({
    ...agent,
    letter: String.fromCharCode(65 + index),
  }));
}

/** What the learner had said, or that a class moment opened without them */
function describeLearner(learnerText: string): string {
  return learnerText.trim()
    ? `The learner had just said: "${learnerText}"`
    : 'A class moment had just opened; the learner had not spoken yet.';
}

export function buildSpeakerJudgePrompt(opts: {
  people: ReadonlyArray<{ letter: string; name: string; role: string; persona: string }>;
  learnerText: string;
  line: string;
}): string {
  return [
    'People of the class (in random order):',
    ...opts.people.map(
      (person) => `${person.letter}. ${person.name} (${person.role}): ${person.persona}`,
    ),
    '',
    describeLearner(opts.learnerText),
    '',
    `The line: "${opts.line}"`,
  ].join('\n');
}

export interface SpeakerVerdict {
  /** An agent id or 'unsure'; undefined when the answer was unusable */
  picked?: string;
  confidence?: number;
  reason: string;
  error?: string;
}

export function parseSpeakerVerdict(
  text: string,
  people: ReadonlyArray<{ letter: string; id: string }>,
): SpeakerVerdict {
  const parsed = extractJsonObject(text);
  const answer = typeof parsed?.speaker === 'string' ? parsed.speaker.trim() : undefined;
  if (!parsed || !answer) return { reason: '', error: `No speaker: ${text.slice(0, 200)}` };
  const confidence = score(parsed.confidence) ?? undefined;
  const base = { reason: reasonOf(parsed), ...(confidence ? { confidence } : {}) };
  if (answer.toLowerCase() === 'unsure') return { ...base, picked: 'unsure' };
  const letter = /^([A-Z])(?:[.)\s]|$)/i.exec(answer)?.[1]?.toUpperCase();
  const person = people.find((candidate) => candidate.letter === letter);
  return person
    ? { ...base, picked: person.id }
    : { ...base, error: `Unknown speaker "${answer.slice(0, 40)}"` };
}

export async function judgeSpeaker(
  model: LanguageModel,
  opts: {
    roster: ReadonlyArray<{ id: string; name: string; role: string; persona: string }>;
    learnerText: string;
    line: string;
    seed: string;
  },
): Promise<SpeakerVerdict> {
  const people = letterRoster(opts.roster, opts.seed);
  try {
    const result = await generateText({
      model,
      system: SPEAKER_JUDGE_SYSTEM,
      prompt: buildSpeakerJudgePrompt({ people, learnerText: opts.learnerText, line: opts.line }),
      temperature: 0,
    });
    return parseSpeakerVerdict(result.text, people);
  } catch (error) {
    return { reason: '', error: error instanceof Error ? error.message : String(error) };
  }
}

// ==================== Cognitive boundary ====================

export const BOUNDARY_JUDGE_SYSTEM = `You review one short exchange in a simulated class, against what the lesson has taught so far. The people are a teacher, perhaps a teaching assistant, and students (the learner's classmates). Students know only what has been taught so far and what anyone said in this exchange; the teacher and the assistant know the whole course but should not teach ahead of it. The turns are numbered.

Report the turn numbers of each kind (an empty list when there is none):
- untaught: a STUDENT turn that uses content from the pages not taught yet, which nobody in this exchange (the learner included) brought up first. Everyday knowledge is fine.
- student_lectures: a STUDENT turn that explains or teaches at length like a teacher, instead of speaking as a classmate (a short correct answer, a guess or a question is fine).
- assistant_takes_over: a TEACHING ASSISTANT turn that takes over the class from the teacher: moves the lesson on, teaches new material at length, or overrides the teacher, rather than supporting (an example, a tip or checking understanding is fine).
- student_wrong: a STUDENT turn that states something wrong, or offers a guess and leaves it uncertain (a question is not a wrong claim).

Respond with ONLY a JSON object, no code fences:
{"untaught":[],"student_lectures":[],"assistant_takes_over":[],"student_wrong":[],"reason":"1-2 sentences"}`;

function describePage(page: { title: string; keyPoints?: string[] }): string {
  return `- ${page.title}${page.keyPoints?.length ? `: ${page.keyPoints.join('; ')}` : ''}`;
}

export function buildBoundaryJudgePrompt(opts: {
  taught: ReadonlyArray<{ title: string; keyPoints?: string[] }>;
  /** What was narrated on the current page so far */
  currentNarration?: string;
  upcoming: ReadonlyArray<{ title: string; keyPoints?: string[] }>;
  learnerText: string;
  turns: readonly TranscriptTurn[];
}): string {
  return [
    'Taught so far:',
    ...opts.taught.map(describePage),
    ...(opts.currentNarration ? [`(Just said on the current page: ${opts.currentNarration})`] : []),
    '',
    'Not taught yet:',
    ...(opts.upcoming.length > 0 ? opts.upcoming.map(describePage) : ['- (nothing)']),
    '',
    describeLearner(opts.learnerText),
    '',
    'The exchange:',
    ...opts.turns.map((turn, index) => `${index + 1}. ${turn.name} (${turn.role}): ${turn.text}`),
  ].join('\n');
}

/** The judge's turn numbers (1-based) as 0-based indexes; out-of-range numbers are dropped */
export function parseBoundaryVerdict(text: string, turnCount: number): BoundaryVerdict {
  const empty: BoundaryVerdict = {
    untaught: [],
    studentLectures: [],
    assistantTakeover: [],
    studentWrong: [],
    reason: '',
  };
  const parsed = extractJsonObject(text);
  if (!parsed) return { ...empty, error: `Unparseable: ${text.slice(0, 200)}` };
  const fields = {
    untaught: parsed.untaught,
    studentLectures: parsed.student_lectures,
    assistantTakeover: parsed.assistant_takes_over,
    studentWrong: parsed.student_wrong,
  };
  const verdict: BoundaryVerdict = { ...empty, reason: reasonOf(parsed) };
  for (const [key, value] of Object.entries(fields) as Array<[keyof typeof fields, unknown]>) {
    if (!Array.isArray(value)) return { ...empty, error: `Missing list "${key}"` };
    verdict[key] = [
      ...new Set(
        value
          .map((item) => (typeof item === 'string' ? Number(item.trim()) : item))
          .filter(
            (item): item is number =>
              typeof item === 'number' && Number.isInteger(item) && item >= 1 && item <= turnCount,
          )
          .map((item) => item - 1),
      ),
    ].sort((a, b) => a - b);
  }
  return verdict;
}

export async function judgeBoundary(
  model: LanguageModel,
  opts: Parameters<typeof buildBoundaryJudgePrompt>[0],
): Promise<BoundaryVerdict> {
  try {
    const result = await generateText({
      model,
      system: BOUNDARY_JUDGE_SYSTEM,
      prompt: buildBoundaryJudgePrompt(opts),
      temperature: 0,
    });
    return parseBoundaryVerdict(result.text, opts.turns.length);
  } catch (error) {
    return {
      untaught: [],
      studentLectures: [],
      assistantTakeover: [],
      studentWrong: [],
      reason: '',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
