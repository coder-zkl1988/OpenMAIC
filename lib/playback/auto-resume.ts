import type { EngineMode } from './types';

/**
 * Where a chat-session cleanup originated. A confirmed or timed-out soft close
 * may auto-resume an interrupted lecture; other sources must not.
 */
export type CleanupSource =
  | 'soft_close_enter'
  | 'soft_close_confirmed'
  | 'soft_close_timeout'
  | 'manual_stop'
  | 'scene_switch'
  | 'error'
  | 'turn_complete';

export interface AutoResumeArgs {
  /** Which cleanup path is running. */
  source: CleanupSource;
  /** Director-provided reason the Q&A/discussion ended, if any. */
  endReason?: string;
  /** Whether this session interrupted an active lecture (read before cleanup). */
  hadLectureInterruption: boolean;
  /** Engine mode AFTER cleanup restored the saved lecture position. */
  engineMode: EngineMode;
  /** Whether the course has no more content to play. */
  isExhausted: boolean;
  /**
   * Whether the interrupted lecture played its last action before the Q&A
   * (a raised hand answered at the final boundary): resuming then only runs
   * the completion, so exhaustion must not block it.
   */
  lectureCompletionPending?: boolean;
  /** Whether playback already reached completion. */
  playbackCompleted: boolean;
}

/**
 * Decide whether an ended Q&A/discussion should auto-resume the lecture it
 * interrupted. Pure and conservative: it only returns true for the narrow
 * "completed soft close after a satisfied/back-to-lesson Q&A" case, and
 * requires the engine to be idle with content still remaining (or with only
 * the completion of a lecture whose last line already played).
 */
export function shouldAutoResumeLecture(args: AutoResumeArgs): boolean {
  if (args.source !== 'soft_close_confirmed' && args.source !== 'soft_close_timeout') return false;
  if (args.engineMode !== 'idle') return false;
  return willResumeAfterSoftClose(args);
}

/**
 * The countdown (ms) from the end of a class moment to the next page when
 * auto-play moves on by itself: as long as the page turn after a lecture
 * (onComplete's pause) plus a beat to read "3 秒后继续讲课".
 */
export const MOMENT_ADVANCE_DELAY_MS = 3000;

export interface MomentAdvanceArgs {
  /** Which cleanup path ended the session */
  source: CleanupSource;
  /** Director-provided reason the session ended, if any */
  endReason?: string;
  /** The ended session was a class moment the learner joined from its card */
  wasLectureMoment: boolean;
  /** The learner's auto-play setting */
  autoPlayLecture: boolean;
  /** Engine mode AFTER cleanup restored the saved lecture position */
  engineMode: EngineMode;
  /** Nothing of the page is left to play (the moment was its last action) */
  isExhausted: boolean;
  /** A raised hand preempted the completion: the Q&A resume path owns it */
  lectureCompletionPending?: boolean;
  /**
   * Auto-play turns this page by itself (a slide). An interactive, quiz or
   * PBL page waits for the learner: after a moment there, the widget stays
   * as they left it and nothing counts down. Absent: a slide.
   */
  pageTurnsByItself?: boolean;
}

/**
 * Whether the end of a class moment should move on to the next page, the way
 * a finished page does under auto-play. Joining a moment must not stop the
 * course when skipping it would not have: so with auto-play on, a moment the
 * director closed (close_session, or the learner confirming its end) on a
 * page already fully lectured counts down and advances. A goodbye, a manual
 * stop, an error or a scene switch never do.
 */
export function shouldAdvanceAfterMoment(args: MomentAdvanceArgs): boolean {
  if (!args.wasLectureMoment || !args.autoPlayLecture) return false;
  if (args.pageTurnsByItself === false) return false;
  if (args.source !== 'soft_close_confirmed' && args.source !== 'soft_close_timeout') return false;
  if (args.endReason === 'user_goodbye') return false;
  if (args.engineMode !== 'idle') return false;
  return args.isExhausted && !args.lectureCompletionPending;
}

/**
 * The part of shouldAutoResumeLecture that is already known while a session
 * soft-closes: whether its end will hand back to the interrupted lecture. The
 * caption's "N 秒后继续讲课" countdown uses it, so it never promises a
 * resume the cleanup will refuse.
 */
export function willResumeAfterSoftClose(
  args: Omit<AutoResumeArgs, 'source' | 'engineMode'>,
): boolean {
  if (!args.hadLectureInterruption) return false;
  if (args.endReason !== 'user_done' && args.endReason !== 'back_to_lesson') return false;
  if ((args.isExhausted && !args.lectureCompletionPending) || args.playbackCompleted) return false;
  return true;
}
