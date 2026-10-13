/**
 * What a classmate card tells the learner about someone (I24): who they are
 * and how they come across — the persona's first sentence, which the persona
 * guide reserves for temperament — and never the rest. A persona goes on to
 * describe the person's level and the misconceptions they tend to have; that
 * is written for the model, and shown to the learner it would give away how
 * a classmate is going to get things wrong. A built-in agent has its own
 * one-line intro in the interface language instead.
 */

/** The longest intro a card shows, in characters (code points) */
export const CLASSMATE_INTRO_MAX_CHARS = 120;

/** A first sentence shorter than this ("Hi." / "嗯。") is joined with the next */
const MIN_SENTENCE_CHARS = 12;

/** A sentence end: CJK terminators anywhere, Latin ones before a space or the end */
const SENTENCE_END = /[。！？]+|[.!?…]+(?=\s|$)/gu;

/** A Latin abbreviation whose dot does not end the sentence ("Ms. Lin") */
const ABBREVIATION = /(?:^|\s)(?:mr|mrs|ms|dr|prof|st|jr|sr|vs|e\.g|i\.e|etc)\.$/iu;

const ELLIPSIS = '…';

function cut(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  const kept = chars.slice(0, max - 1).join('');
  return kept.trimEnd() + ELLIPSIS;
}

/**
 * The opening of a persona: its first sentence (with the next one when the
 * first is only a few characters), on one line, cut to
 * {@link CLASSMATE_INTRO_MAX_CHARS}. Empty for an empty persona.
 */
export function personaIntro(persona: string | undefined): string {
  const text = (persona ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  let end = text.length;
  for (const match of text.matchAll(SENTENCE_END)) {
    const stop = (match.index ?? 0) + match[0].length;
    if (match[0] === '.' && ABBREVIATION.test(text.slice(0, stop))) continue;
    if (Array.from(text.slice(0, stop).trim()).length < MIN_SENTENCE_CHARS) continue;
    end = stop;
    break;
  }
  return cut(text.slice(0, end).trim(), CLASSMATE_INTRO_MAX_CHARS);
}

/**
 * A card's intro for an agent: a built-in agent's one-liner in the
 * interface language (`settings.agentDescriptions.<id>`), else the opening
 * of its persona.
 */
export function classmateIntro(
  agent: { id: string; persona?: string },
  t: (key: string) => string,
): string {
  const key = `settings.agentDescriptions.${agent.id}`;
  const described = t(key);
  return described && described !== key ? described : personaIntro(agent.persona);
}
