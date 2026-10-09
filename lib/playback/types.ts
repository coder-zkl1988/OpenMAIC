/**
 * Playback Types - Types for lecture playback and live discussion engine
 */

export interface PlaybackSnapshot {
  sceneIndex: number;
  actionIndex: number;
  consumedDiscussions: string[];
  sceneId?: string;
}

/** Visual effects (for onEffectFire callback) */
export type Effect =
  | { kind: 'spotlight'; targetId: string; dimOpacity?: number }
  | { kind: 'laser'; targetId: string; color?: string };

/** Engine mode state machine */
export type EngineMode = 'idle' | 'playing' | 'paused' | 'live';

/** Discussion topic state */
export type TopicState = 'active' | 'pending' | 'closed';

/** Trigger event (for proactive discussion card) */
export interface TriggerEvent {
  id: string;
  question: string;
  prompt?: string;
  agentId?: string;
}

/**
 * A text-less raised hand: 'raised' waits for the next action boundary,
 * 'called' means the engine stopped and handed the floor to the learner.
 */
export type HandState = 'raised' | 'called';

/** Why and where a raised hand was called (onHandCalled) */
export interface HandCall {
  /**
   * The previous action finished naturally, so a question asked now resumes
   * the lecture at the next action instead of replaying a cut-off line.
   */
  atBoundary: boolean;
  /**
   * The discussion the hand jumped ahead of: its card was withdrawn without
   * being consumed and is offered again once the learner is done. The engine
   * re-offers this same object, so when it has no agentId yet (the card's delay
   * was still running) the handler may pick one and write it here; the card
   * offered later then names the same agent.
   */
  deferredDiscussion?: TriggerEvent;
}

/** Playback engine callbacks */
export interface PlaybackEngineCallbacks {
  onModeChange?: (mode: EngineMode) => void;
  onSceneChange?: (sceneId: string) => void;
  onSpeechStart?: (text: string) => void;
  onSpeechEnd?: () => void;
  onTextDelta?: (content: string) => void;
  onSpeakerChange?: (role: string) => void;
  onEffectFire?: (effect: Effect) => void;

  // Proactive discussion
  onProactiveShow?: (trigger: TriggerEvent) => void;
  onProactiveHide?: () => void;

  // Discussion lifecycle
  onDiscussionConfirmed?: (topic: string, prompt?: string, agentId?: string) => void;
  onDiscussionEnd?: () => void;
  onUserInterrupt?: (text: string) => void;
  /**
   * A raised hand got the floor: the engine is paused (or stays idle) until
   * the learner speaks (handleUserInterrupt) or lowers the hand (lowerHand).
   */
  onHandCalled?: (call: HandCall) => void;

  // Topic / Transcript
  onTopicStart?: (type: 'lecture' | 'discussion', title: string) => void;
  onTopicAppend?: (role: string, text: string) => void;
  onTopicEnd?: () => void;

  /**
   * Progress tracking (for persistence). `atBoundary`: the snapshot points at
   * an action that has not started while the previous one finished naturally
   * (a raised hand answered between actions), so resume exactly there,
   * whatever its type.
   */
  onProgress?: (snapshot: PlaybackSnapshot, progress?: { atBoundary?: boolean }) => void;

  /** Check if a given agent is in the user's selected list (for skipping discussion actions) */
  isAgentSelected?: (agentId: string) => boolean;

  /** Get current playback speed multiplier (e.g. 1, 1.5, 2) */
  getPlaybackSpeed?: () => number;

  onComplete?: () => void;
}
