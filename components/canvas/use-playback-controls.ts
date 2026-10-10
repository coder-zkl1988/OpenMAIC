'use client';

import { useCallback } from 'react';
import { useSettingsStore, PLAYBACK_SPEEDS } from '@/lib/store/settings';
import { useModelCapabilities } from '@/lib/model-settings/use-model-settings';
import type { EngineMode } from '@/lib/playback';

/** Which session the stop control ends */
export type StopKind = 'qa' | 'discussion';

/**
 * The one stop-control rule: shown while the engine is live or a Q&A /
 * discussion session is open. The session type is only cleared by the session
 * cleanup, so the control stays put through brief gaps (between the user's
 * message and the agent's first SSE event, or between agent-loop turns).
 */
export function getStopControl({
  engineMode,
  sessionType,
}: {
  engineMode: EngineMode;
  sessionType?: string | null;
}): { show: boolean; kind: StopKind } {
  return {
    show: engineMode === 'live' || sessionType === 'qa' || sessionType === 'discussion',
    kind: sessionType === 'qa' ? 'qa' : 'discussion',
  };
}

/** The speed after `speed` in PLAYBACK_SPEEDS, wrapping around (an unknown speed restarts) */
export function getNextPlaybackSpeed(speed: number): (typeof PLAYBACK_SPEEDS)[number] {
  const currentIndex = PLAYBACK_SPEEDS.indexOf(speed as (typeof PLAYBACK_SPEEDS)[number]);
  return PLAYBACK_SPEEDS[(currentIndex + 1) % PLAYBACK_SPEEDS.length];
}

export interface UsePlaybackControlsOptions {
  engineMode: EngineMode;
  sessionType?: string | null;
  /** A Q&A / discussion was soft-paused and waits to be resumed */
  isTopicPending?: boolean;
  /** Live SSE flow (Q&A / discussion) rather than the lecture */
  isInLiveFlow: boolean;
  /** The live answer's text reveal is paused */
  isLivePaused?: boolean;
  /** Whether the live answer may be paused now (not while thinking, not before text arrives) */
  canPauseLive: boolean;
  onResumeTopic?: () => void;
  onLivePause?: () => void;
  onLiveResume?: () => void;
  /** Lecture play/pause (the owner's handlePlayPause, which flushes a raised hand) */
  onPlayPause?: () => void;
}

/**
 * Playback chrome state and actions: volume, mute, speed, auto-play (settings
 * store), the stop control, and the primary play action.
 */
export function usePlaybackControls({
  engineMode,
  sessionType,
  isTopicPending,
  isInLiveFlow,
  isLivePaused,
  canPauseLive,
  onResumeTopic,
  onLivePause,
  onLiveResume,
  onPlayPause,
}: UsePlaybackControlsOptions) {
  const ttsMuted = useSettingsStore((s) => s.ttsMuted);
  const setTTSMuted = useSettingsStore((s) => s.setTTSMuted);
  const ttsVolume = useSettingsStore((s) => s.ttsVolume);
  const setTTSVolume = useSettingsStore((s) => s.setTTSVolume);
  const autoPlayLecture = useSettingsStore((s) => s.autoPlayLecture);
  const setAutoPlayLecture = useSettingsStore((s) => s.setAutoPlayLecture);
  const playbackSpeed = useSettingsStore((s) => s.playbackSpeed);
  const setPlaybackSpeed = useSettingsStore((s) => s.setPlaybackSpeed);
  // The workspace's tts slot decides whether narration is available at all
  const ttsEnabled = !!useModelCapabilities().tts;

  const toggleMute = useCallback(() => {
    // Without narration there is nothing to mute
    if (ttsEnabled) setTTSMuted(!ttsMuted);
  }, [setTTSMuted, ttsEnabled, ttsMuted]);

  const toggleAutoPlay = useCallback(
    () => setAutoPlayLecture(!autoPlayLecture),
    [autoPlayLecture, setAutoPlayLecture],
  );

  const cycleSpeed = useCallback(
    () => setPlaybackSpeed(getNextPlaybackSpeed(playbackSpeed)),
    [playbackSpeed, setPlaybackSpeed],
  );

  /** Live answer: buffer-level pause/resume (the text reveal freezes, SSE continues) */
  const toggleLivePause = useCallback(() => {
    if (isLivePaused) {
      onLiveResume?.();
    } else if (canPauseLive) {
      onLivePause?.();
    }
  }, [canPauseLive, isLivePaused, onLivePause, onLiveResume]);

  /**
   * The primary play action: resume a pending topic, else pause/resume the
   * live answer, else play/pause the lecture.
   */
  const primaryAction = useCallback(() => {
    if (isTopicPending) {
      onResumeTopic?.();
      return;
    }
    if (isInLiveFlow) {
      toggleLivePause();
      return;
    }
    onPlayPause?.();
  }, [isInLiveFlow, isTopicPending, onPlayPause, onResumeTopic, toggleLivePause]);

  const stop = getStopControl({ engineMode, sessionType });

  return {
    ttsEnabled,
    ttsMuted,
    toggleMute,
    ttsVolume,
    setTTSVolume,
    autoPlayLecture,
    toggleAutoPlay,
    playbackSpeed,
    cycleSpeed,
    showStop: stop.show,
    stopKind: stop.kind,
    toggleLivePause,
    primaryAction,
  };
}
