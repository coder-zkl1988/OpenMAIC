/**
 * The learner's level the agent profiles place the classmates around: their
 * own description, never their name, and only as much as calibrating needs.
 */
import { describe, expect, it } from 'vitest';

import { learnerLevelText } from '@/lib/server/generation/run/engine';
import type { GenerationRunInput } from '@/lib/server/generation/run/types';

const input = (learnerProfile?: GenerationRunInput['learnerProfile']) =>
  ({ requirement: 'Teach photosynthesis', learnerProfile }) as GenerationRunInput;

describe('the learner level for the agent profiles', () => {
  it('is the learner description, without their name', () => {
    expect(learnerLevelText(input({ nickname: 'Sam', bio: '  Grade 8, new to biology ' }))).toBe(
      'Grade 8, new to biology',
    );
  });

  it('masks the name where the description says it', () => {
    expect(
      learnerLevelText(input({ nickname: '小明', bio: '我叫小明，读初二，小明数学一般' })),
    ).toBe('我叫…，读初二，…数学一般');
    expect(learnerLevelText(input({ nickname: 'Sam', bio: "I'm sam, same age as my class" }))).toBe(
      "I'm …, same age as my class",
    );
  });

  it('is absent without a description', () => {
    expect(learnerLevelText(input({ nickname: 'Sam' }))).toBeUndefined();
    expect(learnerLevelText(input({ nickname: 'Sam', bio: '   ' }))).toBeUndefined();
    expect(learnerLevelText(input())).toBeUndefined();
  });

  it('is cut to what calibrating a level needs', () => {
    const level = learnerLevelText(input({ bio: '学'.repeat(500) }))!;
    expect(Array.from(level)).toHaveLength(303);
    expect(level.endsWith('学...')).toBe(true);
  });
});
