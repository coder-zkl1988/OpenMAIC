/**
 * A class moment on an interactive page (I29): the page's actions are its
 * widget_* steps and then one closing discussion (the teacher's whole-class
 * "predict first" question, or a classmate's "what if…?"). The engine offers
 * it exactly as on a slide — after the widget steps, with the usual pause —
 * and joining, skipping or ending it never replays or resets the widget: the
 * learner finds it as they left it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PlaybackEngine } from '@/lib/playback/engine';
import type { Action, DiscussionAction } from '@/lib/types/action';
import type { Scene } from '@/lib/types/stage';
import type { ActionEngine } from '@/lib/action/engine';
import type { AudioPlayer } from '@/lib/utils/audio-player';
import type { PlaybackEngineCallbacks } from '@/lib/playback/types';
import { DISCUSSION_TRIGGER_DELAY_MS } from '@/lib/choreography';

const widgetSteps = [
  { id: 'w1', type: 'widget_setState', state: { mass: 2 } },
  { id: 'w2', type: 'widget_highlight', target: 'slider' },
] as unknown as Action[];

const predict = {
  id: 'd1',
  type: 'discussion',
  topic: 'Before you drag it: what happens to the period if the mass doubles?',
  prompt: 'Have the learner predict, then try it.',
  agentId: 'teacher',
} as unknown as DiscussionAction;

function interactiveScene(actions: Action[]): Scene {
  return {
    id: 'scene-1',
    stageId: 'stage-1',
    type: 'interactive',
    title: 'Pendulum lab',
    order: 1,
    content: { type: 'interactive', url: '', html: '<div></div>' },
    actions,
  } as unknown as Scene;
}

function setup(callbacks: PlaybackEngineCallbacks = {}) {
  const actionEngine = {
    execute: vi.fn(async (_action: Action) => {}),
    clearEffects: vi.fn(),
    resetPlaybackVisualState: vi.fn(),
  };
  const audioPlayer = {
    play: vi.fn(async () => false),
    onEnded: vi.fn(),
    stop: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    isPlaying: vi.fn(() => false),
    hasActiveAudio: vi.fn(() => false),
  };
  const engine = new PlaybackEngine(
    [interactiveScene([...widgetSteps, predict as unknown as Action])],
    actionEngine as unknown as ActionEngine,
    audioPlayer as unknown as AudioPlayer,
    callbacks,
  );
  return { engine, actionEngine };
}

describe('a closing class moment on an interactive page', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is offered after the widget steps, with the usual pause, like on a slide', async () => {
    vi.useFakeTimers();
    const onProactiveShow = vi.fn();
    const { engine, actionEngine } = setup({ onProactiveShow });
    engine.start();
    await vi.advanceTimersByTimeAsync(DISCUSSION_TRIGGER_DELAY_MS - 100);
    expect(actionEngine.execute.mock.calls.map(([action]) => action.id)).toEqual(['w1', 'w2']);
    expect(onProactiveShow).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(onProactiveShow).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: 'd1', agentId: 'teacher', question: predict.topic }),
    );
  });

  it('leaves the widget as the learner left it when the moment is joined and ends', async () => {
    vi.useFakeTimers();
    const onDiscussionOutcome = vi.fn();
    const onDiscussionConfirmed = vi.fn();
    const { engine, actionEngine } = setup({ onDiscussionOutcome, onDiscussionConfirmed });
    engine.start();
    await vi.advanceTimersByTimeAsync(DISCUSSION_TRIGGER_DELAY_MS + 100);
    engine.confirmDiscussion();
    expect(onDiscussionOutcome).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: 'd1' }),
      'joined',
    );
    expect(onDiscussionConfirmed).toHaveBeenCalledWith(predict.topic, predict.prompt, 'teacher');

    engine.handleEndDiscussion();
    await vi.advanceTimersByTimeAsync(DISCUSSION_TRIGGER_DELAY_MS * 2);
    // No widget step ran again, nothing reset the page
    expect(actionEngine.execute).toHaveBeenCalledTimes(2);
    expect(actionEngine.resetPlaybackVisualState).not.toHaveBeenCalled();
    expect(engine.isExhausted()).toBe(true);
    expect(engine.getMode()).toBe('idle');
  });

  it('completes the page without replaying the widget when the moment is skipped', async () => {
    vi.useFakeTimers();
    const onComplete = vi.fn();
    const onDiscussionOutcome = vi.fn();
    const { engine, actionEngine } = setup({ onComplete, onDiscussionOutcome });
    engine.start();
    await vi.advanceTimersByTimeAsync(DISCUSSION_TRIGGER_DELAY_MS + 100);
    engine.skipDiscussion({ auto: true });
    await vi.advanceTimersByTimeAsync(100);
    expect(onDiscussionOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'd1' }),
      'auto_skipped',
    );
    expect(onComplete).toHaveBeenCalledOnce();
    expect(actionEngine.execute).toHaveBeenCalledTimes(2);
    expect(actionEngine.resetPlaybackVisualState).not.toHaveBeenCalled();
  });
});
