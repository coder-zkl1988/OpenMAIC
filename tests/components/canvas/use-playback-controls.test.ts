// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const settings = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  capabilities: { tts: {} as object | null },
}));
vi.mock('@/lib/store/settings', () => ({
  PLAYBACK_SPEEDS: [1, 1.25, 1.5, 2] as const,
  useSettingsStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector(settings.state),
}));
vi.mock('@/lib/model-settings/use-model-settings', () => ({
  useModelCapabilities: () => settings.capabilities,
}));

import {
  getNextPlaybackSpeed,
  getStopControl,
  usePlaybackControls,
  type UsePlaybackControlsOptions,
} from '@/components/canvas/use-playback-controls';

type Controls = ReturnType<typeof usePlaybackControls>;

describe('getStopControl', () => {
  it('shows the stop control for a Q&A, a discussion or a live engine', () => {
    expect(getStopControl({ engineMode: 'playing', sessionType: 'qa' })).toEqual({
      show: true,
      kind: 'qa',
    });
    expect(getStopControl({ engineMode: 'paused', sessionType: 'discussion' })).toEqual({
      show: true,
      kind: 'discussion',
    });
    expect(getStopControl({ engineMode: 'live', sessionType: null })).toEqual({
      show: true,
      kind: 'discussion',
    });
    expect(getStopControl({ engineMode: 'playing', sessionType: null }).show).toBe(false);
    expect(getStopControl({ engineMode: 'idle', sessionType: 'lecture' }).show).toBe(false);
  });
});

describe('getNextPlaybackSpeed', () => {
  it('cycles through the speeds and wraps around', () => {
    expect(getNextPlaybackSpeed(1)).toBe(1.25);
    expect(getNextPlaybackSpeed(1.5)).toBe(2);
    expect(getNextPlaybackSpeed(2)).toBe(1);
    // An unknown speed restarts the cycle
    expect(getNextPlaybackSpeed(3)).toBe(1);
  });
});

describe('usePlaybackControls', () => {
  let container: HTMLDivElement;
  let root: Root;
  let controls: Controls;
  const setters = {
    setTTSMuted: vi.fn(),
    setTTSVolume: vi.fn(),
    setAutoPlayLecture: vi.fn(),
    setPlaybackSpeed: vi.fn(),
  };

  function Probe({
    onResult,
    ...props
  }: UsePlaybackControlsOptions & { readonly onResult: (value: Controls) => void }) {
    onResult(usePlaybackControls(props));
    return null;
  }

  function render(props: Partial<UsePlaybackControlsOptions> = {}) {
    act(() =>
      root.render(
        createElement(Probe, {
          onResult: (value) => {
            controls = value;
          },
          engineMode: 'playing',
          isInLiveFlow: false,
          canPauseLive: false,
          ...props,
        }),
      ),
    );
  }

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    Object.values(setters).forEach((setter) => setter.mockReset());
    settings.state = {
      ttsMuted: false,
      ttsVolume: 0.8,
      autoPlayLecture: false,
      playbackSpeed: 1.5,
      ...setters,
    };
    settings.capabilities = { tts: {} };
    container = document.createElement('div');
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  });

  it('cycles the speed from the settings store', () => {
    render();
    act(() => controls.cycleSpeed());
    expect(setters.setPlaybackSpeed).toHaveBeenCalledExactlyOnceWith(2);
  });

  it('mutes only when narration is available', () => {
    render();
    act(() => controls.toggleMute());
    expect(setters.setTTSMuted).toHaveBeenCalledExactlyOnceWith(true);

    settings.capabilities = { tts: null };
    render();
    expect(controls.ttsEnabled).toBe(false);
    act(() => controls.toggleMute());
    expect(setters.setTTSMuted).toHaveBeenCalledOnce();
  });

  it('toggles auto-play and passes volume through', () => {
    render();
    act(() => controls.toggleAutoPlay());
    expect(setters.setAutoPlayLecture).toHaveBeenCalledExactlyOnceWith(true);
    expect(controls.ttsVolume).toBe(0.8);
    expect(controls.setTTSVolume).toBe(setters.setTTSVolume);
  });

  it('exposes the stop control for qa, discussion and live', () => {
    render({ sessionType: 'qa' });
    expect([controls.showStop, controls.stopKind]).toEqual([true, 'qa']);
    render({ sessionType: 'discussion' });
    expect([controls.showStop, controls.stopKind]).toEqual([true, 'discussion']);
    render({ engineMode: 'live' });
    expect(controls.showStop).toBe(true);
    render();
    expect(controls.showStop).toBe(false);
  });

  describe('primary action', () => {
    const actions = {
      onResumeTopic: vi.fn(),
      onLivePause: vi.fn(),
      onLiveResume: vi.fn(),
      onPlayPause: vi.fn(),
    };
    beforeEach(() => Object.values(actions).forEach((action) => action.mockReset()));

    it('resumes a pending topic first', () => {
      render({ ...actions, isTopicPending: true, isInLiveFlow: true, canPauseLive: true });
      act(() => controls.primaryAction());
      expect(actions.onResumeTopic).toHaveBeenCalledOnce();
      expect(actions.onLivePause).not.toHaveBeenCalled();
      expect(actions.onPlayPause).not.toHaveBeenCalled();
    });

    it('pauses and resumes the live answer, never before its text arrives', () => {
      render({ ...actions, isInLiveFlow: true, canPauseLive: false });
      act(() => controls.primaryAction());
      expect(actions.onLivePause).not.toHaveBeenCalled();

      render({ ...actions, isInLiveFlow: true, canPauseLive: true });
      act(() => controls.primaryAction());
      expect(actions.onLivePause).toHaveBeenCalledOnce();

      render({ ...actions, isInLiveFlow: true, isLivePaused: true });
      act(() => controls.primaryAction());
      expect(actions.onLiveResume).toHaveBeenCalledOnce();
      expect(actions.onPlayPause).not.toHaveBeenCalled();
    });

    it('reports when the control bar may toggle the live answer', () => {
      render({ canPauseLive: false });
      expect(controls.canToggleLivePause).toBe(false);
      render({ canPauseLive: true });
      expect(controls.canToggleLivePause).toBe(true);
      // A paused answer can always be resumed
      render({ canPauseLive: false, isLivePaused: true });
      expect(controls.canToggleLivePause).toBe(true);
    });

    it('plays or pauses the lecture otherwise', () => {
      render(actions);
      act(() => controls.primaryAction());
      expect(actions.onPlayPause).toHaveBeenCalledOnce();
    });
  });
});
