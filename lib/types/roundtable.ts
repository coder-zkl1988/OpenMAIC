import type { DiscussionMomentKind, LearnerStance } from '@/lib/types/chat';

export const USER_AVATAR = '/avatars/user.png';

export type ParticipantRole = 'teacher' | 'student' | 'user';

export interface Participant {
  id: string;
  name: string;
  role: ParticipantRole;
  avatar: string;
  isOnline: boolean;
  isSpeaking?: boolean;
}

export interface MessageAction {
  id: string;
  label: string;
  icon?: string;
  onClick: () => void;
}

export interface Message {
  id: string;
  senderId: string;
  senderRole: ParticipantRole;
  content: string;
  timestamp: number;
  actions?: MessageAction[];
}

/** A discussion the shell asks the chat layer to start */
export interface DiscussionRequest {
  topic: string;
  prompt?: string;
  /**
   * Who opens the moment. Absent: the classroom's teacher opens a lecture
   * moment, and the director picks the opener of a 'quiz-review'.
   */
  agentId?: string;
  /** The kind of class moment; absent means 'lecture' */
  momentKind?: DiscussionMomentKind;
  /** The learner's choice on a whole-class question ('ask-learner' only) */
  learnerStance?: LearnerStance;
}
