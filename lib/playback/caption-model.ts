/**
 * Caption model — who is speaking now, what they say and what the classroom
 * is doing, derived from the PlaybackView plus the local "you just asked"
 * overlay. One pure function feeds every surface that shows the current line
 * (the caption strip, the presentation overlay).
 */

import {
  DEFAULT_STUDENT_AVATAR,
  DEFAULT_TEACHER_AVATAR,
  DEFAULT_USER_AVATAR,
} from '@/lib/constants/avatar-fallbacks';
import type { Participant } from '@/lib/types/roundtable';
import type { PlaybackView } from './derived-state';

export type CaptionRole = 'teacher' | 'agent' | 'user';

/** What the classroom is doing, as a caption status chip would say it */
export type CaptionStatus =
  | 'lecturing'
  | 'paused'
  | 'thinking'
  | 'answering'
  | 'discussion'
  | 'idle';

/** Fallback display names (already translated) */
export interface CaptionNames {
  teacher: string;
  student: string;
  user: string;
}

export interface CaptionModelInput {
  /** Centralised derived state (computePlaybackView); the fallbacks below cover its absence */
  playbackView?: PlaybackView;
  participants: readonly Participant[];
  speakingAgentId?: string | null;
  /** Live SSE speech (Q&A / discussion) */
  currentSpeech?: string | null;
  /** Active lecture line (PlaybackEngine) */
  lectureSpeech?: string | null;
  /** Static idle text (the first speech action) */
  idleText?: string | null;
  playbackCompleted?: boolean;
  isStreaming?: boolean;
  sessionType?: 'qa' | 'discussion';
  thinkingState?: { stage: string; agentId?: string } | null;
  isCueUser?: boolean;
  isTopicPending?: boolean;
  /** The live answer's text reveal is paused (Space / bubble click) */
  isLivePaused?: boolean;
  /** The question the user just sent, shown until the answer starts */
  userMessage?: string | null;
  names: CaptionNames;
  avatars?: {
    /** Overrides the user participant's avatar */
    user?: string;
    /** Used when the speaking agent has no avatar */
    agentFallback?: string;
  };
}

export interface CaptionModel {
  /** Stable per speaker, never per text, so a re-keyed bubble does not flicker */
  key: string;
  /** Who owns the caption (null: nobody, e.g. waiting for the learner) */
  role: CaptionRole | null;
  /** Who is speaking (avatar highlight) */
  activeRole: CaptionRole | null;
  name: string;
  avatar: string;
  text: string;
  status: CaptionStatus;
  /** A speaker was announced but no text has arrived yet */
  isLoading: boolean;
  /** Same, for a student agent */
  isAgentLoading: boolean;
  topicPending: boolean;
  isInLiveFlow: boolean;
  speakingStudent: Participant | null;
  /** The PlaybackView with the user overlay and the fallbacks applied */
  view: PlaybackView;
}

function findSpeakingStudent(
  participants: readonly Participant[],
  speakingAgentId: string | null | undefined,
): Participant | null {
  if (!speakingAgentId) return null;
  return (
    participants.find(
      (participant) =>
        participant.id === speakingAgentId &&
        participant.role !== 'teacher' &&
        participant.role !== 'user',
    ) ?? null
  );
}

function getCaptionStatus(
  view: PlaybackView,
  {
    currentSpeech,
    speakingAgentId,
    thinkingState,
    sessionType,
    isLivePaused,
  }: Pick<
    CaptionModelInput,
    'currentSpeech' | 'speakingAgentId' | 'thinkingState' | 'sessionType' | 'isLivePaused'
  >,
): CaptionStatus {
  switch (view.phase) {
    case 'lecturePlaying':
      return 'lecturing';
    case 'lecturePaused':
    case 'discussionPaused':
    case 'cueUser':
      return 'paused';
    case 'discussionActive':
      if (isLivePaused) return 'paused';
      // Waiting for the first words of the answer
      if (!currentSpeech && (thinkingState || speakingAgentId)) return 'thinking';
      return sessionType === 'discussion' ? 'discussion' : 'answering';
    default:
      return 'idle';
  }
}

/**
 * Describe a resolved view: the speaker's name and avatar and a stable key.
 * The presentation overlay calls this directly on a view the caption model
 * already resolved.
 */
export function describeCaptionSpeaker(
  role: CaptionRole | null,
  {
    participants,
    speakingAgentId,
    names,
    avatars,
  }: Pick<CaptionModelInput, 'participants' | 'speakingAgentId' | 'names' | 'avatars'>,
): Pick<CaptionModel, 'key' | 'name' | 'avatar'> {
  if (role === 'teacher') {
    const teacher = participants.find((participant) => participant.role === 'teacher');
    return {
      key: 'teacher',
      name: teacher?.name || names.teacher,
      avatar: teacher?.avatar || DEFAULT_TEACHER_AVATAR,
    };
  }
  if (role === 'user') {
    const user = participants.find((participant) => participant.role === 'user');
    return {
      key: 'user',
      name: user?.name || names.user,
      avatar: avatars?.user || user?.avatar || DEFAULT_USER_AVATAR,
    };
  }
  if (role === 'agent') {
    const student = findSpeakingStudent(participants, speakingAgentId);
    return {
      key: `agent-${speakingAgentId || 'unknown'}`,
      name: student?.name || names.student,
      avatar: student?.avatar || avatars?.agentFallback || DEFAULT_STUDENT_AVATAR,
    };
  }
  return { key: 'idle', name: '', avatar: '' };
}

export function buildCaptionModel(input: CaptionModelInput): CaptionModel {
  const {
    playbackView,
    participants,
    speakingAgentId,
    currentSpeech,
    lectureSpeech,
    idleText,
    playbackCompleted,
    isStreaming,
    sessionType,
    thinkingState,
    isCueUser,
    isTopicPending,
    userMessage,
  } = input;

  const speakingStudent = findSpeakingStudent(participants, speakingAgentId);

  const isInLiveFlow =
    playbackView?.isInLiveFlow ??
    !!(speakingAgentId || thinkingState || isStreaming || sessionType);

  // Role-aware source text: the user overlay on top of the playback view
  const text = userMessage
    ? userMessage
    : (playbackView?.sourceText ??
      (currentSpeech
        ? currentSpeech
        : isInLiveFlow
          ? ''
          : lectureSpeech || (playbackCompleted ? '' : idleText) || ''));

  // A speaker was announced (agent_start) but no text has arrived yet
  const isLoading = !!(speakingAgentId && !currentSpeech && !userMessage);
  const isAgentLoading = !!(speakingStudent && !currentSpeech && !userMessage);

  // A null role in the view still falls through to the local derivation
  const activeRole: CaptionRole | null = userMessage
    ? 'user'
    : (playbackView?.activeRole ??
      (currentSpeech && speakingStudent
        ? 'agent'
        : currentSpeech
          ? 'teacher'
          : isAgentLoading
            ? 'agent'
            : isLoading
              ? 'teacher'
              : isCueUser
                ? null
                : lectureSpeech
                  ? 'teacher'
                  : null));

  const role: CaptionRole | null = userMessage
    ? 'user'
    : (playbackView?.bubbleRole ??
      (currentSpeech && speakingStudent
        ? 'agent'
        : currentSpeech
          ? 'teacher'
          : isAgentLoading
            ? 'agent'
            : isLoading
              ? 'teacher'
              : isInLiveFlow
                ? null
                : isCueUser
                  ? null
                  : lectureSpeech || idleText
                    ? 'teacher'
                    : null));

  const view: PlaybackView = playbackView
    ? {
        ...playbackView,
        bubbleRole: role,
        sourceText: text,
        activeRole: activeRole ?? playbackView.activeRole,
      }
    : {
        phase: 'idle',
        sourceText: text,
        bubbleRole: role,
        activeRole,
        buttonState: 'none',
        isInLiveFlow: false,
        isTopicActive: false,
      };

  return {
    ...describeCaptionSpeaker(role, input),
    role,
    activeRole,
    text,
    status: getCaptionStatus(view, input),
    isLoading,
    isAgentLoading,
    topicPending: !!isTopicPending,
    isInLiveFlow,
    speakingStudent,
    view,
  };
}
