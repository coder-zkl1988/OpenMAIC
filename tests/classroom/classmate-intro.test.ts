/**
 * A classmate card shows who someone is (I24): the persona's first sentence,
 * never the level and misconceptions written for the model.
 */
import { describe, expect, it } from 'vitest';
import {
  CLASSMATE_INTRO_MAX_CHARS,
  classmateIntro,
  personaIntro,
} from '@/lib/classroom/classmate-intro';

describe('personaIntro', () => {
  it('keeps only the first sentence (temperament), not the level or the misconceptions', () => {
    const persona =
      'Mia is a lively joker who blurts out her first guess. She is new to fractions and often adds the denominators. She speaks up whenever something sounds funny.';
    expect(personaIntro(persona)).toBe('Mia is a lively joker who blurts out her first guess.');
    expect(personaIntro('小思安静、爱琢磨，说话慢条斯理。她常把面积和周长混在一起。')).toBe(
      '小思安静、爱琢磨，说话慢条斯理。',
    );
  });

  it('does not stop at an abbreviation or after a too-short first sentence', () => {
    expect(personaIntro('Ms. Lin is calm and warm. She asks the class to guess first.')).toBe(
      'Ms. Lin is calm and warm.',
    );
    expect(personaIntro('Hi. Leo is a careful note-taker. He checks every step.')).toBe(
      'Hi. Leo is a careful note-taker.',
    );
  });

  it('is one line, cut with an ellipsis, and empty for no persona', () => {
    const long = `${'very '.repeat(60)}long first sentence`;
    const intro = personaIntro(long);
    expect(Array.from(intro)).toHaveLength(CLASSMATE_INTRO_MAX_CHARS);
    expect(intro.endsWith('…')).toBe(true);
    expect(personaIntro('A shy\nthinker with no full stop')).toBe(
      'A shy thinker with no full stop',
    );
    expect(personaIntro('')).toBe('');
    expect(personaIntro(undefined)).toBe('');
  });
});

describe('classmateIntro', () => {
  const t = (key: string) =>
    key === 'settings.agentDescriptions.default-3'
      ? 'Lively joker who blurts out her first guess'
      : key;

  it("uses a built-in agent's one-liner, else the persona's opening", () => {
    expect(classmateIntro({ id: 'default-3', persona: 'You are the class clown...' }, t)).toBe(
      'Lively joker who blurts out her first guess',
    );
    expect(
      classmateIntro({ id: 'gen-1', persona: 'Leo is quiet and careful. He mixes up x and y.' }, t),
    ).toBe('Leo is quiet and careful.');
  });
});
