/**
 * The one guide for writing a classroom persona, and the deterministic checks
 * every roster written by a model passes before it is used: the generated
 * agent profiles, the workbench's `set_roster` and the persona upgrade all
 * read this module, so a persona means the same thing wherever it is written.
 *
 * A persona describes a real person (who they are, how they talk, what they
 * know, when they speak up); it is never a schedule or a script. The checks
 * only guard what code can judge for sure: roles, one teacher, distinct
 * names, and a persona of a sensible length. How students resemble each
 * other is only a warning: a bigram overlap misjudges short Chinese texts.
 */

/** How to write a persona: a real person, in five elements. Prompt text, English. */
export const PERSONA_GUIDE = `A persona describes a believable PERSON, not a script of what they will do in this course (no "responsible for the whiteboard demo", no list of questions they will ask, no quota of how often they speak). Write it in plain prose (no lists, no markdown), as a description of the person rather than instructions to them. In 3-5 sentences cover:
  - temperament and how they come across (warm, dry, energetic, shy, meticulous...);
  - how they talk: register, verbal habits, length of what they say;
  - what they already know and do not know yet. For a student: their real level for this course, and the kind of confusion or misconception that level leads to — one that learners at that level commonly have about this subject, never an invented or unusual error; a student never knows what the lesson has not taught yet;
  - what makes them speak up and when they stay quiet (a curious student blurts out "why?", a shy one speaks when asked or when sure; a teaching assistant steps in when someone is stuck, offers hands-on tips and checks understanding, without taking over from the teacher);
  - for the teacher: how they teach and how they involve the class (asking questions, calling on students, encouraging).
A persona may add half a sentence on how they relate to another agent in this class (e.g. sits next to one of the other students, looks up to the teaching assistant), still within 3-5 sentences.`;

/** Shorter than this, a persona cannot hold the five elements (characters, code points). */
export const PERSONA_MIN_CHARS = 40;
/** Longer than this, a persona is a script, not a person (≤ PI_REQUEST_BOUNDS.personaMaxChars). */
export const PERSONA_MAX_CHARS = 1200;

/** The class sizes a learner may ask a generated class for, teacher included. */
export const AUTO_AGENT_COUNT_MIN = 2;
export const AUTO_AGENT_COUNT_MAX = 8;

/**
 * What kind of people a generated class is made of, as the learner chose it:
 * quiet and focused, give-and-take, or lively. It only describes the people
 * when their personas are written; it is never stored with the course, and
 * no lecture or director prompt reads it (how often anyone speaks still
 * comes from who they are).
 */
export const CLASS_ATMOSPHERES = ['focused', 'conversational', 'lively'] as const;
export type ClassAtmosphere = (typeof CLASS_ATMOSPHERES)[number];

export function isClassAtmosphere(value: unknown): value is ClassAtmosphere {
  return typeof value === 'string' && (CLASS_ATMOSPHERES as readonly string[]).includes(value);
}

const CLASS_ATMOSPHERE_PEOPLE: Readonly<Record<ClassAtmosphere, string>> = {
  focused:
    'a quiet, focused class: most students are reserved and attentive, think before they speak, and speak up mainly when they are sure or when asked',
  conversational:
    "a class with plenty of give-and-take: students readily ask and answer, react to each other's points, and say so when they are lost",
  lively:
    'a lively, talkative class: more of the students are outgoing, like to jump in, joke and think out loud, sometimes before they have thought it through',
};

/** The kind of class, as a description of its people for the persona prompt. */
export function describeClassAtmosphere(atmosphere: ClassAtmosphere): string {
  return `This is ${CLASS_ATMOSPHERE_PEOPLE[atmosphere]}. This describes what kind of people the students are; each still has their own temperament and level.`;
}

export type RosterRole = 'teacher' | 'assistant' | 'student';

const ROLE_ALIASES: Readonly<Record<string, RosterRole>> = {
  teacher: 'teacher',
  'lead teacher': 'teacher',
  instructor: 'teacher',
  老师: 'teacher',
  教师: 'teacher',
  老師: 'teacher',
  教師: 'teacher',
  assistant: 'assistant',
  'teaching assistant': 'assistant',
  'teaching-assistant': 'assistant',
  teaching_assistant: 'assistant',
  ta: 'assistant',
  助教: 'assistant',
  student: 'student',
  学生: 'student',
  學生: 'student',
  同学: 'student',
  同學: 'student',
};

/**
 * A role as a model or a person wrote it, in the roster's own terms:
 * `老师` is the teacher, `TA` the assistant, `学生` a student. Undefined for
 * a role the classroom has no place for.
 */
export function normalizeRosterRole(role: string): RosterRole | undefined {
  if (typeof role !== 'string') return undefined;
  const key = role.trim().toLowerCase().replace(/\s+/g, ' ');
  return Object.hasOwn(ROLE_ALIASES, key) ? ROLE_ALIASES[key] : undefined;
}

export type RosterIssueCode =
  | 'too-few-agents'
  | 'teacher-count'
  | 'unknown-role'
  | 'empty-name'
  | 'duplicate-name'
  | 'empty-persona'
  | 'persona-too-short'
  | 'persona-too-long'
  | 'similar-students';

export interface RosterIssue {
  code: RosterIssueCode;
  /** The agent the issue is about (0-based), when it is about one. */
  agentIndex?: number;
  /** What is wrong, said so the model that wrote the roster can fix it. */
  message: string;
}

/** Two student personas this alike (bigram Jaccard) read as one person twice. */
const SIMILAR_STUDENTS_THRESHOLD = 0.6;

function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function charCount(text: string): number {
  return Array.from(text).length;
}

/** The persona's character bigrams, ignoring case, spaces and punctuation. */
function bigrams(text: string): Set<string> {
  const chars = Array.from(text.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, ''));
  const grams = new Set<string>();
  for (let i = 0; i + 1 < chars.length; i += 1) grams.add(chars[i]! + chars[i + 1]!);
  return grams;
}

/** How alike two texts are, 0 to 1 (bigram Jaccard). */
export function personaSimilarity(a: string, b: string): number {
  const left = bigrams(a);
  const right = bigrams(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const gram of left) if (right.has(gram)) shared += 1;
  return shared / (left.size + right.size - shared);
}

function label(agent: { name: string }, index: number): string {
  const name = textOf(agent.name);
  return name ? `Agent ${index + 1} ("${name}")` : `Agent ${index + 1}`;
}

/**
 * Check a roster as a model wrote it. Roles are normalized (an agent whose
 * role is unknown is listed as a student, and the roster is not ok). The
 * roster is ok when it has at least `minAgents` agents (default 2), exactly
 * one teacher, a known role, a name and a distinct name for everyone, and a
 * persona of {@link PERSONA_MIN_CHARS}-{@link PERSONA_MAX_CHARS} characters
 * for everyone. Students whose personas are nearly the same only warn.
 */
export function validateRoster<T extends { name: string; role: string; persona: string }>(
  agents: readonly T[],
  options: { minAgents?: number } = {},
): {
  ok: boolean;
  agents: Array<T & { role: RosterRole }>;
  issues: RosterIssue[];
  warnings: RosterIssue[];
} {
  const minAgents = options.minAgents ?? 2;
  const issues: RosterIssue[] = [];
  const warnings: RosterIssue[] = [];
  const list = Array.isArray(agents) ? agents : [];

  if (list.length < minAgents) {
    issues.push({
      code: 'too-few-agents',
      message: `The class needs at least ${minAgents} agents; there ${list.length === 1 ? 'is' : 'are'} ${list.length}.`,
    });
  }

  const roles = list.map((agent) => normalizeRosterRole(agent.role));
  const normalized = list.map((agent, index) => {
    const role = roles[index];
    if (!role) {
      issues.push({
        code: 'unknown-role',
        agentIndex: index,
        message: `${label(agent, index)} has the role "${textOf(agent.role)}"; a role is "teacher", "assistant" or "student".`,
      });
    }
    return { ...agent, role: role ?? 'student' } as T & { role: RosterRole };
  });

  const teachers = list.filter((_, index) => roles[index] === 'teacher');
  if (list.length > 0 && teachers.length !== 1) {
    issues.push({
      code: 'teacher-count',
      message:
        teachers.length === 0
          ? 'The class needs exactly 1 teacher; there is none.'
          : `The class needs exactly 1 teacher; there are ${teachers.length} (${teachers.map((agent) => `"${textOf(agent.name)}"`).join(', ')}).`,
    });
  }

  const seen = new Map<string, number>();
  list.forEach((agent, index) => {
    const name = textOf(agent.name);
    if (!name) {
      issues.push({
        code: 'empty-name',
        agentIndex: index,
        message: `${label(agent, index)} has no name.`,
      });
      return;
    }
    const key = name.toLowerCase();
    const first = seen.get(key);
    if (first === undefined) {
      seen.set(key, index);
      return;
    }
    issues.push({
      code: 'duplicate-name',
      agentIndex: index,
      message: `${label(agent, index)} has the same name as agent ${first + 1}; every person in the class has their own name.`,
    });
  });

  list.forEach((agent, index) => {
    const persona = textOf(agent.persona);
    const length = charCount(persona);
    if (!persona) {
      issues.push({
        code: 'empty-persona',
        agentIndex: index,
        message: `${label(agent, index)} has no persona.`,
      });
    } else if (length < PERSONA_MIN_CHARS) {
      issues.push({
        code: 'persona-too-short',
        agentIndex: index,
        message: `${label(agent, index)}'s persona is ${length} characters; describe the person in 3-5 sentences (at least ${PERSONA_MIN_CHARS} characters).`,
      });
    } else if (length > PERSONA_MAX_CHARS) {
      issues.push({
        code: 'persona-too-long',
        agentIndex: index,
        message: `${label(agent, index)}'s persona is ${length} characters; keep it to 3-5 sentences (at most ${PERSONA_MAX_CHARS} characters).`,
      });
    }
  });

  const students = list
    .map((agent, index) => ({ agent, index }))
    .filter(({ index }) => roles[index] === 'student');
  for (let later = 1; later < students.length; later += 1) {
    for (let earlier = 0; earlier < later; earlier += 1) {
      const a = students[earlier]!;
      const b = students[later]!;
      if (
        personaSimilarity(textOf(a.agent.persona), textOf(b.agent.persona)) >=
        SIMILAR_STUDENTS_THRESHOLD
      ) {
        warnings.push({
          code: 'similar-students',
          agentIndex: b.index,
          message: `${label(b.agent, b.index)} reads almost like ${label(a.agent, a.index)}; students in a real class differ.`,
        });
        break;
      }
    }
  }

  return { ok: issues.length === 0, agents: normalized, issues, warnings };
}

/** The issues as a list a retry prompt appends, one per line. */
export function formatRosterIssues(issues: readonly RosterIssue[]): string {
  return issues.map((issue) => `- ${issue.message}`).join('\n');
}

/** A name this short would match by accident. */
const LEARNER_NAME_MIN_CHARS = 2;

const CJK_CHAR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/** The text holds a CJK character (Han, kana or Hangul). */
export function isCjkText(text: string): boolean {
  return CJK_CHAR.test(text);
}

/**
 * Where a text names the learner, case-insensitively: a CJK name anywhere
 * (particles attach to it), any other name only as a whole word ("Sam", not
 * "same"). Undefined for a name too short to tell apart.
 */
export function learnerNamePattern(name: string | undefined): RegExp | undefined {
  const trimmed = name?.trim();
  if (!trimmed || Array.from(trimmed).length < LEARNER_NAME_MIN_CHARS) return undefined;
  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    isCjkText(trimmed) ? escaped : `(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`,
    'giu',
  );
}
