/**
 * Playback Engine - Unified state machine for lecture playback and live discussion
 *
 * Consumes Scene.actions[] directly via ActionEngine.
 * No intermediate compile step — actions are executed as-is.
 *
 * State machine:
 *
 *                  start()                  pause()
 *   idle ──────────────────→ playing ──────────────→ paused
 *     ▲                         ▲                       │
 *     │                         │  resume()             │
 *     │                         └───────────────────────┘
 *     │
 *     │  handleEndDiscussion()
 *     │                         confirmDiscussion()
 *     │                         / handleUserInterrupt()
 *     │                              │
 *     │                              ▼         pause()
 *     └──────────────────────── live ──────────────→ paused
 *                                 ▲                    │
 *                                 │ resume / user msg  │
 *                                 └────────────────────┘
 *
 * A question sent while playing can wait for the current action to finish
 * (queueUserInterrupt — a "raised hand"); processNext then delivers it at the
 * next action boundary, entering live mode just like handleUserInterrupt.
 *
 * A hand can also go up without a question (raiseHand). At the boundary the
 * engine pauses and calls the learner (onHandCalled) instead of entering live
 * mode; the learner then speaks (handleUserInterrupt, resuming at the next
 * action afterwards) or lowers the hand (lowerHand, which resumes at once).
 */

import type { Scene } from '@/lib/types/stage';
import type { Action, SpeechAction, DiscussionAction } from '@/lib/types/action';
import type {
  EngineMode,
  TopicState,
  PlaybackEngineCallbacks,
  PlaybackSnapshot,
  TriggerEvent,
  Effect,
  HandState,
} from './types';
import type { AudioPlayer } from '@/lib/utils/audio-player';
import type { LegacySpeechAction } from '@/lib/types/action';
import { ActionEngine } from '@/lib/action/engine';
import {
  resolvePlaybackCursor,
  estimateSpeechDurationMs,
  DISCUSSION_TRIGGER_DELAY_MS,
} from '@/lib/choreography';
import {
  canJumpWithinReconstructablePrefix,
  getSpeechVisualCueStartIndex,
  isWhiteboardPlaybackAction,
} from '@/lib/playback/action-navigation';
import { useCanvasStore } from '@/lib/store/canvas';
import { useSettingsStore } from '@/lib/store/settings';
import { ttsSelection } from '@/lib/audio/tts-selection';
import { detectSpeechLang } from '@/lib/audio/browser-tts-preview';
import { createLogger } from '@/lib/logger';

const log = createLogger('PlaybackEngine');

/** What waits for the next action boundary: a question, or a bare hand */
type QueuedInterrupt = { kind: 'question'; text: string } | { kind: 'hand' };

/**
 * Where a called hand stopped the lecture: 'boundary' after an action
 * finished (nothing to replay), 'paused' with a line possibly cut off (it
 * replays, as for any interrupt from pause), 'idle' with no lecture running.
 */
type HandCallPosition = 'boundary' | 'paused' | 'idle';

export class PlaybackEngine {
  private scenes: Scene[] = [];
  private sceneIndex: number = 0;
  private actionIndex: number = 0;
  private mode: EngineMode = 'idle';
  private consumedDiscussions: Set<string> = new Set();

  // Discussion state save
  private savedSceneIndex: number | null = null;
  private savedActionIndex: number | null = null;
  // The lecture played its last action but a raised hand answered at the final
  // boundary preempted its completion (onComplete), which continuePlayback
  // runs. Outlives the Q&A's restore; cleared once it runs or the cursor moves.
  private lectureCompletionPending: boolean = false;

  // Discussion topic state
  private currentTopicState: TopicState | null = null;

  // Dependencies
  private audioPlayer: AudioPlayer;
  private actionEngine: ActionEngine;
  private callbacks: PlaybackEngineCallbacks;

  // Scene identity (for snapshot validation)
  private sceneId: string | undefined;

  // Internal state
  private currentTrigger: TriggerEvent | null = null;
  private triggerDelayTimer: ReturnType<typeof setTimeout> | null = null;
  // Reading-time timer for speech actions without pre-generated audio (TTS disabled)
  private speechTimer: ReturnType<typeof setTimeout> | null = null;
  private speechTimerStart: number = 0; // Date.now() when timer was scheduled
  // Browser-native TTS state (Web Speech API)
  private browserTTSActive: boolean = false;
  private browserTTSChunks: string[] = []; // sentence-level chunks for sequential playback
  private browserTTSChunkIndex: number = 0; // current chunk being spoken
  private browserTTSPausedChunks: string[] = []; // remaining chunks saved on pause (for cancel+re-speak)
  private speechTimerRemaining: number = 0; // remaining ms (set on pause)
  private speechTimerTotal: number = 0; // full reading time of the line (for progress)
  private browserTTSTotalChunks: number = 0; // chunk count of the whole line (for progress)
  // What voices the line in flight once its play() settles: pre-generated
  // audio, browser TTS or the reading timer. The audio element outlives a
  // finished line, so hasActiveAudio() alone can't tell whose it is.
  private speechSource: 'audio' | 'tts' | 'timer' | null = null;
  private playbackGeneration: number = 0;
  // Keep the cursor on speech for progress/persistence; defer its cues until playback starts.
  private pendingNavigationSpeechIndex: number | null = null;
  // Question or bare hand raised mid-line; delivered at the next action boundary
  private queued: QueuedInterrupt | null = null;
  // A raised hand that has been called: the learner holds the floor
  private handCall: HandCallPosition | null = null;
  // The discussion a raised hand jumped ahead of. Kept so the card offered
  // again is the same trigger (and agent) onHandCalled announced.
  private deferredTrigger: TriggerEvent | null = null;

  constructor(
    scenes: Scene[],
    actionEngine: ActionEngine,
    audioPlayer: AudioPlayer,
    callbacks: PlaybackEngineCallbacks = {},
  ) {
    this.scenes = scenes;
    this.sceneId = scenes[0]?.id;
    this.actionEngine = actionEngine;
    this.audioPlayer = audioPlayer;
    this.callbacks = callbacks;
  }

  // ==================== Public API ====================

  /** Get the current engine mode */
  getMode(): EngineMode {
    return this.mode;
  }

  /**
   * Whether the current session interrupted an active lecture.
   * True while a saved lecture position exists (set by handleUserInterrupt,
   * cleared by restoreSavedLectureState). Must be read BEFORE cleanup runs.
   */
  hasLectureInterruption(): boolean {
    return this.savedSceneIndex !== null;
  }

  /**
   * Whether the lecture already played its last action — a raised hand
   * answered at the final boundary — so resuming it only runs the completion
   * branch. Unlike hasLectureInterruption it still holds after the Q&A ends
   * (an exhausted cursor then means "Play completes", not "Play restarts").
   */
  hasPendingLectureCompletion(): boolean {
    return this.lectureCompletionPending;
  }

  /**
   * Raise a hand while the lecture plays: hold the question until the current
   * action finishes, then deliver it through onUserInterrupt and resume at the
   * next action afterwards. Returns false when the question should be sent
   * right away instead (handleUserInterrupt): not playing, or waiting on a
   * discussion trigger rather than in a line. One question waits at a time; a
   * second one is refused (check hasQueuedInterrupt first; a bare hand takes
   * its question through attachQuestion).
   */
  queueUserInterrupt(text: string): boolean {
    if (this.mode !== 'playing') return false;
    if (this.isDiscussionTriggerPending()) return false;
    if (this.queued !== null) {
      log.warn('queueUserInterrupt called while a question is already queued');
      return false;
    }
    this.queued = { kind: 'question', text };
    return true;
  }

  /**
   * Raise a hand without a question. While the lecture plays the hand waits
   * for the current action to finish; the engine then pauses and calls the
   * learner (onHandCalled). Paused or idle, the learner is called at once. A
   * hand outranks a discussion about to be offered: its card is withdrawn
   * unconsumed and offered again after the learner is done. Returns false
   * when no hand can go up: in a live Q&A (the learner talks directly), while
   * something already waits, or once the learner holds the floor.
   */
  raiseHand(): boolean {
    if (this.handCall !== null) return false;
    if (this.mode === 'live') return false;
    if (this.mode === 'paused' && this.currentTopicState === 'pending') return false;

    if (this.isDiscussionTriggerPending()) {
      this.callHandBeforeDiscussion();
      return true;
    }
    if (this.mode === 'playing') {
      if (this.queued !== null) return false;
      this.queued = { kind: 'hand' };
      return true;
    }
    // Paused or idle: nothing to wait for. A question already waiting through
    // a pause keeps its turn (it is delivered on resume or flush).
    if (this.queued?.kind === 'question') return false;
    this.queued = null;
    this.callHand(this.mode === 'paused' ? 'paused' : 'idle');
    return true;
  }

  /**
   * The learner typed while the hand waits: the hand becomes a queued
   * question, delivered at the same boundary. False when no bare hand waits.
   */
  attachQuestion(text: string): boolean {
    if (this.queued?.kind !== 'hand') return false;
    this.queued = { kind: 'question', text };
    return true;
  }

  /**
   * Lower a bare hand. A waiting hand is withdrawn and the lecture plays on;
   * a called hand gives the floor back and the paused lecture resumes at
   * once. False when no hand was up.
   */
  lowerHand(): boolean {
    if (this.queued?.kind === 'hand') {
      this.queued = null;
      return true;
    }
    if (this.handCall === null) return false;
    const position = this.handCall;
    this.handCall = null;
    if (position !== 'idle' && this.mode === 'paused') this.resume();
    return true;
  }

  /** Where the bare hand stands: waiting, called, or null (no hand up) */
  getHandState(): HandState | null {
    if (this.handCall !== null) return 'called';
    if (this.queued?.kind === 'hand') return 'raised';
    return null;
  }

  /**
   * How far the line in flight has been spoken, 0..1 (audio position, reading
   * timer, or browser-TTS chunk). Null when no spoken line is in flight.
   */
  getSpeechProgress(): number | null {
    if (this.mode !== 'playing' && this.mode !== 'paused') return null;
    if (this.mode === 'paused' && (this.currentTopicState === 'pending' || this.handCall)) {
      return null;
    }
    const action = this.scenes[this.sceneIndex]?.actions?.[this.actionIndex - 1];
    if (action?.type !== 'speech' || !action.text.trim()) return null;

    const clamp = (value: number) => Math.min(1, Math.max(0, value));
    switch (this.speechSource) {
      case 'tts': {
        if (!this.browserTTSActive || this.browserTTSTotalChunks === 0) return 0;
        // A resumed line re-speaks only the remaining chunks, so count from the end
        const remaining = this.browserTTSChunks.length - this.browserTTSChunkIndex;
        return clamp(1 - remaining / this.browserTTSTotalChunks);
      }
      case 'audio': {
        if (!this.audioPlayer.hasActiveAudio()) return 0;
        const duration = this.audioPlayer.getDuration();
        return duration > 0 ? clamp(this.audioPlayer.getCurrentTime() / duration) : 0;
      }
      case 'timer': {
        if (this.speechTimerTotal <= 0) return 0;
        const remaining =
          this.speechTimer !== null
            ? this.speechTimerRemaining - (Date.now() - this.speechTimerStart)
            : this.speechTimerRemaining;
        return clamp(1 - remaining / this.speechTimerTotal);
      }
      default:
        // The line started but its audio, voice or timer is not running yet
        return 0;
    }
  }

  /** Whether a raised-hand question or bare hand is waiting for the next action boundary */
  hasQueuedInterrupt(): boolean {
    return this.queued !== null;
  }

  /**
   * Whether the action now playing is a spoken line: a raised hand then waits
   * for "this sentence" rather than another step (a video, a drawing, a widget,
   * a blank slide's dwell). processNext advances the cursor as an action
   * starts, so the one in flight sits just before it.
   */
  isSpeechInFlight(): boolean {
    if (this.mode !== 'playing') return false;
    const action = this.scenes[this.sceneIndex]?.actions?.[this.actionIndex - 1];
    return action?.type === 'speech' && !!action.text.trim();
  }

  /**
   * Drop the waiting question (or bare hand); returns the question's text
   * (null when none was queued, or only a hand was up)
   */
  cancelQueuedInterrupt(): string | null {
    const queued = this.queued;
    this.queued = null;
    return queued?.kind === 'question' ? queued.text : null;
  }

  /**
   * Deliver the waiting question now (e.g. the user pressed pause). The line is
   * cut off, so handleUserInterrupt replays it on resume. A bare hand is called
   * instead: the lecture pauses mid-line and the learner gets the floor.
   * Returns false when nothing was queued.
   */
  flushQueuedInterrupt(): boolean {
    const queued = this.queued;
    if (queued === null) return false;
    if (queued.kind === 'question') {
      this.handleUserInterrupt(queued.text);
      return true;
    }
    this.queued = null;
    if (this.mode === 'playing') {
      // Mark the call first: pause() announces the mode change
      this.handCall = 'paused';
      this.pause();
    }
    this.callHand(this.mode === 'paused' ? 'paused' : 'idle');
    return true;
  }

  /** Scene id at the current playback position (post-restore engine state) */
  getCurrentSceneId(): string | null {
    return this.scenes[this.sceneIndex]?.id ?? null;
  }

  /** Export a serializable playback snapshot */
  getSnapshot(): PlaybackSnapshot {
    return {
      sceneIndex: this.sceneIndex,
      actionIndex: this.actionIndex,
      consumedDiscussions: [...this.consumedDiscussions],
      sceneId: this.sceneId,
    };
  }

  /** Restore playback position from a snapshot */
  restoreFromSnapshot(snapshot: PlaybackSnapshot): void {
    this.pendingNavigationSpeechIndex = null;
    this.lectureCompletionPending = false;
    // A hand raised at the old position would be answered at the wrong one
    this.queued = null;
    this.handCall = null;
    this.deferredTrigger = null;
    this.sceneIndex = snapshot.sceneIndex;
    this.actionIndex = snapshot.actionIndex;
    this.consumedDiscussions = new Set(snapshot.consumedDiscussions);
  }

  /** idle → playing (from beginning) */
  start(): void {
    if (this.mode !== 'idle') {
      log.warn('Cannot start: not idle, current mode:', this.mode);
      return;
    }

    this.sceneIndex = 0;
    this.actionIndex = 0;
    this.pendingNavigationSpeechIndex = null;
    this.lectureCompletionPending = false;
    this.invalidatePlaybackGeneration();
    this.setMode('playing');
    this.processNext();
  }

  /** idle → playing (continue from current position, e.g. after discussion end) */
  continuePlayback(): void {
    if (this.mode !== 'idle') {
      log.warn('Cannot continue: not idle, current mode:', this.mode);
      return;
    }
    this.invalidatePlaybackGeneration();
    this.setMode('playing');
    this.processNext();
  }

  /**
   * Jumps target speech lines; `atBoundary` also accepts an action a raised
   * hand was answered just before (restoring that resume position).
   */
  canJumpToAction(actionIndex: number, options: { atBoundary?: boolean } = {}): boolean {
    const actions = this.scenes[0]?.actions ?? [];
    return (
      this.mode !== 'live' &&
      canJumpWithinReconstructablePrefix(actions, this.actionIndex, actionIndex, options)
    );
  }

  async jumpToAction(
    actionIndex: number,
    options: { autoplay?: boolean; atBoundary?: boolean } = {},
  ): Promise<boolean> {
    const actions = this.scenes[0]?.actions ?? [];
    if (!this.canJumpToAction(actionIndex, { atBoundary: options.atBoundary })) return false;

    const autoplay = options.autoplay ?? this.mode === 'playing';
    const generation = this.invalidatePlaybackGeneration();
    this.pendingNavigationSpeechIndex = null;
    this.cancelActivePlaybackWork();
    this.sceneIndex = 0;
    this.actionIndex = 0;
    this.savedSceneIndex = null;
    this.savedActionIndex = null;
    this.lectureCompletionPending = false;
    this.currentTopicState = null;
    this.currentTrigger = null;
    this.deferredTrigger = null;
    this.queued = null;
    this.handCall = null;
    this.actionEngine.resetPlaybackVisualState();

    for (let i = 0; i < actionIndex; i++) {
      if (!this.isCurrentGeneration(generation)) return false;
      const action = actions[i];
      if (isWhiteboardPlaybackAction(action)) {
        await this.actionEngine.execute(action, { silent: true });
      }
    }

    if (!this.isCurrentGeneration(generation)) return false;
    this.actionEngine.clearEffects();
    this.sceneIndex = 0;
    this.actionIndex = actionIndex;
    this.pendingNavigationSpeechIndex = actionIndex;
    this.callbacks.onProgress?.(this.getSnapshot());

    if (autoplay) {
      this.setMode('playing');
      this.processNext(generation);
    } else if (this.mode === 'playing' || this.mode === 'live') {
      this.setMode('paused');
    }

    return true;
  }

  /** playing → paused | live → paused (abort SSE, truncate, topic pending) */
  pause(): void {
    if (this.mode === 'playing') {
      this.invalidatePlaybackGeneration();
      // Cancel pending timers
      if (this.triggerDelayTimer) {
        clearTimeout(this.triggerDelayTimer);
        this.triggerDelayTimer = null;
      }
      if (this.speechTimer) {
        // Save remaining time so resume() can reschedule
        this.speechTimerRemaining = Math.max(
          0,
          this.speechTimerRemaining - (Date.now() - this.speechTimerStart),
        );
        clearTimeout(this.speechTimer);
        this.speechTimer = null;
      }
      this.setMode('paused');
      // Freeze TTS — but skip if waiting on ProactiveCard (no active speech)
      if (!this.currentTrigger) {
        if (this.browserTTSActive) {
          // Cancel+re-speak pattern: save remaining chunks for resume.
          // speechSynthesis.pause()/resume() is broken on Firefox, so we
          // cancel now and re-speak from current chunk onward on resume.
          this.browserTTSPausedChunks = this.browserTTSChunks.slice(this.browserTTSChunkIndex);
          window.speechSynthesis?.cancel();
          // Note: cancel fires onerror('canceled'), which we ignore (see playBrowserTTSChunk)
        } else if (this.audioPlayer.isPlaying()) {
          this.audioPlayer.pause();
        }
      }
    } else if (this.mode === 'live') {
      this.invalidatePlaybackGeneration();
      this.setMode('paused');
      this.currentTopicState = 'pending';
      // Caller is responsible for aborting SSE
    } else {
      log.warn('Cannot pause: mode is', this.mode);
    }
  }

  /** paused → playing (TTS resume) | paused (in discussion) → live */
  resume(): void {
    if (this.mode !== 'paused') {
      log.warn('Cannot resume: not paused, mode is', this.mode);
      return;
    }

    if (this.currentTopicState === 'pending') {
      // Resume discussion → live
      this.currentTopicState = 'active';
      this.setMode('live');
    } else if (this.currentTrigger) {
      // Waiting on ProactiveCard — just resume mode, don't touch audio
      this.setMode('playing');
    } else {
      // Resume lecture
      this.setMode('playing');
      if (this.browserTTSPausedChunks.length > 0) {
        // Browser TTS was paused via cancel — re-speak remaining chunks
        this.browserTTSActive = true;
        this.browserTTSChunks = this.browserTTSPausedChunks;
        this.browserTTSChunkIndex = 0;
        this.browserTTSPausedChunks = [];
        this.playBrowserTTSChunk(this.playbackGeneration);
      } else if (this.speechSource !== 'timer' && this.audioPlayer.hasActiveAudio()) {
        // Audio is paused — resume it; TTS onend will call processNext.
        // (A reading-timer line keeps the previous line's ended element.)
        const generation = this.playbackGeneration;
        this.audioPlayer.onEnded(() => {
          if (!this.isCurrentGeneration(generation)) return;
          this.callbacks.onSpeechEnd?.();
          if (this.mode === 'playing') {
            this.processNext(generation);
          }
        });
        this.audioPlayer.resume();
      } else if (this.speechTimerRemaining > 0) {
        // Reading timer was paused — reschedule with remaining time
        const generation = this.playbackGeneration;
        this.speechTimerStart = Date.now();
        this.speechTimer = setTimeout(() => {
          if (!this.isCurrentGeneration(generation)) return;
          this.speechTimer = null;
          this.speechTimerRemaining = 0;
          this.callbacks.onSpeechEnd?.();
          if (this.mode === 'playing') this.processNext(generation);
        }, this.speechTimerRemaining);
      } else {
        // TTS finished while paused, continue to next event
        this.processNext();
      }
    }
  }

  /** → idle */
  stop(): void {
    this.invalidatePlaybackGeneration();
    this.pendingNavigationSpeechIndex = null;
    // Set mode BEFORE stopping audio to prevent spurious processNext from
    // synchronous onend callbacks (see handleUserInterrupt for details).
    this.setMode('idle');
    this.audioPlayer.stop();
    this.cancelBrowserTTS();
    this.actionEngine.clearEffects();
    if (this.triggerDelayTimer) {
      clearTimeout(this.triggerDelayTimer);
      this.triggerDelayTimer = null;
    }
    if (this.speechTimer) {
      clearTimeout(this.speechTimer);
      this.speechTimer = null;
    }
    this.speechTimerRemaining = 0;
    this.speechSource = null;
    this.sceneIndex = 0;
    this.actionIndex = 0;
    this.savedSceneIndex = null;
    this.savedActionIndex = null;
    this.lectureCompletionPending = false;
    this.currentTopicState = null;
    this.currentTrigger = null;
    this.deferredTrigger = null;
    this.queued = null;
    this.handCall = null;
  }

  /**
   * Consume a discussion and immediately publish a progress snapshot.
   * `onProgress` otherwise fires before a discussion action executes (the id
   * is not yet consumed) and a discussion is the scene's last action, so
   * without this emit the consumption fact would never reach persistence.
   */
  private markDiscussionConsumed(id: string): void {
    this.consumedDiscussions.add(id);
    this.callbacks.onProgress?.(this.getSnapshot());
  }

  /** User clicks "Join" on ProactiveCard → save cursor → live */
  confirmDiscussion(): void {
    if (!this.currentTrigger) {
      log.warn('confirmDiscussion called but no trigger');
      return;
    }
    this.invalidatePlaybackGeneration();

    // Mark consumed so it won't re-trigger on replay
    this.markDiscussionConsumed(this.currentTrigger.id);

    // Save lecture state — keep actionIndex as-is (past the discussion).
    // Discussions are placed after all speech actions, so the preceding
    // speech was already fully played; no need to replay it.
    this.savedSceneIndex = this.sceneIndex;
    this.savedActionIndex = this.actionIndex;

    // Enter live mode
    this.currentTopicState = 'active';
    this.setMode('live');

    // Notify callbacks
    this.callbacks.onProactiveHide?.();
    this.callbacks.onDiscussionConfirmed?.(
      this.currentTrigger.question,
      this.currentTrigger.prompt,
      this.currentTrigger.agentId,
    );
    this.currentTrigger = null;
  }

  /** User clicks "Skip" on ProactiveCard → consumed → processNext */
  skipDiscussion(): void {
    if (this.currentTrigger) {
      this.markDiscussionConsumed(this.currentTrigger.id);
      this.currentTrigger = null;
    }
    const generation = this.invalidatePlaybackGeneration();
    this.callbacks.onProactiveHide?.();

    if (this.mode === 'playing') {
      this.processNext(generation);
    }
  }

  /** End discussion → restore lecture → idle (user clicks "start" to continue) */
  handleEndDiscussion(): void {
    this.invalidatePlaybackGeneration();
    this.actionEngine.clearEffects();
    this.currentTopicState = 'closed';

    // Close whiteboard if it was open during the discussion
    useCanvasStore.getState().setWhiteboardOpen(false);

    // Restore the interrupted lecture cursor before notifying consumers. The
    // callback may inspect isExhausted() to decide whether playback completed.
    this.restoreSavedLectureState();

    this.callbacks.onDiscussionEnd?.();

    this.setMode('idle');
  }

  /**
   * Exit live discussion mode after a request failure without treating it as a
   * normal discussion end. The chat session stays retryable; this only restores
   * the playback engine to a coherent non-live state.
   */
  handleDiscussionError(): void {
    const hasSavedLectureState = this.savedSceneIndex !== null && this.savedActionIndex !== null;
    const isLiveTopic =
      this.mode === 'live' || (this.mode === 'paused' && this.currentTopicState === 'pending');

    if (!isLiveTopic && !hasSavedLectureState) {
      return;
    }

    this.invalidatePlaybackGeneration();
    this.actionEngine.clearEffects();
    useCanvasStore.getState().setWhiteboardOpen(false);
    this.currentTopicState = 'closed';
    this.currentTrigger = null;
    this.restoreSavedLectureState();
    this.setMode('idle');
  }

  /** User sends a message during playback → interrupt → live mode */
  handleUserInterrupt(text: string): void {
    this.invalidatePlaybackGeneration();
    // A direct message supersedes a raised hand still waiting for its boundary
    this.queued = null;
    // A hand called at a boundary paused AFTER its action finished
    const calledAtBoundary = this.handCall === 'boundary';
    this.handCall = null;
    if (this.mode === 'playing' || this.mode === 'paused') {
      // Save lecture state BEFORE stopping audio — actionIndex was already
      // incremented by processNext, so subtract 1 to replay the interrupted
      // sentence when resuming.  Guard against overwriting a previously saved
      // position (e.g. live → paused → new message).
      if (this.savedSceneIndex === null) {
        this.savedSceneIndex = this.sceneIndex;
        if (calledAtBoundary) {
          // Nothing was cut off: resume at the next action, like a queued
          // question delivered at the same boundary
          this.savedActionIndex = this.actionIndex;
          this.lectureCompletionPending = this.isExhausted();
        } else {
          this.savedActionIndex = Math.max(0, this.actionIndex - 1);
          this.lectureCompletionPending = false;
        }
      }

      // Cancel pending trigger delay
      if (this.triggerDelayTimer) {
        clearTimeout(this.triggerDelayTimer);
        this.triggerDelayTimer = null;
      }
      // Hide a shown ProactiveCard WITHOUT consuming its discussion: the saved
      // cursor is the discussion itself, so it is offered again on resume (and
      // the card can't auto-skip or "Join" over the saved cursor mid-Q&A).
      if (this.currentTrigger) {
        this.currentTrigger = null;
        this.callbacks.onProactiveHide?.();
      }
    }

    // Set mode BEFORE stopping audio — speechSynthesis.cancel() may fire the
    // onend callback synchronously, and the processNext guard checks
    // `this.mode === 'playing'`.  Setting mode first prevents a spurious
    // processNext that would advance actionIndex past the interrupted speech.
    this.currentTopicState = 'active';
    this.setMode('live');
    this.audioPlayer.stop();
    this.cancelBrowserTTS();
    this.callbacks.onUserInterrupt?.(text);
  }

  /** Whether all remaining actions have been consumed (no speech left to play) */
  isExhausted(): boolean {
    let si = this.sceneIndex;
    let ai = this.actionIndex;
    while (si < this.scenes.length) {
      const actions = this.scenes[si].actions || [];
      while (ai < actions.length) {
        const action = actions[ai];
        // Consumed discussions don't count as remaining work
        if (action.type === 'discussion' && this.consumedDiscussions.has(action.id)) {
          ai++;
          continue;
        }
        return false;
      }
      si++;
      ai = 0;
    }
    return true;
  }

  // ==================== Private ====================

  private invalidatePlaybackGeneration(): number {
    this.playbackGeneration += 1;
    return this.playbackGeneration;
  }

  private isCurrentGeneration(generation: number): boolean {
    return generation === this.playbackGeneration;
  }

  private cancelActivePlaybackWork(): void {
    this.audioPlayer.stop();
    this.cancelBrowserTTS();
    this.actionEngine.clearEffects();
    useCanvasStore.getState().pauseVideo();

    if (this.triggerDelayTimer) {
      clearTimeout(this.triggerDelayTimer);
      this.triggerDelayTimer = null;
    }
    if (this.speechTimer) {
      clearTimeout(this.speechTimer);
      this.speechTimer = null;
    }
    this.speechTimerRemaining = 0;
    this.speechSource = null;
    this.callbacks.onProactiveHide?.();
  }

  private setMode(mode: EngineMode): void {
    // Playing on or entering a Q&A ends a called hand's turn, however it ends
    if (mode === 'playing' || mode === 'live') this.handCall = null;
    if (this.mode === mode) return;
    this.mode = mode;
    this.callbacks.onModeChange?.(mode);
  }

  private restoreSavedLectureState(): void {
    if (this.savedSceneIndex !== null && this.savedActionIndex !== null) {
      this.sceneIndex = this.savedSceneIndex;
      this.actionIndex = this.savedActionIndex;
    }
    this.savedSceneIndex = null;
    this.savedActionIndex = null;
  }

  /**
   * Deliver a raised-hand question at an action boundary. The previous action
   * finished naturally, so the lecture resumes at the NEXT action (unlike
   * handleUserInterrupt, which replays the line it cut off).
   */
  private deliverQueuedInterrupt(): void {
    const queued = this.queued;
    if (queued?.kind !== 'question') return;
    const text = queued.text;
    this.queued = null;
    this.invalidatePlaybackGeneration();

    if (this.savedSceneIndex === null) {
      this.savedSceneIndex = this.sceneIndex;
      this.savedActionIndex = this.actionIndex;
      this.lectureCompletionPending = this.isExhausted();
    }
    // Publish the boundary so the UI cursor and persisted progress already
    // point past the finished action while the question is answered. Flagged
    // so that a reload resumes at the next action whatever its type, rather
    // than replaying the last speech line (handleUserInterrupt publishes
    // nothing: the line it cuts off must replay).
    this.callbacks.onProgress?.(this.getSnapshot(), { atBoundary: true });

    // Mode BEFORE stopping audio, mirroring handleUserInterrupt (both are
    // no-ops at a boundary, but must never re-enter processNext).
    this.currentTopicState = 'active';
    this.setMode('live');
    this.audioPlayer.stop();
    this.cancelBrowserTTS();
    this.callbacks.onUserInterrupt?.(text);
  }

  /**
   * Call a bare raised hand at an action boundary. Same bookkeeping as
   * deliverQueuedInterrupt, but the engine pauses for the learner instead of
   * entering live mode: lowerHand resumes at the next action, a question sent
   * now (handleUserInterrupt) saves that next action as the resume point.
   */
  private deliverRaisedHand(): void {
    this.queued = null;
    this.invalidatePlaybackGeneration();
    this.callHandAtBoundary();
  }

  /**
   * A hand outranks the discussion about to be offered: withdraw its card (or
   * the delay before it) WITHOUT consuming it, step the cursor back onto the
   * discussion action and call the learner, so the discussion is offered again
   * when the lecture resumes — after a Q&A (the saved cursor) or a lowered hand.
   */
  private callHandBeforeDiscussion(): void {
    this.queued = null;
    this.invalidatePlaybackGeneration();
    if (this.triggerDelayTimer) {
      clearTimeout(this.triggerDelayTimer);
      this.triggerDelayTimer = null;
    }
    // processNext stepped past the discussion before scheduling its card
    this.actionIndex = Math.max(0, this.actionIndex - 1);
    const action = this.scenes[this.sceneIndex]?.actions?.[this.actionIndex];
    const deferred =
      this.currentTrigger ??
      (action?.type === 'discussion' ? this.toTrigger(action as DiscussionAction) : undefined);
    if (this.currentTrigger) {
      this.currentTrigger = null;
      this.callbacks.onProactiveHide?.();
    }
    // processNext re-offers this very object, so an agent picked for the
    // shown card (or written onto it by the onHandCalled handler) carries over
    this.deferredTrigger = deferred ?? null;
    this.callHandAtBoundary(deferred);
  }

  /**
   * The boundary bookkeeping of deliverQueuedInterrupt (completion owed,
   * flagged progress so a reload resumes at the next action), then the call.
   */
  private callHandAtBoundary(deferredDiscussion?: TriggerEvent): void {
    if (this.savedSceneIndex === null) {
      this.lectureCompletionPending = this.isExhausted();
    }
    this.callbacks.onProgress?.(this.getSnapshot(), { atBoundary: true });
    this.callHand('boundary', deferredDiscussion);
  }

  /**
   * Give a raised hand the floor. Set the mode BEFORE stopping audio (see
   * handleUserInterrupt): a synchronous onend must not re-enter processNext.
   * Stopping also drops a finished line's audio element, so a later resume()
   * moves on to the next action instead of restarting that line.
   */
  private callHand(position: HandCallPosition, deferredDiscussion?: TriggerEvent): void {
    this.handCall = position;
    if (position === 'boundary') {
      this.setMode('paused');
      this.audioPlayer.stop();
      this.cancelBrowserTTS();
    }
    this.callbacks.onHandCalled?.({
      atBoundary: position === 'boundary',
      ...(deferredDiscussion ? { deferredDiscussion } : {}),
    });
  }

  /** Waiting on a discussion: its card's delay is running, or the card shows */
  private isDiscussionTriggerPending(): boolean {
    return this.triggerDelayTimer !== null || this.currentTrigger !== null;
  }

  private toTrigger(action: DiscussionAction): TriggerEvent {
    return {
      id: action.id,
      question: action.topic,
      prompt: action.prompt,
      agentId: action.agentId,
    };
  }

  /**
   * Get the current action, or null if playback is complete.
   * Advances sceneIndex automatically when a scene's actions are exhausted.
   * A scene with no actions yields one synthetic dwell beat (so the slide still
   * shows) instead of being skipped — see {@link resolvePlaybackCursor}.
   */
  private getCurrentAction(): { action: Action; sceneId: string } | null {
    const res = resolvePlaybackCursor(this.scenes, this.sceneIndex, this.actionIndex);
    if (!res) return null;
    this.sceneIndex = res.sceneIndex;
    this.actionIndex = res.actionIndex;
    return { action: res.action, sceneId: res.sceneId };
  }

  private fireVisualCue(action: Extract<Action, { type: 'spotlight' | 'laser' }>): void {
    this.actionEngine.execute(action);
    this.callbacks.onEffectFire?.({
      kind: action.type,
      targetId: action.elementId,
      ...(action.type === 'spotlight'
        ? { dimOpacity: action.dimOpacity }
        : { color: action.color }),
    } as Effect);
  }

  /**
   * Core processing loop: consume the next action.
   */
  private async processNext(generation: number = this.playbackGeneration): Promise<void> {
    if (this.mode !== 'playing' || !this.isCurrentGeneration(generation)) return;

    // Every action boundary passes through here: answer a raised hand before
    // the next action (or the completion branch) starts.
    if (this.queued !== null) {
      if (this.queued.kind === 'hand') this.deliverRaisedHand();
      else this.deliverQueuedInterrupt();
      return;
    }

    // Check for scene boundary (fire scene change callback at start of each new scene)
    if (this.actionIndex === 0 && this.sceneIndex < this.scenes.length) {
      const scene = this.scenes[this.sceneIndex];
      this.actionEngine.clearEffects();
      this.callbacks.onSceneChange?.(scene.id);
      this.callbacks.onSpeakerChange?.('teacher');
    }

    const current = this.getCurrentAction();
    if (!current) {
      if (!this.isCurrentGeneration(generation)) return;
      // All scenes complete
      this.invalidatePlaybackGeneration();
      this.lectureCompletionPending = false;
      this.actionEngine.clearEffects();
      this.setMode('idle');
      this.callbacks.onComplete?.();
      return;
    }

    const { action } = current;

    const replayCues =
      this.sceneIndex === 0 && this.pendingNavigationSpeechIndex === this.actionIndex;
    this.pendingNavigationSpeechIndex = null;
    if (replayCues && action.type === 'speech') {
      const actions = this.scenes[0].actions ?? [];
      const targetIndex = this.actionIndex;
      for (let i = getSpeechVisualCueStartIndex(actions, targetIndex); i < targetIndex; i++) {
        if (this.mode !== 'playing' || !this.isCurrentGeneration(generation)) return;
        const cue = actions[i];
        if (cue.type === 'spotlight' || cue.type === 'laser') this.fireVisualCue(cue);
      }
      if (this.mode !== 'playing' || !this.isCurrentGeneration(generation)) return;
    }

    // Notify progress BEFORE advancing the cursor so the snapshot points at
    // the current action.  On restore the same action will be replayed — this
    // is the desired behaviour for speech (user may have only heard half).
    this.callbacks.onProgress?.(this.getSnapshot());

    this.actionIndex++;

    switch (action.type) {
      case 'speech': {
        const speechAction = action as SpeechAction;
        this.speechSource = null;
        this.callbacks.onSpeechStart?.(speechAction.text);

        // onEnded → processNext; if paused, resume() will call processNext
        this.audioPlayer.onEnded(() => {
          if (!this.isCurrentGeneration(generation)) return;
          this.callbacks.onSpeechEnd?.();
          if (this.mode === 'playing') {
            this.processNext(generation);
          }
        });

        // Estimated reading time when no pre-generated audio (TTS disabled).
        // The estimate (CJK vs word-based pace, 2s floor, speed-adjusted) lives
        // in @/lib/choreography so the video exporter dwells identically.
        // Cancelled on pause; resume() calls processNext directly.
        const scheduleReadingTimer = () => {
          if (!this.isCurrentGeneration(generation)) return;
          const speed = this.callbacks.getPlaybackSpeed?.() ?? 1;
          const readingMs = estimateSpeechDurationMs(speechAction.text, { speed });
          this.speechSource = 'timer';
          this.speechTimerStart = Date.now();
          this.speechTimerRemaining = readingMs;
          this.speechTimerTotal = readingMs;
          this.speechTimer = setTimeout(() => {
            if (!this.isCurrentGeneration(generation)) return;
            this.speechTimer = null;
            this.speechTimerRemaining = 0;
            this.callbacks.onSpeechEnd?.();
            if (this.mode === 'playing') this.processNext(generation);
          }, readingMs);
        };

        // A speech line with no text (e.g. a freshly inserted blank slide's
        // seeded clip, or one the user cleared) has nothing to synthesize —
        // route it straight to the reading timer for a short dwell. Speaking an
        // empty SpeechSynthesisUtterance doesn't reliably fire onend in Chromium,
        // which would hang playback on that slide.
        const hasText = !!speechAction.text.trim();

        this.audioPlayer
          // The legacy URL of an unconverted pair rides along as the
          // fallback of last resort; converted documents carry no audioUrl.
          .play(speechAction.audioId || '', (speechAction as LegacySpeechAction).audioUrl)
          .then((audioStarted) => {
            if (!this.isCurrentGeneration(generation)) return;
            if (audioStarted) {
              this.speechSource = 'audio';
            } else {
              // No pre-generated audio — try browser-native TTS only when it is
              // the selected provider AND actually enabled (opt-in, #665).
              if (
                hasText &&
                ttsSelection()?.providerId === 'browser-native-tts' &&
                typeof window !== 'undefined' &&
                window.speechSynthesis
              ) {
                this.playBrowserTTS(speechAction, generation);
              } else {
                scheduleReadingTimer();
              }
            }
          })
          .catch((err) => {
            if (!this.isCurrentGeneration(generation)) return;
            log.error('TTS error:', err);
            scheduleReadingTimer();
          });
        break;
      }

      case 'spotlight':
      case 'laser': {
        // Fire-and-forget visual effects via ActionEngine
        this.fireVisualCue(action);
        // Don't block — continue immediately (use queueMicrotask to avoid
        // stack overflow from deep synchronous recursion when many consecutive
        // spotlight/laser actions appear in sequence)
        queueMicrotask(() => {
          if (this.isCurrentGeneration(generation)) {
            this.processNext(generation);
          }
        });
        break;
      }

      case 'discussion': {
        const discussionAction = action as DiscussionAction;
        // Check if already consumed
        if (this.consumedDiscussions.has(discussionAction.id)) {
          this.processNext(generation);
          return;
        }
        // Skip if the discussion's agent isn't in the user's selected list
        if (
          discussionAction.agentId &&
          this.callbacks.isAgentSelected &&
          !this.callbacks.isAgentSelected(discussionAction.agentId)
        ) {
          this.markDiscussionConsumed(discussionAction.id);
          this.processNext(generation);
          return;
        }

        // 3s delay before showing ProactiveCard (allows previous speech to finish naturally).
        // A discussion a raised hand deferred comes back as the same trigger.
        const deferred = this.deferredTrigger;
        this.deferredTrigger = null;
        const trigger =
          deferred?.id === discussionAction.id ? deferred : this.toTrigger(discussionAction);

        this.triggerDelayTimer = setTimeout(() => {
          if (!this.isCurrentGeneration(generation)) return;
          this.triggerDelayTimer = null;
          if (this.mode !== 'playing') return; // Cancelled if user paused/stopped
          this.currentTrigger = trigger;
          this.callbacks.onProactiveShow?.(trigger);
          // Engine pauses here — user calls confirmDiscussion() or skipDiscussion()
        }, DISCUSSION_TRIGGER_DELAY_MS);
        break;
      }

      case 'play_video':
      case 'wb_open':
      case 'wb_draw_text':
      case 'wb_draw_shape':
      case 'wb_draw_chart':
      case 'wb_draw_latex':
      case 'wb_draw_table':
      case 'wb_draw_line':
      case 'wb_draw_code':
      case 'wb_edit_code':
      case 'wb_clear':
      case 'wb_delete':
      case 'wb_close':
      case 'widget_highlight':
      case 'widget_setState':
      case 'widget_annotation':
      case 'widget_reveal': {
        // Synchronous actions — await completion, then continue
        await this.actionEngine.execute(action);
        if (!this.isCurrentGeneration(generation)) return;
        if (this.mode === 'playing') {
          this.processNext(generation);
        }
        break;
      }

      default:
        // Unknown action, skip
        this.processNext(generation);
        break;
    }
  }

  // ==================== Browser Native TTS ====================

  /**
   * Split text into sentence-level chunks for sequential playback.
   * Chrome has a bug where utterances >~15s are silently cut off and onend
   * never fires, causing the engine to hang. Chunking avoids this.
   */
  private splitIntoChunks(text: string): string[] {
    // Split on sentence-ending punctuation (Latin + CJK) and newlines
    const chunks = text
      .split(/(?<=[.!?。！？\n])\s*/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (chunks.length > 0) return chunks;
    // Blank/whitespace text → no chunks (so playBrowserTTSChunk finishes cleanly
    // instead of speaking an empty utterance that never fires onend). Otherwise
    // the text had no sentence punctuation — speak it as one chunk.
    return text.trim() ? [text] : [];
  }

  /**
   * Play text using the Web Speech API (browser-native TTS).
   * Splits text into sentence-level chunks to avoid Chrome's ~15s cutoff.
   * Uses cancel+re-speak for pause/resume (Firefox compatibility).
   */
  private playBrowserTTS(speechAction: SpeechAction, generation: number): void {
    if (!this.isCurrentGeneration(generation)) return;
    this.browserTTSChunks = this.splitIntoChunks(speechAction.text);
    this.browserTTSTotalChunks = this.browserTTSChunks.length;
    this.browserTTSChunkIndex = 0;
    this.browserTTSPausedChunks = [];
    this.browserTTSActive = true;
    this.speechSource = 'tts';
    this.playBrowserTTSChunk(generation);
  }

  /** Speak the current chunk; on completion, advance to next or finish. */
  private async playBrowserTTSChunk(generation: number): Promise<void> {
    if (!this.isCurrentGeneration(generation)) return;
    if (this.browserTTSChunkIndex >= this.browserTTSChunks.length) {
      // All chunks done
      this.browserTTSActive = false;
      this.browserTTSChunks = [];
      this.callbacks.onSpeechEnd?.();
      if (this.mode === 'playing') this.processNext(generation);
      return;
    }

    const settings = useSettingsStore.getState();
    // The user's voice when it was picked for browser speech.
    const selectedVoice = ttsSelection()?.voice;
    const chunkText = this.browserTTSChunks[this.browserTTSChunkIndex];
    const utterance = new SpeechSynthesisUtterance(chunkText);

    // Apply settings
    const speed = this.callbacks.getPlaybackSpeed?.() ?? 1;
    utterance.rate = (settings.ttsSpeed ?? 1) * speed;
    utterance.volume = settings.ttsMuted ? 0 : (settings.ttsVolume ?? 1);

    // Ensure voices are loaded (Chrome loads them asynchronously)
    const voices = await this.ensureVoicesLoaded();
    if (!this.isCurrentGeneration(generation)) return;

    // Set voice: try user's configured voice, fall back to auto-detect language
    let voiceFound = false;
    if (selectedVoice && selectedVoice !== 'default') {
      const voice = voices.find((v) => v.voiceURI === selectedVoice);
      if (voice) {
        utterance.voice = voice;
        utterance.lang = voice.lang;
        voiceFound = true;
      }
    }
    if (!voiceFound) {
      // No usable voice configured — detect text language so the browser
      // auto-selects an appropriate voice. For Vietnamese additionally bind an
      // installed vi voice when one exists, since browsers otherwise fall back
      // to an English voice reading Vietnamese text.
      utterance.lang = detectSpeechLang(chunkText);
      if (utterance.lang === 'vi-VN') {
        const viVoice = voices.find((v) => v.lang?.toLowerCase().startsWith('vi'));
        if (viVoice) {
          utterance.voice = viVoice;
          utterance.lang = viVoice.lang;
        }
      }
    }

    utterance.onend = () => {
      if (!this.isCurrentGeneration(generation)) return;
      this.browserTTSChunkIndex++;
      if (this.mode === 'playing') {
        this.playBrowserTTSChunk(generation); // next chunk
      }
    };

    utterance.onerror = (event) => {
      if (!this.isCurrentGeneration(generation)) return;
      // 'canceled' is expected when stop/pause is called — not a real error
      if (event.error !== 'canceled') {
        log.warn('Browser TTS chunk error:', event.error);
        // Skip failed chunk, try next
        this.browserTTSChunkIndex++;
        if (this.mode === 'playing') {
          this.playBrowserTTSChunk(generation);
        }
      }
      // On 'canceled': do nothing — pause handler already saved state
    };

    // Chrome bug workaround: cancel() before speak() to clear stale synthesis
    // state that can produce garbled/broken audio output.
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
  }

  /**
   * Wait for speechSynthesis voices to load (Chrome loads them asynchronously).
   * Caches result so subsequent calls return immediately.
   */
  private cachedVoices: SpeechSynthesisVoice[] | null = null;
  private async ensureVoicesLoaded(): Promise<SpeechSynthesisVoice[]> {
    if (this.cachedVoices && this.cachedVoices.length > 0) {
      return this.cachedVoices;
    }

    let voices = window.speechSynthesis.getVoices();
    if (voices.length > 0) {
      this.cachedVoices = voices;
      return voices;
    }

    // Chrome: voices load asynchronously — wait for the voiceschanged event
    await new Promise<void>((resolve) => {
      const onVoicesChanged = () => {
        window.speechSynthesis.removeEventListener('voiceschanged', onVoicesChanged);
        resolve();
      };
      window.speechSynthesis.addEventListener('voiceschanged', onVoicesChanged);
      // Timeout after 2s to avoid hanging
      setTimeout(() => {
        window.speechSynthesis.removeEventListener('voiceschanged', onVoicesChanged);
        resolve();
      }, 2000);
    });

    voices = window.speechSynthesis.getVoices();
    this.cachedVoices = voices;
    return voices;
  }

  /** Cancel any active browser-native TTS */
  private cancelBrowserTTS(): void {
    if (this.browserTTSActive) {
      this.browserTTSActive = false;
      this.browserTTSChunks = [];
      this.browserTTSTotalChunks = 0;
      this.browserTTSChunkIndex = 0;
      this.browserTTSPausedChunks = [];
      window.speechSynthesis?.cancel();
    }
  }
}
