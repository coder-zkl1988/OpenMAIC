/**
 * The learner addressing someone by name (I23): the composer's @ menu, or a
 * classmate card's "ask them", writes "@Name " into the message, and the Pi
 * request names whom the latest message addressed (config.addressedAgentIds).
 * The text is the one source of truth: a mention is a roster name right
 * after "@", under any name the learner may see (the registry's, and for a
 * built-in agent the localized one), so a typed "@小思" counts as much as a
 * picked one.
 *
 * Pure and deterministic. Never persisted: a mention belongs to the message
 * that carries it.
 */

import { PI_REQUEST_BOUNDS } from '@/lib/types/chat';
import type { MomentRosterMember } from './moment-kind';

/** A roster member under every name the learner may see (empty names are ignored) */
export type MentionRosterMember = MomentRosterMember;

/** A person the @ menu offers */
export interface MentionCandidate {
  id: string;
  /** The name the learner sees, written into the message */
  name: string;
  avatar?: string;
  /** Registry role ('teacher' | 'assistant' | 'student' | custom) */
  role?: string;
}

/** The "@query" being typed at the caret: where it starts ("@") and ends (the caret) */
export interface MentionQuery {
  start: number;
  end: number;
  query: string;
}

/** A typed query longer than this is not read as a name any more */
const MAX_QUERY_CHARS = 24;

/** An ASCII word character: "@" right after one is an e-mail address, not a mention */
const ASCII_WORD = /[A-Za-z0-9_]/;

const lower = (text: string) => text.toLocaleLowerCase();

/** Whether the "@" at `at` can open a mention (not inside a word like a@b.c) */
function opensMention(text: string, at: number): boolean {
  return text[at] === '@' && (at === 0 || !ASCII_WORD.test(text[at - 1]!));
}

function memberNames(member: MentionRosterMember): string[] {
  const names: string[] = [];
  for (const name of member.names) {
    const trimmed = name?.trim();
    if (trimmed && !names.includes(trimmed)) names.push(trimmed);
  }
  return names;
}

/**
 * The mention being typed at the caret: an "@" that may open one, and what
 * follows it up to the caret. A space ends the query unless some name goes
 * on with it ("@Ms. L" while "Ms. Lin" is in class); a line break always
 * does. Null when the caret is not in a mention.
 */
export function findMentionQuery(
  text: string,
  caret: number,
  names: readonly string[] = [],
): MentionQuery | null {
  if (caret < 1 || caret > text.length) return null;
  const at = text.lastIndexOf('@', caret - 1);
  if (at < 0 || !opensMention(text, at)) return null;
  const query = text.slice(at + 1, caret);
  if (/[\r\n@]/.test(query) || Array.from(query).length > MAX_QUERY_CHARS) return null;
  if (/\s/.test(query)) {
    const typed = lower(query);
    if (!names.some((name) => lower(name).startsWith(typed))) return null;
  }
  return { start: at, end: caret, query };
}

/**
 * The people whose name fits the typed query, in roster order: names that
 * start with it first, then names that contain it. Everyone for an empty
 * query.
 */
export function filterMentionCandidates<T extends Pick<MentionCandidate, 'name'>>(
  candidates: readonly T[],
  query: string,
): T[] {
  const typed = lower(query.trim());
  if (!typed) return [...candidates];
  const starts = candidates.filter((c) => lower(c.name).startsWith(typed));
  const contains = candidates.filter((c) => !starts.includes(c) && lower(c.name).includes(typed));
  return [...starts, ...contains];
}

/**
 * The text with the typed "@query" replaced by "@Name " and where the caret
 * goes (after the space; an existing space after the query is reused).
 */
export function insertMention(
  text: string,
  range: Pick<MentionQuery, 'start' | 'end'>,
  name: string,
): { text: string; caret: number } {
  const before = text.slice(0, range.start);
  const after = text.slice(range.end);
  const mention = `@${name}`;
  const space = /^\s/.test(after) ? '' : ' ';
  return {
    text: `${before}${mention}${space}${after}`,
    caret: before.length + mention.length + 1,
  };
}

/**
 * The draft addressed to `name` ("ask them" on a classmate card): "@Name "
 * in front, unless the draft already mentions them.
 */
export function addMention(text: string, name: string): string {
  const mention = `@${name}`;
  if (lower(text).includes(lower(mention))) return text;
  const rest = text.replace(/^\s+/, '');
  return rest ? `${mention} ${rest}` : `${mention} `;
}

/** One "@Name" in a text: where it runs (the "@" included) and whom it names */
export interface MentionSpan {
  start: number;
  end: number;
  id: string;
}

/**
 * Every "@" followed by a roster name, in order: the longest name that fits
 * (so "@小明明" is not "@小明"), and a Latin name must end at a word boundary
 * (so "@Mia" is not "@Miami"). An "@" inside a word (a@b.c) opens nothing.
 */
export function findMentions(text: string, roster: readonly MentionRosterMember[]): MentionSpan[] {
  const named = roster.flatMap((member) =>
    memberNames(member).map((name) => ({ id: member.id, name, key: lower(name) })),
  );
  if (named.length === 0 || !text.includes('@')) return [];
  const haystack = lower(text);
  const spans: MentionSpan[] = [];
  for (let at = text.indexOf('@'); at >= 0; ) {
    let best: { id: string; length: number } | null = null;
    if (opensMention(text, at)) {
      for (const { id, name, key } of named) {
        if (!haystack.startsWith(key, at + 1)) continue;
        const next = text[at + 1 + name.length];
        // "@Mia" inside "@Miami": a Latin name runs on into the next word
        if (next && ASCII_WORD.test(name[name.length - 1]!) && ASCII_WORD.test(next)) continue;
        if (!best || name.length > best.length) best = { id, length: name.length };
      }
    }
    if (best) spans.push({ start: at, end: at + 1 + best.length, id: best.id });
    at = text.indexOf('@', best ? at + 1 + best.length : at + 1);
  }
  return spans;
}

/** The text cut into runs, each either plain or one mention ({@link findMentions}) */
export function splitMentions(
  text: string,
  spans: readonly MentionSpan[],
): { text: string; mention?: string }[] {
  const runs: { text: string; mention?: string }[] = [];
  let cursor = 0;
  for (const span of spans) {
    if (span.start > cursor) runs.push({ text: text.slice(cursor, span.start) });
    runs.push({ text: text.slice(span.start, span.end), mention: span.id });
    cursor = span.end;
  }
  if (cursor < text.length) runs.push({ text: text.slice(cursor) });
  return runs;
}

/**
 * Who the message addresses: the people its mentions name
 * ({@link findMentions}), in the order first mentioned, each once, at most
 * PI_REQUEST_BOUNDS.addressedAgentIdsMax.
 */
export function resolveAddressedAgentIds(
  text: string,
  roster: readonly MentionRosterMember[],
): string[] {
  const addressed: string[] = [];
  for (const { id } of findMentions(text, roster)) {
    if (!addressed.includes(id)) addressed.push(id);
    if (addressed.length >= PI_REQUEST_BOUNDS.addressedAgentIdsMax) break;
  }
  return addressed;
}

/**
 * The roster the mentions are matched against: each agent under its
 * registry name and, for a built-in agent, the name the learner's interface
 * language gives it (`settings.agentNames.<id>`).
 */
export function mentionRoster(
  agentIds: readonly string[],
  getAgent: (id: string) => { name?: string; role?: string } | undefined,
  t: (key: string) => string,
): MentionRosterMember[] {
  return agentIds.flatMap((id) => {
    const agent = getAgent(id);
    if (!agent) return [];
    const key = `settings.agentNames.${id}`;
    const localized = t(key);
    return [
      { id, role: agent.role, names: [localized !== key ? localized : undefined, agent.name] },
    ];
  });
}
