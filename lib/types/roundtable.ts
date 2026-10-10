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
  agentId?: string; // Agent ID to initiate discussion (default: 'default-1')
}
