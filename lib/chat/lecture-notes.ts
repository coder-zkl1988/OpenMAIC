import type { DiscussionAction } from '@/lib/types/action';
import type { LectureNoteEntry, LectureNoteItem } from '@/lib/types/chat';
import type { Scene } from '@/lib/types/stage';
import type { DiscussionOutcome } from '@/lib/playback/types';
import type { LectureMomentRecord } from '@/lib/chat/class-presence';

const LECTURE_NOTE_ACTION_TYPES = new Set([
  'speech',
  'spotlight',
  'laser',
  'play_video',
  'discussion',
  'widget_highlight',
  'widget_setState',
  'widget_annotation',
  'widget_reveal',
]);

export function buildLectureNotes(scenes: readonly Scene[]): LectureNoteEntry[] {
  return scenes
    .filter((scene) => scene.actions && scene.actions.length > 0)
    .map((scene) => ({
      sceneId: scene.id,
      sceneTitle: scene.title,
      sceneOrder: scene.order,
      items: scene
        .actions!.map((action, actionIndex): LectureNoteItem | null => {
          if (!LECTURE_NOTE_ACTION_TYPES.has(action.type)) return null;
          const base = {
            actionIndex,
            actionId: action.id,
            actionType: action.type,
          };
          if (action.type === 'speech') {
            return {
              ...base,
              kind: 'speech',
              text: action.text,
            };
          }
          return {
            ...base,
            kind: 'action',
            type: action.type,
            label: action.type === 'discussion' ? (action as DiscussionAction).topic : undefined,
          };
        })
        .filter((item): item is LectureNoteItem => item !== null),
      completedAt: scene.updatedAt || scene.createdAt || 0,
    }))
    .sort((a, b) => a.sceneOrder - b.sceneOrder);
}

/** A class moment as the notes show it: what was said, who opened it, how it ended */
export interface LectureNoteMoment {
  sceneId: string;
  actionId: string;
  /** The opener's words, as the card showed them */
  topic: string;
  prompt?: string;
  /**
   * The opener: the one the moment was actually given to (its badge), else
   * the action's own; absent for a legacy moment, which is the teacher's
   */
  agentId?: string;
  /** How it ended for the learner; absent while it has not come up */
  outcome?: DiscussionOutcome;
}

/**
 * The class moments of the course by action id, each with its recorded
 * outcome (the lecture bubbles' badges, see collectLectureMoments).
 */
export function buildLectureNoteMoments(
  scenes: readonly Scene[],
  recorded: readonly LectureMomentRecord[],
): Map<string, LectureNoteMoment> {
  const outcomes = new Map(recorded.map((moment) => [moment.discussionActionId, moment]));
  const moments = new Map<string, LectureNoteMoment>();
  for (const scene of scenes) {
    for (const action of scene.actions ?? []) {
      if (action.type !== 'discussion') continue;
      const discussion = action as DiscussionAction;
      const record = outcomes.get(discussion.id);
      const agentId = record?.agentId ?? discussion.agentId;
      moments.set(discussion.id, {
        sceneId: scene.id,
        actionId: discussion.id,
        topic: discussion.topic,
        ...(discussion.prompt ? { prompt: discussion.prompt } : {}),
        ...(agentId ? { agentId } : {}),
        ...(record ? { outcome: record.outcome } : {}),
      });
    }
  }
  return moments;
}

/** A moment the learner let pass (skipped, or its card ran out): it can still be talked over */
export function isMissedMoment(outcome: DiscussionOutcome | undefined): boolean {
  return outcome === 'skipped' || outcome === 'auto_skipped';
}
