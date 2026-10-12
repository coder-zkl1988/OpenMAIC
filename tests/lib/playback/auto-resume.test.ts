import { describe, expect, it } from 'vitest';
import {
  shouldAdvanceAfterMoment,
  shouldAutoResumeLecture,
  willResumeAfterSoftClose,
  type AutoResumeArgs,
  type MomentAdvanceArgs,
} from '@/lib/playback/auto-resume';

const base: AutoResumeArgs = {
  source: 'soft_close_timeout',
  endReason: 'user_done',
  hadLectureInterruption: true,
  engineMode: 'idle',
  isExhausted: false,
  playbackCompleted: false,
};

describe('shouldAutoResumeLecture', () => {
  it('resumes after a soft-close timeout that ended an interrupting Q&A (user_done)', () => {
    expect(shouldAutoResumeLecture(base)).toBe(true);
  });

  it('resumes when endReason is back_to_lesson', () => {
    expect(shouldAutoResumeLecture({ ...base, endReason: 'back_to_lesson' })).toBe(true);
  });

  it('uses the same resume gate for a user-confirmed soft close', () => {
    expect(shouldAutoResumeLecture({ ...base, source: 'soft_close_confirmed' })).toBe(true);
    expect(
      shouldAutoResumeLecture({
        ...base,
        source: 'soft_close_confirmed',
        endReason: 'user_goodbye',
      }),
    ).toBe(false);
  });

  it('never resumes for a non-soft-close cleanup source', () => {
    expect(shouldAutoResumeLecture({ ...base, source: 'soft_close_enter' })).toBe(false);
    expect(shouldAutoResumeLecture({ ...base, source: 'manual_stop' })).toBe(false);
    expect(shouldAutoResumeLecture({ ...base, source: 'scene_switch' })).toBe(false);
    expect(shouldAutoResumeLecture({ ...base, source: 'error' })).toBe(false);
    expect(shouldAutoResumeLecture({ ...base, source: 'turn_complete' })).toBe(false);
  });

  it('never resumes when the Q&A did not interrupt a lecture', () => {
    expect(shouldAutoResumeLecture({ ...base, hadLectureInterruption: false })).toBe(false);
  });

  it('never resumes for goodbye/lesson_complete/unknown/undefined endReason', () => {
    expect(shouldAutoResumeLecture({ ...base, endReason: 'user_goodbye' })).toBe(false);
    expect(shouldAutoResumeLecture({ ...base, endReason: 'lesson_complete' })).toBe(false);
    expect(shouldAutoResumeLecture({ ...base, endReason: 'something_else' })).toBe(false);
    expect(shouldAutoResumeLecture({ ...base, endReason: undefined })).toBe(false);
  });

  it('never resumes when the engine is not idle', () => {
    expect(shouldAutoResumeLecture({ ...base, engineMode: 'playing' })).toBe(false);
    expect(shouldAutoResumeLecture({ ...base, engineMode: 'paused' })).toBe(false);
    expect(shouldAutoResumeLecture({ ...base, engineMode: 'live' })).toBe(false);
  });

  it('never resumes when the course is exhausted or already completed', () => {
    expect(shouldAutoResumeLecture({ ...base, isExhausted: true })).toBe(false);
    expect(shouldAutoResumeLecture({ ...base, playbackCompleted: true })).toBe(false);
  });

  it('resumes an exhausted lecture whose completion a raised hand preempted', () => {
    expect(
      shouldAutoResumeLecture({ ...base, isExhausted: true, lectureCompletionPending: true }),
    ).toBe(true);
    expect(
      shouldAutoResumeLecture({
        ...base,
        isExhausted: true,
        lectureCompletionPending: true,
        playbackCompleted: true,
      }),
    ).toBe(false);
    expect(
      shouldAutoResumeLecture({
        ...base,
        isExhausted: true,
        lectureCompletionPending: true,
        source: 'manual_stop',
      }),
    ).toBe(false);
  });
});

describe('willResumeAfterSoftClose', () => {
  const pending = {
    endReason: 'user_done',
    hadLectureInterruption: true,
    isExhausted: false,
    playbackCompleted: false,
  };

  it('agrees with shouldAutoResumeLecture before the session ends', () => {
    expect(willResumeAfterSoftClose(pending)).toBe(true);
    expect(willResumeAfterSoftClose({ ...pending, endReason: 'back_to_lesson' })).toBe(true);
    expect(willResumeAfterSoftClose({ ...pending, endReason: 'user_goodbye' })).toBe(false);
    expect(willResumeAfterSoftClose({ ...pending, endReason: undefined })).toBe(false);
    expect(willResumeAfterSoftClose({ ...pending, hadLectureInterruption: false })).toBe(false);
    expect(willResumeAfterSoftClose({ ...pending, playbackCompleted: true })).toBe(false);
    expect(willResumeAfterSoftClose({ ...pending, isExhausted: true })).toBe(false);
    expect(
      willResumeAfterSoftClose({ ...pending, isExhausted: true, lectureCompletionPending: true }),
    ).toBe(true);
  });
});

describe('shouldAdvanceAfterMoment (I19: a joined moment ends, the course goes on)', () => {
  const ended: MomentAdvanceArgs = {
    source: 'soft_close_timeout',
    endReason: 'user_done',
    wasLectureMoment: true,
    autoPlayLecture: true,
    engineMode: 'idle',
    isExhausted: true,
    lectureCompletionPending: false,
  };

  it('moves on after the director closed a moment at the end of its page, with auto-play on', () => {
    expect(shouldAdvanceAfterMoment(ended)).toBe(true);
    // The learner confirmed its end ("结束讨论", back to the lecture)
    expect(shouldAdvanceAfterMoment({ ...ended, source: 'soft_close_confirmed' })).toBe(true);
    // Whatever the director's reason, but a goodbye
    for (const endReason of ['back_to_lesson', 'lesson_complete', undefined]) {
      expect(shouldAdvanceAfterMoment({ ...ended, endReason })).toBe(true);
    }
    expect(shouldAdvanceAfterMoment({ ...ended, endReason: 'user_goodbye' })).toBe(false);
  });

  it('stays without auto-play, or for a session that was not a joined moment', () => {
    expect(shouldAdvanceAfterMoment({ ...ended, autoPlayLecture: false })).toBe(false);
    expect(shouldAdvanceAfterMoment({ ...ended, wasLectureMoment: false })).toBe(false);
  });

  it('stays on an interactive page after its moment: the learner keeps the widget (I29)', () => {
    expect(shouldAdvanceAfterMoment({ ...ended, pageTurnsByItself: false })).toBe(false);
    expect(shouldAdvanceAfterMoment({ ...ended, pageTurnsByItself: true })).toBe(true);
  });

  it('never moves on for a manual stop, an error, a scene switch or a plain turn end', () => {
    for (const source of [
      'manual_stop',
      'error',
      'scene_switch',
      'turn_complete',
      'soft_close_enter',
    ] as const) {
      expect(shouldAdvanceAfterMoment({ ...ended, source })).toBe(false);
    }
  });

  it('leaves a page with lecture left, a running engine and a preempted completion alone', () => {
    expect(shouldAdvanceAfterMoment({ ...ended, isExhausted: false })).toBe(false);
    expect(shouldAdvanceAfterMoment({ ...ended, engineMode: 'playing' })).toBe(false);
    // The Q&A resume path runs that completion itself
    expect(shouldAdvanceAfterMoment({ ...ended, lectureCompletionPending: true })).toBe(false);
  });
});
