/**
 * What was said earlier in this course, and how the learner is doing, as one
 * compact memory a Pi request carries (config.classMemory, I13 / I14.3): one
 * entry per earlier Q&A, aside or class moment — the learner's question in a
 * sentence and each speaker's gist — older entries folded into per-speaker
 * counts, and the learner's missed quiz concepts and repeated questions.
 *
 * Pure and deterministic: built from the course's loaded chat sessions (each
 * message names its speaker in metadata.agentId) and the graded quizzes. Gists
 * are cuts of what was said, never summaries; nothing is paraphrased. The
 * whole text stays within PI_REQUEST_BOUNDS.memoryTotalMaxChars, so the route
 * has nothing to cut.
 *
 * What the assistant said in an aside is an 'aside' entry: the teacher, who
 * takes over afterwards, hears it and does not contradict it (I14.3).
 *
 * Agent notes (AgentStateNote, I33) are reserved: nothing produces them yet.
 * Continuity comes from each agent's own earlier lines here ("what you said
 * earlier"); notes are added only if the eval shows agents drifting.
 */

import type { UIMessage } from 'ai';
import type {
  ChatMessageMetadata,
  ChatSession,
  ClassMemory,
  ClassMemoryEntry,
  ClassMemoryEntryKind,
  ClassMemoryLearner,
  ClassMemoryPoint,
  ClassMemoryTally,
} from '@/lib/types/chat';
import { PI_REQUEST_BOUNDS } from '@/lib/types/chat';
import type { QuestionResult } from '@/lib/quiz/grading';
import type { QuizQuestion } from '@/lib/types/stage';
import { createLogger } from '@/lib/logger';

const log = createLogger('ClassMemory');

type ChatMessage = UIMessage<ChatMessageMetadata>;

const ELLIPSIS = '…';

/** A question a learner sentence ends with */
const QUESTION_MARK = /[?？]/u;

/** A sentence end: CJK terminators anywhere, Latin ones before a space or the end */
const SENTENCE_END = /[。！？!?]+|[.…]+(?=\s|$)/gu;

/** A sentence shorter than this (a filler like "嗯。") is not taken alone */
const MIN_SENTENCE_CHARS = 8;

/** Two learner questions this similar (character-bigram Dice) count as the same */
const REPEAT_SIMILARITY = 0.8;

/** Shorter questions (normalized) are never compared: too little to tell */
const MIN_REPEAT_CHARS = 4;

const charLength = (text: string | undefined) => (text ? Array.from(text).length : 0);

/** Whitespace runs collapsed into single spaces, trimmed */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * A text on one line, cut to `maxChars` characters (code points): a cut text
 * ends in "…", which counts toward the limit.
 */
export function cutText(text: string, maxChars: number): string {
  const chars = Array.from(oneLine(text));
  if (chars.length <= maxChars) return chars.join('');
  return (
    chars
      .slice(0, Math.max(0, maxChars - 1))
      .join('')
      .trimEnd() + ELLIPSIS
  );
}

/** The text's sentences, in order (the rest after the last end is one too) */
function sentences(text: string): string[] {
  const line = oneLine(text);
  const out: string[] = [];
  let start = 0;
  for (const match of line.matchAll(SENTENCE_END)) {
    const end = (match.index ?? 0) + match[0].length;
    const sentence = line.slice(start, end).trim();
    if (sentence) out.push(sentence);
    start = end;
  }
  const rest = line.slice(start).trim();
  if (rest) out.push(rest);
  return out;
}

/**
 * The learner's question in one sentence: the first sentence that asks
 * something, else the first one long enough to stand alone, else the whole
 * text — cut to `maxChars`.
 */
export function questionSentence(text: string, maxChars: number): string {
  const all = sentences(text);
  const asking = all.find((sentence) => QUESTION_MARK.test(sentence));
  if (asking) return cutText(asking, maxChars);
  let prefix = '';
  for (const sentence of all) {
    prefix = prefix ? `${prefix} ${sentence}` : sentence;
    if (charLength(prefix) >= MIN_SENTENCE_CHARS) return cutText(prefix, maxChars);
  }
  return cutText(text, maxChars);
}

/** The text a message shows (its text parts) */
function messageText(message: ChatMessage): string {
  return message.parts
    .map((part) =>
      part.type === 'text' ? ((part as { type: 'text'; text?: string }).text ?? '') : '',
    )
    .join(' ');
}

/**
 * What an agent's message said, on one line: an interrupted answer loses the
 * "..." its cut left. Empty when it said nothing (or only "...").
 */
function spokenText(message: ChatMessage): string {
  let text = oneLine(messageText(message));
  if (message.metadata?.interrupted) text = text.replace(/(?:\.\.\.|…)+$/u, '').trimEnd();
  return /^[\s.…]*$/u.test(text) ? '' : text;
}

/** A visible line of an agent: its speaker and text */
function agentLine(message: ChatMessage): { agentId: string; text: string } | null {
  if (message.role !== 'assistant') return null;
  const agentId = message.metadata?.agentId;
  if (!agentId) return null;
  const text = spokenText(message);
  return text ? { agentId, text } : null;
}

function learnerText(message: ChatMessage): string {
  return message.role === 'user' ? oneLine(messageText(message)) : '';
}

/**
 * The memory kind of a live session: an aside is the assistant answering
 * during the lecture; a discussion is a class moment of the lecture (from its
 * card or the notes), except a quiz review, which is a plain discussion.
 */
export function classMemoryEntryKind(
  session: Pick<ChatSession, 'type' | 'config'>,
): ClassMemoryEntryKind {
  if (session.type === 'discussion') {
    return session.config?.momentKind === 'quiz-review' ? 'discussion' : 'lecture-moment';
  }
  return session.config?.aside ? 'aside' : 'qa';
}

/** Live sessions (Q&A, aside, discussion) oldest first: the order of the course */
function liveSessionsInOrder(sessions: readonly ChatSession[]): ChatSession[] {
  return sessions
    .map((session, index) => ({ session, index }))
    .filter(({ session }) => session.type === 'qa' || session.type === 'discussion')
    .sort((a, b) => a.session.createdAt - b.session.createdAt || a.index - b.index)
    .map(({ session }) => session);
}

interface BuiltEntry {
  entry: ClassMemoryEntry;
  /** Visible lines per speaker (requested agents only), for the older tallies */
  turns: Map<string, number>;
}

/**
 * One session as a memory entry: the learner's question (a Q&A's first
 * message; in a moment, the first one that asks something), each requested
 * speaker's gist in speaking order, and whether the learner's last message
 * went unanswered. Null when nothing of it is worth remembering.
 */
function buildEntry(
  session: ChatSession,
  allowed: ReadonlySet<string>,
  sceneIds?: ReadonlySet<string>,
): BuiltEntry | null {
  const kind = classMemoryEntryKind(session);
  const said = new Map<string, string[]>();
  const turns = new Map<string, number>();
  let firstQuestion: string | undefined;
  let lastLearnerIndex = -1;
  session.messages.forEach((message, index) => {
    const learner = learnerText(message);
    if (learner) {
      lastLearnerIndex = index;
      const asks = kind === 'qa' || kind === 'aside' || QUESTION_MARK.test(learner);
      if (firstQuestion === undefined && asks) firstQuestion = learner;
      return;
    }
    const line = agentLine(message);
    if (!line || !allowed.has(line.agentId)) return;
    said.set(line.agentId, [...(said.get(line.agentId) ?? []), line.text]);
    turns.set(line.agentId, (turns.get(line.agentId) ?? 0) + 1);
  });

  const points: ClassMemoryPoint[] = [...said.entries()]
    .slice(0, PI_REQUEST_BOUNDS.memoryPointsPerEntryMax)
    .map(([agentId, texts]) => ({
      agentId,
      gist: cutText(texts.join(' '), PI_REQUEST_BOUNDS.memoryGistMaxChars),
    }));
  const learnerQuestion = firstQuestion
    ? questionSentence(firstQuestion, PI_REQUEST_BOUNDS.memoryLearnerQuestionMaxChars)
    : undefined;
  if (points.length === 0 && !learnerQuestion) return null;

  // Open: nobody answered the learner's last message (a cut-off answer is none)
  const unresolved =
    lastLearnerIndex >= 0 &&
    !session.messages
      .slice(lastLearnerIndex + 1)
      .some((message) => !message.metadata?.interrupted && agentLine(message) !== null);

  return {
    entry: {
      kind,
      // A page no longer in the course is left unnamed (the route would drop it)
      ...(session.sceneId && (!sceneIds || sceneIds.has(session.sceneId))
        ? { sceneId: session.sceneId }
        : {}),
      ...(learnerQuestion ? { learnerQuestion } : {}),
      points,
      ...(unresolved ? { unresolved: true } : {}),
    },
    turns,
  };
}

/** A question reduced for comparison: lower case, no spaces, punctuation or symbols */
function normalizeQuestion(text: string): string {
  return oneLine(text)
    .toLocaleLowerCase()
    .replace(/[\p{P}\p{S}\s]/gu, '');
}

function bigrams(text: string): Set<string> {
  const chars = Array.from(text);
  const out = new Set<string>();
  for (let i = 0; i + 1 < chars.length; i++) out.add(chars[i] + chars[i + 1]);
  return out;
}

/** The same question asked again: equal, or nearly the same characters in order */
function isSameQuestion(a: string, b: string): boolean {
  if (a === b) return true;
  const left = bigrams(a);
  const right = bigrams(b);
  if (left.size === 0 || right.size === 0) return false;
  let shared = 0;
  for (const pair of left) if (right.has(pair)) shared += 1;
  return (2 * shared) / (left.size + right.size) >= REPEAT_SIMILARITY;
}

/**
 * Questions the learner asked more than once across the course, newest
 * repetition first, each as first worded (one sentence). A question is a
 * Q&A's (or aside's) opening message, or any learner message that asks
 * something; a quick reply or an answer to a moment is not one.
 */
export function findRepeatedQuestions(sessions: readonly ChatSession[]): string[] {
  const groups: Array<{ key: string; text: string; count: number; last: number }> = [];
  let order = 0;
  for (const session of liveSessionsInOrder(sessions)) {
    const kind = classMemoryEntryKind(session);
    const opensWithQuestion = kind === 'qa' || kind === 'aside';
    let first = true;
    for (const message of session.messages) {
      const text = learnerText(message);
      if (!text) continue;
      const isQuestion = (first && opensWithQuestion) || QUESTION_MARK.test(text);
      first = false;
      if (!isQuestion) continue;
      const key = normalizeQuestion(text);
      order += 1;
      if (charLength(key) < MIN_REPEAT_CHARS) continue;
      const group = groups.find((candidate) => isSameQuestion(candidate.key, key));
      if (group) {
        group.count += 1;
        group.last = order;
      } else {
        groups.push({ key, text, count: 1, last: order });
      }
    }
  }
  return groups
    .filter((group) => group.count > 1)
    .sort((a, b) => b.last - a.last)
    .slice(0, PI_REQUEST_BOUNDS.memoryRepeatedQuestionsMax)
    .map((group) => questionSentence(group.text, PI_REQUEST_BOUNDS.memoryRepeatedQuestionMaxChars));
}

/** The concepts one graded quiz missed: the stems answered wrong, in question order */
export interface QuizMissRecord {
  sceneId: string;
  concepts: string[];
}

/**
 * The concepts behind the questions answered wrong: their stems, never the
 * options, answers, points or scores.
 */
export function quizMissedConcepts(
  questions: readonly Pick<QuizQuestion, 'id' | 'question'>[],
  results: readonly Pick<QuestionResult, 'questionId' | 'status'>[],
): string[] {
  const wrong = new Set(
    results.filter((result) => result.status === 'incorrect').map((r) => r.questionId),
  );
  return questions
    .filter((question) => wrong.has(question.id) && question.question?.trim())
    .map((question) => cutText(question.question, PI_REQUEST_BOUNDS.memoryMissedConceptMaxChars));
}

/** The text the route counts against the memory budget */
function entryLength(entry: ClassMemoryEntry): number {
  return (
    charLength(entry.learnerQuestion) +
    entry.points.reduce((sum, point) => sum + charLength(point.gist), 0)
  );
}

const listLength = (list: readonly string[]) =>
  list.reduce((sum, item) => sum + charLength(item), 0);

/**
 * The class memory a Pi request sends (config.classMemory). `sessions` are
 * the course's loaded sessions; the requesting session (`excludeSessionId`)
 * is left out of the entries — its messages travel in the request itself —
 * but its learner messages still count toward repeated questions. Points of
 * agents outside `agentIds` are left out. The newest
 * PI_REQUEST_BOUNDS.memoryEntriesMax entries are kept, older ones (and, over
 * the text budget, the oldest kept ones) become per-speaker counts; then the
 * repeated questions, then the missed concepts, lose items from their ends.
 * With `sceneIds` (the course's pages), an entry's page outside them is left
 * out. Undefined when there is nothing to remember.
 */
export function buildClassMemory({
  sessions,
  agentIds,
  excludeSessionId,
  quizMisses = [],
  sceneIds,
}: {
  sessions: readonly ChatSession[];
  agentIds: readonly string[];
  excludeSessionId?: string;
  quizMisses?: readonly QuizMissRecord[];
  sceneIds?: ReadonlySet<string>;
}): ClassMemory | undefined {
  const ids = [...new Set(agentIds.filter((id) => typeof id === 'string' && id))];
  const allowed = new Set(ids);

  const built = liveSessionsInOrder(sessions)
    .filter((session) => session.id !== excludeSessionId)
    .map((session) => buildEntry(session, allowed, sceneIds))
    .filter((item): item is BuiltEntry => item !== null);

  const tallied = new Map<string, number>();
  const fold = (item: BuiltEntry) => {
    for (const [agentId, turns] of item.turns) {
      tallied.set(agentId, (tallied.get(agentId) ?? 0) + turns);
    }
  };
  const older = built.splice(0, Math.max(0, built.length - PI_REQUEST_BOUNDS.memoryEntriesMax));
  older.forEach(fold);

  const missedConcepts = [
    ...new Set(quizMisses.flatMap((record) => record.concepts).filter(Boolean)),
  ]
    .map((concept) => cutText(concept, PI_REQUEST_BOUNDS.memoryMissedConceptMaxChars))
    .slice(0, PI_REQUEST_BOUNDS.memoryMissedConceptsMax);
  const repeatedQuestions = findRepeatedQuestions(sessions);

  // One budget for all the text, as the route counts it
  const total = () =>
    built.reduce((sum, item) => sum + entryLength(item.entry), 0) +
    listLength(missedConcepts) +
    listLength(repeatedQuestions);
  const overBudget = () => total() > PI_REQUEST_BOUNDS.memoryTotalMaxChars;
  while (overBudget() && built.length > 0) fold(built.shift()!);
  while (overBudget() && repeatedQuestions.length > 0) repeatedQuestions.pop();
  while (overBudget() && missedConcepts.length > 0) missedConcepts.pop();

  const olderTallies: ClassMemoryTally[] = ids
    .filter((agentId) => (tallied.get(agentId) ?? 0) > 0)
    .map((agentId) => ({
      agentId,
      turns: Math.min(tallied.get(agentId)!, PI_REQUEST_BOUNDS.presenceCountMax),
    }));
  const learner: ClassMemoryLearner = {
    ...(missedConcepts.length > 0 ? { missedConcepts } : {}),
    ...(repeatedQuestions.length > 0 ? { repeatedQuestions } : {}),
  };
  const hasLearner = Object.keys(learner).length > 0;
  if (built.length === 0 && olderTallies.length === 0 && !hasLearner) return undefined;

  return {
    entries: built.map((item) => item.entry),
    ...(olderTallies.length > 0 ? { olderTallies } : {}),
    ...(hasLearner ? { learner } : {}),
  };
}

/** A scene as the quiz loader reads it (the stage store's scenes) */
interface QuizSceneLike {
  id: string;
  type?: string;
  stageId?: string;
  order?: number;
  content?: unknown;
}

type LoadQuizAttemptState = (input: { stageId: string; sceneId: string }) => Promise<{
  state?: { phase?: string; results?: QuestionResult[] };
}>;

/** How long one quiz's graded state may take to load before it is left out */
const QUIZ_MISS_TIMEOUT_MS = 1000;

function quizQuestionsOf(scene: QuizSceneLike): QuizQuestion[] | undefined {
  const content = scene.content as { type?: unknown; questions?: unknown } | undefined;
  return content?.type === 'quiz' && Array.isArray(content.questions)
    ? (content.questions as QuizQuestion[])
    : undefined;
}

/**
 * The missed concepts of every graded quiz in the course, in page order,
 * read from the RuntimeStore. A quiz not yet reviewed, one that fails or
 * takes too long to load is left out (never blocks the request for long).
 */
export async function loadQuizMisses(
  scenes: readonly QuizSceneLike[],
  options: { load?: LoadQuizAttemptState; timeoutMs?: number } = {},
): Promise<QuizMissRecord[]> {
  const quizzes = scenes
    .map((scene, index) => ({ scene, index, questions: quizQuestionsOf(scene) }))
    .filter(
      (item): item is { scene: QuizSceneLike; index: number; questions: QuizQuestion[] } =>
        item.scene.type === 'quiz' && !!item.scene.stageId && !!item.questions?.length,
    )
    .sort((a, b) => (a.scene.order ?? a.index) - (b.scene.order ?? b.index) || a.index - b.index);
  if (quizzes.length === 0) return [];

  // Loaded only when the course has a quiz: the runtime store is not touched otherwise
  const load: LoadQuizAttemptState =
    options.load ?? (await import('@/lib/quiz/runtime')).loadQuizAttemptState;
  const timeoutMs = options.timeoutMs ?? QUIZ_MISS_TIMEOUT_MS;

  const records = await Promise.all(
    quizzes.map(async ({ scene, questions }): Promise<QuizMissRecord | null> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const { state } = await Promise.race([
          load({ stageId: scene.stageId!, sceneId: scene.id }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('Timed out loading a quiz')), timeoutMs);
          }),
        ]);
        if (state?.phase !== 'reviewed' || !state.results?.length) return null;
        const concepts = quizMissedConcepts(questions, state.results);
        return concepts.length > 0 ? { sceneId: scene.id, concepts } : null;
      } catch (error) {
        log.warn('Quiz left out of the class memory:', error);
        return null;
      } finally {
        clearTimeout(timer);
      }
    }),
  );
  return records.filter((record): record is QuizMissRecord => record !== null);
}
