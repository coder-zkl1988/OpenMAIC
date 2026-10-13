/**
 * The kind of a lecture moment (I10): a classmate's moment, the teacher
 * calling on a named classmate, or the teacher's question to the whole class.
 */
import { describe, expect, it } from 'vitest';
import { classifyLectureMoment, type MomentRosterMember } from '@/lib/chat/moment-kind';

const roster: MomentRosterMember[] = [
  { id: 'teacher', role: 'teacher', names: ['Ms. Lin', '林老师'] },
  { id: 'ta', role: 'assistant', names: ['Sam', undefined] },
  { id: 'mia', role: 'student', names: ['Mia', '小米'] },
  { id: 'x', role: 'student', names: ['X'] },
];

describe('classifyLectureMoment', () => {
  it("is a classmate's moment when a classmate opens it", () => {
    expect(classifyLectureMoment({ openerId: 'mia', topic: 'Wait, why?', roster })).toBe('lecture');
    expect(classifyLectureMoment({ openerId: 'ta', topic: 'Anyone?', roster })).toBe('lecture');
  });

  it('is a question to the whole class when the teacher names no classmate', () => {
    expect(
      classifyLectureMoment({ openerId: 'teacher', topic: '大家猜猜会发生什么？', roster }),
    ).toBe('ask-learner');
    // A one-letter name would match by accident: it never counts
    expect(
      classifyLectureMoment({ openerId: 'teacher', topic: 'Guess the next value of x?', roster }),
    ).toBe('ask-learner');
  });

  it('is the named classmate’s moment when the teacher calls on them (any of their names)', () => {
    expect(
      classifyLectureMoment({ openerId: 'teacher', topic: 'MIA, what do you think?', roster }),
    ).toBe('lecture');
    expect(classifyLectureMoment({ openerId: 'teacher', topic: '小米，你来说说？', roster })).toBe(
      'lecture',
    );
    expect(classifyLectureMoment({ openerId: 'teacher', topic: 'Sam, help us out?', roster })).toBe(
      'lecture',
    );
  });

  it('never makes a whole-class question of an opener it does not know', () => {
    expect(classifyLectureMoment({ openerId: undefined, topic: 'Guess?', roster })).toBe('lecture');
    expect(classifyLectureMoment({ openerId: 'ghost', topic: 'Guess?', roster })).toBe('lecture');
  });
});
