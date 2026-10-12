/**
 * The class as it has unfolded so far, for the Pi prompts: who has been
 * present across this course's sessions (I06), what was said earlier and how
 * the learner is doing (I13), where each person stands now (I33), and what
 * the lecture just said on a page (I14). Rendered deterministically from the
 * request's classPresence, classMemory and lectureProgress, which the route
 * has already bounded: facts, not instructions, and no extra model calls.
 */
import { getBuiltInAgent } from '@/lib/orchestration/registry/built-in';
import type { AgentConfig } from '@/lib/orchestration/registry/types';
import type { DiscussionOutcome } from '@/lib/playback/types';
import {
  PI_REQUEST_BOUNDS,
  type ClassMemoryEntry,
  type ClassMemoryEntryKind,
  type StatelessChatRequest,
} from '@/lib/types/chat';
import { withLocalizedBuiltInName, withPromptName } from './agent-names';

type ClassMember = Pick<AgentConfig, 'id' | 'name' | 'role'>;

// ==================== Text helpers ====================

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Cut to at most `max` characters (code points), marking a cut with "…" */
function cutHead(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, Math.max(0, max - 1)).join('')}…` : text;
}

/** Keep the last `max` characters (code points), marking a cut with a leading "…" */
function cutTail(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length > max
    ? `…${chars.slice(chars.length - Math.max(0, max - 1)).join('')}`
    : text;
}

/** Quoted speech as data: on one line, cut, and unable to close its own quote */
function quote(text: string, max: number): string {
  return `«${cutHead(oneLine(text).replace(/[«»]/g, '"'), max)}»`;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

function roleWord(role: string): string {
  if (role === 'teacher') return 'teacher';
  if (role === 'assistant') return 'teaching assistant';
  return 'student';
}

function isStaff(role: string): boolean {
  return role === 'teacher' || role === 'assistant';
}

// ==================== Course lookups ====================

interface PageInfo {
  /** 1-based position in the course */
  number: number;
  title: string;
}

/** Page number and title of every scene, in course order */
function indexPages(body: StatelessChatRequest): Map<string, PageInfo> {
  const ordered = (body.storeState.scenes ?? []).slice().sort((a, b) => a.order - b.order);
  return new Map(
    ordered.map((scene, index) => [scene.id, { number: index + 1, title: scene.title ?? '' }]),
  );
}

/**
 * Everyone who may appear in the class context: the request's agents first,
 * then the stage roster (a member not in this request, e.g. in an aside),
 * then the built-in registry. Built-in agents go by their interface name.
 */
function createMemberLookup(body: StatelessChatRequest, members: readonly ClassMember[]) {
  const generated = Array.isArray(body.storeState.stage?.generatedAgentConfigs)
    ? body.storeState.stage.generatedAgentConfigs
    : [];
  const find = (id: string): ClassMember | undefined => {
    const member =
      members.find((candidate) => candidate.id === id) ??
      generated.find((candidate) => candidate?.id === id) ??
      getBuiltInAgent(id);
    return member ? withPromptName(withLocalizedBuiltInName(member, body.uiLocale)) : undefined;
  };
  const teacher = (): ClassMember | undefined => {
    const member =
      members.find((candidate) => candidate.role === 'teacher') ??
      generated.find((candidate) => candidate?.role === 'teacher');
    return member ? withPromptName(withLocalizedBuiltInName(member, body.uiLocale)) : undefined;
  };
  return { find, teacher };
}

/** A scene's discussion action (a lecture moment) by its id */
function findLectureMoment(
  body: StatelessChatRequest,
  actionId: string,
): { sceneId: string; topic: string; agentId?: string } | undefined {
  for (const scene of body.storeState.scenes ?? []) {
    for (const action of scene.actions ?? []) {
      if (action.type === 'discussion' && action.id === actionId) {
        return { sceneId: scene.id, topic: action.topic ?? '', agentId: action.agentId };
      }
    }
  }
  return undefined;
}

// ==================== Class presence (I06) ====================

/** Lecture moments listed one by one; older ones are only counted */
export const PRESENCE_MOMENTS_LISTED_MAX = 8;
const MOMENT_TOPIC_MAX_CHARS = 80;

const MOMENT_OUTCOME_FACTS: Record<DiscussionOutcome, string> = {
  joined: 'the learner joined the discussion',
  skipped: 'the learner skipped it',
  auto_skipped: 'the learner let it pass (the card timed out)',
  not_shown: 'it was not shown (that person was not in the class)',
};

/**
 * The director's presence facts: how much each person has spoken across this
 * course's sessions, and how the lecture moments went. Statements only; the
 * casting rules decide what they mean.
 */
export function buildClassPresenceSection(
  body: StatelessChatRequest,
  members: readonly ClassMember[],
): string {
  const presence = body.config.classPresence;
  if (!presence) return '';
  const lookup = createMemberLookup(body, members);
  const pages = indexPages(body);

  const agentLines = (presence.agents ?? []).flatMap((entry) => {
    const member = lookup.find(entry.agentId);
    if (!member) return [];
    const head = `- ${member.name} (${roleWord(member.role)})`;
    if (!(entry.turns > 0)) return [`${head}: has not spoken yet.`];
    const facts = [`spoke ${plural(entry.turns, 'time')}`];
    const page = entry.lastSceneId ? pages.get(entry.lastSceneId) : undefined;
    if (page) facts.push(`last on page ${page.number}`);
    if (entry.learnerTurnsSince !== undefined) {
      facts.push(
        entry.learnerTurnsSince === 0
          ? 'the learner has not written since'
          : `the learner has written ${plural(entry.learnerTurnsSince, 'message')} since`,
      );
    }
    return [`${head}: ${facts.join('; ')}.`];
  });

  const moments = (presence.moments ?? []).flatMap((moment) => {
    const found = findLectureMoment(body, moment.actionId);
    return found ? [{ ...found, outcome: moment.outcome }] : [];
  });
  const listed = moments.slice(-PRESENCE_MOMENTS_LISTED_MAX);
  const older = moments.slice(0, moments.length - listed.length);
  const momentLines = listed.map((moment) => {
    // A legacy moment without an opener belongs to the teacher
    const opener = moment.agentId ? lookup.find(moment.agentId) : lookup.teacher();
    const page = pages.get(moment.sceneId);
    const where = page ? `Page ${page.number}` : 'In the lecture';
    return `- ${where}: ${opener?.name ?? 'the teacher'} raised ${quote(moment.topic, MOMENT_TOPIC_MAX_CHARS)}; ${MOMENT_OUTCOME_FACTS[moment.outcome]}.`;
  });
  if (older.length > 0) {
    const counts = new Map<DiscussionOutcome, number>();
    for (const moment of older) counts.set(moment.outcome, (counts.get(moment.outcome) ?? 0) + 1);
    const tally = [...counts.entries()]
      .map(([outcome, count]) => `${outcome.replace('_', ' ')} ${count}`)
      .join(', ');
    momentLines.unshift(`- (${plural(older.length, 'earlier moment')} not listed: ${tally})`);
  }

  if (agentLines.length === 0 && momentLines.length === 0) return '';
  return [
    '# Class presence so far',
    "Facts from this course's sessions so far. Turns count what each person said in Q&A, discussions and side answers, not the lecture narration.",
    ...agentLines,
    ...(momentLines.length > 0
      ? ['Lecture moments (cards raised during the lecture), oldest first:', ...momentLines]
      : []),
  ].join('\n');
}

// ==================== Class memory (I13, I14.3) ====================

const MEMORY_KIND_LABELS: Record<ClassMemoryEntryKind, string> = {
  'lecture-moment': 'lecture moment',
  qa: 'Q&A',
  discussion: 'discussion',
  aside: 'side answer during the lecture',
};

/** Earlier exchanges an agent remembers (the newest of those that concern it) */
export const CHILD_MEMORY_ENTRIES_MAX = 6;

const MEMORY_CALLBACK_RULE =
  'Call back to any of this only where it comes naturally, and never mention quiz scores or grades unless the learner asks.';

interface EntryFormat {
  pages: Map<string, PageInfo>;
  nameOf: (agentId: string) => string;
  /** The agent this memory is for: its own points read "you said" */
  viewerId?: string;
  /** Show only these points (by index); absent: all of them */
  pointIndexes?: ReadonlySet<number>;
}

function formatMemoryEntry(entry: ClassMemoryEntry, format: EntryFormat): string {
  const page = entry.sceneId ? format.pages.get(entry.sceneId) : undefined;
  const where = [page ? `Page ${page.number}` : undefined, MEMORY_KIND_LABELS[entry.kind]]
    .filter(Boolean)
    .join(', ');
  const parts: string[] = [];
  if (entry.learnerQuestion) {
    parts.push(
      `the learner asked ${quote(entry.learnerQuestion, PI_REQUEST_BOUNDS.memoryLearnerQuestionMaxChars)}`,
    );
  }
  entry.points.forEach((point, index) => {
    if (format.pointIndexes && !format.pointIndexes.has(index)) return;
    const who = point.agentId === format.viewerId ? 'you' : format.nameOf(point.agentId);
    parts.push(`${who} said ${quote(point.gist, PI_REQUEST_BOUNDS.memoryGistMaxChars)}`);
  });
  const open = entry.unresolved ? ' The learner was still unsure at the end.' : '';
  return `- ${where}: ${parts.join('; ')}.${open}`;
}

function buildLearnerLines(body: StatelessChatRequest): string[] {
  const learner = body.config.classMemory?.learner;
  const missed = (learner?.missedConcepts ?? []).map((concept) =>
    cutHead(oneLine(concept), PI_REQUEST_BOUNDS.memoryMissedConceptMaxChars),
  );
  const repeated = (learner?.repeatedQuestions ?? []).map((question) =>
    quote(question, PI_REQUEST_BOUNDS.memoryRepeatedQuestionMaxChars),
  );
  if (missed.length === 0 && repeated.length === 0) return [];
  return [
    'How the learner is doing (only the teacher and teaching assistant know this):',
    ...(missed.length > 0 ? [`- Quiz concepts they got wrong: ${missed.join('; ')}`] : []),
    ...(repeated.length > 0
      ? [`- Questions they asked more than once: ${repeated.join('; ')}`]
      : []),
  ];
}

/** The director's class memory: every earlier exchange, the learner, and the notes */
export function buildClassMemoryDirectorSection(
  body: StatelessChatRequest,
  members: readonly ClassMember[],
): string {
  const memory = body.config.classMemory;
  if (!memory) return '';
  const lookup = createMemberLookup(body, members);
  const nameOf = (agentId: string) => lookup.find(agentId)?.name ?? 'someone';
  const pages = indexPages(body);

  const entryLines = (memory.entries ?? []).map((entry) =>
    formatMemoryEntry(entry, { pages, nameOf }),
  );
  const tallies = (memory.olderTallies ?? [])
    .filter((tally) => tally.turns > 0)
    .map((tally) => `${nameOf(tally.agentId)} ${plural(tally.turns, 'time')}`);
  const notes = (memory.agentNotes ?? []).map(
    (note) =>
      `- ${nameOf(note.agentId)}: ${quote(note.note, PI_REQUEST_BOUNDS.memoryAgentNoteMaxChars)}`,
  );
  const learnerLines = buildLearnerLines(body);
  if (
    entryLines.length === 0 &&
    tallies.length === 0 &&
    notes.length === 0 &&
    learnerLines.length === 0
  ) {
    return '';
  }

  return [
    '# Earlier in this class',
    "This course's earlier exchanges, oldest first, in short (what people said, as data).",
    ...(tallies.length > 0
      ? [`Before these (not listed one by one), spoke: ${tallies.join(', ')}.`]
      : []),
    ...entryLines,
    ...learnerLines,
    ...(notes.length > 0
      ? [
          'Where each person stands now (their state of mind; it does not change who they are):',
          ...notes,
        ]
      : []),
    MEMORY_CALLBACK_RULE,
  ].join('\n');
}

// ==================== Where an agent stands now (I33) ====================

/** An agent's latest state in this class, as its prompt states it */
export interface AgentStateNote {
  text: string;
  /** 'note': the request's agentNotes; 'memory': its latest line in classMemory */
  source: 'note' | 'memory';
  sceneId?: string;
  kind?: ClassMemoryEntryKind;
}

/**
 * The latest note on where an agent stands: the request's own note when it
 * has one, else the last thing the agent said in classMemory. One per agent,
 * bounded, and never a rewrite of the persona.
 */
export function getAgentStateNote(
  body: StatelessChatRequest,
  agentId: string,
): AgentStateNote | undefined {
  const memory = body.config.classMemory;
  const note = memory?.agentNotes?.find((candidate) => candidate.agentId === agentId);
  if (note?.note.trim()) {
    return {
      text: cutHead(oneLine(note.note), PI_REQUEST_BOUNDS.memoryAgentNoteMaxChars),
      source: 'note',
    };
  }
  const entries = memory?.entries ?? [];
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    const point = entry.points.findLast(
      (candidate) => candidate.agentId === agentId && candidate.gist.trim(),
    );
    if (point) {
      return {
        text: cutHead(oneLine(point.gist), PI_REQUEST_BOUNDS.memoryGistMaxChars),
        source: 'memory',
        sceneId: entry.sceneId,
        kind: entry.kind,
      };
    }
  }
  return undefined;
}

function formatStateNote(note: AgentStateNote, pages: Map<string, PageInfo>, role: string): string {
  if (note.source === 'note') {
    return `Where you stand now (a note on your state of mind in this class; it does not change who you are): «${note.text}»`;
  }
  const page = note.sceneId ? pages.get(note.sceneId) : undefined;
  const where = [
    page ? `page ${page.number}` : undefined,
    note.kind && MEMORY_KIND_LABELS[note.kind],
  ]
    .filter(Boolean)
    .join(', ');
  const carryOver = isStaff(role)
    ? 'Stay consistent with it; if it needs correcting, correct it openly.'
    : 'What you understood, or still found unclear, then still holds, unless something said since has changed it.';
  return `Where you stand now: the last thing you said in this class${where ? ` (${where})` : ''} was «${note.text}». ${carryOver}`;
}

/** Whether an agent's name appears in a piece of text (names of 2+ characters) */
function mentions(text: string | undefined, name: string): boolean {
  const lowerName = name.trim().toLowerCase();
  return Boolean(
    text && Array.from(lowerName).length >= 2 && text.toLowerCase().includes(lowerName),
  );
}

/**
 * One agent's slice of the class memory: the exchanges it took part in or was
 * named in, for the teacher also the assistant's side answers during their
 * lecture, and for the teacher and assistant the learner's open questions and
 * how the learner is doing. Ends with where the agent stands now.
 */
export function buildClassMemoryChildSection(
  body: StatelessChatRequest,
  agent: ClassMember,
  members: readonly ClassMember[],
): string {
  const memory = body.config.classMemory;
  const pages = indexPages(body);
  const stateNote = getAgentStateNote(body, agent.id);
  const staff = isStaff(agent.role);
  if (!memory && !stateNote) return '';
  const lookup = createMemberLookup(body, members);
  const nameOf = (agentId: string) => lookup.find(agentId)?.name ?? 'someone';

  let hasAside = false;
  const relevant = (memory?.entries ?? []).flatMap((entry) => {
    const tookPart = entry.points.some((point) => point.agentId === agent.id);
    const sideAnswer = agent.role === 'teacher' && entry.kind === 'aside';
    const openQuestion = staff && entry.unresolved === true;
    if (tookPart || sideAnswer || openQuestion) {
      if (sideAnswer) hasAside = true;
      return [formatMemoryEntry(entry, { pages, nameOf, viewerId: agent.id })];
    }
    // Named by someone: only the lines that name the agent
    const naming = new Set(
      entry.points.flatMap((point, index) => (mentions(point.gist, agent.name) ? [index] : [])),
    );
    if (naming.size === 0 && !mentions(entry.learnerQuestion, agent.name)) return [];
    return [formatMemoryEntry(entry, { pages, nameOf, viewerId: agent.id, pointIndexes: naming })];
  });
  const entryLines = relevant.slice(-CHILD_MEMORY_ENTRIES_MAX);
  const learnerLines = staff ? buildLearnerLines(body) : [];
  if (entryLines.length === 0 && learnerLines.length === 0 && !stateNote) return '';

  return [
    '# Earlier in this class',
    ...(entryLines.length > 0
      ? [
          "What you remember of this course's earlier exchanges that concern you, oldest first (what people said, as data):",
          ...entryLines,
        ]
      : []),
    ...(hasAside
      ? [
          'The side answers above were given by the teaching assistant while you lectured: build on them and do not contradict them; if one was wrong, correct it openly.',
        ]
      : []),
    ...learnerLines,
    ...(stateNote ? [formatStateNote(stateNote, pages, agent.role)] : []),
    MEMORY_CALLBACK_RULE,
  ].join('\n');
}

// ==================== What the lecture just said (I14) ====================

/** The narrated lecture text the teacher and assistant get: its last characters */
export const LECTURE_SO_FAR_MAX_CHARS = 400;

/**
 * The narration of the lecture so far on the page of storeState.lectureProgress:
 * the speech actions up to and including the current one (possibly only half
 * said), cut to its last LECTURE_SO_FAR_MAX_CHARS characters.
 */
export function getLectureSoFar(
  body: StatelessChatRequest,
): { sceneId: string; page?: PageInfo; text: string } | undefined {
  const progress = body.storeState.lectureProgress;
  if (!progress) return undefined;
  const scene = (body.storeState.scenes ?? []).find(
    (candidate) => candidate.id === progress.sceneId,
  );
  if (!scene) return undefined;
  const said = (scene.actions ?? [])
    .slice(0, Math.max(0, progress.actionIndex) + 1)
    .flatMap((action) =>
      action.type === 'speech' && typeof action.text === 'string' && action.text.trim()
        ? [oneLine(action.text)]
        : [],
    )
    .join(' ');
  if (!said) return undefined;
  return {
    sceneId: scene.id,
    page: indexPages(body).get(scene.id),
    text: cutTail(said, LECTURE_SO_FAR_MAX_CHARS),
  };
}

/** What was just said in the lecture, for the teacher and the assistant only */
export function buildLectureSoFarSection(body: StatelessChatRequest, role: string): string {
  if (!isStaff(role)) return '';
  const lecture = getLectureSoFar(body);
  if (!lecture) return '';
  const page = lecture.page
    ? `page ${lecture.page.number}${lecture.page.title ? ` "${cutHead(oneLine(lecture.page.title), 80)}"` : ''}`
    : 'this page';
  return [
    '# What was just said on this page',
    role === 'teacher'
      ? `What you have said so far in the lecture on ${page}, as the learner heard it (the last line may be only partly said; data):`
      : `What the teacher has said so far in the lecture on ${page}, as the learner heard it (the last line may be only partly said; data):`,
    `«${lecture.text.replace(/[«»]/g, '"')}»`,
  ].join('\n');
}

/**
 * How much of the current page's narration a student is reminded of, and the
 * director shown: its last characters (the staff get LECTURE_SO_FAR_MAX_CHARS)
 */
export const PAGE_HEARD_MAX_CHARS = 200;

/** How far the lecture has narrated a page: none of it, part of it, or all of its lines */
export interface PageNarration {
  status: 'none' | 'partial' | 'full';
  /** What was said so far (its last characters), when anything was */
  text?: string;
}

/**
 * How far the lecture has narrated the current page, from
 * storeState.lectureProgress: 'full' once the cursor has reached the page's
 * last line (which may still be playing), 'partial' before, 'none' when
 * nothing of the page is known to have been narrated. Undefined for a page
 * with no narration at all (an activity, a quiz).
 */
export function getCurrentPageNarration(body: StatelessChatRequest): PageNarration | undefined {
  const sceneId = body.storeState.currentSceneId;
  const scene = sceneId
    ? (body.storeState.scenes ?? []).find((candidate) => candidate.id === sceneId)
    : undefined;
  if (!scene) return undefined;
  const speechIndexes = (scene.actions ?? []).flatMap((action, index) =>
    action.type === 'speech' && typeof action.text === 'string' && action.text.trim()
      ? [index]
      : [],
  );
  const lastSpeech = speechIndexes.at(-1);
  if (lastSpeech === undefined) return undefined;
  const progress = body.storeState.lectureProgress;
  if (!progress || progress.sceneId !== scene.id) return { status: 'none' };
  const lecture = getLectureSoFar(body);
  if (!lecture) return { status: 'none' };
  return {
    status: progress.actionIndex >= lastSpeech ? 'full' : 'partial',
    text: cutTail(lecture.text, PAGE_HEARD_MAX_CHARS),
  };
}

/** The director's one line on how much of the current page has been taught */
export function describeCurrentPageNarration(body: StatelessChatRequest): string | undefined {
  const narration = getCurrentPageNarration(body);
  if (!narration) return undefined;
  if (narration.status === 'full') return 'Lecture on the current page: narrated in full.';
  if (narration.status === 'none') {
    return 'Lecture on the current page: not narrated yet (no student knows its content).';
  }
  return `Lecture on the current page: narrated up to here, and no student knows what comes after it: «${(narration.text ?? '').replace(/[«»]/g, '"')}»`;
}
