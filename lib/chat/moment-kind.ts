/**
 * Which kind of class moment a lecture's discussion action opens (I10, the
 * contract's moment kind rule). Lesson scripts carry no kind of their own: a
 * teacher calling on a student and a teacher asking the whole class are both
 * written as the teacher's moment, told apart by whether the line names a
 * classmate.
 */

import type { DiscussionMomentKind } from '@/lib/types/chat';

/** One member of the classroom's roster, under every name the learner may see */
export interface MomentRosterMember {
  id: string;
  role?: string;
  /** Display names (the registry's and the localized one); empty ones are ignored */
  names: readonly (string | undefined)[];
}

/** Names this short would match by accident inside other words */
const MIN_NAME_CHARS = 2;

/**
 * The kind of a lecture moment opened by `openerId` with these words:
 * - opened by anyone but the teacher (or an opener not in the roster):
 *   'lecture';
 * - opened by the teacher naming a classmate (any non-teacher member, by a
 *   case-insensitive name of at least two characters): 'lecture' — the
 *   teacher calls on that student, who answers next;
 * - opened by the teacher naming nobody: 'ask-learner' — a question to the
 *   whole class, the learner included.
 */
export function classifyLectureMoment({
  openerId,
  topic,
  roster,
}: {
  openerId: string | undefined;
  topic: string;
  roster: readonly MomentRosterMember[];
}): Extract<DiscussionMomentKind, 'lecture' | 'ask-learner'> {
  const opener = openerId ? roster.find((member) => member.id === openerId) : undefined;
  if (opener?.role !== 'teacher') return 'lecture';
  const words = topic.toLocaleLowerCase();
  const namesClassmate = roster.some(
    (member) =>
      member.id !== opener.id &&
      member.role !== 'teacher' &&
      member.names.some((name) => {
        const needle = name?.trim().toLocaleLowerCase();
        return !!needle && Array.from(needle).length >= MIN_NAME_CHARS && words.includes(needle);
      }),
  );
  return namesClassmate ? 'lecture' : 'ask-learner';
}
