import { afterEach, describe, expect, it, vi } from 'vitest';

import { PlaybackEngine } from '@/lib/playback/engine';
import type { Action, DiscussionAction } from '@/lib/types/action';
import type { Scene } from '@/lib/types/stage';
import type { ActionEngine } from '@/lib/action/engine';
import type { AudioPlayer } from '@/lib/utils/audio-player';
import type { PlaybackEngineCallbacks } from '@/lib/playback/types';
import { DISCUSSION_TRIGGER_DELAY_MS } from '@/lib/choreography';

function discussion(id: string, agentId?: string): Action {
  return {
    id,
    type: 'discussion',
    topic: `topic-${id}`,
    prompt: `prompt-${id}`,
    agentId,
  } as unknown as DiscussionAction;
}

function scene(actions: Action[]): Scene {
  return {
    id: 'scene-1',
    stageId: 'stage-1',
    type: 'slide',
    title: 'Scene 1',
    order: 1,
    content: { type: 'slide', canvas: {} },
    actions,
  } as unknown as Scene;
}

function createActionEngine(): ActionEngine {
  return {
    execute: vi.fn(async () => {}),
    clearEffects: vi.fn(),
    resetPlaybackVisualState: vi.fn(),
  } as unknown as ActionEngine;
}

function createAudioPlayer(): AudioPlayer {
  return {
    play: vi.fn(async () => false),
    onEnded: vi.fn(),
    stop: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    isPlaying: vi.fn(() => false),
    hasActiveAudio: vi.fn(() => false),
  } as unknown as AudioPlayer;
}

function engineWith(
  actions: Action[],
  callbacks: PlaybackEngineCallbacks = {},
  options?: ConstructorParameters<typeof PlaybackEngine>[4],
) {
  return new PlaybackEngine(
    [scene(actions)],
    createActionEngine(),
    createAudioPlayer(),
    callbacks,
    options,
  );
}

/**
 * How each lecture moment ended for the learner (I06): reported once per
 * moment and playthrough, right after it is consumed, before the card hides
 * or the discussion starts.
 */
describe('discussion outcomes', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports 'joined' from confirmDiscussion, before the card hides and the discussion starts", async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    const onDiscussionOutcome = vi.fn(() => order.push('outcome'));
    const engine = engineWith([discussion('d1', 'mia')], {
      onDiscussionOutcome,
      onProgress: (snapshot) => {
        if (snapshot.consumedDiscussions.includes('d1')) order.push('consumed');
      },
      onProactiveHide: () => order.push('hide'),
      onDiscussionConfirmed: () => order.push('confirmed'),
    });
    engine.start();
    await vi.advanceTimersByTimeAsync(DISCUSSION_TRIGGER_DELAY_MS + 100);
    engine.confirmDiscussion();

    expect(onDiscussionOutcome).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: 'd1', question: 'topic-d1', agentId: 'mia' }),
      'joined',
    );
    expect(order.slice(order.indexOf('consumed'))).toEqual([
      'consumed',
      'outcome',
      'hide',
      'confirmed',
    ]);
  });

  it("tells a click on skip ('skipped') from the countdown running out ('auto_skipped')", async () => {
    vi.useFakeTimers();
    const onDiscussionOutcome = vi.fn();
    const engine = engineWith([discussion('d1'), discussion('d2')], { onDiscussionOutcome });
    engine.start();
    await vi.advanceTimersByTimeAsync(DISCUSSION_TRIGGER_DELAY_MS + 100);
    engine.skipDiscussion();
    await vi.advanceTimersByTimeAsync(DISCUSSION_TRIGGER_DELAY_MS + 100);
    engine.skipDiscussion({ auto: true });

    expect(
      onDiscussionOutcome.mock.calls.map(([trigger, outcome]) => [trigger.id, outcome]),
    ).toEqual([
      ['d1', 'skipped'],
      ['d2', 'auto_skipped'],
    ]);
  });

  it("reports 'not_shown' for a moment whose opener is not in the classroom", async () => {
    const onDiscussionOutcome = vi.fn();
    const onProactiveShow = vi.fn();
    const engine = engineWith([discussion('d1', 'absent')], {
      onDiscussionOutcome,
      onProactiveShow,
      isAgentSelected: () => false,
    });
    engine.start();
    await Promise.resolve();

    expect(onProactiveShow).not.toHaveBeenCalled();
    expect(onDiscussionOutcome).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: 'd1', agentId: 'absent' }),
      'not_shown',
    );
  });

  it('never reports a moment already consumed, nor a skip with no card up', async () => {
    vi.useFakeTimers();
    const onDiscussionOutcome = vi.fn();
    const engine = engineWith([discussion('d1')], { onDiscussionOutcome });
    engine.restoreFromSnapshot({ sceneIndex: 0, actionIndex: 0, consumedDiscussions: ['d1'] });
    engine.start();
    await vi.advanceTimersByTimeAsync(DISCUSSION_TRIGGER_DELAY_MS + 100);
    engine.skipDiscussion();

    expect(onDiscussionOutcome).not.toHaveBeenCalled();
  });

  it('never reports a card cancelled by a pause before it showed', async () => {
    vi.useFakeTimers();
    const onDiscussionOutcome = vi.fn();
    const onProactiveShow = vi.fn();
    const engine = engineWith([discussion('d1')], { onDiscussionOutcome, onProactiveShow });
    engine.start();
    await vi.advanceTimersByTimeAsync(DISCUSSION_TRIGGER_DELAY_MS / 2);
    engine.pause();
    await vi.advanceTimersByTimeAsync(DISCUSSION_TRIGGER_DELAY_MS);

    expect(onProactiveShow).not.toHaveBeenCalled();
    expect(onDiscussionOutcome).not.toHaveBeenCalled();
  });

  it('never reports a moment a raised hand deferred: it is offered again', async () => {
    vi.useFakeTimers();
    const onDiscussionOutcome = vi.fn();
    const onProactiveShow = vi.fn();
    const engine = engineWith([discussion('d1')], { onDiscussionOutcome, onProactiveShow });
    engine.start();
    await vi.advanceTimersByTimeAsync(DISCUSSION_TRIGGER_DELAY_MS + 100);
    expect(onProactiveShow).toHaveBeenCalledOnce();

    expect(engine.raiseHand()).toBe(true);
    expect(onDiscussionOutcome).not.toHaveBeenCalled();
    expect(engine.lowerHand()).toBe(true);
    await vi.advanceTimersByTimeAsync(DISCUSSION_TRIGGER_DELAY_MS + 100);
    expect(onProactiveShow).toHaveBeenCalledTimes(2);
    engine.confirmDiscussion();
    expect(onDiscussionOutcome).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: 'd1' }),
      'joined',
    );
  });
});

describe('the pause before a class moment card', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('asks the classroom per moment (a voiced card shows sooner)', async () => {
    vi.useFakeTimers();
    const onProactiveShow = vi.fn();
    const discussionTriggerDelayMs = vi.fn(() => 600);
    const engine = engineWith(
      [discussion('d1', 'mia')],
      { onProactiveShow },
      { discussionTriggerDelayMs },
    );
    engine.start();
    await vi.advanceTimersByTimeAsync(500);
    expect(onProactiveShow).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(onProactiveShow).toHaveBeenCalledOnce();
    expect(discussionTriggerDelayMs).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'd1', agentId: 'mia' }),
    );
  });

  it('keeps the usual pause by default and for a bad value', async () => {
    vi.useFakeTimers();
    for (const options of [undefined, { discussionTriggerDelayMs: () => Number.NaN }]) {
      const onProactiveShow = vi.fn();
      const engine = engineWith([discussion('d1')], { onProactiveShow }, options);
      engine.start();
      await vi.advanceTimersByTimeAsync(DISCUSSION_TRIGGER_DELAY_MS - 100);
      expect(onProactiveShow).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(200);
      expect(onProactiveShow).toHaveBeenCalledOnce();
      engine.stop();
    }
  });
});

describe('beginLearnerDiscussion (a missed moment opened from the notes)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('interrupts the lecture like a question: live, the cut line replayed afterwards, no message', async () => {
    const onUserInterrupt = vi.fn();
    const speech = { id: 's1', type: 'speech', text: 'First line' } as Action;
    const engine = engineWith([speech, { ...speech, id: 's2', text: 'Second line' } as Action], {
      onUserInterrupt,
    });
    engine.start();
    await Promise.resolve();
    expect(engine.getMode()).toBe('playing');

    expect(engine.beginLearnerDiscussion()).toBe(true);
    expect(engine.getMode()).toBe('live');
    expect(engine.hasLectureInterruption()).toBe(true);
    expect(onUserInterrupt).not.toHaveBeenCalled();

    // Already live: the learner talks directly
    expect(engine.beginLearnerDiscussion()).toBe(false);

    engine.handleEndDiscussion();
    // The line it cut off plays again
    expect(engine.getSnapshot().actionIndex).toBe(0);
  });
});
