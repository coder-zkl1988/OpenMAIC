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
